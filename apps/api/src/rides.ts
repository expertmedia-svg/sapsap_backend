import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomInt } from "node:crypto";
import {
  DEFAULT_PRICING,
  eligible,
  fare,
  QuoteInput,
  Coordinates,
} from "../../../packages/shared/src";
import {
  Audit,
  Driver,
  Vehicle,
  Document,
  Quote,
  Ride,
  Offer,
  Wallet,
  LedgerTransaction,
  LedgerEntry,
  Payment,
  RideEvent,
  Outbox,
  Gps,
  Idempotency,
  Pricing,
  User,
  tx,
  mongoose,
} from "./db";
import { Router, OsrmRouter, geo, coords, distance } from "./routing";
import { digest, equal, encrypt, decrypt, hash } from "./security";
const objectId = (s: string) => {
  if (!mongoose.isValidObjectId(s))
    throw new BadRequestException("Identifiant invalide");
  return s;
};
const now = () => new Date();
const same = (a: any, b: any) => String(a) === String(b);
export class RideService {
  constructor(public router: Router = new OsrmRouter()) {}
  async pricing() {
    const p = (await Pricing.findOne({ active: true }).lean()) as any;
    return p
      ? {
          version: p.version,
          perKm: p.perKm,
          perMinute: p.perMinute,
          commissionBps: p.commissionBps,
          fuelPerKm: p.fuelPerKm,
        }
      : DEFAULT_PRICING;
  }
  async quote(user: any, input: unknown) {
    const data = QuoteInput.parse(input);
    for (const p of [data.pickup, data.dropoff])
      if (
        p.longitude < -6 ||
        p.longitude > 3 ||
        p.latitude < 9 ||
        p.latitude > 16
      )
        throw new BadRequestException("Zone desservie : Burkina Faso");
    const route = await this.router.route(data.pickup, data.dropoff);
    const pricing = await this.pricing();
    const quote = await Quote.create({
      passengerId: user._id,
      ...data,
      pickup: geo(data.pickup),
      dropoff: geo(data.dropoff),
      distanceMeters: route.meters,
      durationSeconds: route.seconds,
      geometry: route.geometry,
      pricing,
      expiresAt: new Date(Date.now() + 5 * 60000),
    });
    return {
      ...quote.toObject(),
      fare: fare(route.meters, 0, pricing),
      notice: `${pricing.perKm} FCFA/km + ${pricing.perMinute} FCFA/min d’immobilisation. Prix hors arrêts.`,
    };
  }
  async event(
    session: any,
    ride: any,
    actorId: any,
    type: string,
    data: unknown = {},
  ) {
    await RideEvent.create([{ rideId: ride._id, actorId, type, data }], {
      session,
    });
    await Outbox.create(
      [
        {
          kind: type,
          rideId: ride._id,
          userIds: [
            String(ride.passengerId),
            ...(ride.driverId ? [String(ride.driverId)] : []),
          ],
          payload: { rideId: String(ride._id), status: ride.status },
        },
      ],
      { session },
    );
  }
  async create(user: any, quoteId: string, key: string) {
    objectId(quoteId);
    const payloadHash = hash(quoteId);
    const cached = await Idempotency.findOne({
      userId: user._id,
      key,
      route: "rides",
    });
    if (cached) {
      if (cached.payloadHash !== payloadHash)
        throw new ConflictException("Clé déjà utilisée pour une autre demande");
      return this.get(user, cached.response.rideId);
    }
    let rideId = "";
    try {
      await tx(async (s) => {
        const previous = await Idempotency.findOne({
          userId: user._id,
          key,
          route: "rides",
        }).session(s);
        if (previous) {
          if (previous.payloadHash !== payloadHash)
            throw new ConflictException("Clé déjà utilisée");
          rideId = previous.response.rideId;
          return;
        }
        const quote = await Quote.findOneAndUpdate(
          {
            _id: quoteId,
            passengerId: user._id,
            consumed: false,
            expiresAt: { $gt: now() },
          },
          { $set: { consumed: true } },
          { returnDocument: "after", session: s },
        );
        if (!quote)
          throw new ConflictException("Estimation expirée ou déjà utilisée");
        const code = String(randomInt(1000, 10000));
        const [r] = await Ride.create(
          [
            {
              passengerId: user._id,
              requestId: quote._id,
              pickup: quote.pickup,
              dropoff: quote.dropoff,
              pickupLabel: quote.pickupLabel,
              dropoffLabel: quote.dropoffLabel,
              landmark: quote.landmark,
              distanceMeters: quote.distanceMeters,
              durationSeconds: quote.durationSeconds,
              pricing: quote.pricing,
              status: "searching",
              active: true,
              stationarySeconds: 0,
              pickupDigest: digest(code),
              pickupCodeCipher: encrypt(code),
            },
          ],
          { session: s },
        );
        rideId = String(r._id);
        await Idempotency.create(
          [
            {
              userId: user._id,
              key,
              route: "rides",
              payloadHash,
              response: { rideId },
            },
          ],
          { session: s },
        );
        await this.event(s, r, user._id, "ride.requested");
      });
    } catch (e: any) {
      if (e.code === 11000) {
        const c = await Idempotency.findOne({
          userId: user._id,
          key,
          route: "rides",
        });
        if (c && c.payloadHash === payloadHash)
          return this.get(user, c.response.rideId);
        throw new ConflictException("Vous avez déjà une course active");
      }
      throw e;
    }
    try {
      await this.dispatch(rideId);
    } catch {
      /* booking persists, outbox retries dispatch */
    }
    return this.get(user, rideId);
  }
  async dispatch(id: string) {
    const ride = await Ride.findOne({ _id: id, status: "searching" });
    if (!ride) return;
    const drivers = await Driver.find({
      approved: true,
      online: true,
      locationAt: { $gt: new Date(Date.now() - 60000) },
      accuracy: { $lte: 100 },
      location: {
        $near: {
          $geometry: ride.pickup,
          $maxDistance: ride.distanceMeters / 3,
        },
      },
    }).limit(15);
    for (const d of drivers) {
      if (await Ride.exists({ driverId: d.userId, active: true })) continue;
      const valid = await this.driverValid(d.userId);
      if (!valid) continue;
      let route;
      try {
        route = await this.router.route(
          coords(d.location),
          coords(ride.pickup),
          { allowZero: true },
        );
      } catch {
        continue;
      }
      if (!eligible(route.meters + d.accuracy, ride.distanceMeters)) continue;
      try {
        await tx(async (s) => {
          await Offer.updateOne(
            { rideId: ride._id, driverId: d.userId },
            {
              $setOnInsert: {
                pickupMeters: route.meters,
                expiresAt: new Date(Date.now() + 45000),
                status: "pending",
              },
            },
            { upsert: true, session: s },
          );
          await Outbox.create(
            [
              {
                kind: "ride.offer",
                rideId: ride._id,
                userIds: [String(d.userId)],
                payload: { rideId: String(ride._id) },
              },
            ],
            { session: s },
          );
        });
      } catch (e: any) {
        if (e.code !== 11000) throw e;
      }
    }
  }
  async driverValid(id: any) {
    const [v, docs] = await Promise.all([
      Vehicle.findOne({
        driverId: id,
        insuranceExpiresAt: { $gt: now() },
        inspectionExpiresAt: { $gt: now() },
      }),
      Document.find({
        driverId: id,
        status: "approved",
        $or: [{ expiresAt: { $gt: now() } }, { expiresAt: { $exists: false } }],
      }),
    ]);
    return (
      !!v &&
      ["identity", "license", "insurance", "registration", "inspection"].every(
        (k) => docs.some((d) => d.kind === k),
      )
    );
  }
  async offers(user: any) {
    const driver = await Driver.findOne({
      userId: user._id,
      approved: true,
      online: true,
    });
    if (!driver) return [];
    const offers = await Offer.find({
      driverId: user._id,
      status: "pending",
      expiresAt: { $gt: now() },
    })
      .sort({ pickupMeters: 1 })
      .limit(20);
    const results = [];
    for (const o of offers) {
      const r = (await Ride.findOne({
        _id: o.rideId,
        status: "searching",
      }).lean()) as any;
      if (r)
        results.push({
          id: String(o._id),
          rideId: String(r._id),
          pickupLabel: r.pickupLabel,
          dropoffLabel: r.dropoffLabel,
          landmark: r.landmark,
          distanceMeters: r.distanceMeters,
          pickupMeters: o.pickupMeters,
          expiresAt: o.expiresAt,
          fare: fare(r.distanceMeters, 0, r.pricing),
        });
    }
    return results;
  }
  async accept(user: any, id: string) {
    objectId(id);
    const ride = await Ride.findById(id);
    if (!ride) throw new NotFoundException();
    if (
      same(ride.driverId, user._id) &&
      ["accepted", "arrived", "in_progress"].includes(ride.status)
    )
      return this.get(user, id);
    const d = await Driver.findOne({
      userId: user._id,
      approved: true,
      online: true,
      locationAt: { $gt: new Date(Date.now() - 60000) },
      accuracy: { $lte: 100 },
    });
    if (!d || !(await this.driverValid(user._id)))
      throw new ForbiddenException("Profil, documents ou position non valides");
    const route = await this.router.route(
      coords(d.location),
      coords(ride.pickup),
      { allowZero: true },
    );
    if (!eligible(route.meters + d.accuracy, ride.distanceMeters))
      throw new ConflictException("Hors limite de récupération");
    try {
      await tx(async (s) => {
        const offer = await Offer.findOneAndUpdate(
          {
            rideId: id,
            driverId: user._id,
            status: "pending",
            expiresAt: { $gt: now() },
          },
          { $set: { status: "accepted" } },
          { returnDocument: "after", session: s },
        );
        if (!offer) throw new ConflictException("Proposition expirée");
        const r = await Ride.findOneAndUpdate(
          { _id: id, status: "searching", active: true },
          { $set: { driverId: user._id, status: "accepted" } },
          { returnDocument: "after", session: s },
        );
        if (!r) throw new ConflictException("Course déjà affectée");
        await Offer.updateMany(
          { rideId: id, status: "pending" },
          { $set: { status: "expired" } },
          { session: s },
        );
        await this.event(s, r, user._id, "ride.accepted", {
          pickupMeters: route.meters,
        });
      });
    } catch (e: any) {
      if (e.code === 11000)
        throw new ConflictException("Chauffeur déjà occupé");
      throw e;
    }
    return this.get(user, id);
  }
  async get(user: any, id: string): Promise<any> {
    objectId(id);
    const r = (await Ride.findById(id).lean()) as any;
    if (!r) throw new NotFoundException();
    const admin = ["superadmin", "operations", "support", "finance"].includes(
      user.role,
    );
    if (!same(r.passengerId, user._id) && !same(r.driverId, user._id) && !admin)
      throw new ForbiddenException("Cette course ne vous appartient pas");
    const { pickupDigest, pickupCodeCipher, pickupAttempts, lastGps, ...safe } =
      r;
    if (user.role === "finance")
      return {
        _id: r._id,
        driverId: r.driverId,
        pickupLabel: r.pickupLabel,
        dropoffLabel: r.dropoffLabel,
        status: r.status,
        distanceMeters: r.distanceMeters,
        stationarySeconds: r.stationarySeconds,
        pricing: r.pricing,
        fare: r.fare || fare(r.distanceMeters, r.stationarySeconds, r.pricing),
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      };
    let driver;
    if (r.driverId) {
      const [u, v, d] = await Promise.all([
        User.findById(r.driverId),
        Vehicle.findOne({ driverId: r.driverId }),
        Driver.findOne({ userId: r.driverId }),
      ]);
      driver = {
        name: u?.name,
        vehicle: v ? { brand: v.brand, plate: v.plate } : undefined,
        location: r.active ? d?.location : undefined,
        locationAt: r.active ? d?.locationAt : undefined,
      };
    }
    return {
      ...safe,
      fare: r.fare || fare(r.distanceMeters, r.stationarySeconds, r.pricing),
      driver,
      ...(same(r.passengerId, user._id) && r.active
        ? { pickupCode: decrypt(pickupCodeCipher) }
        : {}),
    };
  }
  async active(user: any) {
    const r = await Ride.findOne({
      active: true,
      ...(user.role === "driver"
        ? { driverId: user._id }
        : { passengerId: user._id }),
    });
    return r ? this.get(user, String(r._id)) : null;
  }
  async history(user: any) {
    const filter =
      user.role === "driver"
        ? { driverId: user._id }
        : { passengerId: user._id };
    const rides = await Ride.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .select("_id");
    return Promise.all(rides.map((r) => this.get(user, String(r._id))));
  }
  async transition(user: any, id: string, action: string, code?: string) {
    objectId(id);
    if (action === "finish") return this.finish(user, id);
    const pre = await Ride.findById(id);
    if (!pre) throw new NotFoundException();
    if (
      action === "start" &&
      same(pre.driverId, user._id) &&
      pre.status === "arrived"
    ) {
      if (pre.pickupAttempts >= 5)
        throw new ForbiddenException("Code bloqué. Contactez le support.");
      if (!equal(digest(code || ""), pre.pickupDigest)) {
        await Ride.updateOne(
          { _id: id, status: "arrived" },
          { $inc: { pickupAttempts: 1 } },
        );
        throw new BadRequestException("Code passager incorrect");
      }
    }
    await tx(async (s) => {
      const r = await Ride.findById(id).session(s);
      if (!r) throw new NotFoundException();
      if (action === "cancel") {
        if (!same(r.passengerId, user._id) && !same(r.driverId, user._id))
          throw new ForbiddenException();
        if (!["searching", "accepted", "arrived"].includes(r.status))
          throw new ConflictException("Annulation impossible à cette étape");
        r.status = "cancelled";
        r.active = false;
      } else {
        if (!same(r.driverId, user._id)) throw new ForbiddenException();
        if (action === "arrive") {
          if (r.status !== "accepted")
            throw new ConflictException("Transition impossible");
          const d = await Driver.findOne({
            userId: user._id,
            locationAt: { $gt: new Date(Date.now() - 60000) },
          }).session(s);
          if (!d || distance(coords(d.location), coords(r.pickup)) > 200)
            throw new ConflictException(
              "Vous devez être près du point de départ",
            );
          r.status = "arrived";
        } else if (action === "start") {
          if (
            r.status !== "arrived" ||
            r.pickupAttempts >= 5 ||
            !equal(digest(code || ""), r.pickupDigest)
          )
            throw new ConflictException("Démarrage impossible");
          r.status = "in_progress";
          r.startedAt = now();
          r.stationarySeconds = 0;
          r.lastGps = undefined;
        } else throw new BadRequestException("Action inconnue");
      }
      await r.save({ session: s });
      if (!r.active)
        await Offer.updateMany(
          { rideId: id, status: "pending" },
          { $set: { status: "expired" } },
          { session: s },
        );
      await this.event(s, r, user._id, "ride." + r.status);
    });
    return this.get(user, id);
  }
  async finish(user: any, id: string) {
    await tx(async (s) => {
      const r = await Ride.findOne({ _id: id, driverId: user._id }).session(s);
      if (!r) throw new ForbiddenException();
      if (r.status === "completed") return;
      if (r.status !== "in_progress")
        throw new ConflictException("Course non démarrée");
      const calculated = fare(r.distanceMeters, r.stationarySeconds, r.pricing);
      const [transaction] = await LedgerTransaction.create(
        [
          {
            key: "commission:" + id,
            rideId: r._id,
            kind: "commission",
            amount: calculated.commission,
          },
        ],
        { session: s, ordered: true },
      );
      await LedgerEntry.create(
        [
          {
            transactionId: transaction._id,
            account: "driver:" + String(user._id),
            amount: -calculated.commission,
          },
          {
            transactionId: transaction._id,
            account: "platform:commissions",
            amount: calculated.commission,
          },
        ],
        { session: s, ordered: true },
      );
      await Wallet.updateOne(
        { driverId: user._id },
        { $inc: { balance: -calculated.commission } },
        { session: s, upsert: true },
      );
      r.status = "completed";
      r.active = false;
      r.completedAt = now();
      r.fare = calculated;
      await r.save({ session: s });
      await Payment.create(
        [
          {
            rideId: r._id,
            userId: r.passengerId,
            method: "cash",
            amount: calculated.total,
            status: "awaiting_cash_confirmation",
          },
        ],
        { session: s },
      );
      await this.event(s, r, user._id, "ride.completed", calculated);
    });
    return this.get(user, id);
  }
  async cash(user: any, id: string) {
    await tx(async (s) => {
      const r = await Ride.findOne({
        _id: objectId(id),
        driverId: user._id,
        status: "completed",
      }).session(s);
      if (!r) throw new ForbiddenException();
      if (r.cashReceivedAt) return;
      r.cashReceivedAt = now();
      await r.save({ session: s });
      await Payment.updateOne(
        { rideId: id, method: "cash" },
        { $set: { status: "cash_received_reported" } },
        { session: s },
      );
      await this.event(s, r, user._id, "cash.received.reported");
    });
    return this.get(user, id);
  }
  async gps(
    user: any,
    id: string,
    input: {
      eventId: string;
      longitude: number;
      latitude: number;
      accuracy: number;
      speed: number;
      at: string;
    },
  ) {
    objectId(id);
    const at = new Date(input.at),
      age = Date.now() - at.getTime();
    if (age < -5000 || age > 30000)
      throw new BadRequestException("Position trop ancienne ou future");
    await tx(async (s) => {
      if (await Gps.exists({ rideId: id, eventId: input.eventId }).session(s))
        return;
      const r = await Ride.findOne({
        _id: id,
        driverId: user._id,
        status: "in_progress",
      }).session(s);
      if (!r) throw new ForbiddenException("Aucune course en cours");
      let accepted = input.accuracy <= 20,
        reason = accepted ? "valid" : "accuracy";
      let extra = 0;
      const previous = r.lastGps;
      const current = {
        longitude: input.longitude,
        latitude: input.latitude,
        accuracy: input.accuracy,
        speed: input.speed,
        at: at.getTime(),
      };
      if (previous) {
        const dt = (current.at - previous.at) / 1000;
        const movement = distance(previous, current);
        if (dt <= 0 || dt > 15 || movement / Math.max(dt, 1) > 55) {
          accepted = false;
          reason = "gap_or_outlier";
        } else if (accepted && previous.accuracy <= 20) {
          const stationary =
            current.speed <= 0.5 && previous.speed <= 0.5 && movement <= 8;
          const moving = current.speed >= 1.2 || movement >= 15;
          if (stationary && r.stationaryConfirmed) extra = Math.floor(dt);
          r.stationaryConfirmed =
            stationary || (r.stationaryConfirmed && !moving);
        }
      } else r.stationaryConfirmed = false;
      if (accepted) {
        r.lastGps = current;
        r.stationarySeconds += extra;
      } else {
        r.lastGps = undefined;
        r.stationaryConfirmed = false;
      }
      await r.save({ session: s });
      await Gps.create(
        [
          {
            rideId: id,
            driverId: user._id,
            eventId: input.eventId,
            at,
            point: geo(current),
            accuracy: input.accuracy,
            speed: input.speed,
            accepted,
            reason,
          },
        ],
        { session: s },
      );
      if (extra)
        await this.event(s, r, user._id, "ride.meter", {
          stationarySeconds: r.stationarySeconds,
        });
    });
    return this.get(user, id);
  }
  async credit(
    actor: any,
    driverId: string,
    amount: number,
    key: string,
    reason: string,
  ) {
    objectId(driverId);
    await tx(async (s) => {
      const previous = await LedgerTransaction.findOne({
        key: "adjustment:" + key,
      }).session(s);
      if (previous) {
        if (
          previous.amount !== amount ||
          previous.reason !== reason ||
          !same(previous.driverId, driverId) ||
          !same(previous.actorId, actor._id)
        )
          throw new ConflictException("Clé déjà utilisée");
        return;
      }
      if (!(await Driver.exists({ userId: driverId }).session(s)))
        throw new NotFoundException();
      const [t] = await LedgerTransaction.create(
        [
          {
            key: "adjustment:" + key,
            actorId: actor._id,
            driverId,
            kind: "manual_adjustment",
            amount,
            reason,
          },
        ],
        { session: s },
      );
      await LedgerEntry.create(
        [
          { transactionId: t._id, account: "driver:" + driverId, amount },
          {
            transactionId: t._id,
            account: "platform:adjustment_clearing",
            amount: -amount,
          },
        ],
        { session: s, ordered: true },
      );
      await Wallet.updateOne(
        { driverId },
        { $inc: { balance: amount } },
        { session: s },
      );
      await Audit.create(
        [
          {
            actorId: actor._id,
            action: "wallet.manual_adjustment",
            target: driverId,
            reason,
            data: { amount, transactionId: String(t._id) },
          },
        ],
        { session: s },
      );
    });
    return Wallet.findOne({ driverId });
  }
}

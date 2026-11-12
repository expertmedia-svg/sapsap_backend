import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  connectDb,
  mongoose,
  User,
  Driver,
  Vehicle,
  Document,
  Wallet,
  Offer,
  Ride,
  LedgerTransaction,
  LedgerEntry,
  Payment,
  Gps,
  Outbox,
  Session,
} from "../apps/api/src/db";
import { RideService } from "../apps/api/src/rides";
import { geo, Router } from "../apps/api/src/routing";
import {
  decrypt,
  digest,
  hash,
  authenticate,
  encrypt,
} from "../apps/api/src/security";
import { randomUUID } from "node:crypto";
import { start } from "../apps/api/src/main";
import { AdminController, RideController } from "../apps/api/src/controllers";
import { Pricing, ChatMessage, Expense } from "../apps/api/src/db";
import { DEFAULT_PRICING } from "../packages/shared/src";
import { AuthService } from "../apps/api/src/auth";
let repl: MongoMemoryReplSet;
const router: Router = {
  async route(a, b) {
    return {
      meters: a.longitude === -1.5 ? 1200 : 5000,
      seconds: 600,
      geometry: {
        type: "LineString",
        coordinates: [
          [a.longitude, a.latitude],
          [b.longitude, b.latitude],
        ],
      },
    };
  },
};
const service = new RideService(router);
let passenger: any, driver: any, driver2: any, outsider: any;
let ride: any;
before(async () => {
  process.env.AUTH_SECRET = "integration-secret-only-not-for-production-123456";
  process.env.NODE_ENV = "test";
  repl = await MongoMemoryReplSet.create({
    binary: { version: "8.0.17" },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await connectDb(repl.getUri("test"));
  [passenger, driver, driver2, outsider] = await User.create([
    { phone: "+22670000010", name: "Passager", role: "passenger" },
    { phone: "+22670000011", name: "Chauffeur", role: "driver" },
    { phone: "+22670000012", name: "Autre chauffeur", role: "driver" },
    { phone: "+22670000013", name: "Autre passager", role: "passenger" },
  ]);
  for (const d of [driver, driver2]) {
    await Driver.create({
      userId: d._id,
      name: d.name,
      approved: true,
      online: true,
      location: geo({ longitude: -1.5, latitude: 12.35 }),
      locationAt: new Date(),
      accuracy: 5,
    });
    await Vehicle.create({
      driverId: d._id,
      brand: "Toyota",
      plate: String(d._id),
      insuranceExpiresAt: new Date(Date.now() + 86400000),
      inspectionExpiresAt: new Date(Date.now() + 86400000),
    });
    for (const kind of [
      "identity",
      "license",
      "insurance",
      "registration",
      "inspection",
    ])
      await Document.create({
        driverId: d._id,
        kind,
        key: randomUUID(),
        mime: "image/jpeg",
        status: "approved",
        expiresAt: new Date(Date.now() + 86400000),
      });
    await Wallet.create({ driverId: d._id, balance: 5000 });
  }
});
after(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});
test("OTP local renvoyé à l’application et utilisable uniquement si activé", async () => {
  const previous = {
    node: process.env.NODE_ENV,
    local: process.env.ALLOW_LOCAL_OTP,
    sms: process.env.SMS_MODE,
  };
  const auth = new AuthService();
  try {
    process.env.ALLOW_LOCAL_OTP = "true";
    process.env.SMS_MODE = "disabled";
    const result = await auth.request("+22670000091", "local-otp-test");
    assert.match(result.devCode ?? "", /^\d{6}$/);
    const session = await auth.verify(
      { phone: "+22670000091", code: result.devCode },
      "local-otp-test",
    );
    assert.ok(session.token);
    process.env.ALLOW_LOCAL_OTP = "false";
    await assert.rejects(
      auth.request("+22670000092", "production-otp-test"),
      /Envoi SMS indisponible/,
    );
  } finally {
    for (const [key, value] of Object.entries({
      NODE_ENV: previous.node,
      ALLOW_LOCAL_OTP: previous.local,
      SMS_MODE: previous.sms,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
test("chiffrement réversible, pas de code en clair en base", () => {
  const cipher = encrypt("1234");
  assert.equal(decrypt(cipher), "1234");
  assert.notEqual(cipher, "1234");
});
test("réservation idempotente et affectation concurrente unique", async () => {
  const q = await service.quote(passenger, {
    pickup: { longitude: -1.51, latitude: 12.35 },
    dropoff: { longitude: -1.52, latitude: 12.37 },
    pickupLabel: "Départ",
    dropoffLabel: "Arrivée",
    landmark: "Monument",
  });
  const key = randomUUID();
  ride = await service.create(passenger, String(q._id), key);
  const again = await service.create(passenger, String(q._id), key);
  assert.equal(String(ride._id), String(again._id));
  assert.equal(await Ride.countDocuments(), 1);
  await assert.rejects(
    () => service.get(outsider, String(ride._id)),
    /appartient/,
  );
  assert.equal(await Offer.countDocuments({ rideId: ride._id }), 2);
  const results = await Promise.allSettled([
    service.accept(driver, String(ride._id)),
    service.accept(driver2, String(ride._id)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const r = await Ride.findById(ride._id);
  driver = String(r!.driverId) === String(driver._id) ? driver : driver2;
});
test("démarrage avec code et GPS rejeté hors intervalle fiable", async () => {
  await Driver.updateOne(
    { userId: driver._id },
    { $set: { location: ride.pickup, locationAt: new Date() } },
  );
  await service.transition(driver, String(ride._id), "arrive");
  await assert.rejects(() =>
    service.transition(driver, String(ride._id), "start", "0000"),
  );
  const view = await service.get(passenger, String(ride._id));
  await service.transition(driver, String(ride._id), "start", view.pickupCode);
  const base = Date.now() - 20000;
  for (let i = 0; i < 5; i++)
    await service.gps(driver, String(ride._id), {
      eventId: randomUUID(),
      longitude: -1.51,
      latitude: 12.35,
      at: new Date(base + i * 5000).toISOString(),
      accuracy: 5,
      speed: 0,
    });
  const r = await Ride.findById(ride._id);
  assert.equal(r!.stationarySeconds, 15);
  const old = randomUUID();
  await assert.rejects(() =>
    service.gps(driver, String(ride._id), {
      eventId: old,
      longitude: -1.51,
      latitude: 12.35,
      at: new Date(Date.now() - 60000).toISOString(),
      accuracy: 5,
      speed: 0,
    }),
  );
  assert.equal(await Gps.countDocuments({ eventId: old }), 0);
});
test("fin concurrente : un seul débit et registre équilibré", async () => {
  const before = await Wallet.findOne({ driverId: driver._id });
  const results = await Promise.all([
    service.finish(driver, String(ride._id)),
    service.finish(driver, String(ride._id)),
  ]);
  assert.equal(results[0].status, "completed");
  assert.equal(results[1].status, "completed");
  const r = await service.get(passenger, String(ride._id));
  const after = await Wallet.findOne({ driverId: driver._id });
  assert.equal(before!.balance - after!.balance, r.fare.commission);
  assert.equal(
    await LedgerTransaction.countDocuments({ key: "commission:" + ride._id }),
    1,
  );
  const entries = await LedgerEntry.find();
  assert.equal(
    entries.reduce((sum, e) => sum + e.amount, 0),
    0,
  );
  assert.equal(await Payment.countDocuments({ rideId: ride._id }), 1);
  await service.cash(driver, String(ride._id));
  await service.cash(driver, String(ride._id));
  assert.equal(
    (await Payment.findOne({ rideId: ride._id }))!.status,
    "cash_received_reported",
  );
  assert.ok((await Outbox.countDocuments()) > 0);
});
test("session révoquée refusée", async () => {
  const token = randomUUID();
  await Session.create({
    userId: passenger._id,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + 60000),
  });
  assert.equal(
    String((await authenticate(token)).user._id),
    String(passenger._id),
  );
  await Session.updateOne(
    { tokenHash: hash(token) },
    { $set: { revokedAt: new Date() } },
  );
  await assert.rejects(() => authenticate(token));
});
test("transaction annulée ne laisse aucune écriture", async () => {
  const count = await LedgerTransaction.countDocuments();
  await assert.rejects(() =>
    mongoose.connection.transaction(async (session) => {
      await LedgerTransaction.create(
        [{ key: "rollback", kind: "test", amount: 10 }],
        { session },
      );
      throw Error("rollback");
    }),
  );
  assert.equal(await LedgerTransaction.countDocuments(), count);
});
test("ajustement financier idempotent, clé liée au chauffeur et registre équilibré", async () => {
  const other = await Driver.findOne({ userId: { $ne: driver._id } });
  const key = randomUUID();
  const original = (await Wallet.findOne({ driverId: driver._id }))!.balance;
  await service.credit(
    passenger,
    String(driver._id),
    1000,
    key,
    "Versement de test justifié",
  );
  await service.credit(
    passenger,
    String(driver._id),
    1000,
    key,
    "Versement de test justifié",
  );
  assert.equal(
    (await Wallet.findOne({ driverId: driver._id }))!.balance,
    original + 1000,
  );
  await assert.rejects(
    () =>
      service.credit(
        passenger,
        String(other!.userId),
        1000,
        key,
        "Versement de test justifié",
      ),
    /Clé déjà utilisée/,
  );
  const total = await LedgerEntry.aggregate([
    { $group: { _id: null, balance: { $sum: "$amount" } } },
  ]);
  assert.equal(total[0].balance, 0);
});
test("récupération routière trop longue : aucune proposition malgré proximité géographique", async () => {
  const saved = service.router;
  service.router = {
    async route(a, b) {
      return {
        meters: a.longitude === -1.5 ? 2000 : 5000,
        seconds: 600,
        geometry: null,
      };
    },
  };
  try {
    await Driver.updateMany(
      {},
      {
        $set: {
          location: geo({ longitude: -1.5, latitude: 12.35 }),
          locationAt: new Date(),
        },
      },
    );
    const q = await service.quote(outsider, {
      pickup: { longitude: -1.51, latitude: 12.35 },
      dropoff: { longitude: -1.52, latitude: 12.37 },
      pickupLabel: "Départ",
      dropoffLabel: "Arrivée",
      landmark: "",
    });
    const r = await service.create(outsider, String(q._id), randomUUID());
    assert.equal(await Offer.countDocuments({ rideId: r._id }), 0);
    const transactions = await LedgerTransaction.countDocuments();
    await service.transition(outsider, String(r._id), "cancel");
    assert.equal(await LedgerTransaction.countDocuments(), transactions);
  } finally {
    service.router = saved;
  }
});
test("réutilisation de clé avec une autre demande refusée", async () => {
  const input = {
    pickup: { longitude: -1.51, latitude: 12.35 },
    dropoff: { longitude: -1.52, latitude: 12.37 },
    pickupLabel: "Départ",
    dropoffLabel: "Arrivée",
    landmark: "",
  };
  const q = await service.quote(passenger, input),
    q2 = await service.quote(passenger, input);
  const key = randomUUID();
  const r = await service.create(passenger, String(q._id), key);
  await assert.rejects(
    () => service.create(passenger, String(q2._id), key),
    /Clé déjà utilisée/,
  );
  await service.transition(passenger, String(r._id), "cancel");
});
test("API HTTP : authentification, absence de fuite et validation stricte", async () => {
  process.env.MONGODB_URI = repl.getUri("test");
  process.env.PORT = "0";
  process.env.REDIS_URL = "";
  const app = await start();
  try {
    const url = (await app.getUrl()).replace("0.0.0.0", "127.0.0.1");
    assert.equal((await fetch(url + "/health")).status, 200);
    assert.equal((await fetch(url + "/me")).status, 401);
    const raw = randomUUID();
    await Session.create({
      userId: passenger._id,
      tokenHash: hash(raw),
      expiresAt: new Date(Date.now() + 60000),
    });
    const headers = {
      Authorization: "Bearer " + raw,
      "Content-Type": "application/json",
    };
    const me = (await (await fetch(url + "/me", { headers })).json()) as any;
    assert.equal(me.role, "passenger");
    assert.equal(me.mfaSecret, undefined);
    const accountant = await User.create({
        phone: "+22670000022",
        name: "Finance test",
        role: "finance",
      }),
      financeToken = randomUUID();
    await Session.create({
      userId: accountant._id,
      tokenHash: hash(financeToken),
      expiresAt: new Date(Date.now() + 60000),
    });
    const financeHeaders = { Authorization: "Bearer " + financeToken };
    const financialRide = (await (
      await fetch(url + "/rides/" + ride._id, { headers: financeHeaders })
    ).json()) as any;
    assert.equal(financialRide.pickup, undefined);
    assert.equal(financialRide.driver, undefined);
    assert.equal(financialRide.pickupCode, undefined);
    const navigationResponse = await fetch(
      url + "/rides/" + ride._id + "/navigation",
      { headers },
    );
    assert.equal(navigationResponse.status, 200);
    const navigationData = (await navigationResponse.json()) as any;
    assert.equal(navigationData.geometry.type, "LineString");
    assert.equal(navigationData.trafficAware, false);
    assert.equal(
      (
        await fetch(url + "/rides/" + ride._id + "/navigation", {
          headers: financeHeaders,
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url + "/admin/drivers", { headers: financeHeaders })).status,
      403,
    );
    assert.equal(
      (await fetch(url + "/admin/summary", { headers })).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/rides/quotes", {
          method: "POST",
          headers,
          body: JSON.stringify({ pickup: { $gt: "" } }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url + "/me", {
          headers: { ...headers, Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
  } finally {
    await app.close();
  }
});
test("versions tarifaires : les estimations confirmées conservent leur tarif", async () => {
  await Pricing.create({ ...DEFAULT_PRICING, active: true });
  const admin = new AdminController();
  const actor = await User.create({
    phone: "+22670000021",
    name: "Admin test",
    role: "superadmin",
  });
  const input = {
    pickup: { longitude: -1.51, latitude: 12.35 },
    dropoff: { longitude: -1.52, latitude: 12.37 },
    pickupLabel: "Départ",
    dropoffLabel: "Arrivée",
    landmark: "",
  };
  const q = await service.quote(passenger, input);
  await admin.updatePricing(
    { user: actor },
    {
      version: "economy-v2",
      perKm: 300,
      perMinute: 30,
      commissionBps: 700,
      reason: "Modification justifiée de test",
    },
  );
  const newQuote = await service.quote(outsider, input);
  assert.equal(newQuote.fare.total, 1500);
  const r = await service.create(passenger, String(q._id), randomUUID());
  assert.equal(r.fare.total, 1000);
  await service.transition(passenger, String(r._id), "cancel");
  await admin.updatePricing(
    { user: actor },
    {
      version: "economy-v3",
      perKm: 200,
      perMinute: 25,
      commissionBps: 700,
      reason: "Retour aux tarifs retenus pour les tests",
    },
  );
});
test("messagerie : participants uniquement, message unique, fermeture après course", async () => {
  const controller = new RideController();
  const input = {
    pickup: { longitude: -1.51, latitude: 12.35 },
    dropoff: { longitude: -1.52, latitude: 12.37 },
    pickupLabel: "Départ",
    dropoffLabel: "Arrivée",
    landmark: "",
  };
  const q = await service.quote(passenger, input);
  const r = await service.create(passenger, String(q._id), randomUUID());
  await service.accept(driver, String(r._id));
  const body = { text: "Je suis devant le monument", clientId: randomUUID() };
  await controller.message({ user: passenger }, String(r._id), body);
  await controller.message({ user: passenger }, String(r._id), body);
  assert.equal(await ChatMessage.countDocuments({ rideId: r._id }), 1);
  await assert.rejects(() =>
    controller.messages({ user: outsider }, String(r._id)),
  );
  await service.transition(passenger, String(r._id), "cancel");
  await assert.rejects(() =>
    controller.message({ user: passenger }, String(r._id), {
      text: "Autre message",
      clientId: randomUUID(),
    }),
  );
});
test("suspension motivée : session immédiatement inutilisable", async () => {
  const admin = new AdminController();
  const actor = await User.findOne({ role: "superadmin" });
  const raw = randomUUID();
  await Session.create({
    userId: outsider._id,
    tokenHash: hash(raw),
    expiresAt: new Date(Date.now() + 60000),
  });
  await admin.suspend({ user: actor }, String(outsider._id), {
    suspended: true,
    reason: "Incident de test soumis à revue humaine",
  });
  await assert.rejects(() => authenticate(raw));
  await admin.suspend({ user: actor }, String(outsider._id), {
    suspended: false,
    reason: "Réactivation après examen de la contestation",
  });
});
test("dépense enregistrée une seule fois et contreparties équilibrées", async () => {
  const admin = new AdminController(),
    actor = await User.findOne({ role: "superadmin" });
  const k = randomUUID(),
    req = { user: actor, headers: { "idempotency-key": k } },
    data = {
      amount: 5000,
      category: "Hébergement",
      reason: "Facture de test du serveur",
      incurredAt: new Date().toISOString(),
    };
  await admin.expense(req, data);
  await admin.expense(req, data);
  assert.equal(await Expense.countDocuments({ key: k }), 1);
  assert.equal(
    await LedgerTransaction.countDocuments({ key: "expense:" + k }),
    1,
  );
  await assert.rejects(() => admin.expense(req, { ...data, amount: 6000 }));
  const result = await LedgerEntry.aggregate([
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  assert.equal(result[0].total, 0);
});

test("Affectation et acceptation avec précision 82 m, marge du tiers et GPS récent", async () => {
  const p = await User.create({
    phone: "+22670008590",
    name: "Test affectation",
    role: "passenger",
  });
  const d = await User.create({
    phone: "+22670008591",
    name: "Test GPS navigateur",
    role: "driver",
  });
  await Driver.create({
    userId: d._id,
    name: d.name,
    approved: true,
    online: true,
    location: geo({ longitude: -1.65, latitude: 12.4 }),
    locationAt: new Date(),
    accuracy: 82,
  });
  await Vehicle.create({
    driverId: d._id,
    brand: "Test",
    plate: "TEST-GPS-82",
    insuranceExpiresAt: new Date(Date.now() + 86400000),
    inspectionExpiresAt: new Date(Date.now() + 86400000),
  });
  for (const kind of [
    "identity",
    "license",
    "insurance",
    "registration",
    "inspection",
  ])
    await Document.create({
      driverId: d._id,
      kind,
      key: randomUUID(),
      mime: "application/pdf",
      status: "approved",
    });
  await Wallet.create({ driverId: d._id, balance: 0 });
  let meters = 1960;
  const matching = new RideService({
    async route(a, b, options) {
      assert.equal(options?.allowZero, true);
      return {
        meters,
        seconds: 0,
        geometry: {
          type: "LineString",
          coordinates: [
            [a.longitude, a.latitude],
            [b.longitude, b.latitude],
          ],
        },
      };
    },
  });
  const r = await Ride.create({
    passengerId: p._id,
    requestId: new mongoose.Types.ObjectId(),
    pickup: geo({ longitude: -1.65, latitude: 12.4 }),
    dropoff: geo({ longitude: -1.6, latitude: 12.4 }),
    distanceMeters: 6000,
    durationSeconds: 600,
    pricing: DEFAULT_PRICING,
    status: "searching",
    active: true,
  });
  try {
    await matching.dispatch(String(r._id));
    assert.equal(
      await Offer.countDocuments({ rideId: r._id }),
      0,
      "1960 + 82 dépasse le tiers de 6000",
    );
    meters = 0;
    await Driver.updateOne({ userId: d._id }, { $set: { accuracy: 101 } });
    await matching.dispatch(String(r._id));
    assert.equal(
      await Offer.countDocuments({ rideId: r._id }),
      0,
      "Précision supérieure à 100 m refusée",
    );
    await Driver.updateOne(
      { userId: d._id },
      { $set: { accuracy: 82, locationAt: new Date(Date.now() - 61000) } },
    );
    await matching.dispatch(String(r._id));
    assert.equal(
      await Offer.countDocuments({ rideId: r._id }),
      0,
      "Position périmée refusée",
    );
    await Driver.updateOne(
      { userId: d._id },
      { $set: { locationAt: new Date() } },
    );
    await matching.dispatch(String(r._id));
    assert.equal(
      await Offer.countDocuments({ rideId: r._id, status: "pending" }),
      1,
    );
    const result = await matching.accept(d, String(r._id));
    assert.equal(result.status, "accepted");
    assert.equal(String(result.driverId), String(d._id));
    assert.equal(
      (await Wallet.findOne({ driverId: d._id }))!.balance,
      0,
      "Aucun prélèvement à l’acceptation",
    );
    await Ride.updateOne({ _id: r._id }, { $set: { status: "in_progress" } });
    const finished = await Promise.all([
      matching.finish(d, String(r._id)),
      matching.finish(d, String(r._id)),
    ]);
    const commission = finished[0].fare.commission;
    assert.ok(commission > 0);
    assert.equal(
      (await Wallet.findOne({ driverId: d._id }))!.balance,
      -commission,
    );
    assert.equal(
      await LedgerTransaction.countDocuments({ key: "commission:" + r._id }),
      1,
    );
    const next = await Ride.create({
      passengerId: p._id,
      requestId: new mongoose.Types.ObjectId(),
      pickup: r.pickup,
      dropoff: r.dropoff,
      distanceMeters: 6000,
      durationSeconds: 600,
      pricing: DEFAULT_PRICING,
      status: "searching",
      active: true,
    });
    try {
      await matching.dispatch(String(next._id));
      assert.equal(
        await Offer.countDocuments({ rideId: next._id, status: "pending" }),
        1,
        "Les commissions dues ne bloquent pas une nouvelle course",
      );
      assert.equal(
        (await matching.accept(d, String(next._id))).status,
        "accepted",
      );
      assert.equal(
        (await Wallet.findOne({ driverId: d._id }))!.balance,
        -commission,
        "Pas de débit supplémentaire avant la fin",
      );
    } finally {
      await Ride.updateOne(
        { _id: next._id },
        { $set: { status: "cancelled", active: false } },
      );
    }
  } finally {
    await Ride.updateOne(
      { _id: r._id },
      { $set: { active: false, status: "cancelled" } },
    );
    await Driver.updateOne({ userId: d._id }, { $set: { online: false } });
  }
});

import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
  Header,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { z } from "zod";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { AuthService } from "./auth";
import { assistantInput, understandRequest } from "./assistant";
import { RideService } from "./rides";
import { AuthGuard, requireRole, hash, newToken, limit } from "./security";
import {
  User,
  Driver,
  Quote,
  Vehicle,
  Document,
  Wallet,
  Ride,
  Offer,
  Session,
  LedgerEntry,
  LedgerTransaction,
  Audit,
  Rating,
  Ticket,
  Pricing,
  Share,
  Payment,
  tx,
  mongoose,
} from "./db";
import {
  AdminRoles,
  Point,
  DEFAULT_PRICING,
} from "../../../packages/shared/src";
import { geo, coords } from "./routing";
import { Expense, ChatMessage, PushToken, Outbox, Notification } from "./db";
export const rides = new RideService();
const auth = new AuthService();
const id = (s: string) => {
  if (!mongoose.isValidObjectId(s))
    throw new BadRequestException("Identifiant invalide");
  return s;
};
const key = (req: any) =>
  z.string().uuid().parse(req.headers["idempotency-key"]);
function storage() {
  if (!process.env.S3_BUCKET || !process.env.AWS_ACCESS_KEY_ID)
    throw new ServiceUnavailableException("Stockage privé non configuré");
  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
  });
}
@ApiTags("Connexion")
@Controller("auth")
export class AuthController {
  @Post("otp") request(@Body() b: unknown, @Req() r: any) {
    const x = z.object({ phone: z.string() }).strict().parse(b);
    return auth.request(x.phone, r.ip);
  }
  @Post("verify") async verify(
    @Body() b: unknown,
    @Req() r: any,
    @Res({ passthrough: true }) res: any,
  ) {
    const result = await auth.verify(b, r.ip);
    res.cookie("or_session", result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 8 * 3600000,
      path: "/",
    });
    res.setHeader("Cache-Control", "no-store");
    return result;
  }
  @Post("logout") @UseGuards(AuthGuard) async logout(
    @Req() r: any,
    @Res({ passthrough: true }) res: any,
  ) {
    await Session.updateOne(
      { _id: r.session._id },
      { $set: { revokedAt: new Date() } },
    );
    res.clearCookie("or_session");
    return { ok: true };
  }
}
@ApiTags("Compte")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class AccountController {
  @Post("notifications/register") async registerPush(
    @Req() r: any,
    @Body() b: unknown,
  ) {
    const data = z
      .object({
        token: z.string().min(16).max(4096),
      })
      .strict()
      .parse(b);
    await PushToken.updateOne(
      { token: data.token },
      { $set: { userId: r.user._id, enabled: true } },
      { upsert: true },
    );
    return { ok: true };
  }
  @Get("notifications") notifications(@Req() r: any) {
    return Notification.find({ userId: r.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
  }
  @Get("me") me(@Req() r: any) {
    return {
      id: String(r.user._id),
      name: r.user.name,
      phone: r.user.phone,
      role: r.user.role,
    };
  }
  @Patch("me") async profile(@Req() r: any, @Body() b: unknown) {
    const data = z
      .object({ name: z.string().trim().min(2).max(80) })
      .strict()
      .parse(b);
    await User.updateOne({ _id: r.user._id }, { $set: data });
    return { ok: true };
  }
  @Post("me/delete-request") async deleteRequest(@Req() r: any) {
    await User.updateOne(
      { _id: r.user._id },
      { $set: { deletionRequestedAt: new Date() } },
    );
    return {
      message:
        "Demande reçue. Conservation des pièces financières selon politique applicable.",
    };
  }
  @Get("capabilities") capabilities() {
    return {
      cash: true,
      mobileMoney: false,
      sms: process.env.SMS_MODE === "twilio",
      localOtp:
        process.env.NODE_ENV !== "production" &&
        process.env.ALLOW_LOCAL_OTP === "true",
      routing: !!process.env.ROUTING_URL,
      geocoding: !!process.env.GEOCODING_URL,
      voiceTranscription: !!process.env.TRANSCRIPTION_URL,
      documents: !!process.env.AWS_ACCESS_KEY_ID,
      demandForecast: false,
      notice: "Les fonctions externes non configurées ne sont pas simulées.",
    };
  }
  @Get("wallet") async wallet(@Req() r: any) {
    requireRole(r.user, ["driver"]);
    const w = await Wallet.findOne({ driverId: r.user._id }).lean();
    const entries = await LedgerEntry.find({ account: "driver:" + r.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return { wallet: w, entries };
  }
  @Post("payments/mobile-money") mobileMoney() {
    throw new ServiceUnavailableException(
      "Orange Money et Moov Money nécessitent un contrat marchand et un adaptateur certifié. Aucun paiement initié.",
    );
  }
  @Post("voice/transcribe")
  @UseInterceptors(
    FileInterceptor("audio", {
      limits: { fileSize: 10000000, files: 1, fields: 2 },
    }),
  )
  async voice(@Req() r: any, @UploadedFile() file: any) {
    await limit("voice:" + r.user._id, 10, 600);
    if (!process.env.TRANSCRIPTION_URL)
      throw new ServiceUnavailableException(
        "Transcription vocale serveur non configurée. Utilisez la saisie ou la dictée du clavier.",
      );
    if (
      !file ||
      ![
        "audio/mp4",
        "audio/m4a",
        "audio/x-m4a",
        "audio/mpeg",
        "audio/wav",
        "audio/webm",
        "video/webm",
      ].includes(file.mimetype)
    )
      throw new BadRequestException("Format audio non accepté");
    const form = new FormData();
    form.append(
      "audio",
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      "voice",
    );
    form.append("language", "fr");
    try {
      const response = await fetch(process.env.TRANSCRIPTION_URL, {
        method: "POST",
        headers: process.env.TRANSCRIPTION_API_KEY
          ? { Authorization: "Bearer " + process.env.TRANSCRIPTION_API_KEY }
          : {},
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw Error();
      const output = z
        .object({ text: z.string().trim().min(1).max(3000) })
        .parse(await response.json());
      return {
        text: output.text,
        requiresConfirmation: true,
        notice: "Vérifiez les lieux et le prix avant de réserver.",
      };
    } catch {
      throw new ServiceUnavailableException(
        "Transcription indisponible. Saisissez votre trajet.",
      );
    }
  }
  @Get("places") async places(@Query("q") query: string) {
    const text = z.string().trim().min(3).max(100).parse(query);
    if (!process.env.GEOCODING_URL)
      throw new ServiceUnavailableException(
        "Recherche d’adresses indisponible. Utilisez la carte et un repère.",
      );
    const url = new URL(process.env.GEOCODING_URL);
    url.searchParams.set("q", text);
    url.searchParams.set("limit", "6");
    url.searchParams.set("lat", "12.371");
    url.searchParams.set("lon", "-1.519");
    url.searchParams.set("bbox", "-1.8,12.1,-1.2,12.7");
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new ServiceUnavailableException();
    return response.json();
  }
  @Post("support") async support(@Req() r: any, @Body() b: unknown) {
    const data = z
      .object({
        rideId: z.string().optional(),
        kind: z.enum(["lost_item", "price", "incident", "other"]),
        message: z.string().trim().min(5).max(3000),
      })
      .strict()
      .parse(b);
    if (data.rideId) await rides.get(r.user, data.rideId);
    return Ticket.create({ ...data, userId: r.user._id });
  }
  @Get("support") tickets(@Req() r: any) {
    return Ticket.find({ userId: r.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
  }
  @Post("assistant/explain") async explain(@Req() r: any, @Body() b: unknown) {
    const data = z.object({ rideId: z.string() }).strict().parse(b);
    const ride = await rides.get(r.user, data.rideId);
    return {
      source: "deterministic_receipt",
      message: `La course prévoit ${ride.distanceMeters / 1000} km. L’immobilisation validée est de ${ride.stationarySeconds} secondes. Le total est ${ride.fare.total} FCFA, dont ${ride.fare.commission} FCFA de commission. Votre reçu est calculé selon la version ${ride.pricing.version}.`,
      rideId: data.rideId,
    };
  }
  @Post("assistant/intent") async assistant(@Req() r: any, @Body() b: unknown) {
    requireRole(r.user, ["passenger", "driver"]);
    const input = assistantInput.parse(b);
    await limit("assistant:" + r.user._id, 15, 60);
    return understandRequest(input);
  }
}
@ApiTags("Courses")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("rides")
export class RideController {
  @Get(":id/navigation") async navigation(
    @Req() r: any,
    @Param("id") rideId: string,
  ) {
    requireRole(r.user, ["passenger", "driver"]);
    await rides.get(r.user, rideId);
    const ride = await Ride.findById(rideId);
    if (!ride) throw new NotFoundException();
    const approaching = ["accepted", "arrived"].includes(ride.status);
    if (ride.active && ride.driverId) {
      const driver = await Driver.findOne({
        userId: ride.driverId,
        locationAt: { $gt: new Date(Date.now() - 60000) },
        accuracy: { $lte: 100 },
      });
      if (driver?.location?.coordinates?.length === 2) {
        const route = await rides.router.route(
          coords(driver.location),
          coords(approaching ? ride.pickup : ride.dropoff),
          { allowZero: approaching },
        );
        return {
          phase: approaching ? "approach" : "trip",
          geometry: route.geometry,
          distanceMeters: route.meters,
          durationSeconds: route.seconds,
          computedAt: new Date(),
          trafficAware: false,
        };
      }
      if (approaching)
        throw new ServiceUnavailableException(
          "Position récente du chauffeur indisponible",
        );
    }
    const quote = await Quote.findById(ride.requestId);
    if (!quote?.geometry)
      throw new ServiceUnavailableException("Itinéraire indisponible");
    return {
      phase: "trip",
      geometry: quote.geometry,
      distanceMeters: ride.distanceMeters,
      durationSeconds: ride.durationSeconds,
      computedAt: quote.createdAt,
      trafficAware: false,
    };
  }
  @Get(":id/messages") async messages(
    @Req() r: any,
    @Param("id") rideId: string,
  ) {
    const ride = await rides.get(r.user, rideId);
    if (
      ![String(ride.passengerId), String(ride.driverId)].includes(
        String(r.user._id),
      )
    )
      throw new ForbiddenException();
    return ChatMessage.find({ rideId }).sort({ createdAt: -1 }).limit(100);
  }
  @Post(":id/messages") async message(
    @Req() r: any,
    @Param("id") rideId: string,
    @Body() b: unknown,
  ) {
    const data = z
      .object({
        text: z.string().trim().min(1).max(1000),
        clientId: z.string().uuid(),
      })
      .strict()
      .parse(b);
    const ride = await rides.get(r.user, rideId);
    if (
      !ride.active ||
      !ride.driverId ||
      ![String(ride.passengerId), String(ride.driverId)].includes(
        String(r.user._id),
      )
    )
      throw new ForbiddenException(
        "Messagerie réservée aux participants pendant la course",
      );
    await tx(async (s) => {
      const existing = await ChatMessage.findOne({
        rideId,
        senderId: r.user._id,
        clientId: data.clientId,
      }).session(s);
      if (existing) {
        if (existing.text !== data.text)
          throw new ConflictException("Clé de message déjà utilisée");
        return;
      }
      await ChatMessage.create([{ rideId, senderId: r.user._id, ...data }], {
        session: s,
      });
      await Outbox.create(
        [
          {
            kind: "ride.message",
            rideId,
            userIds: [String(ride.passengerId), String(ride.driverId)],
            payload: { rideId, type: "new_message" },
          },
        ],
        { session: s },
      );
    });
    return { ok: true };
  }
  @Post("quotes") quote(@Req() r: any, @Body() b: unknown) {
    requireRole(r.user, ["passenger"]);
    return rides.quote(r.user, b);
  }
  @Post() create(@Req() r: any, @Body() b: unknown) {
    requireRole(r.user, ["passenger"]);
    const data = z.object({ quoteId: z.string() }).strict().parse(b);
    return rides.create(r.user, data.quoteId, key(r));
  }
  @Get("active") active(@Req() r: any) {
    requireRole(r.user, ["passenger", "driver"]);
    return rides.active(r.user);
  }
  @Get("history") history(@Req() r: any) {
    requireRole(r.user, ["passenger", "driver"]);
    return rides.history(r.user);
  }
  @Get(":id") get(@Req() r: any, @Param("id") rideId: string) {
    return rides.get(r.user, rideId);
  }
  @Post(":id/accept") accept(@Req() r: any, @Param("id") rideId: string) {
    requireRole(r.user, ["driver"]);
    return rides.accept(r.user, rideId);
  }
  @Post(":id/decline") async decline(
    @Req() r: any,
    @Param("id") rideId: string,
  ) {
    requireRole(r.user, ["driver"]);
    await Offer.updateOne(
      { rideId: id(rideId), driverId: r.user._id, status: "pending" },
      { $set: { status: "declined" } },
    );
    return { ok: true };
  }
  @Post(":id/actions") action(
    @Req() r: any,
    @Param("id") rideId: string,
    @Body() b: unknown,
  ) {
    const data = z
      .object({
        action: z.enum(["arrive", "start", "finish", "cancel"]),
        code: z
          .string()
          .regex(/^\d{4}$/)
          .optional(),
      })
      .strict()
      .parse(b);
    return rides.transition(r.user, rideId, data.action, data.code);
  }
  @Post(":id/cash-received") cash(@Req() r: any, @Param("id") rideId: string) {
    requireRole(r.user, ["driver"]);
    return rides.cash(r.user, rideId);
  }
  @Post(":id/gps") gps(
    @Req() r: any,
    @Param("id") rideId: string,
    @Body() b: unknown,
  ) {
    requireRole(r.user, ["driver"]);
    const data = Point.extend({
      eventId: z.string().uuid(),
      at: z.iso.datetime(),
      accuracy: z.number().min(0).max(1000),
      speed: z.number().min(0).max(80),
    })
      .strict()
      .parse(b);
    return rides.gps(r.user, rideId, data);
  }
  @Post(":id/rating") async rating(
    @Req() r: any,
    @Param("id") rideId: string,
    @Body() b: unknown,
  ) {
    requireRole(r.user, ["passenger"]);
    const data = z
      .object({
        score: z.number().int().min(1).max(5),
        comment: z.string().max(1000).default(""),
      })
      .strict()
      .parse(b);
    const ride = await rides.get(r.user, rideId);
    if (
      ride.status !== "completed" ||
      String(ride.passengerId) !== String(r.user._id)
    )
      throw new ForbiddenException();
    return Rating.findOneAndUpdate(
      { rideId },
      {
        $setOnInsert: {
          ...data,
          passengerId: r.user._id,
          driverId: ride.driverId,
        },
      },
      { upsert: true, returnDocument: "after" },
    );
  }
  @Post(":id/share") async share(@Req() r: any, @Param("id") rideId: string) {
    requireRole(r.user, ["passenger"]);
    const ride = await rides.get(r.user, rideId);
    if (!ride.active || String(ride.passengerId) !== String(r.user._id))
      throw new ForbiddenException();
    const token = newToken();
    await Share.create({
      rideId,
      passengerId: r.user._id,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + 2 * 3600000),
    });
    return { token, expiresIn: 7200 };
  }
  @Post(":id/share/revoke") async revoke(
    @Req() r: any,
    @Param("id") rideId: string,
  ) {
    await Share.updateMany(
      { rideId: id(rideId), passengerId: r.user._id },
      { $set: { revokedAt: new Date() } },
    );
    return { ok: true };
  }
}
@Controller("shared")
export class ShareController {
  @Get(":token") @Header("Cache-Control", "no-store") async shared(
    @Param("token") token: string,
    @Req() req: any,
  ) {
    await limit("share:" + hash(req.ip), 60, 60);
    const share = await Share.findOne({
      tokenHash: hash(token),
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    });
    if (!share) throw new NotFoundException();
    const ride = await Ride.findOne({ _id: share.rideId, active: true });
    if (!ride) throw new NotFoundException();
    const driver = await Driver.findOne({ userId: ride.driverId });
    return {
      status: ride.status,
      location: driver?.location,
      locationAt: driver?.locationAt,
    };
  }
}
@ApiTags("Chauffeurs")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("driver")
export class DriverController {
  @Get("profile") async profile(@Req() r: any) {
    requireRole(r.user, ["driver"]);
    const profile = await Driver.findOne({ userId: r.user._id });
    const availability = !profile?.approved
      ? "not_approved"
      : !profile.online
        ? "offline"
        : !profile.locationAt
          ? "gps_missing"
          : Date.now() - new Date(profile.locationAt).getTime() >= 60000
            ? "gps_stale"
            : !Number.isFinite(profile.accuracy) || profile.accuracy > 100
              ? "gps_inaccurate"
              : "ready";
    return {
      profile,
      availability,
      vehicle: await Vehicle.findOne({ driverId: r.user._id }),
      documents: await Document.find({ driverId: r.user._id }).select("-key"),
    };
  }
  @Post("vehicle") async vehicle(@Req() r: any, @Body() b: unknown) {
    requireRole(r.user, ["driver"]);
    const data = z
      .object({
        brand: z.string().min(2).max(80),
        plate: z.string().min(3).max(30),
        insuranceExpiresAt: z.iso.datetime(),
        inspectionExpiresAt: z.iso.datetime(),
      })
      .strict()
      .parse(b);
    await tx(async (s) => {
      await Vehicle.updateOne(
        { driverId: r.user._id },
        { $set: data },
        { upsert: true, session: s },
      );
      await Driver.updateOne(
        { userId: r.user._id },
        { $set: { approved: false, online: false } },
        { session: s },
      );
    });
    return {
      ok: true,
      notice: "Nouvelle validation administrative nécessaire",
    };
  }
  @Post("online") async online(@Req() r: any, @Body() b: unknown) {
    requireRole(r.user, ["driver"]);
    const data = z.object({ online: z.boolean() }).strict().parse(b);
    if (data.online && !(await rides.driverValid(r.user._id)))
      throw new ForbiddenException("Documents ou véhicule non valides");
    const d = await Driver.findOneAndUpdate(
      { userId: r.user._id, ...(data.online ? { approved: true } : {}) },
      { $set: data },
      { returnDocument: "after" },
    );
    if (!d) throw new ForbiddenException("Validation administrative requise");
    return d;
  }
  @Post("location") async location(@Req() r: any, @Body() b: unknown) {
    requireRole(r.user, ["driver"]);
    const data = Point.extend({
      accuracy: z.number().min(0).max(1000),
      at: z.iso.datetime(),
    })
      .strict()
      .parse(b);
    const age = Date.now() - new Date(data.at).getTime();
    if (age < -5000 || age > 30000)
      throw new BadRequestException("Position périmée");
    await Driver.updateOne(
      {
        userId: r.user._id,
        $or: [
          { locationAt: { $lt: new Date(data.at) } },
          { locationAt: { $exists: false } },
        ],
      },
      {
        $set: {
          location: geo(data),
          locationAt: new Date(data.at),
          accuracy: data.accuracy,
        },
      },
    );
    return { ok: true };
  }
  @Get("offers") offers(@Req() r: any) {
    requireRole(r.user, ["driver"]);
    return rides.offers(r.user);
  }
  @Post("documents/upload-url") async upload(
    @Req() r: any,
    @Body() b: unknown,
  ) {
    requireRole(r.user, ["driver"]);
    const data = z
      .object({
        kind: z.enum([
          "identity",
          "license",
          "insurance",
          "registration",
          "inspection",
        ]),
        mime: z.enum(["image/jpeg", "image/png", "application/pdf"]),
        expiresAt: z.iso.datetime().optional(),
      })
      .strict()
      .parse(b);
    const client = storage(),
      key = `drivers/${r.user._id}/${randomUUID()}`;
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        ContentType: data.mime,
      }),
      { expiresIn: 300 },
    );
    const document = await Document.create({
      driverId: r.user._id,
      ...data,
      key,
      status: "pending",
    });
    return {
      documentId: String(document._id),
      url,
      expiresIn: 300,
      maxBytes: 10000000,
    };
  }
}
@ApiTags("Administration")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("admin")
export class AdminController {
  @Get("summary") async summary(@Req() r: any) {
    requireRole(r.user, AdminRoles);
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const [drivers, active, completed, commission, volume] = await Promise.all([
      Driver.countDocuments({ approved: true }),
      Ride.countDocuments({ active: true }),
      Ride.countDocuments({
        status: "completed",
        completedAt: { $gte: start },
      }),
      LedgerEntry.aggregate([
        {
          $match: {
            account: "platform:commissions",
            createdAt: { $gte: start },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Ride.aggregate([
        { $match: { status: "completed", completedAt: { $gte: start } } },
        { $group: { _id: null, total: { $sum: "$fare.total" } } },
      ]),
    ]);
    const expenses = await Expense.aggregate([
      { $match: { incurredAt: { $gte: start } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    return {
      drivers,
      pricing: await rides.pricing(),
      active,
      completed,
      commission: commission[0]?.total || 0,
      volume: volume[0]?.total || 0,
      profit: null,
      recordedExpenses: expenses[0]?.total || 0,
      resultAfterRecordedExpenses:
        (commission[0]?.total || 0) - (expenses[0]?.total || 0),
      notice:
        "Commissions avant frais ; aucune prévision IA sans données évaluées.",
    };
  }
  @Get("rides") async list(@Req() r: any, @Query("page") page = "1") {
    requireRole(r.user, AdminRoles);
    const p = z.coerce.number().int().min(1).max(10000).parse(page);
    return Ride.find()
      .select(
        r.user.role === "finance"
          ? "_id driverId pickupLabel dropoffLabel status distanceMeters stationarySeconds pricing fare createdAt completedAt"
          : "-pickupDigest -pickupCodeCipher -lastGps",
      )
      .sort({ createdAt: -1 })
      .skip((p - 1) * 30)
      .limit(30);
  }
  @Get("drivers") async drivers(@Req() r: any) {
    requireRole(r.user, ["superadmin", "operations"]);
    const drivers = await Driver.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return Promise.all(
      drivers.map(async (d) => ({
        ...d,
        accountSuspended: (await User.findById(d.userId))?.suspended || false,
        vehicle: await Vehicle.findOne({ driverId: d.userId }),
        documents: await Document.find({ driverId: d.userId }).select("-key"),
      })),
    );
  }
  @Post("documents/:id/review") async document(
    @Req() r: any,
    @Param("id") docId: string,
    @Body() b: unknown,
  ) {
    requireRole(r.user, ["superadmin", "operations"]);
    const data = z
      .object({
        status: z.enum(["approved", "rejected"]),
        reason: z.string().min(3).max(1000),
      })
      .strict()
      .parse(b);
    const doc = await Document.findById(id(docId));
    if (!doc) throw new NotFoundException();
    if (data.status === "approved") {
      const meta = await storage().send(
        new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: doc.key }),
      );
      if (
        !meta.ContentLength ||
        meta.ContentLength > 10000000 ||
        meta.ContentType !== doc.mime
      )
        throw new BadRequestException("Fichier absent ou non conforme");
      const content = await storage().send(
        new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: doc.key }),
      );
      const bytes = Buffer.from(await content.Body!.transformToByteArray());
      const signature =
        doc.mime === "application/pdf"
          ? bytes.subarray(0, 5).toString() === "%PDF-"
          : doc.mime === "image/png"
            ? bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!signature)
        throw new BadRequestException(
          "Le contenu ne correspond pas au format déclaré",
        );
      if (bytes.length > 10000000)
        throw new BadRequestException("Fichier trop volumineux");
      if (process.env.DOCUMENT_SCAN_URL) {
        try {
          const scan = await fetch(process.env.DOCUMENT_SCAN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              ...(process.env.DOCUMENT_SCAN_KEY
                ? { Authorization: "Bearer " + process.env.DOCUMENT_SCAN_KEY }
                : {}),
            },
            body: new Uint8Array(bytes),
            signal: AbortSignal.timeout(30000),
          });
          const result = z
            .object({ clean: z.boolean() })
            .parse(await scan.json());
          if (!scan.ok || !result.clean) throw Error();
        } catch {
          throw new BadRequestException(
            "Document non validé par le service de contrôle",
          );
        }
      } else if (process.env.NODE_ENV === "production")
        throw new ServiceUnavailableException(
          "Service de contrôle documentaire requis",
        );
      // Freeze reviewed content at a new key inaccessible to the upload URL.
      const reviewedKey = `reviewed/${doc.driverId}/${randomUUID()}`;
      await storage().send(
        new CopyObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: reviewedKey,
          CopySource: `${process.env.S3_BUCKET}/${doc.key}`,
          CopySourceIfMatch: content.ETag,
          ContentType: doc.mime,
          MetadataDirective: "REPLACE",
        }),
      );
      doc.key = reviewedKey;
      doc.contentHash = hash(bytes.toString("base64"));
    }
    await tx(async (s) => {
      await Document.updateOne(
        { _id: doc._id },
        { $set: { ...data, key: doc.key, contentHash: doc.contentHash } },
        { session: s },
      );
      await Driver.updateOne(
        { userId: doc.driverId },
        { $set: { approved: false, online: false } },
        { session: s },
      );
      await Audit.create(
        [
          {
            actorId: r.user._id,
            action: "document.review",
            target: docId,
            reason: data.reason,
          },
        ],
        { session: s },
      );
    });
    return { ok: true };
  }
  @Get("documents/:id/view") async viewDocument(
    @Req() r: any,
    @Param("id") docId: string,
  ) {
    requireRole(r.user, ["superadmin", "operations"]);
    const doc = await Document.findById(id(docId));
    if (!doc) throw new NotFoundException();
    await Audit.create({
      actorId: r.user._id,
      action: "document.view",
      target: docId,
    });
    return {
      url: await getSignedUrl(
        storage(),
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: doc.key,
          ResponseContentDisposition: "attachment",
        }),
        { expiresIn: 120 },
      ),
    };
  }
  @Post("drivers/:id/review") async review(
    @Req() r: any,
    @Param("id") driverId: string,
    @Body() b: unknown,
  ) {
    requireRole(r.user, ["superadmin", "operations"]);
    const data = z
      .object({ approved: z.boolean(), reason: z.string().min(3).max(1000) })
      .strict()
      .parse(b);
    id(driverId);
    if (data.approved && !(await rides.driverValid(driverId)))
      throw new BadRequestException(
        "Vérifiez les cinq justificatifs et le véhicule",
      );
    await tx(async (s) => {
      const d = await Driver.findOneAndUpdate(
        { userId: driverId },
        {
          $set: {
            approved: data.approved,
            online: false,
            documentsApprovedAt: new Date(),
          },
        },
        { session: s, returnDocument: "after" },
      );
      if (!d) throw new NotFoundException();
      await Audit.create(
        [
          {
            actorId: r.user._id,
            action: "driver.review",
            target: driverId,
            reason: data.reason,
            data: { approved: data.approved },
          },
        ],
        { session: s },
      );
    });
    return { ok: true };
  }
  @Post("wallets/:id/adjust") adjust(
    @Req() r: any,
    @Param("id") driverId: string,
    @Body() b: unknown,
  ) {
    requireRole(r.user, ["superadmin", "finance"]);
    const data = z
      .object({
        amount: z.number().int().min(1).max(1000000),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(b);
    return rides.credit(r.user, driverId, data.amount, key(r), data.reason);
  }
  @Get("ledger") ledger(@Req() r: any) {
    requireRole(r.user, ["superadmin", "finance"]);
    return LedgerTransaction.find().sort({ createdAt: -1 }).limit(100);
  }
  @Get("support") tickets(@Req() r: any) {
    requireRole(r.user, ["superadmin", "support"]);
    return Ticket.find().sort({ createdAt: -1 }).limit(100);
  }
  @Patch("support/:id") async reply(
    @Req() r: any,
    @Param("id") ticketId: string,
    @Body() b: unknown,
  ) {
    requireRole(r.user, ["superadmin", "support"]);
    const data = z
      .object({
        reply: z.string().min(2).max(3000),
        status: z.enum(["open", "resolved"]),
      })
      .strict()
      .parse(b);
    await tx(async (s) => {
      if (
        !(await Ticket.findByIdAndUpdate(
          id(ticketId),
          { $set: data },
          { session: s },
        ))
      )
        throw new NotFoundException();
      await Audit.create(
        [{ actorId: r.user._id, action: "support.reply", target: ticketId }],
        { session: s },
      );
    });
    return { ok: true };
  }
  @Get("pricing") pricing(@Req() r: any) {
    requireRole(r.user, AdminRoles);
    return rides.pricing();
  }
  @Get("audit") audit(@Req() r: any) {
    requireRole(r.user, ["superadmin"]);
    return Audit.find().sort({ createdAt: -1 }).limit(100);
  }
  @Post("pricing") async updatePricing(@Req() r: any, @Body() b: unknown) {
    requireRole(r.user, ["superadmin"]);
    const data = z
      .object({
        version: z.string().regex(/^[a-z0-9-]{3,60}$/),
        perKm: z.number().int().min(1).max(10000),
        perMinute: z.number().int().min(0).max(1000),
        commissionBps: z.number().int().min(0).max(5000),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(b);
    await tx(async (s) => {
      if (await Pricing.exists({ version: data.version }).session(s))
        throw new ConflictException("Version déjà utilisée");
      await Pricing.updateMany(
        { active: true },
        { $set: { active: false } },
        { session: s },
      );
      const { reason, ...pricing } = data;
      await Pricing.create([{ ...pricing, fuelPerKm: 100, active: true }], {
        session: s,
      });
      await Audit.create(
        [
          {
            actorId: r.user._id,
            action: "pricing.version.created",
            target: data.version,
            reason,
            data: pricing,
          },
        ],
        { session: s },
      );
    });
    return rides.pricing();
  }
  @Post("users/:id/suspension") async suspend(
    @Req() r: any,
    @Param("id") userId: string,
    @Body() b: unknown,
  ) {
    requireRole(r.user, ["superadmin", "operations"]);
    const data = z
      .object({ suspended: z.boolean(), reason: z.string().min(10).max(1000) })
      .strict()
      .parse(b);
    await tx(async (s) => {
      const u = await User.findById(id(userId)).session(s);
      if (!u || !["driver", "passenger"].includes(u.role))
        throw new ForbiddenException("Compte non modifiable");
      if (r.user.role === "operations" && u.role !== "driver")
        throw new ForbiddenException();
      await User.updateOne(
        { _id: userId },
        { $set: { suspended: data.suspended } },
        { session: s },
      );
      if (data.suspended) {
        await Driver.updateOne(
          { userId },
          { $set: { online: false } },
          { session: s },
        );
        await Session.updateMany(
          { userId, revokedAt: { $exists: false } },
          { $set: { revokedAt: new Date() } },
          { session: s },
        );
      }
      await Audit.create(
        [
          {
            actorId: r.user._id,
            action: "user.suspension",
            target: userId,
            reason: data.reason,
            data: { suspended: data.suspended },
          },
        ],
        { session: s },
      );
    });
    return {
      ok: true,
      notice:
        "Le motif est journalisé. Les contestations peuvent être traitées par le support.",
    };
  }
  @Get("expenses") expenses(@Req() r: any) {
    requireRole(r.user, ["superadmin", "finance"]);
    return Expense.find().sort({ incurredAt: -1 }).limit(100);
  }
  @Post("expenses") async expense(@Req() r: any, @Body() b: unknown) {
    requireRole(r.user, ["superadmin", "finance"]);
    const data = z
      .object({
        amount: z.number().int().min(1).max(100000000),
        category: z.string().trim().min(2).max(80),
        reason: z.string().trim().min(5).max(1000),
        incurredAt: z.iso.datetime(),
      })
      .strict()
      .parse(b);
    const k = key(r);
    await tx(async (s) => {
      const previous = await Expense.findOne({ key: k }).session(s);
      if (previous) {
        if (
          previous.amount !== data.amount ||
          previous.category !== data.category ||
          previous.reason !== data.reason ||
          String(previous.actorId) !== String(r.user._id) ||
          previous.incurredAt.getTime() !== new Date(data.incurredAt).getTime()
        )
          throw new ConflictException("Clé déjà utilisée");
        return;
      }
      const [e] = await Expense.create(
        [{ ...data, key: k, actorId: r.user._id }],
        { session: s },
      );
      const [transaction] = await LedgerTransaction.create(
        [
          {
            key: "expense:" + k,
            actorId: r.user._id,
            kind: "recorded_operating_expense",
            amount: data.amount,
            reason: data.reason,
          },
        ],
        { session: s },
      );
      await LedgerEntry.create(
        [
          {
            transactionId: transaction._id,
            account: "platform:operating_expenses",
            amount: data.amount,
          },
          {
            transactionId: transaction._id,
            account: "platform:expense_record_clearing",
            amount: -data.amount,
          },
        ],
        { session: s, ordered: true },
      );
      await Audit.create(
        [
          {
            actorId: r.user._id,
            action: "expense.recorded",
            target: String(e._id),
            reason: data.reason,
          },
        ],
        { session: s },
      );
    });
    return { ok: true };
  }
  @Get("export/ledger") async exportLedger(@Req() r: any, @Res() res: any) {
    requireRole(r.user, ["superadmin", "finance"]);
    const entries = await LedgerTransaction.find()
      .sort({ createdAt: -1 })
      .limit(10000)
      .lean();
    const csv = (s: any) =>
      '"' +
      String(s ?? "")
        .replace(/^[=+@-]/, "'")
        .replace(/"/g, '""') +
      '"';
    await Audit.create({
      actorId: r.user._id,
      action: "ledger.export",
      target: "last-10000",
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="ouagaride-registre.csv"',
    );
    res.send(
      "\uFEFF" +
        [
          "date;reference;type;montant_fcfa",
          ...entries.map((e) =>
            [e.createdAt.toISOString(), e.key, e.kind, e.amount]
              .map(csv)
              .join(";"),
          ),
        ].join("\r\n"),
    );
  }
}

import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { authenticate, token } from "./security";
import {
  Outbox,
  Session,
  User,
  Ride,
  Offer,
  Notification,
  PushToken,
} from "./db";
import { RideService } from "./rides";
@WebSocketGateway({
  cors: {
    origin: (origin: string, callback: any) =>
      callback(
        null,
        !origin ||
          (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
            .split(",")
            .includes(origin),
      ),
    credentials: true,
  },
})
export class RealtimeGateway {
  @WebSocketServer() server!: Server;
  async handleConnection(client: Socket) {
    try {
      const a = await authenticate(
        client.handshake.auth?.token ||
          token({ headers: client.handshake.headers }),
      );
      client.data.sessionId = String(a.session._id);
      client.data.userId = String(a.user._id);
      await client.join("user:" + a.user._id);
    } catch {
      client.disconnect(true);
    }
  }
  async flush() {
    if (!this.server) return;
    for (const socket of this.server.sockets.sockets.values()) {
      const [session, user] = await Promise.all([
        Session.exists({
          _id: socket.data.sessionId,
          revokedAt: { $exists: false },
          expiresAt: { $gt: new Date() },
        }),
        User.exists({ _id: socket.data.userId, suspended: false }),
      ]);
      if (!session || !user) socket.disconnect(true);
    }
    const events = await Outbox.find({ publishedAt: { $exists: false } })
      .sort({ createdAt: 1 })
      .limit(100);
    for (const e of events) {
      for (const uid of e.userIds) {
        this.server
          .to("user:" + uid)
          .emit("ride.updated", { eventId: String(e._id), ...e.payload });
        const notification = await Notification.findOneAndUpdate(
          { userId: uid, eventId: String(e._id) },
          { $setOnInsert: { type: e.kind, payload: e.payload } },
          { upsert: true, returnDocument: "after" },
        );
        if (
          !!process.env.PUSH_RELAY_URL &&
          !notification.pushSentAt &&
          [
            "ride.offer",
            "ride.accepted",
            "ride.message",
            "ride.completed",
            "ride.no_driver",
          ].includes(e.kind)
        ) {
          const targets = await PushToken.find({
            userId: uid,
            enabled: true,
          }).limit(5);
          if (targets.length) {
            const response = await fetch(process.env.PUSH_RELAY_URL!, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(process.env.PUSH_RELAY_KEY
                  ? {
                      Authorization: "Bearer " + process.env.PUSH_RELAY_KEY,
                    }
                  : {}),
              },
              body: JSON.stringify(
                targets.map((t) => ({
                  to: t.token,
                  title: "SAPSAP",
                  body:
                    e.kind === "ride.offer"
                      ? "Une nouvelle proposition de course vous attend."
                      : "Votre course a été actualisée.",
                  data: { eventId: String(e._id), ...e.payload },
                  sound: "default",
                })),
              ),
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) throw Error("Push delivery retry");
            const result = (await response.json()) as any;
            if (!Array.isArray(result.data))
              throw Error("Push response invalid");
            for (let i = 0; i < result.data.length; i++)
              if (result.data[i]?.details?.error === "DeviceNotRegistered")
                await PushToken.updateOne(
                  { _id: targets[i]?._id },
                  { $set: { enabled: false } },
                );
            await Notification.updateOne(
              { _id: notification._id },
              { $set: { pushSentAt: new Date(), pushTickets: result.data } },
            );
          }
        }
      }
      await Outbox.updateOne(
        { _id: e._id },
        { $set: { publishedAt: new Date() }, $inc: { attempts: 1 } },
      );
    }
  }
}
export async function maintenance(rides: RideService) {
  await Offer.updateMany(
    { status: "pending", expiresAt: { $lte: new Date() } },
    { $set: { status: "expired" } },
  );
  const searches = await Ride.find({
    status: "searching",
    createdAt: { $gt: new Date(Date.now() - 120000) },
  }).limit(30);
  for (const r of searches) await rides.dispatch(String(r._id));
  const old = await Ride.find({
    status: "searching",
    createdAt: { $lte: new Date(Date.now() - 120000) },
  }).limit(100);
  for (const r of old) {
    await Ride.updateOne(
      { _id: r._id, status: "searching" },
      { $set: { status: "no_driver", active: false } },
    );
    await Outbox.create({
      kind: "ride.no_driver",
      rideId: r._id,
      userIds: [String(r.passengerId)],
      payload: { rideId: String(r._id), status: "no_driver" },
    });
  }
}

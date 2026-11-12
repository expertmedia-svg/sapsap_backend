import mongoose, { Schema, Model } from "mongoose";
const point = {
  type: { type: String, enum: ["Point"], required: true },
  coordinates: { type: [Number], required: true },
};
const model = (
  name: string,
  definition: Record<string, any>,
  indexes: [Record<string, any>, Record<string, any>][] = [],
): Model<any> => {
  const schema = new Schema(definition, {
    timestamps: true,
    strict: "throw",
    versionKey: "revision",
  });
  for (const [fields, options] of indexes) schema.index(fields, options);
  return mongoose.models[name] || mongoose.model(name, schema, name);
};
const str = (required = true) => ({ type: String, required });
export const User = model("users", {
  phone: { type: String, unique: true, required: true },
  name: str(),
  role: {
    type: String,
    enum: [
      "passenger",
      "driver",
      "superadmin",
      "operations",
      "support",
      "finance",
    ],
    required: true,
  },
  suspended: { type: Boolean, default: false },
  mfaSecret: { type: String, select: false },
  deletionRequestedAt: Date,
});
export const Session = model(
  "sessions",
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, unique: true, required: true },
    expiresAt: Date,
    revokedAt: Date,
  },
  [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
);
export const Otp = model(
  "otpChallenges",
  {
    phone: { type: String, unique: true },
    digest: String,
    attempts: Number,
    expiresAt: Date,
    lastSentAt: Date,
  },
  [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
);
export const Driver = model(
  "driverProfiles",
  {
    userId: { type: Schema.Types.ObjectId, unique: true },
    name: String,
    approved: { type: Boolean, default: false },
    online: { type: Boolean, default: false },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: [Number],
    },
    locationAt: Date,
    accuracy: Number,
    documentsApprovedAt: Date,
  },
  [[{ location: "2dsphere" }, {}]],
);
export const Vehicle = model("vehicles", {
  driverId: { type: Schema.Types.ObjectId, unique: true },
  brand: String,
  plate: { type: String, unique: true },
  insuranceExpiresAt: Date,
  inspectionExpiresAt: Date,
});
export const Document = model("driverDocuments", {
  driverId: Schema.Types.ObjectId,
  kind: {
    type: String,
    enum: ["identity", "license", "insurance", "registration", "inspection"],
  },
  key: { type: String, unique: true },
  mime: String,
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  expiresAt: Date,
  reason: String,
  contentHash: String,
});
export const Pricing = model(
  "pricingVersions",
  {
    version: { type: String, unique: true },
    perKm: Number,
    perMinute: Number,
    commissionBps: Number,
    fuelPerKm: Number,
    active: Boolean,
  },
  [
    [
      { active: 1 },
      { unique: true, partialFilterExpression: { active: true } },
    ],
  ],
);
export const Quote = model("rideRequests", {
  passengerId: Schema.Types.ObjectId,
  pickup: point,
  dropoff: point,
  pickupLabel: String,
  dropoffLabel: String,
  landmark: String,
  distanceMeters: Number,
  durationSeconds: Number,
  geometry: Schema.Types.Mixed,
  pricing: Schema.Types.Mixed,
  expiresAt: Date,
  consumed: { type: Boolean, default: false },
});
export const Ride = model(
  "rides",
  {
    passengerId: Schema.Types.ObjectId,
    driverId: Schema.Types.ObjectId,
    requestId: { type: Schema.Types.ObjectId, unique: true },
    pickup: point,
    dropoff: point,
    pickupLabel: String,
    dropoffLabel: String,
    landmark: String,
    distanceMeters: Number,
    durationSeconds: Number,
    pricing: Schema.Types.Mixed,
    status: {
      type: String,
      enum: [
        "searching",
        "accepted",
        "arrived",
        "in_progress",
        "completed",
        "cancelled",
        "no_driver",
      ],
    },
    active: { type: Boolean, default: true },
    stationarySeconds: { type: Number, default: 0 },
    pickupDigest: String,
    pickupCodeCipher: String,
    pickupAttempts: { type: Number, default: 0 },
    startedAt: Date,
    completedAt: Date,
    lastGps: Schema.Types.Mixed,
    stationaryConfirmed: { type: Boolean, default: false },
    fare: Schema.Types.Mixed,
    cashReceivedAt: Date,
  },
  [
    [
      { passengerId: 1 },
      { unique: true, partialFilterExpression: { active: true } },
    ],
    [
      { driverId: 1 },
      {
        unique: true,
        partialFilterExpression: {
          active: true,
          driverId: { $type: "objectId" },
        },
      },
    ],
    [{ status: 1, createdAt: -1 }, {}],
  ],
);
export const Offer = model(
  "rideOffers",
  {
    rideId: Schema.Types.ObjectId,
    driverId: Schema.Types.ObjectId,
    pickupMeters: Number,
    expiresAt: Date,
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "expired"],
      default: "pending",
    },
  },
  [
    [{ rideId: 1, driverId: 1 }, { unique: true }],
    [{ driverId: 1, status: 1, expiresAt: 1 }, {}],
  ],
);
export const RideEvent = model(
  "rideEvents",
  {
    rideId: Schema.Types.ObjectId,
    actorId: Schema.Types.ObjectId,
    type: String,
    data: Schema.Types.Mixed,
  },
  [[{ rideId: 1, createdAt: 1 }, {}]],
);
export const Gps = model(
  "gpsObservations",
  {
    rideId: Schema.Types.ObjectId,
    driverId: Schema.Types.ObjectId,
    eventId: String,
    at: Date,
    point: point,
    accuracy: Number,
    speed: Number,
    accepted: Boolean,
    reason: String,
  },
  [
    [{ rideId: 1, eventId: 1 }, { unique: true }],
    [{ rideId: 1, at: 1 }, {}],
  ],
);
export const Wallet = model("wallets", {
  driverId: { type: Schema.Types.ObjectId, unique: true },
  balance: { type: Number, default: 0 },
});
export const LedgerTransaction = model("ledgerTransactions", {
  key: { type: String, unique: true },
  rideId: Schema.Types.ObjectId,
  actorId: Schema.Types.ObjectId,
  driverId: Schema.Types.ObjectId,
  kind: String,
  amount: Number,
  reason: String,
});
export const LedgerEntry = model(
  "ledgerEntries",
  { transactionId: Schema.Types.ObjectId, account: String, amount: Number },
  [[{ transactionId: 1, account: 1 }, { unique: true }]],
);
export const Payment = model("payments", {
  rideId: { type: Schema.Types.ObjectId, unique: true },
  userId: Schema.Types.ObjectId,
  method: String,
  amount: Number,
  status: String,
  reference: String,
});
export const PaymentEvent = model(
  "paymentEvents",
  { provider: String, eventId: String, payloadDigest: String, status: String },
  [[{ provider: 1, eventId: 1 }, { unique: true }]],
);
export const Rating = model("ratings", {
  rideId: { type: Schema.Types.ObjectId, unique: true },
  passengerId: Schema.Types.ObjectId,
  driverId: Schema.Types.ObjectId,
  score: Number,
  comment: String,
});
export const Ticket = model("supportTickets", {
  userId: Schema.Types.ObjectId,
  rideId: Schema.Types.ObjectId,
  kind: String,
  message: String,
  status: { type: String, default: "open" },
  reply: String,
});
export const Notification = model(
  "notifications",
  {
    userId: Schema.Types.ObjectId,
    type: String,
    payload: Schema.Types.Mixed,
    readAt: Date,
    eventId: String,
    pushSentAt: Date,
    pushTickets: Schema.Types.Mixed,
  },
  [[{ userId: 1, eventId: 1 }, { unique: true }]],
);
export const Audit = model("adminAuditLogs", {
  actorId: Schema.Types.ObjectId,
  action: String,
  target: String,
  reason: String,
  data: Schema.Types.Mixed,
});
export const Idempotency = model(
  "idempotencyKeys",
  {
    userId: Schema.Types.ObjectId,
    key: String,
    route: String,
    payloadHash: String,
    response: Schema.Types.Mixed,
  },
  [[{ userId: 1, key: 1, route: 1 }, { unique: true }]],
);
export const Outbox = model("outboxEvents", {
  kind: String,
  rideId: Schema.Types.ObjectId,
  userIds: [String],
  payload: Schema.Types.Mixed,
  publishedAt: Date,
  attempts: { type: Number, default: 0 },
});
export const Share = model(
  "rideShares",
  {
    rideId: Schema.Types.ObjectId,
    passengerId: Schema.Types.ObjectId,
    tokenHash: { type: String, unique: true },
    expiresAt: Date,
    revokedAt: Date,
  },
  [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
);
export const Expense = model("operatingExpenses", {
  actorId: Schema.Types.ObjectId,
  amount: Number,
  category: String,
  reason: String,
  incurredAt: Date,
  key: { type: String, unique: true },
});
export const ChatMessage = model(
  "rideMessages",
  {
    rideId: Schema.Types.ObjectId,
    senderId: Schema.Types.ObjectId,
    clientId: String,
    text: String,
  },
  [
    [{ rideId: 1, senderId: 1, clientId: 1 }, { unique: true }],
    [{ rideId: 1, createdAt: 1 }, {}],
  ],
);
export const PushToken = model("pushTokens", {
  userId: Schema.Types.ObjectId,
  token: { type: String, unique: true },
  enabled: { type: Boolean, default: true },
});
export async function connectDb(uri: string) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName) throw Error("MongoDB doit fonctionner en replica set");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}
export const tx = <T>(f: (s: mongoose.ClientSession) => Promise<T>) =>
  mongoose.connection.transaction(f);
export { mongoose };

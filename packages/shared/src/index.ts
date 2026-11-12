import { z } from "zod";
export const Roles = [
  "passenger",
  "driver",
  "superadmin",
  "operations",
  "support",
  "finance",
] as const;
export type Role = (typeof Roles)[number];
export const AdminRoles: Role[] = [
  "superadmin",
  "operations",
  "support",
  "finance",
];
export const Point = z
  .object({
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
  })
  .strict();
export type Coordinates = z.infer<typeof Point>;
export const Phone = z
  .string()
  .regex(/^\+226[0-9]{8}$/, "Numéro attendu : +226 et 8 chiffres");
export const QuoteInput = z
  .object({
    pickup: Point,
    dropoff: Point,
    pickupLabel: z.string().trim().min(2).max(160),
    dropoffLabel: z.string().trim().min(2).max(160),
    landmark: z.string().trim().max(240).default(""),
  })
  .strict();
export type QuoteRequest = z.infer<typeof QuoteInput>;
export const RideStates = [
  "searching",
  "accepted",
  "arrived",
  "in_progress",
  "completed",
  "cancelled",
  "no_driver",
] as const;
export type RideState = (typeof RideStates)[number];
export const DEFAULT_PRICING = Object.freeze({
  version: "economy-v1",
  perKm: 200,
  perMinute: 25,
  commissionBps: 700,
  fuelPerKm: 100,
});
const integer = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("Valeur entière positive attendue");
  return BigInt(n);
};
const round = (n: bigint, d: bigint) => Number((n + d / 2n) / d);
export function fare(
  meters: number,
  seconds: number,
  pricing: typeof DEFAULT_PRICING = DEFAULT_PRICING,
) {
  const m = integer(meters),
    s = integer(seconds);
  const total = round(
    m * BigInt(pricing.perKm) * 60n + s * BigInt(pricing.perMinute) * 1000n,
    60000n,
  );
  if (!Number.isSafeInteger(total)) throw new Error("Montant trop élevé");
  const commission = round(
    BigInt(total) * BigInt(pricing.commissionBps),
    10000n,
  );
  return {
    total,
    commission,
    driver: total - commission,
    currency: "XOF",
    meters,
    stationarySeconds: seconds,
  };
}
export function eligible(pickupMeters: number, rideMeters: number) {
  integer(pickupMeters);
  integer(rideMeters);
  return rideMeters > 0 && BigInt(pickupMeters) * 3n <= BigInt(rideMeters);
}
export const formatMoney = (n: number) =>
  new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n) +
  " FCFA";
export interface ApiError {
  message: string;
  statusCode?: number;
}
export type RideView = {
  _id: string;
  status: RideState;
  pickupLabel: string;
  dropoffLabel: string;
  landmark: string;
  distanceMeters: number;
  stationarySeconds: number;
  fare: ReturnType<typeof fare>;
  pickupCode?: string;
  driver?: { name: string; vehicle?: { brand: string; plate: string } };
  events?: unknown[];
};

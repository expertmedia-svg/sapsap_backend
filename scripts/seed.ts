import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as OTPAuth from "otpauth";
import {
  connectDb,
  User,
  Driver,
  Wallet,
  Vehicle,
  Document,
  Pricing,
  mongoose,
} from "../apps/api/src/db";
import { encrypt, secret } from "../apps/api/src/security";
import { DEFAULT_PRICING } from "../packages/shared/src";
async function main() {
  if (process.env.NODE_ENV === "production")
    throw Error("Données de démonstration interdites en production");
  secret();
  await connectDb(process.env.MONGODB_URI!);
  await Pricing.updateOne(
    { version: DEFAULT_PRICING.version },
    { $setOnInsert: { ...DEFAULT_PRICING, active: true } },
    { upsert: true },
  );
  const mfa = new OTPAuth.Secret({ size: 20 });
  const existing = await User.findOne({ phone: "+22670000001" });
  if (!existing) {
    await User.create({
      phone: "+22670000001",
      name: "Administration locale",
      role: "superadmin",
      mfaSecret: encrypt(mfa.base32),
    });
    const totp = new OTPAuth.TOTP({
      issuer: "OuagaRide local",
      label: "+22670000001",
      secret: mfa,
    });
    await mkdir(".local", { recursive: true });
    await writeFile(".local/admin-mfa.txt", totp.toString(), { mode: 0o600 });
  }
  console.log(
    "Compte admin local : +22670000001. Provisionnement MFA : .local/admin-mfa.txt. OTP envoyés vers .local/otp.jsonl si mode local activé.",
  );
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

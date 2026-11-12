import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomInt } from "node:crypto";
import * as OTPAuth from "otpauth";
import { z } from "zod";
import { Phone, AdminRoles } from "../../../packages/shared/src";
import { Otp, User, Session, Driver, Wallet, tx } from "./db";
import { digest, equal, hash, newToken, limit, decrypt } from "./security";
export class AuthService {
  async request(phoneInput: unknown, ip: string) {
    const phone = Phone.parse(phoneInput);
    await limit("otp-ip:" + hash(ip), 10, 600);
    await limit("otp-phone:" + hash(phone), 3, 300);
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 5 * 60000);
    await Otp.updateOne(
      { phone },
      {
        $set: {
          digest: digest(phone + ":" + code),
          attempts: 0,
          expiresAt,
          lastSentAt: new Date(),
        },
      },
      { upsert: true },
    );
    try {
      if (process.env.SMS_MODE === "twilio") {
        const sid = process.env.TWILIO_ACCOUNT_SID,
          token = process.env.TWILIO_AUTH_TOKEN,
          from = process.env.TWILIO_FROM;
        if (!sid || !token || !from) throw Error("SMS non configuré");
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization:
                "Basic " + Buffer.from(sid + ":" + token).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: phone,
              From: from,
              Body: `Votre code SAPSAP : ${code}. Valable 5 minutes.`,
            }),
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) throw Error("SMS échoué");
      } else if (
        process.env.NODE_ENV !== "production" &&
        process.env.ALLOW_LOCAL_OTP === "true"
      ) {
        return { message: "Code local prêt", expiresIn: 300, devCode: code };
      } else throw Error("SMS non configuré");
    } catch {
      await Otp.deleteOne({ phone, digest: digest(phone + ":" + code) });
      throw new ServiceUnavailableException("Envoi SMS indisponible");
    }
    return { message: "Code envoyé", expiresIn: 300 };
  }
  async verify(body: unknown, ip: string) {
    const data = z
      .object({
        phone: Phone,
        code: z.string().regex(/^\d{6}$/),
        name: z.string().trim().min(2).max(80).default("Utilisateur"),
        role: z.enum(["passenger", "driver"]).default("passenger"),
        mfa: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      })
      .strict()
      .parse(body);
    await limit("verify-ip:" + hash(ip), 30, 600);
    const otp = await Otp.findOneAndUpdate(
      {
        phone: data.phone,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: 5 },
      },
      { $inc: { attempts: 1 } },
      { returnDocument: "after" },
    );
    if (!otp || !equal(otp.digest, digest(data.phone + ":" + data.code)))
      throw new UnauthorizedException("Code incorrect ou expiré");
    let user = await User.findOne({ phone: data.phone }).select("+mfaSecret");
    if (user?.suspended) throw new ForbiddenException("Compte suspendu");
    if (user && AdminRoles.includes(user.role)) {
      if (!user.mfaSecret || !data.mfa)
        throw new UnauthorizedException("Code MFA administrateur requis");
      const totp = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(decrypt(user.mfaSecret)),
        digits: 6,
        period: 30,
      });
      if (totp.validate({ token: data.mfa, window: 1 }) === null)
        throw new UnauthorizedException("Code MFA incorrect");
    }
    const consumed = await Otp.deleteOne({ _id: otp._id, digest: otp.digest });
    if (!consumed.deletedCount)
      throw new UnauthorizedException("Code déjà utilisé");
    if (!user) {
      try {
        user = await tx(async (s) => {
          const [u] = await User.create(
            [{ phone: data.phone, name: data.name, role: data.role }],
            { session: s },
          );
          if (data.role === "driver") {
            await Driver.create(
              [{ userId: u._id, name: u.name, approved: false, online: false }],
              { session: s },
            );
            await Wallet.create([{ driverId: u._id, balance: 0 }], {
              session: s,
            });
          }
          return u;
        });
      } catch (e: any) {
        if (e.code === 11000) user = await User.findOne({ phone: data.phone });
        else throw e;
      }
    }
    if (!user) throw new BadRequestException();
    const raw = newToken();
    await Session.create({
      userId: user._id,
      tokenHash: hash(raw),
      expiresAt: new Date(
        Date.now() + (AdminRoles.includes(user.role) ? 8 : 24 * 7) * 3600000,
      ),
    });
    return {
      token: raw,
      user: {
        id: String(user._id),
        name: user.name,
        phone: user.phone,
        role: user.role,
      },
    };
  }
}

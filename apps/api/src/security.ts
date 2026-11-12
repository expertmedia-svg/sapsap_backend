import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
} from "@nestjs/common";
import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { Session, User } from "./db";
import Redis from "ioredis";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32)
    throw Error("AUTH_SECRET : au moins 32 caractères requis");
  return s;
}
export const digest = (s: string) =>
  createHmac("sha256", secret()).update(s).digest("hex");
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function encrypt(value: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", Buffer.from(hash(secret()), "hex"), iv);
  const payload = Buffer.concat([c.update(value), c.final()]);
  return Buffer.concat([iv, payload, c.getAuthTag()]).toString("base64url");
}
export function decrypt(value: string) {
  const b = Buffer.from(value, "base64url"),
    d = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(hash(secret()), "hex"),
      b.subarray(0, 12),
    );
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
}
export function token(req: any) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookies = String(req.headers.cookie || "")
    .split(";")
    .map((s: string) => s.trim());
  return cookies.find((s: string) => s.startsWith("or_session="))?.slice(11);
}
export async function authenticate(raw: string | undefined) {
  if (!raw) throw new UnauthorizedException("Connexion requise");
  const session = await Session.findOne({
    tokenHash: hash(raw),
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  });
  if (!session) throw new UnauthorizedException("Session expirée");
  const user = await User.findById(session.userId);
  if (!user || user.suspended)
    throw new UnauthorizedException("Compte indisponible");
  return { user, session };
}
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(c: ExecutionContext) {
    const req = c.switchToHttp().getRequest();
    const a = await authenticate(token(req));
    req.user = a.user;
    req.session = a.session;
    return true;
  }
}
export function requireRole(user: any, roles: string[]) {
  if (!roles.includes(user.role))
    throw new ForbiddenException("Accès interdit");
}
export const newToken = () => randomBytes(32).toString("base64url");
class TooManyRequestsException extends HttpException {
  constructor(message: string) {
    super(message, 429);
  }
}
let redis: Redis | undefined;
const localBuckets = new Map<string, { count: number; until: number }>();
export async function limit(key: string, max: number, seconds: number) {
  if (process.env.REDIS_URL) {
    redis ??= new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    const count = (await redis.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      1,
      "limit:" + key,
      String(seconds),
    )) as number;
    if (count > max) throw new TooManyRequestsException("Trop de tentatives");
  } else {
    if (process.env.NODE_ENV === "production")
      throw new Error("Redis requis en production");
    const now = Date.now();
    if (localBuckets.size > 10000)
      for (const [k, v] of localBuckets)
        if (v.until < now) localBuckets.delete(k);
    const bucket = localBuckets.get(key);
    if (!bucket || bucket.until < now)
      localBuckets.set(key, { count: 1, until: now + seconds * 1000 });
    else if (++bucket.count > max)
      throw new TooManyRequestsException("Trop de tentatives");
  }
}

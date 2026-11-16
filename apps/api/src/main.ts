import "reflect-metadata";
import "dotenv/config";
import {
  Module,
  Catch,
  ArgumentsHost,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import {
  AuthController,
  AccountController,
  RideController,
  DriverController,
  AdminController,
  ShareController,
  rides,
} from "./controllers";
import { connectDb, mongoose } from "./db";
import { AuthGuard, secret, limit } from "./security";
import { RealtimeGateway, maintenance } from "./realtime";
@Catch()
class Errors implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    let status = 500,
      message = "Erreur interne. Réessayez.";
    if (error instanceof ZodError) {
      status = 400;
      message = error.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .join("; ");
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      message = error.message;
    } else if (error?.code === 11000) {
      status = 409;
      message = "Opération déjà effectuée ou conflit de données";
    } else if (error?.name === "CastError") {
      status = 400;
      message = "Identifiant invalide";
    }
    if (status === 500)
      console.error(
        JSON.stringify({
          event: "request.error",
          name: error?.name,
          code: error?.code,
        }),
      );
    response.status(status).json({ statusCode: status, message });
  }
}
@Module({
  controllers: [
    AuthController,
    AccountController,
    RideController,
    DriverController,
    AdminController,
    ShareController,
  ],
  providers: [AuthGuard, RealtimeGateway],
})
class AppModule {}
export async function start() {
  secret();
  const uri = process.env.MONGODB_URI;
  if (!uri) throw Error("MONGODB_URI requis");
  if (
    process.env.NODE_ENV === "production" &&
    (process.env.ALLOW_LOCAL_OTP === "true" ||
      process.env.SMS_MODE !== "twilio" ||
      !process.env.REDIS_URL)
  )
    throw Error(
      "Configuration de production incomplète : OTP sécurisé et Redis requis",
    );
  await connectDb(uri);
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: true,
  });
  if (process.env.TRUST_PROXY === "loopback")
    app.getHttpAdapter().getInstance().set("trust proxy", "loopback");
  app.use(helmet());
  app.useGlobalFilters(new Errors());
  const allowed = (
    process.env.ALLOWED_ORIGINS || "http://localhost:3000"
  ).split(",");
  app.enableCors({
    origin: allowed,
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-OuagaRide-Client",
    ],
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
  });
  app.use(async (req: any, res: any, next: any) => {
    res.setHeader("X-Request-Id", randomUUID());
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.origin && !allowed.includes(req.headers.origin))
      return res.status(403).json({ message: "Origine interdite" });
    if (
      ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) &&
      req.headers.cookie?.includes("or_session=") &&
      !req.headers.authorization &&
      req.headers["x-ouagaride-client"] !== "admin"
    )
      return res.status(403).json({ message: "En-tête de protection requis" });
    try {
      await limit("http:" + req.ip, 300, 60);
      next();
    } catch {
      res.status(429).json({ message: "Trop de requêtes. Réessayez." });
    }
  });
  app.getHttpAdapter().get("/health", (_req: any, res: any) =>
    res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
      status: mongoose.connection.readyState === 1 ? "ok" : "unavailable",
    }),
  );
  if (process.env.NODE_ENV !== "production") {
    const config = new DocumentBuilder()
      .setTitle("SAPSAP API")
      .setVersion("0.1")
      .addBearerAuth()
      .build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config));
  }
  await app.listen(
    Number(process.env.PORT || 4000),
    process.env.HOST || "0.0.0.0",
  );
  const gateway = app.get(RealtimeGateway);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await gateway.flush();
      await maintenance(rides);
    } catch (e) {
      console.error(
        JSON.stringify({ event: "worker.retry", name: (e as Error).name }),
      );
    } finally {
      busy = false;
    }
  }, 4000);
  timer.unref();
  const close = app.close.bind(app);
  app.close = async () => {
    clearInterval(timer);
    await close();
  };
  process.on("SIGTERM", async () => {
    await app.close();
    await mongoose.disconnect();
    process.exit(0);
  });
  console.log(
    "SAPSAP API disponible sur le port " + (process.env.PORT || 4000),
  );
  return app;
}
if (require.main === module)
  start().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });

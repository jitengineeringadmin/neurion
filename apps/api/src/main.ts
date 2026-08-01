import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  // Behind nginx: trust the first proxy hop so req.ip is the real client IP
  // (from X-Forwarded-For). Without this the rate limiter keys every request on
  // the nginx loopback — a single shared bucket that one client could exhaust.
  app.getHttpAdapter().getInstance().set("trust proxy", 1);
  app.use(json({ limit: "12mb" }));
  app.use(urlencoded({ extended: true, limit: "12mb" }));
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const webPort = process.env.NEURION_WEB_PORT ?? 3091;
  // Both loopback spellings: the desktop window may be pointed at either, and a
  // mismatch between them shows up as an opaque CORS failure in the browser.
  app.enableCors({
    origin: [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`],
    credentials: true,
  });

  const port = Number(process.env.NEURION_API_PORT ?? 8091);
  // Bind loopback-only by default. On the desktop the API sits on the user's
  // machine with public registration enabled and an agent that can run shell
  // commands, so listening on 0.0.0.0 would hand that to the whole LAN. The VPS
  // sets NEURION_BIND_HOST=0.0.0.0 explicitly because nginx fronts it there.
  const host = process.env.NEURION_BIND_HOST ?? "127.0.0.1";
  await app.listen(port, host);
  new Logger("Bootstrap").log(
    `Neurion API listening on http://${host}:${port}/api`,
  );
}

// A rejection here used to be unhandled: Node killed the process with exit code
// 1 and the reason went out through a pipe that closed with it, so the desktop
// supervisor logged "exited code=1" and nothing else — a failed API boot with no
// recoverable cause. Print it first, and set exitCode instead of calling
// process.exit() so the write actually flushes before the process ends.
bootstrap().catch((err: unknown) => {
  console.error("[bootstrap] the API failed to start:", err);
  process.exitCode = 1;
});

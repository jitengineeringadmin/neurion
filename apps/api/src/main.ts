import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  // Behind nginx: trust the first proxy hop so req.ip is the real client IP
  // (from X-Forwarded-For). Without this the rate limiter keys every request on
  // the nginx loopback — a single shared bucket that one client could exhaust.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  const webPort = process.env.NEURION_WEB_PORT ?? 3091;
  app.enableCors({ origin: [`http://localhost:${webPort}`], credentials: true });

  const port = Number(process.env.NEURION_API_PORT ?? 8091);
  await app.listen(port);
  new Logger('Bootstrap').log(`Neurion API listening on http://localhost:${port}/api`);
}

void bootstrap();

import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

/**
 * Optional Redis. When REDIS_URL is set the API runs in horizontally-scalable
 * mode (shared node presence + cross-instance message routing). When it is NOT
 * set, everything falls back to single-process in-memory behavior — so the
 * standalone desktop build needs no Redis.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly instanceId = randomUUID();
  private clients: { kv: Redis; pub: Redis; sub: Redis } | null = null;

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return !!this.config.get<string>('REDIS_URL');
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    const url = this.config.get<string>('REDIS_URL') as string;
    const mk = () => new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    this.clients = { kv: mk(), pub: mk(), sub: mk() };
    this.clients.kv.on('error', (e) => this.logger.warn(`redis kv error: ${e.message}`));
    this.logger.log(`Redis multi-instance mode ON (instance ${this.instanceId.slice(0, 8)})`);
  }

  get kv(): Redis | null {
    return this.clients?.kv ?? null;
  }
  get pub(): Redis | null {
    return this.clients?.pub ?? null;
  }
  get sub(): Redis | null {
    return this.clients?.sub ?? null;
  }

  onModuleDestroy(): void {
    if (!this.clients) return;
    this.clients.kv.disconnect();
    this.clients.pub.disconnect();
    this.clients.sub.disconnect();
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}

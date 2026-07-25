import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect } from 'node:net';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/**
 * Read the shipped version instead of hardcoding it — the literal here said
 * 1.2.0 while the product was 1.8.8, so /api/health lied to anyone checking
 * what was actually deployed. NEURION_VERSION overrides for odd packagings.
 */
const VERSION: string = (() => {
  if (process.env.NEURION_VERSION) return process.env.NEURION_VERSION;
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkg = require(rel) as { version?: string };
      if (pkg?.version) return pkg.version;
    } catch {
      /* try the next layout */
    }
  }
  return 'unknown';
})();

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  root() {
    return { status: 'ok', service: 'neurion-api', version: VERSION };
  }

  @Get('db')
  async db() {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      return { status: 'ok' };
    } catch {
      return { status: 'down' };
    }
  }

  @Get('redis')
  async redis() {
    const url = new URL(this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379');
    return new Promise((resolve) => {
      const sock = connect({ host: url.hostname, port: Number(url.port || 6379) }, () => {
        sock.end();
        resolve({ status: 'ok' });
      });
      sock.on('error', () => resolve({ status: 'down' }));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve({ status: 'down' });
      });
    });
  }

  @Get('storage')
  async storage() {
    try {
      const ep = this.config.get<string>('S3_ENDPOINT') ?? 'http://localhost:9000';
      const res = await withTimeout(fetch(`${ep}/minio/health/live`), 1500);
      return { status: res.ok ? 'ok' : 'down' };
    } catch {
      return { status: 'down' };
    }
  }

  @Get('contracts')
  async contracts() {
    try {
      const rpc = this.config.get<string>('RPC_URL') ?? 'http://127.0.0.1:8545';
      const res = await withTimeout(
        fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', id: 1 }),
        }),
        1500,
      );
      const json = (await res.json()) as { result?: string };
      return { status: json.result ? 'ok' : 'down', chainId: json.result ?? null };
    } catch {
      return { status: 'down' };
    }
  }

  @Get('ai-router')
  async aiRouter() {
    try {
      const base = this.config.get<string>('AI_OPENAI_COMPATIBLE_BASE_URL') ?? 'http://localhost:11434/v1';
      const res = await withTimeout(fetch(`${base}/models`), 1000);
      return { status: res.ok ? 'ok' : 'fallback_only', provider: 'openai_compatible' };
    } catch {
      return { status: 'fallback_only', provider: 'mock' };
    }
  }
}

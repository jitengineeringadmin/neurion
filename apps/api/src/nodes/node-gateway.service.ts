import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../common/redis.service';

interface SocketState {
  nodeId?: string;
}

const WS_PATH = '/ws/nodes';
const PRESENCE_CH = 'neurion:node:presence';
const ROUTE_CH = 'neurion:node:route';
const ALIVE_PREFIX = 'neurion:node:alive:';
const ALIVE_TTL = 35; // seconds (> heartbeat interval 10s)

/**
 * Raw WebSocket gateway for the node fleet (spec §10.5). Owns the live
 * nodeId -> socket map. Handles node.hello/heartbeat itself; emits job.* and
 * realtime.* events for other modules (JobsModule) to consume — keeps Nodes
 * free of a dependency on Jobs.
 */
@Injectable()
export class NodeGatewayService extends EventEmitter implements OnApplicationBootstrap {
  private readonly logger = new Logger(NodeGatewayService.name);
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<string, WebSocket>(); // locally-connected nodes
  private readonly globalOnline = new Set<string>(); // fleet-wide presence (Redis mode)

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as HttpServer;
    httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!req.url || !req.url.startsWith(WS_PATH)) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    this.wss.on('connection', (ws: WebSocket) => this.onConnection(ws));
    this.logger.log(`node WS gateway listening on ${WS_PATH}`);
    void this.setupRedis();
  }

  /** Multi-instance mode: subscribe to fleet presence + cross-instance routing. */
  private async setupRedis(): Promise<void> {
    if (!this.redis.enabled || !this.redis.sub) return;
    await this.redis.sub.subscribe(PRESENCE_CH, ROUTE_CH);
    this.redis.sub.on('message', (ch: string, raw: string) => {
      try {
        const m = JSON.parse(raw) as { type?: string; nodeId: string; message?: unknown };
        if (ch === PRESENCE_CH) {
          if (m.type === 'online') this.globalOnline.add(m.nodeId);
          else if (m.type === 'offline') this.globalOnline.delete(m.nodeId);
        } else if (ch === ROUTE_CH) {
          const ws = this.sockets.get(m.nodeId); // deliver only if WE hold the socket
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m.message));
        }
      } catch {
        /* ignore malformed */
      }
    });
    await this.reconcile();
    setInterval(() => void this.reconcile(), 15_000); // self-heal crashed instances via TTL
    this.logger.log('node gateway: Redis presence + cross-instance routing active');
  }

  /** Rebuild the fleet-online set from the live (TTL'd) presence keys. */
  private async reconcile(): Promise<void> {
    const kv = this.redis.kv;
    if (!kv) return;
    const ids = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await kv.scan(cursor, 'MATCH', `${ALIVE_PREFIX}*`, 'COUNT', 200);
      cursor = next;
      for (const k of keys) ids.add(k.slice(ALIVE_PREFIX.length));
    } while (cursor !== '0');
    for (const id of this.sockets.keys()) ids.add(id); // never drop our own live sockets
    this.globalOnline.clear();
    for (const id of ids) this.globalOnline.add(id);
  }

  private async registerPresence(nodeId: string): Promise<void> {
    this.globalOnline.add(nodeId);
    if (this.redis.enabled && this.redis.kv && this.redis.pub) {
      await this.redis.kv.set(`${ALIVE_PREFIX}${nodeId}`, this.redis.instanceId, 'EX', ALIVE_TTL);
      await this.redis.pub.publish(PRESENCE_CH, JSON.stringify({ type: 'online', nodeId }));
    }
  }

  isOnline(nodeId: string): boolean {
    if (this.sockets.has(nodeId)) return true;
    return this.redis.enabled && this.globalOnline.has(nodeId);
  }

  onlineNodeIds(): string[] {
    if (!this.redis.enabled) return [...this.sockets.keys()];
    const s = new Set(this.globalOnline);
    for (const id of this.sockets.keys()) s.add(id);
    return [...s];
  }

  send(nodeId: string, message: unknown): boolean {
    const ws = this.sockets.get(nodeId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    }
    // not local — if the node is online on another instance, route via Redis
    if (this.redis.enabled && this.redis.pub && this.globalOnline.has(nodeId)) {
      void this.redis.pub.publish(ROUTE_CH, JSON.stringify({ nodeId, message }));
      return true;
    }
    return false;
  }

  private onConnection(ws: WebSocket): void {
    const state: SocketState = {};
    ws.on('message', (raw) => void this.onMessage(ws, state, raw.toString()));
    ws.on('close', () => void this.onClose(state));
    ws.on('error', (err) => this.logger.warn(`node ws error: ${err.message}`));
  }

  private async onMessage(ws: WebSocket, state: SocketState, raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = msg.type as string | undefined;

    if (type === 'node.hello') {
      await this.handleHello(ws, state, msg);
      return;
    }
    if (!state.nodeId) return; // must authenticate first

    switch (type) {
      case 'node.heartbeat':
        await this.handleHeartbeat(state.nodeId, msg);
        break;
      case 'job.accepted':
      case 'job.started':
      case 'job.completed':
      case 'job.failed':
        this.emit(type, { nodeId: state.nodeId, ...msg });
        break;
      case 'realtime.chat.token':
      case 'realtime.chat.done':
      case 'realtime.chat.error':
        this.emit(type, { nodeId: state.nodeId, ...msg });
        break;
      default:
        break;
    }
  }

  private async handleHello(ws: WebSocket, state: SocketState, msg: Record<string, unknown>): Promise<void> {
    const nodeId = msg.nodeId as string | undefined;
    const nodeKey = msg.nodeKey as string | undefined;
    if (!nodeId || !nodeKey) {
      ws.send(JSON.stringify({ type: 'hello.rejected', reason: 'missing credentials' }));
      ws.close();
      return;
    }
    const node = await this.prisma.computeNode.findUnique({ where: { id: nodeId } });
    const keyHash = createHash('sha256').update(nodeKey).digest('hex');
    if (!node || node.nodeKeyHash !== keyHash) {
      ws.send(JSON.stringify({ type: 'hello.rejected', reason: 'invalid node key' }));
      ws.close();
      return;
    }

    const cap = (msg.capabilities ?? {}) as Record<string, unknown>;
    state.nodeId = nodeId;
    this.sockets.set(nodeId, ws);
    await this.prisma.computeNode.update({
      where: { id: nodeId },
      data: {
        status: 'ONLINE',
        lastSeenAt: new Date(),
        os: (cap.os as string) ?? node.os,
        arch: (cap.arch as string) ?? node.arch,
        cpuCores: (cap.cpuCores as number) ?? node.cpuCores,
        ramMb: (cap.ramMb as number) ?? node.ramMb,
        cpuModel: (cap.cpuModel as string) ?? node.cpuModel,
        gpuVendor: (cap.gpuVendor as string) ?? node.gpuVendor,
        gpuModel: (cap.gpuModel as string) ?? node.gpuModel,
        gpuMemoryMb: (cap.gpuMemoryMb as number) ?? node.gpuMemoryMb,
        dockerAvailable: (cap.dockerAvailable as boolean) ?? node.dockerAvailable,
        nvidiaAvailable: (cap.nvidiaAvailable as boolean) ?? node.nvidiaAvailable,
        supportedModes: (cap.modes as string[]) ?? node.supportedModes,
        loadedModels: (cap.loadedModels as string[]) ?? node.loadedModels,
        avgFirstTokenMs: (cap.avgFirstTokenMs as number) ?? node.avgFirstTokenMs,
        avgTokensPerSecond: (cap.avgTokensPerSecond as number) ?? node.avgTokensPerSecond,
      },
    });
    await this.registerPresence(nodeId);
    ws.send(JSON.stringify({ type: 'hello.ok', nodeId }));
    this.logger.log(`node ${nodeId} online`);
    this.emit('node.online', { nodeId });
  }

  private async handleHeartbeat(nodeId: string, msg: Record<string, unknown>): Promise<void> {
    const m = (msg.metrics ?? {}) as Record<string, number>;
    await this.prisma.nodeHeartbeat.create({
      data: {
        nodeId,
        cpuLoad: m.cpuLoad ?? null,
        ramUsedMb: m.ramUsedMb ?? null,
        gpuLoad: m.gpuLoad ?? null,
        gpuTempC: m.gpuTempC ?? null,
        freeDiskMb: m.freeDiskMb ?? null,
        tokensPerSecond: m.tokensPerSecond ?? null,
        activeRealtimeSessions: m.activeRealtimeSessions ?? null,
      },
    });
    await this.prisma.computeNode.update({ where: { id: nodeId }, data: { lastSeenAt: new Date() } });
    if (this.redis.enabled && this.redis.kv) await this.redis.kv.set(`${ALIVE_PREFIX}${nodeId}`, this.redis.instanceId, 'EX', ALIVE_TTL);
  }

  private async onClose(state: SocketState): Promise<void> {
    if (!state.nodeId) return;
    this.sockets.delete(state.nodeId);
    this.globalOnline.delete(state.nodeId);
    if (this.redis.enabled && this.redis.kv && this.redis.pub) {
      await this.redis.kv.del(`${ALIVE_PREFIX}${state.nodeId}`).catch(() => undefined);
      await this.redis.pub.publish(PRESENCE_CH, JSON.stringify({ type: 'offline', nodeId: state.nodeId })).catch(() => undefined);
    }
    await this.prisma.computeNode
      .update({ where: { id: state.nodeId }, data: { status: 'OFFLINE' } })
      .catch(() => undefined);
    this.logger.log(`node ${state.nodeId} offline`);
  }
}

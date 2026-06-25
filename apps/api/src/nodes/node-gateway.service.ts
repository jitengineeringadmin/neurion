import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';

interface SocketState {
  nodeId?: string;
}

const WS_PATH = '/ws/nodes';

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
  private readonly sockets = new Map<string, WebSocket>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly prisma: PrismaService,
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
  }

  isOnline(nodeId: string): boolean {
    return this.sockets.has(nodeId);
  }

  onlineNodeIds(): string[] {
    return [...this.sockets.keys()];
  }

  send(nodeId: string, message: unknown): boolean {
    const ws = this.sockets.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
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
        gpuVendor: (cap.gpuVendor as string) ?? node.gpuVendor,
        gpuModel: (cap.gpuModel as string) ?? node.gpuModel,
        dockerAvailable: (cap.dockerAvailable as boolean) ?? node.dockerAvailable,
        nvidiaAvailable: (cap.nvidiaAvailable as boolean) ?? node.nvidiaAvailable,
        supportedModes: (cap.modes as string[]) ?? node.supportedModes,
        loadedModels: (cap.loadedModels as string[]) ?? node.loadedModels,
        avgFirstTokenMs: (cap.avgFirstTokenMs as number) ?? node.avgFirstTokenMs,
        avgTokensPerSecond: (cap.avgTokensPerSecond as number) ?? node.avgTokensPerSecond,
      },
    });
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
  }

  private async onClose(state: SocketState): Promise<void> {
    if (!state.nodeId) return;
    this.sockets.delete(state.nodeId);
    await this.prisma.computeNode
      .update({ where: { id: state.nodeId }, data: { status: 'OFFLINE' } })
      .catch(() => undefined);
    this.logger.log(`node ${state.nodeId} offline`);
  }
}

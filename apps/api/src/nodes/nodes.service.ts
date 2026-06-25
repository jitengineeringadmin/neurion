import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class NodesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns the node plus the raw nodeKey — shown ONCE, only its hash is stored. */
  async register(user: AuthUser, name: string, supportedJobTypes: string[] = ['echo.v1']) {
    const nodeKey = randomBytes(32).toString('hex');
    const nodeKeyHash = createHash('sha256').update(nodeKey).digest('hex');
    const node = await this.prisma.computeNode.create({
      data: {
        workspaceId: user.workspaceId,
        ownerUserId: user.sub,
        name,
        nodeKeyHash,
        supportedJobTypes,
        supportedModes: ['grid'],
      },
    });
    return { nodeId: node.id, nodeKey, node };
  }

  async list(user: AuthUser) {
    return this.prisma.computeNode.findMany({
      where: { workspaceId: user.workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const node = await this.prisma.computeNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('node not found');
    if (node.workspaceId !== user.workspaceId) throw new ForbiddenException('not your node');
    return node;
  }

  async heartbeats(user: AuthUser, id: string, take = 50) {
    await this.get(user, id);
    return this.prisma.nodeHeartbeat.findMany({
      where: { nodeId: id },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async setEnabled(user: AuthUser, id: string, enabled: boolean) {
    await this.get(user, id);
    return this.prisma.computeNode.update({
      where: { id },
      data: { status: enabled ? 'OFFLINE' : 'DISABLED' },
    });
  }
}

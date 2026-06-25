import { Injectable } from '@nestjs/common';
import { JobPrivacyLevel, NodeTrustLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NodeGatewayService } from '../nodes/node-gateway.service';
import { RealtimeNodeProvider } from './realtime-node.provider';
import { allowedTrustLevels } from './privacy/privacy.util';
import { AiProvider } from './providers/ai-provider.interface';

export interface WarmMatch {
  provider: AiProvider;
  nodeId: string;
  trustLevel: NodeTrustLevel;
  model: string;
}

/**
 * Fast lane (G2-aware). Finds a warm online realtime node that has the model
 * loaded AND whose trust level is permitted by the effective privacy. With the
 * VERIFIED_ONLY chat default, COMMUNITY nodes are excluded from chat by default.
 */
@Injectable()
export class RealtimePoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NodeGatewayService,
  ) {}

  async findWarm(model: string, effectivePrivacy: JobPrivacyLevel): Promise<WarmMatch | null> {
    const online = this.gateway.onlineNodeIds();
    if (online.length === 0) return null;
    const allowed = [...allowedTrustLevels(effectivePrivacy)];

    const node = await this.prisma.computeNode.findFirst({
      where: {
        id: { in: online },
        status: { notIn: ['DISABLED', 'BANNED'] },
        supportedModes: { has: 'realtime' },
        loadedModels: { has: model },
        trustLevel: { in: allowed },
      },
      orderBy: [{ reputationScore: 'desc' }, { avgFirstTokenMs: 'asc' }],
    });
    if (!node) return null;

    return {
      provider: new RealtimeNodeProvider(this.gateway, node.id),
      nodeId: node.id,
      trustLevel: node.trustLevel,
      model,
    };
  }
}

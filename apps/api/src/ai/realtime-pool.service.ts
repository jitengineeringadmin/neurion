import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JobPrivacyLevel, NodeTrustLevel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreditsService } from "../credits/credits.service";
import { NodeGatewayService } from "../nodes/node-gateway.service";
import { RealtimeNodeProvider } from "./realtime-node.provider";
import { allowedTrustLevels } from "./privacy/privacy.util";
import { AiProvider } from "./providers/ai-provider.interface";

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
  private readonly logger = new Logger(RealtimePoolService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NodeGatewayService,
    private readonly credits: CreditsService,
    private readonly config: ConfigService,
  ) {}

  async findWarm(
    model: string,
    effectivePrivacy: JobPrivacyLevel,
  ): Promise<WarmMatch | null> {
    const online = this.gateway.onlineNodeIds();
    if (online.length === 0) return null;
    const allowed = [...allowedTrustLevels(effectivePrivacy)];

    const node = await this.prisma.computeNode.findFirst({
      where: {
        id: { in: online },
        status: { notIn: ["DISABLED", "BANNED"] },
        supportedModes: { has: "realtime" },
        loadedModels: { has: model },
        trustLevel: { in: allowed },
      },
      // `reputation` (EWMA, written by the verification service) — NOT
      // `reputationScore`, which is declared but never assigned anywhere, so it
      // stays 0 and made this a constant primary sort key.
      orderBy: [
        { reputation: "desc" },
        { avgFirstTokenMs: "asc" },
        { id: "asc" },
      ],
    });
    if (!node) return null;

    return {
      provider: new RealtimeNodeProvider(this.gateway, node.id),
      nodeId: node.id,
      trustLevel: node.trustLevel,
      model,
    };
  }

  /**
   * Grant the node owner NRN credits for serving a realtime chat. Token-metered
   * (approx chars/4), capped, min 1 per served reply. Idempotent via `ref`
   * (the assistant message id), so a retry never double-pays.
   */
  async rewardServe(
    nodeId: string,
    outputChars: number,
    ref: string,
  ): Promise<number> {
    const node = await this.prisma.computeNode.findUnique({
      where: { id: nodeId },
      select: { ownerUserId: true },
    });
    if (!node) return 0;
    const estTokens = Math.ceil(outputChars / 4);
    const ratePer1k =
      Number(
        this.config.get<string>("AI_REALTIME_REWARD_PER_1K_TOKENS") ?? "1",
      ) || 1;
    const cap =
      Number(this.config.get<string>("AI_REALTIME_REWARD_MAX") ?? "50") || 50;
    const reward = Math.min(
      cap,
      Math.max(1, Math.round((estTokens / 1000) * ratePer1k)),
    );
    const net = await this.credits.rewardWithFee(
      node.ownerUserId,
      reward,
      "NODE_REALTIME_REWARD",
      ref,
    );
    this.logger.log(
      `realtime serve reward: ${net} credits net -> node ${nodeId} owner (${estTokens} est tokens, ${reward} gross)`,
    );
    return net;
  }
}

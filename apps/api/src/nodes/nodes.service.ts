import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CreditsService } from "../credits/credits.service";
import { AuthUser } from "../common/decorators/current-user.decorator";
import { countryFromIp } from "../common/geoip";

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly config: ConfigService,
  ) {}

  /** Returns the node plus the raw nodeKey — shown ONCE, only its hash is stored. */
  async register(
    user: AuthUser,
    name: string,
    supportedJobTypes: string[] = ["echo.v1"],
    ip?: string,
  ) {
    const cap = Number(this.config.get("NODE_MAX_PER_OWNER") ?? 20) || 20;
    const stake = Number(this.config.get("NODE_STAKE_CREDITS") ?? 0) || 0;

    // Atomic sybil cap: conditionally claim a node slot under the owner's row.
    await this.prisma.ownerReputation.upsert({
      where: { userId: user.sub },
      update: {},
      create: { userId: user.sub, workspaceId: user.workspaceId },
    });
    const claim = await this.prisma.ownerReputation.updateMany({
      where: { userId: user.sub, nodeCount: { lt: cap } },
      data: { nodeCount: { increment: 1 } },
    });
    if (claim.count !== 1)
      throw new ForbiddenException(
        `node limit reached for this owner (${cap})`,
      );

    // Registration bond (sybil cost): spend now, refund on graduation, forfeit on fraud.
    if (stake > 0) {
      try {
        await this.credits.spend(user.sub, stake, "NODE_STAKE");
      } catch (e) {
        await this.prisma.ownerReputation
          .update({
            where: { userId: user.sub },
            data: { nodeCount: { decrement: 1 } },
          })
          .catch(() => undefined);
        throw new BadRequestException(
          `insufficient credits for the ${stake}-credit node stake`,
        );
      }
    }

    const nodeKey = randomBytes(32).toString("hex");
    const nodeKeyHash = createHash("sha256").update(nodeKey).digest("hex");
    try {
      const node = await this.prisma.computeNode.create({
        data: {
          workspaceId: user.workspaceId,
          ownerUserId: user.sub,
          name,
          nodeKeyHash,
          supportedJobTypes,
          supportedModes: ["grid"],
          stakeCredits: stake,
          registrationIp: ip ?? null,
          regionCode: countryFromIp(ip),
        },
      });
      return { nodeId: node.id, nodeKey, node };
    } catch (e) {
      // compensate the claim + stake if node creation fails
      if (stake > 0)
        await this.credits
          .grant(user.sub, stake, "NODE_STAKE_REFUND")
          .catch(() => undefined);
      await this.prisma.ownerReputation
        .update({
          where: { userId: user.sub },
          data: { nodeCount: { decrement: 1 } },
        })
        .catch(() => undefined);
      throw e;
    }
  }

  async list(user: AuthUser) {
    return this.prisma.computeNode.findMany({
      where: { workspaceId: user.workspaceId },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(user: AuthUser, id: string) {
    const node = await this.prisma.computeNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException("node not found");
    if (node.workspaceId !== user.workspaceId)
      throw new ForbiddenException("not your node");
    return node;
  }

  async heartbeats(user: AuthUser, id: string, take = 50) {
    await this.get(user, id);
    return this.prisma.nodeHeartbeat.findMany({
      where: { nodeId: id },
      orderBy: { createdAt: "desc" },
      take,
    });
  }

  async setEnabled(user: AuthUser, id: string, enabled: boolean) {
    await this.get(user, id);
    return this.prisma.computeNode.update({
      where: { id },
      data: { status: enabled ? "OFFLINE" : "DISABLED" },
    });
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Persistent, per-user agent memory (facts the agent was told to remember). */
@Injectable()
export class AgentMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  save(userId: string, content: string) {
    return this.prisma.agentMemory.create({ data: { userId, content: content.slice(0, 2000) } });
  }

  recent(userId: string, take = 20) {
    return this.prisma.agentMemory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take });
  }
}

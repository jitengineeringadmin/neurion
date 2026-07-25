import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { ChatMsg } from "../ai/providers/ai-provider.interface";
import { PrismaService } from "../prisma/prisma.service";

export interface CompiledContext {
  messages: ChatMsg[];
  contextLimit: number;
  inputBudget: number;
  estimatedTokens: number;
  compressed: boolean;
  omittedMessages: number;
}

const IMPORTANT_LINE =
  /\b(error|failed|failure|warn|warning|passed|success|created|wrote|edited|deleted|changed|exit code|exception|traceback|network)\b/i;

@Injectable()
export class AgentContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  estimateTokens(text: string): number {
    return Math.ceil(String(text ?? "").length / 3.5);
  }

  private total(messages: ChatMsg[]): number {
    return messages.reduce(
      (sum, message) => sum + this.estimateTokens(message.content) + 6,
      0,
    );
  }

  async contextLimit(model?: string): Promise<number> {
    if (model) {
      const row = await this.prisma.modelRegistry.findFirst({
        where: { OR: [{ name: model }, { modelRef: model }] },
        select: { contextTokens: true },
      });
      if (row?.contextTokens && row.contextTokens >= 2048)
        return row.contextTokens;
    }
    return Math.max(
      4096,
      Number(this.config.get("AI_AGENT_CONTEXT_TOKENS") ?? 8192),
    );
  }

  compactObservation(text: string, maxChars = 12_000): string {
    const clean = String(text ?? "").replace(/\u0000/g, "");
    if (clean.length <= maxChars) return clean;
    const lines = clean.split(/\r?\n/);
    const selected: string[] = [];
    const seen = new Set<string>();
    const push = (line: string) => {
      const value = line.slice(0, 1000);
      if (!value || seen.has(value)) return;
      seen.add(value);
      selected.push(value);
    };
    for (const line of lines.slice(0, 24)) push(line);
    for (const line of lines) {
      if (IMPORTANT_LINE.test(line)) push(line);
      if (selected.join("\n").length >= maxChars * 0.72) break;
    }
    for (const line of lines.slice(-24)) push(line);
    const body = selected.join("\n").slice(0, maxChars - 180);
    return `${body}\n\n[Observation compressed: ${clean.length} chars; full output stored as an artifact.]`;
  }

  private summarize(messages: ChatMsg[], maxChars: number): string {
    const lines: string[] = [];
    for (const message of messages) {
      let content = message.content
        .replace(
          /--- FILE CONTENT START ---[\s\S]*?--- FILE CONTENT END ---/g,
          "[attached file content omitted]",
        )
        .replace(/<<<FILE[\s\S]*?\nFILE\b/g, "[generated file content omitted]")
        .trim();
      if (!content) continue;
      content = this.compactObservation(content, 900).replace(/\s+/g, " ");
      lines.push(`- ${message.role.toUpperCase()}: ${content.slice(0, 900)}`);
      if (lines.join("\n").length >= maxChars) break;
    }
    return [
      "Earlier context digest (lossy; original events remain stored):",
      ...lines,
    ]
      .join("\n")
      .slice(0, maxChars);
  }

  async compile(
    messages: ChatMsg[],
    model?: string,
    reserveOutputTokens = 1400,
  ): Promise<CompiledContext> {
    const contextLimit = await this.contextLimit(model);
    const inputBudget = Math.max(
      2048,
      Math.floor(contextLimit * 0.78) - reserveOutputTokens,
    );
    if (this.total(messages) <= inputBudget) {
      return {
        messages,
        contextLimit,
        inputBudget,
        estimatedTokens: this.total(messages),
        compressed: false,
        omittedMessages: 0,
      };
    }

    const charBudget = Math.floor(inputBudget * 3.5);
    const perMessage = Math.max(
      1800,
      Math.floor(charBudget / Math.max(4, messages.length)),
    );
    const shortened = messages.map((message, index) => {
      if (index === 0 && message.role === "system") {
        return {
          ...message,
          content: message.content.slice(0, Math.floor(charBudget * 0.42)),
        };
      }
      return {
        ...message,
        content: this.compactObservation(message.content, perMessage),
      };
    });
    if (this.total(shortened) <= inputBudget) {
      return {
        messages: shortened,
        contextLimit,
        inputBudget,
        estimatedTokens: this.total(shortened),
        compressed: true,
        omittedMessages: 0,
      };
    }

    const system = shortened[0]?.role === "system" ? shortened[0] : undefined;
    const tail: ChatMsg[] = [];
    let used = system ? this.estimateTokens(system.content) + 6 : 0;
    const tailBudget = Math.floor(inputBudget * 0.62);
    for (let i = shortened.length - 1; i >= (system ? 1 : 0); i--) {
      const message = shortened[i] as ChatMsg;
      const cost = this.estimateTokens(message.content) + 6;
      if (used + cost > tailBudget && tail.length >= 2) break;
      tail.unshift(message);
      used += cost;
    }
    const omittedCount = shortened.length - tail.length - (system ? 1 : 0);
    const omitted = shortened.slice(
      system ? 1 : 0,
      shortened.length - tail.length,
    );
    const digest: ChatMsg = {
      role: "user",
      content: this.summarize(omitted, Math.floor(charBudget * 0.25)),
    };
    const fitted = [
      ...(system ? [system] : []),
      ...(omitted.length ? [digest] : []),
      ...tail,
    ];
    return {
      messages: fitted,
      contextLimit,
      inputBudget,
      estimatedTokens: this.total(fitted),
      compressed: true,
      omittedMessages: omittedCount,
    };
  }

  async saveAgentSnapshot(
    userId: string,
    runId: string,
    compiled: CompiledContext,
  ): Promise<void> {
    if (!compiled.compressed) return;
    const summary = compiled.messages
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n")
      .slice(0, 24_000);
    await this.prisma.contextSnapshot.create({
      data: {
        userId,
        agentRunId: runId,
        summary,
        tokenEstimate: compiled.estimatedTokens,
        metadata: {
          contextLimit: compiled.contextLimit,
          inputBudget: compiled.inputBudget,
          omittedMessages: compiled.omittedMessages,
        } as Prisma.InputJsonValue,
      },
    });
  }

  async saveConversationSnapshot(
    userId: string,
    conversationId: string,
    throughIndex: number,
    compiled: CompiledContext,
  ): Promise<void> {
    if (!compiled.compressed) return;
    const latest = await this.prisma.contextSnapshot.findFirst({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      select: { throughIndex: true },
    });
    if (latest?.throughIndex === throughIndex) return;
    const summary = compiled.messages
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n")
      .slice(0, 24_000);
    await this.prisma.contextSnapshot.create({
      data: {
        userId,
        conversationId,
        summary,
        tokenEstimate: compiled.estimatedTokens,
        throughIndex,
        metadata: {
          contextLimit: compiled.contextLimit,
          inputBudget: compiled.inputBudget,
          omittedMessages: compiled.omittedMessages,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

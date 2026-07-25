import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { AuthUser } from "../common/decorators/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";

interface IndexableFile {
  name: string;
  type?: string;
  size: number;
  content: string;
  chunks?: string[];
  truncated?: boolean;
}

export interface KnowledgeHit {
  documentId: string;
  documentName: string;
  ordinal: number;
  content: string;
  rank: number;
}

export interface KnowledgeRetrieval {
  enabled: boolean;
  documents: number;
  totalChunks: number;
  selectedChunks: number;
  hits: KnowledgeHit[];
}

const STOP_WORDS = new Set([
  "alla",
  "alle",
  "anche",
  "come",
  "con",
  "cosa",
  "dalla",
  "delle",
  "dello",
  "file",
  "from",
  "have",
  "into",
  "nella",
  "nelle",
  "per",
  "qual",
  "quale",
  "quali",
  "dimmi",
  "trova",
  "where",
  "what",
  "which",
  "questo",
  "that",
  "the",
  "this",
  "with",
]);

@Injectable()
export class KnowledgePagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  enabled(): boolean {
    return String(this.config.get("AI_KNOWLEDGE_PAGING") ?? "true") !== "false";
  }

  isBroadRequest(input: string): boolean {
    const query = input.trim().toLowerCase();
    if (!query) return true;
    return /\b(analizza|analyze|analisi completa|complete analysis|riassumi|summarize|sintesi|summary|overview|tutto|intero|entire|whole)\b/i.test(
      query,
    );
  }

  private sourceText(file: IndexableFile): string {
    return (file.chunks?.length ? file.chunks : [file.content])
      .filter(Boolean)
      .join("\n\n");
  }

  private split(raw: string): string[] {
    const target = 4_000;
    const overlap = 320;
    const maxChunks = 1_600;
    const text = raw.replace(/\r\n/g, "\n").trim();
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length && chunks.length < maxChunks) {
      let end = Math.min(text.length, start + target);
      if (end < text.length) {
        const paragraph = text.lastIndexOf("\n\n", end);
        const sentence = text.lastIndexOf(". ", end);
        const boundary = Math.max(paragraph, sentence);
        if (boundary > start + target / 2) end = boundary + 1;
      }
      const chunk = text.slice(start, end).trim();
      if (chunk) chunks.push(chunk);
      if (end >= text.length) break;
      start = Math.max(start + 1, end - overlap);
    }
    return chunks;
  }

  async indexFile(
    user: AuthUser,
    conversationId: string,
    file: IndexableFile,
  ): Promise<{ documentId: string; totalChunks: number; existed: boolean }> {
    if (!this.enabled())
      return { documentId: "", totalChunks: 0, existed: false };
    const source = this.sourceText(file);
    if (!source.trim())
      return { documentId: "", totalChunks: 0, existed: false };
    const sha256 = createHash("sha256").update(source).digest("hex");
    const existing = await this.prisma.knowledgeDocument.findUnique({
      where: { conversationId_sha256: { conversationId, sha256 } },
      select: { id: true, chunkCount: true },
    });
    if (existing)
      return {
        documentId: existing.id,
        totalChunks: existing.chunkCount,
        existed: true,
      };

    const chunks = this.split(source);
    if (!chunks.length)
      return { documentId: "", totalChunks: 0, existed: false };
    const document = await this.prisma.$transaction(async (tx) => {
      const created = await tx.knowledgeDocument.create({
        data: {
          workspaceId: user.workspaceId,
          userId: user.sub,
          conversationId,
          name: file.name.slice(0, 240),
          mime: (file.type || "text/plain").slice(0, 120),
          sizeBytes: file.size,
          sha256,
          chunkCount: chunks.length,
          truncated: !!file.truncated || chunks.length >= 1_600,
        },
      });
      await tx.knowledgeChunk.createMany({
        data: chunks.map((content, ordinal) => ({
          documentId: created.id,
          ordinal,
          content,
          charCount: content.length,
          tokenEstimate: Math.ceil(content.length / 4),
        })),
      });
      return created;
    });
    return {
      documentId: document.id,
      totalChunks: chunks.length,
      existed: false,
    };
  }

  private queryTokens(query: string): string[] {
    return [
      ...new Set(
        query
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .match(/[a-z0-9_]{3,}/g)
          ?.filter((word) => !STOP_WORDS.has(word)) ?? [],
      ),
    ].slice(0, 24);
  }

  async retrieve(
    userId: string,
    conversationId: string,
    query: string,
    limit = 5,
  ): Promise<KnowledgeRetrieval> {
    if (!this.enabled())
      return {
        enabled: false,
        documents: 0,
        totalChunks: 0,
        selectedChunks: 0,
        hits: [],
      };
    const stats = await this.stats(userId, conversationId);
    const tokens = this.queryTokens(query);
    if (!tokens.length || !stats.totalChunks)
      return { enabled: true, ...stats, selectedChunks: 0, hits: [] };
    const take = Math.min(8, Math.max(1, limit));
    const search = (tsQuery: string) =>
      this.prisma.$queryRaw<KnowledgeHit[]>(Prisma.sql`
        SELECT
          c."documentId",
          d."name" AS "documentName",
          c."ordinal",
          c."content",
          ts_rank_cd(
            to_tsvector('simple', c."content"),
            to_tsquery('simple', ${tsQuery})
          )::double precision AS "rank"
        FROM "KnowledgeChunk" c
        INNER JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
        WHERE d."userId" = ${userId}
          AND d."conversationId" = ${conversationId}
          AND to_tsvector('simple', c."content") @@ to_tsquery('simple', ${tsQuery})
        ORDER BY "rank" DESC, d."createdAt" DESC, c."ordinal" ASC
        LIMIT ${take}
      `);
    const strictQuery = tokens.map((token) => `${token}:*`).join(" & ");
    let hits = await search(strictQuery);
    if (!hits.length && tokens.length > 1) {
      const broadQuery = tokens.map((token) => `${token}:*`).join(" | ");
      hits = await search(broadQuery);
    }
    return {
      enabled: true,
      ...stats,
      selectedChunks: hits.length,
      hits,
    };
  }

  async stats(userId: string, conversationId: string) {
    const result = await this.prisma.knowledgeDocument.aggregate({
      where: { userId, conversationId },
      _count: { id: true },
      _sum: { chunkCount: true },
    });
    return {
      documents: result._count.id,
      totalChunks: result._sum.chunkCount ?? 0,
    };
  }

  context(retrieval: KnowledgeRetrieval): string {
    return [
      "Relevant knowledge pages retrieved from files attached earlier in this conversation.",
      "Use these excerpts when relevant. Do not claim that an excerpt contains facts it does not contain.",
      ...retrieval.hits.map(
        (hit) =>
          `\n--- ${hit.documentName}, page ${hit.ordinal + 1} ---\n${hit.content}`,
      ),
    ].join("\n");
  }
}

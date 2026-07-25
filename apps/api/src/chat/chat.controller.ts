import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IsBoolean, IsOptional, IsString } from "class-validator";
import { Response } from "express";
import { PDFParse } from "pdf-parse";
import { ChatService } from "./chat.service";
import { AiRouterService, RoutePlan } from "../ai/ai-router.service";
import { CreditsService } from "../credits/credits.service";
import { MockProvider } from "../ai/providers/mock.provider";
import { ProviderResolverService } from "../ai/provider-resolver.service";
import { JobPrivacyLevel } from "@prisma/client";
import {
  CreateConversationDto,
  EstimateDto,
  StreamChatDto,
} from "./dto/chat.dto";
import {
  CurrentUser,
  AuthUser,
} from "../common/decorators/current-user.decorator";
import { AiProvider, ChatMsg } from "../ai/providers/ai-provider.interface";
import { AgentContextService } from "../agent/agent-context.service";
import {
  KnowledgePagingService,
  KnowledgeRetrieval,
} from "./knowledge-paging.service";

class PatchConversationDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  projectId?: string | null;
}

@Controller("chat")
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chat: ChatService,
    private readonly router: AiRouterService,
    private readonly credits: CreditsService,
    private readonly config: ConfigService,
    private readonly resolver: ProviderResolverService,
    private readonly contextCompiler: AgentContextService,
    private readonly knowledge: KnowledgePagingService,
  ) {}

  private knowledgeEvent(
    mode: "indexed" | "retrieved",
    retrieval: Pick<
      KnowledgeRetrieval,
      "documents" | "totalChunks" | "selectedChunks"
    >,
  ) {
    return {
      mode,
      documents: retrieval.documents,
      totalChunks: retrieval.totalChunks,
      selectedChunks: retrieval.selectedChunks,
    };
  }

  private displayMessage(dto: StreamChatDto): string {
    const message = dto.message?.trim();
    if (message) return message;
    if (dto.file) return `Analyze the attached file: ${dto.file.name}`;
    return "";
  }

  private fileChunks(dto: StreamChatDto): string[] {
    const chunks = dto.file?.chunks?.length
      ? dto.file.chunks
      : dto.file?.content
        ? [dto.file.content]
        : [];
    return chunks.map((chunk) => chunk.trim()).filter(Boolean);
  }

  private messageWithFile(dto: StreamChatDto): string {
    const message = this.displayMessage(dto);
    if (!dto.file) return message;
    const name = dto.file.name.replace(/[\r\n]/g, " ").slice(0, 240);
    const type = (dto.file.type || "text/plain")
      .replace(/[\r\n]/g, " ")
      .slice(0, 120);
    const suffix = dto.file.truncated
      ? " (content truncated by the client)"
      : "";
    const chunks = this.fileChunks(dto);
    if (chunks.length > 1) {
      return [
        `The user attached a large file named "${name}" (${type}, ${dto.file.size} bytes, ${chunks.length} chunks)${suffix}.`,
        `User request: ${message || `Analyze the attached file "${name}".`}`,
      ].join("\n");
    }
    return [
      `The user attached a file named "${name}" (${type}, ${dto.file.size} bytes)${suffix}.`,
      "",
      "--- FILE CONTENT START ---",
      dto.file.content,
      "--- FILE CONTENT END ---",
      "",
      `User request: ${message || `Analyze the attached file "${name}".`}`,
    ].join("\n");
  }

  private isPdfFile(dto: StreamChatDto): boolean {
    return (
      !!dto.file &&
      (dto.file.type === "application/pdf" || /\.pdf$/i.test(dto.file.name))
    );
  }

  private splitText(raw: string): string[] {
    const maxChars = 24_000;
    const maxChunks = 240;
    const text = raw.slice(0, maxChars * maxChunks);
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxChars)
      chunks.push(text.slice(i, i + maxChars));
    return chunks;
  }

  private async extractPdfText(dto: StreamChatDto): Promise<void> {
    if (!this.isPdfFile(dto) || !dto.file?.data) return;
    const base64 = dto.file.data.includes(",")
      ? dto.file.data.slice(dto.file.data.indexOf(",") + 1)
      : dto.file.data;
    const parser = new PDFParse({ data: Buffer.from(base64, "base64") });
    try {
      const result = await parser.getText();
      const text = result.text.trim();
      if (text.length < 20)
        throw new Error(
          "PDF has no extractable text. It is probably scanned and requires OCR.",
        );
      dto.file.content = text.slice(0, 30_000);
      dto.file.chunks = this.splitText(text);
      dto.file.truncated = dto.file.truncated || text.length > 24_000 * 240;
      dto.file.type = "application/pdf";
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  private async collectProviderText(
    provider: AiProvider,
    model: string,
    messages: ChatMsg[],
  ): Promise<string> {
    let full = "";
    for await (const text of provider.streamChat(messages, model)) full += text;
    return full.trim();
  }

  private async streamLargeFile(
    user: AuthUser,
    dto: StreamChatDto,
    convId: string,
    plan: RoutePlan,
    chosenModel: string,
    cost: number,
    send: (event: string, data: unknown) => void,
    flush: () => Promise<void>,
  ): Promise<void> {
    const file = dto.file as NonNullable<StreamChatDto["file"]>;
    const chunks = this.fileChunks(dto);
    const name = file.name.replace(/[\r\n]/g, " ").slice(0, 240);
    const request =
      this.displayMessage(dto) || `Analyze the attached file "${name}".`;
    await this.chat.addUserMessage(convId, this.messageWithFile(dto));
    send("routing", {
      lane: plan.lane,
      provider: plan.provider.name,
      model: chosenModel,
      labeled: plan.provider.labeled,
      effectivePrivacy: plan.effectivePrivacy,
      routeReason: plan.routeReason,
      estCredits: cost,
    });
    send("token", {
      text: `Analizzo "${name}" in ${chunks.length} parti...\n\n`,
    });
    await flush();

    let usedProvider = plan.provider;
    let usedModel = chosenModel;
    const summaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      send("token", { text: `Parte ${i + 1}/${chunks.length}...\n` });
      await flush();
      const messages: ChatMsg[] = [
        {
          role: "system",
          content:
            "Summarize large files accurately. Be compact and preserve important details.",
        },
        {
          role: "user",
          content: [
            `Summarize chunk ${i + 1} of ${chunks.length} from file "${name}".`,
            "Extract facts, anomalies, numbers, dates, names, errors and details relevant to the request.",
            `User request: ${request}`,
            "",
            "--- CHUNK START ---",
            chunks[i] as string,
            "--- CHUNK END ---",
          ].join("\n"),
        },
      ];
      try {
        summaries.push(
          `Chunk ${i + 1}: ${await this.collectProviderText(usedProvider, usedModel, messages)}`,
        );
      } catch (error) {
        this.logger.warn(
          `large-file provider failed, falling back to mock: ${(error as Error).message}`,
        );
        usedProvider = new MockProvider();
        usedModel = "mock";
        send("routing", {
          lane: "FALLBACK",
          provider: "mock",
          labeled: true,
          note: `provider unavailable: ${(error as Error).message}`,
        });
        summaries.push(
          `Chunk ${i + 1}: ${await this.collectProviderText(usedProvider, usedModel, messages)}`,
        );
      }
    }

    send("token", { text: "\nSintesi finale...\n\n" });
    await flush();
    const context = await this.chat.buildContext(convId, usedModel);
    const finalPrompt = [
      `The attached file "${name}" was analyzed in ${chunks.length} chunks.`,
      `User request: ${request}`,
      "",
      "Chunk summaries:",
      summaries.join("\n\n"),
      "",
      "Answer with a clear final analysis. Mention whether the file was truncated.",
    ].join("\n");
    let full = "";
    let firstTokenMs: number | null = null;
    const startedAt = Date.now();
    const compiled = await this.contextCompiler.compile(
      [...context, { role: "user", content: finalPrompt }],
      usedModel,
    );
    for await (const text of usedProvider.streamChat(
      compiled.messages,
      usedModel,
    )) {
      if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
      full += text;
      send("token", { text });
      await flush();
    }
    const servedByPlannedProvider = usedProvider === plan.provider;
    const effectivePlan: RoutePlan = servedByPlannedProvider
      ? { ...plan, provider: usedProvider, model: usedModel }
      : {
          ...plan,
          provider: usedProvider,
          model: usedModel,
          lane: "FALLBACK",
          servedTrustLevel: "INTERNAL",
          responseTrusted: true,
          nodeId: undefined,
        };
    const assistant = await this.chat.addAssistantMessage(
      convId,
      full,
      effectivePlan,
      cost,
      firstTokenMs,
      usedProvider.getUsage?.() ?? null,
    );
    await this.credits.spend(user.sub, cost, "chat.file.large", {
      chatMessageId: assistant.id,
    });
    send("final", {
      messageId: assistant.id,
      conversationId: convId,
      costCredits: cost,
      estCredits: cost,
      firstTokenMs,
      lane: effectivePlan.lane,
      balance: await this.credits.getBalance(user.sub),
    });
  }

  /** Answer a message that carries an image, locally, with a vision model (llava …). */
  private async streamVision(
    user: AuthUser,
    dto: StreamChatDto,
    convId: string,
    send: (event: string, data: unknown) => void,
    flush: () => Promise<void>,
  ): Promise<void> {
    const model = await this.resolver.pickVisionModel();
    if (!model) {
      send("error", {
        message:
          "No vision model installed. Download one (e.g. llava) from the Models tab to chat about images.",
      });
      return;
    }
    const plan = await this.router.plan({
      message: dto.message,
      conversationPrivacy: dto.privacyLevel ?? JobPrivacyLevel.VERIFIED_ONLY,
      hasLiveOpenTierConsent: false,
      preferredModel: model,
    });
    const cost = plan.estimate.estCredits;
    const balance = await this.credits.getBalance(user.sub);
    if (balance < cost) {
      send("error", { message: "insufficient credits", balance, cost });
      return;
    }

    await this.chat.addUserMessage(convId, dto.message);
    send("routing", {
      lane: "FALLBACK",
      provider: "openai_compatible",
      model,
      labeled: false,
      effectivePrivacy: plan.effectivePrivacy,
      routeReason: "VISION_LOCAL",
      estCredits: cost,
    });

    const context = await this.chat.buildContext(convId);
    // attach the image to the last user message (the one we just added)
    for (let i = context.length - 1; i >= 0; i--) {
      const m = context[i];
      if (m && m.role === "user") {
        m.images = [dto.image as string];
        break;
      }
    }
    // Route to whichever local engine actually has the vision model — it is not
    // necessarily ollama now that LM Studio is discovered too.
    const provider = (await this.resolver.resolveFallback(model)).provider;
    const vPlan: RoutePlan = {
      ...plan,
      provider,
      model,
      lane: "FALLBACK",
      responseTrusted: true,
    };

    let full = "";
    let firstTokenMs: number | null = null;
    const t0 = Date.now();
    try {
      for await (const text of provider.streamChat(context, model)) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        full += text;
        send("token", { text });
        await flush();
      }
    } catch (e) {
      send("error", {
        message: `vision model failed: ${(e as Error).message}`,
      });
      return;
    }
    const assistant = await this.chat.addAssistantMessage(
      convId,
      full,
      vPlan,
      cost,
      firstTokenMs,
      provider.getUsage?.() ?? null,
    );
    await this.credits.spend(user.sub, cost, "chat.vision", {
      chatMessageId: assistant.id,
    });
    send("final", {
      messageId: assistant.id,
      conversationId: convId,
      costCredits: cost,
      lane: "FALLBACK",
      balance: await this.credits.getBalance(user.sub),
    });
  }

  @Post("conversations")
  createConversation(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateConversationDto,
  ) {
    return this.chat.createConversation(user, dto.title, dto.privacyLevel);
  }

  @Get("conversations")
  listConversations(@CurrentUser() user: AuthUser) {
    return this.chat.listConversations(user);
  }

  @Get("conversations/:id")
  getConversation(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.chat.getConversation(user, id);
  }

  @Get("conversations/:id/messages")
  listMessages(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.chat.listMessages(user, id);
  }

  @Get("conversations/:id/knowledge")
  async conversationKnowledge(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
  ) {
    await this.chat.getConversation(user, id);
    return this.knowledge.stats(user.sub, id);
  }

  @Patch("conversations/:id")
  updateConversation(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() dto: PatchConversationDto,
  ) {
    return this.chat.updateConversation(user, id, dto);
  }

  @Delete("conversations/:id")
  removeConversation(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.chat.removeConversation(user, id);
  }

  @Post("estimate")
  async estimate(@CurrentUser() user: AuthUser, @Body() dto: EstimateDto) {
    const plan = await this.router.plan({
      message: dto.message,
      conversationPrivacy: "VERIFIED_ONLY",
      hasLiveOpenTierConsent: false,
      attachmentBytes: dto.attachmentBytes,
    });
    return {
      estimate: plan.estimate,
      lane: plan.lane,
      effectivePrivacy: plan.effectivePrivacy,
      routeReason: plan.routeReason,
      provider: plan.provider.name,
      model: plan.model,
      balance: await this.credits.getBalance(user.sub),
    };
  }

  @Post("stream")
  async stream(
    @CurrentUser() user: AuthUser,
    @Body() dto: StreamChatDto,
    @Res() res: Response,
  ) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // If the user navigates away mid-answer, keep generating and persisting to the DB
    // (addAssistantMessage at the end) — just stop writing to the dead socket. Coming
    // back to the conversation then shows the finished reply instead of a lost one.
    let clientGone = false;
    // The provider interface has always accepted an AbortSignal and nothing
    // ever passed one, so a disconnected client left the engine generating with
    // no way to stop it. Keeping the generation is the DEFAULT and deliberate
    // behaviour (see above); CHAT_ABORT_ON_DISCONNECT=true opts into stopping
    // instead, which matters on a CPU-only machine where an unwatched answer
    // competes with the next real request.
    const abort = new AbortController();
    const abortOnDisconnect =
      String(this.config.get("CHAT_ABORT_ON_DISCONNECT") ?? "false") === "true";
    res.on("close", () => {
      clientGone = true;
      if (abortOnDisconnect) abort.abort();
    });
    const send = (event: string, data: unknown): void => {
      if (clientGone) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        clientGone = true;
      }
    };
    // Backpressure: pause token production while the socket buffer is full so a
    // slow client can't make us buffer the whole stream in memory.
    const flush = (): Promise<void> => {
      if (clientGone || !res.writableNeedDrain) return Promise.resolve();
      return new Promise<void>((resolve) => {
        res.once("drain", resolve);
        res.once("close", resolve);
      });
    };

    try {
      await this.extractPdfText(dto);
      const displayMessage = this.displayMessage(dto);
      const conv = await this.chat.ensureConversation(
        user,
        dto.conversationId,
        displayMessage || dto.message,
        dto.privacyLevel,
      );

      let pagedKnowledge: KnowledgeRetrieval | null = null;
      if (dto.file && this.knowledge.enabled()) {
        const indexed = await this.knowledge.indexFile(user, conv.id, dto.file);
        const stats = await this.knowledge.stats(user.sub, conv.id);
        send(
          "knowledge",
          this.knowledgeEvent("indexed", {
            ...stats,
            selectedChunks: 0,
          }),
        );
        const originalChunks = this.fileChunks(dto).length;
        if (
          indexed.totalChunks > 0 &&
          originalChunks > 1 &&
          !this.knowledge.isBroadRequest(displayMessage)
        ) {
          const retrieval = await this.knowledge.retrieve(
            user.sub,
            conv.id,
            displayMessage,
            4,
          );
          if (retrieval.hits.length) {
            pagedKnowledge = retrieval;
            dto.file.content = this.knowledge.context(retrieval);
            dto.file.chunks = undefined;
            send("knowledge", this.knowledgeEvent("retrieved", retrieval));
          }
        }
      }

      const chatMessage = this.messageWithFile(dto);
      const storedChatMessage = pagedKnowledge
        ? `[File: ${dto.file?.name ?? "file"}]\n${displayMessage}`
        : chatMessage;

      // Vision: an attached image is answered locally by a vision model (llava etc.).
      if (dto.image) {
        await this.streamVision(user, dto, conv.id, send, flush);
        return res.end();
      }

      const plan = await this.router.plan({
        message: chatMessage,
        conversationPrivacy: dto.privacyLevel ?? conv.privacyLevel,
        hasLiveOpenTierConsent: false,
        preferredModel: dto.preferredModel,
        attachmentBytes: dto.file?.size,
      });
      const fileChunkCount = this.fileChunks(dto).length;
      const cost =
        dto.file && fileChunkCount > 1
          ? Math.max(
              plan.estimate.estCredits,
              Math.min(50, 2 + Math.ceil(fileChunkCount / 5)),
            )
          : plan.estimate.estCredits;
      // user-chosen model overrides the default for real (non-mock) providers.
      const chosenModel =
        dto.preferredModel && plan.provider.name !== "mock"
          ? dto.preferredModel
          : plan.model;

      // Soft-disabled online inference: when no real engine is reachable (mock
      // fallback) and this deploy runs without a server engine, return a clear
      // "use the app / run a node" notice instead of a fake mock answer — free.
      if (
        this.config.get<string>("AI_ONLINE_NO_ENGINE") === "true" &&
        plan.provider.name === "mock"
      ) {
        await this.chat.addUserMessage(conv.id, storedChatMessage);
        send("routing", {
          lane: "FALLBACK",
          provider: "none",
          model: null,
          labeled: false,
          effectivePrivacy: plan.effectivePrivacy,
          routeReason: "NO_ONLINE_ENGINE",
          estCredits: 0,
        });
        const notice =
          "⚙ Online AI isn't running here. Neurion runs the model on YOUR machine — download the desktop app to chat locally and privately, or run a node to power the network. (Neurion fa girare il modello sul TUO computer: scarica l'app desktop o avvia un nodo.)";
        send("token", { text: notice });
        const assistant = await this.chat.addAssistantMessage(
          conv.id,
          notice,
          plan,
          0,
          0,
          null,
        );
        send("final", {
          messageId: assistant.id,
          conversationId: conv.id,
          costCredits: 0,
          estCredits: 0,
          tokenUsage: null,
          firstTokenMs: 0,
          lane: "FALLBACK",
          nodeReward: 0,
          balance: await this.credits.getBalance(user.sub),
        });
        return res.end();
      }

      const balance = await this.credits.getBalance(user.sub);
      if (balance < cost) {
        send("error", { message: "insufficient credits", balance, cost });
        return res.end();
      }

      if (dto.file && fileChunkCount > 1) {
        await this.streamLargeFile(
          user,
          dto,
          conv.id,
          plan,
          chosenModel,
          cost,
          send,
          flush,
        );
        return res.end();
      }

      await this.chat.addUserMessage(conv.id, storedChatMessage);

      send("routing", {
        lane: plan.lane,
        provider: plan.provider.name,
        model: chosenModel,
        labeled: plan.provider.labeled,
        effectivePrivacy: plan.effectivePrivacy,
        routeReason: plan.routeReason,
        estCredits: cost,
      });

      let context = await this.chat.buildContext(conv.id, chosenModel);
      if (pagedKnowledge) {
        const augmented = [...context];
        augmented.splice(Math.max(1, augmented.length - 1), 0, {
          role: "user",
          content: this.knowledge.context(pagedKnowledge),
        });
        context = (await this.contextCompiler.compile(augmented, chosenModel))
          .messages;
      } else if (!dto.file && this.knowledge.enabled()) {
        const retrieval = await this.knowledge.retrieve(
          user.sub,
          conv.id,
          displayMessage,
          5,
        );
        if (retrieval.hits.length) {
          send("knowledge", this.knowledgeEvent("retrieved", retrieval));
          const augmented = [...context];
          // Append near the question, not at position 1 — matching the paged
          // branch above. Retrieved text depends on the current query, so
          // putting it right after the system prompt rewrites the head of the
          // prompt every turn and throws away the engine's KV cache for the
          // whole conversation. At the tail the prefix stays byte-identical
          // (and the model weights nearby context more heavily anyway).
          augmented.splice(Math.max(1, augmented.length - 1), 0, {
            role: "user",
            content: this.knowledge.context(retrieval),
          });
          context = (await this.contextCompiler.compile(augmented, chosenModel))
            .messages;
        }
      }
      let full = "";
      let firstTokenMs: number | null = null;
      let usedProvider = plan.provider;
      let usedModel = chosenModel;
      const t0 = Date.now();
      try {
        // Reasoning models think for tens of seconds before the first answer
        // token. Forward that as its own event so the UI can show progress
        // instead of a frozen screen; it is never appended to the answer.
        let reasoningChars = 0;
        for await (const text of plan.provider.streamChat(
          context,
          chosenModel,
          abort.signal,
          {
            onReasoning: (delta) => {
              reasoningChars += delta.length;
              send("reasoning", { text: delta, chars: reasoningChars });
            },
          },
        )) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          full += text;
          send("token", { text });
          await flush();
        }
      } catch (streamErr) {
        // G3: real provider failed before producing output -> fall back to the
        // labeled mock so the user is never left stuck. Logged + re-routed.
        if (firstTokenMs !== null) throw streamErr;
        this.logger.warn(
          `provider ${plan.provider.name} failed, falling back to mock: ${(streamErr as Error).message}`,
        );
        usedProvider = new MockProvider();
        usedModel = "mock";
        send("routing", {
          lane: "FALLBACK",
          provider: "mock",
          labeled: true,
          note: `real provider unavailable: ${(streamErr as Error).message}`,
        });
        for await (const text of usedProvider.streamChat(
          context,
          usedModel,
          abort.signal,
        )) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          full += text;
          send("token", { text });
          await flush();
        }
      }

      // If the planned (FAST) node failed before any token, we fell back to the
      // mock provider — record the route honestly (FALLBACK/INTERNAL), not the
      // dead node, so the audit trail and reward reflect what actually served.
      const servedByNode = usedProvider === plan.provider;
      const effectivePlan: RoutePlan = servedByNode
        ? { ...plan, provider: usedProvider, model: usedModel }
        : {
            ...plan,
            provider: usedProvider,
            model: usedModel,
            lane: "FALLBACK",
            servedTrustLevel: "INTERNAL",
            responseTrusted: true,
            nodeId: undefined,
          };
      const usage = usedProvider.getUsage?.() ?? null;
      const assistant = await this.chat.addAssistantMessage(
        conv.id,
        full,
        effectivePlan,
        cost,
        firstTokenMs,
        usage,
      );
      await this.credits.spend(user.sub, cost, "chat.fallback.small", {
        chatMessageId: assistant.id,
      });

      // Cost reconciliation: when the provider reports real token usage, true-up
      // the up-front estimate (refund an overcharge; best-effort charge an undercharge).
      let finalCost = cost;
      if (usage && usage.totalTokens > 0) {
        const perCredit =
          Number(this.config.get<string>("AI_TOKENS_PER_CREDIT") ?? "1000") ||
          1000;
        const actual = Math.max(1, Math.ceil(usage.totalTokens / perCredit));
        const delta = actual - cost;
        if (delta > 0) {
          await this.credits
            .spend(user.sub, delta, "chat.reconcile", {
              chatMessageId: assistant.id,
            })
            .catch(() => undefined);
        } else if (delta < 0) {
          await this.credits.grant(
            user.sub,
            -delta,
            "chat.reconcile.refund",
            `recon:${assistant.id}`,
          );
        }
        finalCost = actual;
      }

      // Reward the serving node owner (earn NRN) only when the realtime node
      // actually produced the reply — never on the mock fallback.
      let nodeReward = 0;
      if (servedByNode) {
        nodeReward = await this.router
          .rewardRealtimeServe(plan, full.length, `realtime:${assistant.id}`)
          .catch(() => 0);
      }

      send("final", {
        messageId: assistant.id,
        conversationId: conv.id,
        costCredits: finalCost,
        estCredits: cost,
        tokenUsage: usage ?? undefined,
        firstTokenMs,
        lane: effectivePlan.lane,
        servedBy: servedByNode ? plan.nodeId : undefined,
        nodeReward,
        balance: await this.credits.getBalance(user.sub),
      });
      res.end();
    } catch (err) {
      send("error", { message: (err as Error).message });
      res.end();
    }
  }
}

import { Body, Controller, Get, Post, Res } from "@nestjs/common";
import { IsString, MaxLength } from "class-validator";
import { Response } from "express";
import { LlamaEngineService } from "./llama-engine.service";

class SelectModelDto {
  @IsString()
  @MaxLength(120)
  modelId!: string;
}

class UseLocalModelDto {
  /** Absolute path to a .gguf the user already has. */
  @IsString()
  @MaxLength(4000)
  path!: string;
}

/**
 * Setup surface for the bundled inference engine. Mirrors the image engine's
 * shape (status endpoint + SSE progress on selection) because the web app
 * already knows how to consume that.
 */
@Controller("ai/engine")
export class EngineController {
  constructor(private readonly engine: LlamaEngineService) {}

  @Get("status")
  async status() {
    return this.engine.status();
  }

  /**
   * Run a GGUF the user already has, from wherever it is. Nothing is copied:
   * people keep these files in one place and share them between tools, and
   * asking them to re-download several gigabytes they already own would be the
   * wrong answer.
   */
  @Post("use-local")
  async useLocal(@Body() dto: UseLocalModelDto) {
    await this.engine.useLocalModel(dto.path);
    return this.engine.status();
  }

  /** Download the engine and a model, then start it, reporting progress live. */
  @Post("setup")
  async setup(
    @Body() dto: SelectModelDto,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
    });
    const send = (event: string, data: unknown): void => {
      if (clientGone) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        clientGone = true;
      }
    };

    try {
      // Deliberately not aborted when the client disconnects: a user who closes
      // the tab during a 1.7 GB download should come back to a finished install,
      // not to a partial one that starts over.
      await this.engine.setup(dto.modelId, (stage, percent) => {
        send("progress", { stage, percent });
      });
      send("done", await this.engine.status());
    } catch (e) {
      const message = (e as Error).message;
      this.engineError(message);
      send("error", { message });
    } finally {
      if (!clientGone) res.end();
    }
  }

  private engineError(message: string): void {
    this.engine.setError(message);
  }
}

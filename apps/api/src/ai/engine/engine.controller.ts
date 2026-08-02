import { Body, Controller, Delete, Get, Post, Res } from "@nestjs/common";
import { IsBoolean, IsString, MaxLength } from "class-validator";
import { Response } from "express";
import { LlamaEngineService } from "./llama-engine.service";
import { PeerService } from "./peer.service";

class SelectModelDto {
  @IsString()
  @MaxLength(120)
  modelId!: string;
}

class FolderDto {
  /** Absolute path to a folder the user keeps models in. */
  @IsString()
  @MaxLength(4000)
  path!: string;
}

class ComputeDto {
  @IsBoolean()
  enabled!: boolean;
}

class SeedDto {
  /** A peer address: host, or host:port. */
  @IsString()
  @MaxLength(300)
  address!: string;
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
  constructor(
    private readonly engine: LlamaEngineService,
    private readonly peers: PeerService,
  ) {}

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

  /**
   * Every .gguf Neurion can see: its own downloads plus any folder the user
   * pointed it at. This is what makes "I keep my models over there" and "I just
   * dropped a file in" both work without copying gigabytes around.
   */
  @Get("local-models")
  localModels() {
    return {
      folders: this.engine.modelFolders(),
      models: this.engine.scanModelFolders(),
    };
  }

  @Post("folders")
  addFolder(@Body() dto: FolderDto) {
    const folders = this.engine.addModelFolder(dto.path);
    return { folders, models: this.engine.scanModelFolders() };
  }

  @Delete("folders")
  removeFolder(@Body() dto: FolderDto) {
    const folders = this.engine.removeModelFolder(dto.path);
    return { folders, models: this.engine.scanModelFolders() };
  }

  /**
   * What this machine is giving and getting on the local network. Visible on
   * purpose: sharing that nobody can see is sharing nobody believes in.
   */
  @Get("peers")
  peerStatus() {
    const s = this.peers.status();
    return {
      enabled: s.enabled,
      /** How many models this machine is offering to others. */
      sharing: s.sharing,
      /** Distinct models the neighbours are offering, ours excluded. */
      offeredByPeers: s.offeredByPeers,
      /** How many times this machine has handed a model to somebody else. */
      served: s.served,
      /** Whether this machine runs prompts for others, and how many so far. */
      compute: s.compute,
      computed: s.computed,
      /** This machine's own name on the network: its public key fingerprint. */
      me: this.peers.myPeerId(),
      seeds: this.peers.seeds(),
      peers: this.peers.known().map((p) => ({
        address: p.address,
        models: p.has.length,
        lastSeen: p.lastSeen,
      })),
    };
  }

  /**
   * Peer addresses the user added by hand.
   *
   * This is what lets two people find each other with no registry at all: tell
   * a friend your address once and neither of you ever needs our server again.
   */
  /**
   * Lend this machine's processor to other people, or stop.
   *
   * Separate from weight sharing on purpose: passing on a file you already have
   * costs nothing, running somebody's prompt costs your CPU and slows your own
   * work. One is on by default, the other is a decision.
   */
  @Post("compute")
  setCompute(@Body() dto: ComputeDto) {
    return { compute: this.peers.setComputeEnabled(dto.enabled) };
  }

  @Post("seeds")
  addSeed(@Body() dto: SeedDto) {
    return { seeds: this.peers.addSeed(dto.address) };
  }

  @Delete("seeds")
  removeSeed(@Body() dto: SeedDto) {
    return { seeds: this.peers.removeSeed(dto.address) };
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

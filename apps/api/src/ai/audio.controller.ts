import { Body, Controller, Get, Post, Res } from "@nestjs/common";
import { Response } from "express";
import { IsIn, IsString } from "class-validator";
import { AudioService } from "./audio.service";

class SetupDto {
  @IsString()
  @IsIn(["music", "tts", "gen"])
  what!: "music" | "tts" | "gen";
}

/** Setup/status for the local audio stack (music pack, piper voice, MusicGen). */
@Controller("ai/audio")
export class AudioController {
  constructor(private readonly audio: AudioService) {}

  @Get("status")
  status() {
    return this.audio.status();
  }

  @Post("setup")
  async setup(@Body() dto: SetupDto, @Res() res: Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* gone */
      }
    };
    const onPct = (percent: number) => send("progress", { percent });
    try {
      if (dto.what === "music") await this.audio.setupMusic(onPct);
      else if (dto.what === "tts") await this.audio.setupTts(onPct);
      else await this.audio.setupGen(onPct);
      send("done", { ok: true });
    } catch (e) {
      send("error", { message: (e as Error).message });
    }
    res.end();
  }
}

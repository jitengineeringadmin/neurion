import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentSettings {
  instructions: string; // the user's own "always follow this" markdown (CLAUDE.md style)
}

/**
 * Persistent per-install agent settings (desktop-first): a user-written instruction
 * file the agent injects into every run. Stored as JSON in the app data dir (next to
 * the image engine), so it survives updates and needs no DB migration.
 */
@Injectable()
export class AgentSettingsService {
  constructor(private readonly config: ConfigService) {}

  private file(): string | null {
    const img = this.config.get<string>('NEURION_IMAGE_DIR') || process.env.NEURION_IMAGE_DIR;
    // userData = parent of the image-engine dir
    const base = img ? path.dirname(img) : process.env.NEURION_DATA_DIR;
    return base ? path.join(base, 'agent-settings.json') : null;
  }

  get(): AgentSettings {
    const f = this.file();
    if (f && existsSync(f)) {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8')) as Partial<AgentSettings>;
        return { instructions: typeof j.instructions === 'string' ? j.instructions : '' };
      } catch {
        /* corrupt — fall through */
      }
    }
    return { instructions: '' };
  }

  set(instructions: string): AgentSettings {
    const f = this.file();
    const clean = String(instructions ?? '').slice(0, 20_000); // cap so it can't blow the context
    if (f) {
      try {
        mkdirSync(path.dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify({ instructions: clean }));
      } catch {
        /* read-only fs — best effort */
      }
    }
    return { instructions: clean };
  }
}

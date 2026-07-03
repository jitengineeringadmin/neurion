import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface Skill {
  id: string;
  name: string;        // short label, e.g. "Landing page"
  description: string; // what it does / when to use (shown in the UI)
  triggers: string[];  // lowercase keywords; empty = always applies
  body: string;        // the instructions injected into the run
  enabled: boolean;
}

const CAP_NAME = 80;
const CAP_DESC = 300;
const CAP_BODY = 8000;
const CAP_TRIGGER = 40;
const MAX_TRIGGERS = 16;
const INJECT_BUDGET = 6000; // total chars of skill text injected into one run

/**
 * User-authored "skills": modular instruction packs (Claude-Code style) the agent
 * auto-applies when a run's goal matches a skill's trigger keywords. Unlike the single
 * global Settings instructions, skills are many and selective — only the relevant ones
 * load, keeping a small local model's context clean. Persisted as JSON in the app data
 * dir (survives updates, no DB migration).
 */
@Injectable()
export class AgentSkillsService {
  constructor(private readonly config: ConfigService) {}

  private file(): string | null {
    const img = this.config.get<string>('NEURION_IMAGE_DIR') || process.env.NEURION_IMAGE_DIR;
    // userData = parent of the image-engine dir
    const base = img ? path.dirname(img) : process.env.NEURION_DATA_DIR;
    return base ? path.join(base, 'agent-skills.json') : null;
  }

  private read(): Skill[] {
    const f = this.file();
    if (f && existsSync(f)) {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        if (Array.isArray(j)) return j.map((x) => this.normalize(x)).filter((x): x is Skill => x !== null);
      } catch {
        /* corrupt — fall through to empty */
      }
    }
    return [];
  }

  private write(list: Skill[]): void {
    const f = this.file();
    if (!f) return;
    try {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(list, null, 2));
    } catch {
      /* read-only fs — best effort */
    }
  }

  private clampTriggers(raw: unknown): string[] {
    const arr = Array.isArray(raw)
      ? raw
      : String(raw ?? '').split(','); // accept a comma-separated string too
    return arr
      .map((t) => String(t).trim().toLowerCase().slice(0, CAP_TRIGGER))
      .filter(Boolean)
      .slice(0, MAX_TRIGGERS);
  }

  /** Coerce an unknown object read from disk into a valid Skill (or null if unusable). */
  private normalize(x: any): Skill | null {
    if (!x || typeof x !== 'object') return null;
    const name = String(x.name ?? '').trim().slice(0, CAP_NAME);
    if (!name) return null;
    return {
      id: typeof x.id === 'string' && x.id ? x.id : randomUUID(),
      name,
      description: String(x.description ?? '').trim().slice(0, CAP_DESC),
      triggers: this.clampTriggers(x.triggers),
      body: String(x.body ?? '').slice(0, CAP_BODY),
      enabled: x.enabled !== false,
    };
  }

  list(): Skill[] {
    return this.read();
  }

  create(input: Partial<Skill>): Skill {
    const list = this.read();
    const skill = this.normalize({ ...input, id: randomUUID() }) ?? {
      id: randomUUID(),
      name: 'Skill',
      description: '',
      triggers: [],
      body: '',
      enabled: true,
    };
    list.push(skill);
    this.write(list);
    return skill;
  }

  update(id: string, input: Partial<Skill>): Skill | null {
    const list = this.read();
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const merged = this.normalize({ ...list[i], ...input, id });
    if (!merged) return null; // e.g. name cleared to empty — reject
    list[i] = merged;
    this.write(list);
    return merged;
  }

  remove(id: string): { ok: boolean } {
    const list = this.read();
    const next = list.filter((s) => s.id !== id);
    this.write(next);
    return { ok: next.length !== list.length };
  }

  private matches(s: Skill, goalLower: string): boolean {
    if (s.triggers.length === 0) return true; // no triggers = always-on
    return s.triggers.some((t) => t && goalLower.includes(t));
  }

  /**
   * The instruction text to inject for a given goal: bodies of the enabled skills whose
   * triggers match (or that are always-on), capped so they can't blow a small model's
   * context. Returns '' when nothing matches.
   */
  rulesFor(goal: string): string {
    const g = String(goal ?? '').toLowerCase();
    const hits = this.read().filter((s) => s.enabled && s.body.trim() && this.matches(s, g));
    if (hits.length === 0) return '';
    let out = '';
    for (const s of hits) {
      const block = `=== SKILL: ${s.name} ===\n${s.body.trim()}\n`;
      if (out.length + block.length > INJECT_BUDGET) break;
      out += (out ? '\n' : '') + block;
    }
    return out.trim();
  }
}

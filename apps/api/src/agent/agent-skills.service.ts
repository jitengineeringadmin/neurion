import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Skill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
  enabled: boolean;
}

const CAP_NAME = 80;
const CAP_DESC = 300;
const CAP_BODY = 8000;
const CAP_TRIGGER = 40;
const MAX_TRIGGERS = 16;
const INJECT_BUDGET = 6000;

@Injectable()
export class AgentSkillsService {
  constructor(private readonly config: ConfigService) {}

  private file(userId: string): string | null {
    const imageDir =
      this.config.get<string>("NEURION_IMAGE_DIR") ||
      process.env.NEURION_IMAGE_DIR;
    const base = imageDir
      ? path.dirname(imageDir)
      : process.env.NEURION_DATA_DIR;
    const owner = createHash("sha256")
      .update(userId)
      .digest("hex")
      .slice(0, 16);
    return base ? path.join(base, `agent-skills-${owner}.json`) : null;
  }

  private read(userId: string): Skill[] {
    const file = this.file(userId);
    if (!file || !existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .map((item) => this.normalize(item))
        .filter((item): item is Skill => item !== null);
    } catch {
      return [];
    }
  }

  private write(userId: string, list: Skill[]): void {
    const file = this.file(userId);
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(list, null, 2));
    } catch {
      // Settings remain best-effort in read-only deployments.
    }
  }

  private clampTriggers(raw: unknown): string[] {
    const values = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
    return values
      .map((value) => String(value).trim().toLowerCase().slice(0, CAP_TRIGGER))
      .filter(Boolean)
      .slice(0, MAX_TRIGGERS);
  }

  private normalize(raw: unknown): Skill | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<Skill>;
    const name = String(value.name ?? "")
      .trim()
      .slice(0, CAP_NAME);
    if (!name) return null;
    return {
      id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
      name,
      description: String(value.description ?? "")
        .trim()
        .slice(0, CAP_DESC),
      triggers: this.clampTriggers(value.triggers),
      body: String(value.body ?? "").slice(0, CAP_BODY),
      enabled: value.enabled !== false,
    };
  }

  list(userId: string): Skill[] {
    return this.read(userId);
  }

  create(userId: string, input: Partial<Skill>): Skill {
    const list = this.read(userId);
    const skill = this.normalize({ ...input, id: randomUUID() }) ?? {
      id: randomUUID(),
      name: "Skill",
      description: "",
      triggers: [],
      body: "",
      enabled: true,
    };
    list.push(skill);
    this.write(userId, list);
    return skill;
  }

  update(userId: string, id: string, input: Partial<Skill>): Skill | null {
    const list = this.read(userId);
    const index = list.findIndex((skill) => skill.id === id);
    if (index < 0) return null;
    const merged = this.normalize({ ...list[index], ...input, id });
    if (!merged) return null;
    list[index] = merged;
    this.write(userId, list);
    return merged;
  }

  remove(userId: string, id: string): { ok: boolean } {
    const list = this.read(userId);
    const next = list.filter((skill) => skill.id !== id);
    this.write(userId, next);
    return { ok: next.length !== list.length };
  }

  rulesFor(userId: string, goal: string): string {
    const target = String(goal ?? "").toLowerCase();
    const matches = this.read(userId).filter(
      (skill) =>
        skill.enabled &&
        skill.body.trim() &&
        (skill.triggers.length === 0 ||
          skill.triggers.some((trigger) => target.includes(trigger))),
    );
    let output = "";
    for (const skill of matches) {
      const block = `=== SKILL: ${skill.name} ===\n${skill.body.trim()}\n`;
      if (output.length + block.length > INJECT_BUDGET) break;
      output += `${output ? "\n" : ""}${block}`;
    }
    return output.trim();
  }
}

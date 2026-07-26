import { Injectable } from "@nestjs/common";
import {
  AgentTool,
  AgentToolInputSchema,
  AgentValueSchema,
} from "./agent.types";

const text = (minLength = 0, maxLength = 1_000_000): AgentValueSchema => ({
  type: "string",
  minLength,
  maxLength,
});
const number = (
  min?: number,
  max?: number,
  integer = false,
): AgentValueSchema => ({
  type: "number",
  min,
  max,
  integer,
});
const boolean: AgentValueSchema = { type: "boolean" };
const list = (items: AgentValueSchema, maxItems = 100): AgentValueSchema => ({
  type: "array",
  items,
  maxItems,
});
const object = (
  properties: Record<string, AgentValueSchema>,
  required: string[] = [],
): AgentValueSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const schema = (
  properties: Record<string, AgentValueSchema>,
  required: string[] = [],
): AgentToolInputSchema => ({
  properties,
  required,
  additionalProperties: false,
});

const TOOL_SCHEMAS: Record<string, AgentToolInputSchema> = {
  start_process: schema(
    {
      command: text(1),
      cwd: text(1, 4_000),
      timeout_ms: number(1_000, 1_800_000, true),
    },
    ["command"],
  ),
  read_process: schema(
    { process_id: text(1, 100), offset: number(0, undefined, true) },
    ["process_id"],
  ),
  wait_process: schema(
    { process_id: text(1, 100), timeout_ms: number(0, 20_000, true) },
    ["process_id"],
  ),
  stop_process: schema({ process_id: text(1, 100) }, ["process_id"]),
  remember: schema({ note: text(1, 20_000) }, ["note"]),
  recall: schema({}),
  set_plan: schema({ steps: list(text(1, 500), 50) }, ["steps"]),
  update_plan: schema({ index: number(0, 1_000, true), done: boolean }, [
    "index",
  ]),
  read_many_files: schema({ paths: list(text(1, 4_000), 20) }, ["paths"]),
  create_project: schema(
    {
      path: text(1, 4_000),
      type: {
        type: "string",
        enum: ["node", "python", "go", "static", "empty"],
      },
      name: text(1, 200),
    },
    ["path", "type"],
  ),
  apply_patch: schema(
    {
      edits: list(
        object(
          {
            path: text(1, 4_000),
            content: text(),
            find: text(),
            replace: text(),
            expectedMatches: number(0, 100_000, true),
            replaceAll: boolean,
          },
          ["path"],
        ),
        30,
      ),
    },
    ["edits"],
  ),
  rollback_patch: schema({ patch_id: text(1, 100) }, ["patch_id"]),
  project_map: schema({}),
  code_search: schema(
    {
      query: text(1, 1_000),
      kind: {
        type: "string",
        enum: ["all", "symbols", "files", "imports", "calls", "references"],
      },
    },
    ["query"],
  ),
  symbol_graph: schema({ symbol: text(1, 500) }, ["symbol"]),
  verify_project: schema({}),
  search_files: schema({ dir: text(1, 4_000), query: text(1, 5_000) }, [
    "query",
  ]),
  find_files: schema({ dir: text(1, 4_000), pattern: text(1, 500) }),
  web_fetch: schema({ url: text(1, 8_000) }, ["url"]),
  stat_path: schema({ path: text(1, 4_000) }, ["path"]),
  make_dir: schema({ path: text(1, 4_000) }, ["path"]),
  append_file: schema({ path: text(1, 4_000), content: text() }, [
    "path",
    "content",
  ]),
  move_path: schema({ from: text(1, 4_000), to: text(1, 4_000) }, [
    "from",
    "to",
  ]),
  delete_path: schema({ path: text(1, 4_000) }, ["path"]),
  get_credits: schema({}),
  list_nodes: schema({}),
  create_grid_job: schema(
    {
      type: { type: "string", enum: ["echo.v1", "embedding.v1"] },
      text: text(0, 100_000),
    },
    ["type", "text"],
  ),
  read_file: schema({ path: text(1, 4_000) }, ["path"]),
  write_file: schema({ path: text(1, 4_000), content: text() }, [
    "path",
    "content",
  ]),
  edit_file: schema({ path: text(1, 4_000), find: text(1), replace: text() }, [
    "path",
    "find",
    "replace",
  ]),
  list_dir: schema({ path: text(1, 4_000) }),
  run_command: schema({ command: text(1), cwd: text(1, 4_000) }, ["command"]),
  spawn_agent: schema({ goal: text(1, 20_000) }, ["goal"]),
};

export function agentToolSchema(
  name: string,
): AgentToolInputSchema | undefined {
  return TOOL_SCHEMAS[name];
}

export interface ToolValidationResult {
  ok: boolean;
  args: Record<string, unknown>;
  error?: string;
  repairs: string[];
}

@Injectable()
export class AgentToolValidationService {
  resolveTool(name: string, tools: AgentTool[]): AgentTool | undefined {
    const requested = this.normalized(name);
    const matches = tools.filter(
      (tool) => this.normalized(tool.name) === requested,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  validate(tool: AgentTool, raw: unknown): ToolValidationResult {
    const repairs: string[] = [];
    let candidate = raw;
    if (tool.name === "apply_patch" && Array.isArray(candidate)) {
      candidate = { edits: candidate };
      repairs.push("wrapped apply_patch array in args.edits");
    } else if (
      Array.isArray(candidate) &&
      candidate.length === 1 &&
      this.isPlainObject(candidate[0])
    ) {
      candidate = candidate[0];
      repairs.push("unwrapped single argument object");
    }
    if (!this.isPlainObject(candidate)) {
      return {
        ok: false,
        args: {},
        error: "args must be a JSON object",
        repairs,
      };
    }
    if (JSON.stringify(candidate).length > 5_000_000) {
      return {
        ok: false,
        args: {},
        error: "tool arguments exceed 5 MB",
        repairs,
      };
    }
    const input = this.sanitizeObject(candidate as Record<string, unknown>);
    if (
      tool.name === "code_search" &&
      input.query === undefined &&
      typeof input.symbol === "string"
    ) {
      input.query = input.symbol;
      delete input.symbol;
      repairs.push("renamed symbol to query");
    }
    const inputSchema = tool.inputSchema ?? TOOL_SCHEMAS[tool.name];
    if (!inputSchema) return { ok: true, args: input, repairs: [] };
    const renamed = this.repairKeys(input, inputSchema.properties, repairs);
    const result = this.validateObject(renamed, inputSchema, "args", repairs);
    return result.ok
      ? {
          ok: true,
          args: result.value as Record<string, unknown>,
          repairs,
        }
      : { ok: false, args: {}, error: result.error, repairs };
  }

  private validateObject(
    value: Record<string, unknown>,
    inputSchema: AgentToolInputSchema | AgentValueSchema,
    path: string,
    repairs: string[],
  ): { ok: true; value: unknown } | { ok: false; error: string } {
    const properties = inputSchema.properties ?? {};
    for (const key of inputSchema.required ?? []) {
      if (!(key in value))
        return { ok: false, error: `${path}.${key} is required` };
    }
    const output: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      const expected = properties[key];
      if (!expected) {
        if (inputSchema.additionalProperties === false)
          repairs.push(`removed unknown ${path}.${key}`);
        else output[key] = raw;
        continue;
      }
      const checked = this.validateValue(
        raw,
        expected,
        `${path}.${key}`,
        repairs,
      );
      if (!checked.ok) return checked;
      output[key] = checked.value;
    }
    return { ok: true, value: output };
  }

  private validateValue(
    raw: unknown,
    valueSchema: AgentValueSchema,
    path: string,
    repairs: string[],
  ): { ok: true; value: unknown } | { ok: false; error: string } {
    let value = raw;
    if (
      valueSchema.type === "string" &&
      ["number", "boolean"].includes(typeof value)
    ) {
      value = String(value);
      repairs.push(`converted ${path} to string`);
    } else if (
      valueSchema.type === "number" &&
      typeof value === "string" &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    ) {
      value = Number(value);
      repairs.push(`converted ${path} to number`);
    } else if (valueSchema.type === "boolean" && typeof value === "string") {
      if (/^(true|false)$/i.test(value)) {
        value = value.toLowerCase() === "true";
        repairs.push(`converted ${path} to boolean`);
      }
    }

    if (valueSchema.type === "array") {
      if (!Array.isArray(value))
        return { ok: false, error: `${path} must be an array` };
      if (
        valueSchema.maxItems !== undefined &&
        value.length > valueSchema.maxItems
      )
        return {
          ok: false,
          error: `${path} accepts at most ${valueSchema.maxItems} items`,
        };
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!valueSchema.items) output.push(value[index]);
        else {
          const checked = this.validateValue(
            value[index],
            valueSchema.items,
            `${path}[${index}]`,
            repairs,
          );
          if (!checked.ok) return checked;
          output.push(checked.value);
        }
      }
      return { ok: true, value: output };
    }
    if (valueSchema.type === "object") {
      if (!this.isPlainObject(value))
        return { ok: false, error: `${path} must be an object` };
      const repaired = this.repairKeys(
        this.sanitizeObject(value as Record<string, unknown>),
        valueSchema.properties ?? {},
        repairs,
      );
      return this.validateObject(repaired, valueSchema, path, repairs);
    }
    if (typeof value !== valueSchema.type)
      return { ok: false, error: `${path} must be ${valueSchema.type}` };
    if (typeof value === "string") {
      if (
        valueSchema.minLength !== undefined &&
        value.length < valueSchema.minLength
      )
        return { ok: false, error: `${path} cannot be empty` };
      if (
        valueSchema.maxLength !== undefined &&
        value.length > valueSchema.maxLength
      )
        return { ok: false, error: `${path} is too long` };
      if (valueSchema.enum && !valueSchema.enum.includes(value)) {
        const stringValue = value;
        const normalized = valueSchema.enum.find(
          (candidate) => candidate.toLowerCase() === stringValue.toLowerCase(),
        );
        if (!normalized)
          return {
            ok: false,
            error: `${path} must be one of: ${valueSchema.enum.join(", ")}`,
          };
        repairs.push(`normalized ${path} to ${normalized}`);
        value = normalized;
      }
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        return { ok: false, error: `${path} must be finite` };
      if (valueSchema.integer && !Number.isInteger(value))
        return { ok: false, error: `${path} must be an integer` };
      if (valueSchema.min !== undefined && value < valueSchema.min)
        return {
          ok: false,
          error: `${path} must be at least ${valueSchema.min}`,
        };
      if (valueSchema.max !== undefined && value > valueSchema.max)
        return {
          ok: false,
          error: `${path} must be at most ${valueSchema.max}`,
        };
    }
    return { ok: true, value };
  }

  private repairKeys(
    input: Record<string, unknown>,
    properties: Record<string, AgentValueSchema>,
    repairs: string[],
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key in properties) {
        output[key] = value;
        continue;
      }
      const matches = Object.keys(properties).filter(
        (candidate) => this.normalized(candidate) === this.normalized(key),
      );
      const match = matches[0];
      if (
        matches.length === 1 &&
        match &&
        !Object.prototype.hasOwnProperty.call(output, match)
      ) {
        output[match] = value;
        repairs.push(`renamed ${key} to ${match}`);
      } else {
        output[key] = value;
      }
    }
    return output;
  }

  private sanitizeObject(
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      output[key] = value;
    }
    return output;
  }

  private normalized(value: string): string {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
}

import "reflect-metadata";
import assert from "node:assert";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const api = process.env.API ?? "http://localhost:8191";
const projectRoot = resolve(process.cwd(), "../..");
const fixture = join(projectRoot, ".runtime", `agent-live-${Date.now()}`);

interface AgentEvent {
  event: string;
  data: Record<string, any>;
}

async function login(): Promise<string> {
  const response = await fetch(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "user@neurion.local",
      password: "ChangeMe!User2026",
    }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  return String((await response.json()).accessToken);
}

function parseEvents(text: string): AgentEvent[] {
  return text
    .split("\n\n")
    .map((frame) => {
      const event = frame.match(/^event:\s*(.+)$/m)?.[1];
      const raw = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (!event || !raw) return null;
      try {
        return { event, data: JSON.parse(raw) } as AgentEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is AgentEvent => event !== null);
}

void (async () => {
  await mkdir(join(fixture, "src"), { recursive: true });
  await writeFile(
    join(fixture, "src", "cart.ts"),
    [
      "export function calculateTotal(items: number[]): number {",
      "  return items.reduce((sum, item) => sum + item, 0);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify(
      {
        name: "neurion-agent-live-test",
        private: true,
        scripts: {
          typecheck:
            "node -e \"const fs=require('fs');const s=fs.readFileSync('src/cart.ts','utf8');const m=s.match(/export function calculateTotal\\([^)]*\\): number \\{([\\s\\S]*?)\\n\\}/);if(!m)process.exit(1);const fn=new Function('items',m[1]);if(fn([1,2])!==5||fn([])!==2)process.exit(1)\"",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const token = await login();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
  const response = await fetch(`${api}/api/agent/stream`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      goal: [
        "Usa prima project_map e code_search per trovare calculateTotal.",
        "Modifica src/cart.ts affinche calculateTotal aggiunga 2 una sola volta al totale finale, dopo items.reduce, non per ogni elemento.",
        "Usa apply_patch, non modificare altri file, verifica il progetto e termina.",
      ].join(" "),
      model: process.env.AGENT_LIVE_MODEL ?? "qwen2.5-coder:7b",
      cwd: fixture,
      computeMode: "local",
      confineToCwd: true,
      autoApprove: true,
    }),
  });
  clearTimeout(timeout);
  const text = await response.text();
  if (!response.ok) throw new Error(`agent request failed: ${response.status}`);
  const events = parseEvents(text);
  const tools = events
    .filter((event) => event.event === "agent.tool_call")
    .map((event) => String(event.data.tool));
  const final = events.find((event) => event.event === "agent.final");
  const review = events.find((event) => event.event === "agent.review_result");
  const error = events.find((event) => event.event === "agent.error");
  const source = await readFile(join(fixture, "src", "cart.ts"), "utf8");

  assert.equal(error, undefined, error?.data?.message);
  assert.ok(tools.includes("project_map"), `missing project_map: ${tools}`);
  assert.ok(tools.includes("code_search"), `missing code_search: ${tools}`);
  assert.ok(
    tools.some((tool) =>
      ["apply_patch", "edit_file", "write_file"].includes(tool),
    ),
    `missing file mutation: ${tools}`,
  );
  assert.ok(tools.includes("verify_project"), `missing verification: ${tools}`);
  assert.equal(review?.data?.verdict, "pass", `review did not pass: ${text}`);
  assert.match(source, /\+\s*2/);
  assert.ok(final?.data?.text, "missing final answer");

  console.log(`PASS agent live flow (${tools.join(" -> ")})`);
  await rm(fixture, { recursive: true, force: true });
})().catch(async (error) => {
  console.error(error);
  await rm(fixture, { recursive: true, force: true });
  process.exit(1);
});

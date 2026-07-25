// Neurion full local E2E. Assumes API (+ Postgres/Redis) running, optionally a
// local chain with NRN deployed (env NRN_TOKEN_ADDRESS/RPC_URL). Self-contains a
// WS node so it exercises the whole grid + verification + reward + payout path.
import WebSocket from "ws";
import { ethers } from "ethers";
import { createHash } from "node:crypto";

const API = process.env.API ?? "http://localhost:8091";
const BASE = `${API}/api`;
const TOKEN_ADDRESS = process.env.NRN_TOKEN_ADDRESS ?? "";
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  ok ? pass++ : fail++;
};

async function req(
  path: string,
  method: string,
  body?: unknown,
  token?: string,
): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function streamTokens(token: string, message: string): Promise<number> {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let tokens = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) if (f.includes("event: token")) tokens++;
  }
  return tokens;
}

function connectNode(nodeId: string, nodeKey: string): WebSocket {
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws/nodes`);
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "node.hello",
        nodeId,
        nodeKey,
        agentVersion: "e2e",
        capabilities: { modes: ["grid"] },
      }),
    ),
  );
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "job.assign") {
      const j = m.job;
      ws.send(
        JSON.stringify({
          type: "job.started",
          jobId: j.id,
          attempt: j.attempt,
        }),
      );
      const result =
        j.type === "echo.v1"
          ? { echo: j.inputJson.text }
          : { vector: [0.1, 0.2, 0.3], dim: 3 };
      ws.send(
        JSON.stringify({
          type: "job.completed",
          jobId: j.id,
          attempt: j.attempt,
          outputJson: { success: true, result },
        }),
      );
    }
  });
  return ws;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 1) health
  const h = await req("/health", "GET");
  check("health", h.status === "ok");
  const dbh = await req("/health/db", "GET");
  check("health/db", dbh.status === "ok");

  // 2) auth
  const user = await req("/auth/login", "POST", {
    email: "user@neurion.local",
    password: "ChangeMe!User2026",
  });
  const admin = await req("/auth/login", "POST", {
    email: "admin@neurion.local",
    password: "ChangeMe!Neurion2026",
  });
  const node = await req("/auth/login", "POST", {
    email: "node@neurion.local",
    password: "ChangeMe!Node2026",
  });
  check(
    "login user/admin/node",
    !!user.accessToken && !!admin.accessToken && !!node.accessToken,
  );

  // 3) chat stream
  const tokens = await streamTokens(
    user.accessToken,
    "Rispondi in una parola: ok?",
  );
  check("chat streams tokens", tokens > 0, `(${tokens} tokens)`);

  // 4) node register + connect
  const reg = await req(
    "/nodes/register",
    "POST",
    { name: "e2e-node", supportedJobTypes: ["echo.v1", "embedding.v1"] },
    node.accessToken,
  );
  const ws = connectNode(reg.nodeId, reg.nodeKey);
  await sleep(1500);
  const nodes = await req("/nodes", "GET", undefined, node.accessToken);
  check(
    "node online",
    nodes.some((n: any) => n.id === reg.nodeId && n.status === "ONLINE"),
  );

  // 5) grid job -> verified -> rewarded
  const job = await req(
    "/jobs",
    "POST",
    {
      type: "echo.v1",
      inputJson: { text: "e2e echo" },
      privacyLevel: "PUBLIC",
    },
    user.accessToken,
  );
  let jobFinal: any;
  for (let i = 0; i < 50; i++) {
    jobFinal = await req(`/jobs/${job.id}`, "GET", undefined, user.accessToken);
    if (["REWARDED", "FAILED"].includes(jobFinal.status)) break;
    await sleep(300);
  }
  check(
    "grid job REWARDED",
    jobFinal.status === "REWARDED",
    `(${jobFinal.status})`,
  );

  // 6) crypto (only if a chain is configured)
  if (TOKEN_ADDRESS) {
    const wallet = ethers.Wallet.createRandom();
    const nonce = await req(
      "/wallet/nonce",
      "POST",
      { address: wallet.address },
      user.accessToken,
    );
    const signature = await wallet.signMessage(nonce.message);
    await req(
      "/wallet/verify",
      "POST",
      { address: wallet.address, nonce: nonce.nonce, signature },
      user.accessToken,
    );
    const payout = await req(
      "/token/request-payout",
      "POST",
      { credits: 3 },
      user.accessToken,
    );
    await req("/token/admin/process-payouts", "POST", {}, admin.accessToken);
    let pf: any;
    for (let i = 0; i < 40; i++) {
      pf = await req(
        `/token/payouts/${payout.id}`,
        "GET",
        undefined,
        user.accessToken,
      );
      if (["CONFIRMED", "FAILED"].includes(pf.status)) break;
      await sleep(300);
    }
    check(
      "NRN payout CONFIRMED",
      pf.status === "CONFIRMED",
      `tx=${pf.txHash?.slice(0, 12)}…`,
    );
  } else {
    console.log("SKIP  crypto (no NRN_TOKEN_ADDRESS)");
  }

  ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

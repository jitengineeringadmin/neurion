// Fake Neurion node (TS) — stands in for the Go agent (Agent 06) for end-to-end
// testing of the WS gateway + grid + verification pipeline without a Go toolchain.
// Logs in, registers a node, connects the WS gateway, and executes echo/embedding jobs.
import WebSocket from 'ws';
import { createHash } from 'node:crypto';

const API = process.env.API ?? 'http://localhost:8091';
const EMAIL = process.env.NODE_EMAIL ?? 'node@neurion.local';
const PASSWORD = process.env.NODE_PASSWORD ?? 'ChangeMe!Node2026';
const RT_MODEL = process.env.RT_MODEL ?? '';
const OLLAMA_BASE = process.env.OLLAMA_BASE ?? 'http://localhost:11434/v1';
const MODES = RT_MODEL ? ['grid', 'realtime'] : ['grid'];

async function post(path: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(`${API}/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function execute(type: string, input: Record<string, unknown>): Record<string, unknown> {
  const startedAt = new Date().toISOString();
  let result: Record<string, unknown>;
  if (type === 'echo.v1') {
    result = { echo: input.text ?? '' };
  } else if (type === 'embedding.v1') {
    const dim = (input.dim as number) ?? 8;
    let seed = createHash('sha256').update(String(input.text ?? '')).digest();
    const vec: number[] = [];
    let i = 0;
    while (vec.length < dim) {
      if (i >= seed.length) {
        seed = createHash('sha256').update(seed).digest();
        i = 0;
      }
      vec.push((seed[i]! / 255) * 2 - 1);
      i++;
    }
    result = { vector: vec, dim };
  } else {
    result = {};
  }
  return { success: true, result, metrics: { startedAt, completedAt: new Date().toISOString() } };
}

// Realtime mode: proxy the chat request to a local OpenAI-compatible endpoint
// (ollama) and stream tokens back as realtime.chat.token (Fast lane, Agent 04).
async function proxyRealtime(send: (m: unknown) => void, msg: any): Promise<void> {
  const requestId = msg.requestId;
  try {
    const res = await fetch(`${OLLAMA_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: msg.model, messages: msg.messages, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`provider HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) send({ type: 'realtime.chat.token', requestId, text: delta });
        } catch {
          /* ignore */
        }
      }
    }
    send({ type: 'realtime.chat.done', requestId, usage: {} });
    console.log(`realtime.chat.done ${requestId}`);
  } catch (e) {
    send({ type: 'realtime.chat.error', requestId, message: (e as Error).message });
  }
}

async function main(): Promise<void> {
  const { accessToken } = await post('/auth/login', { email: EMAIL, password: PASSWORD });
  const reg = await post('/nodes/register', { name: 'fake-node-ts', supportedJobTypes: ['echo.v1', 'embedding.v1'] }, accessToken);
  console.log(`registered node ${reg.nodeId}`);

  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws/nodes`);
  const send = (m: unknown): void => ws.send(JSON.stringify(m));

  ws.on('open', () => {
    send({
      type: 'node.hello',
      nodeId: reg.nodeId,
      nodeKey: reg.nodeKey,
      agentVersion: '0.1.0-fake',
      capabilities: {
        modes: MODES,
        os: 'linux',
        arch: 'amd64',
        cpuCores: 8,
        ramMb: 16384,
        dockerAvailable: true,
        loadedModels: RT_MODEL ? [RT_MODEL] : [],
      },
    });
    setInterval(() => send({ type: 'node.heartbeat', nodeId: reg.nodeId, metrics: { cpuLoad: 12.3, ramUsedMb: 4096 } }), 10_000);
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'hello.ok') {
      console.log('hello.ok — node online');
    } else if (msg.type === 'hello.rejected') {
      console.error('hello rejected:', msg.reason);
      process.exit(1);
    } else if (msg.type === 'job.assign') {
      const job = msg.job;
      console.log(`job.assign ${job.id} (${job.type})`);
      send({ type: 'job.accepted', jobId: job.id });
      send({ type: 'job.started', jobId: job.id });
      const output = execute(job.type, job.inputJson ?? {});
      send({ type: 'job.completed', jobId: job.id, outputJson: output });
      console.log(`job.completed ${job.id}`);
    } else if (msg.type === 'realtime.chat.request') {
      void proxyRealtime(send, msg);
    }
  });

  ws.on('close', () => {
    console.log('ws closed');
    process.exit(0);
  });
  ws.on('error', (e) => {
    console.error('ws error', e.message);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

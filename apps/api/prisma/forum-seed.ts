import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Starter content for the community forum. Idempotent: a thread is created only
// if no thread with the same title already exists. Authored by the first admin.
type Seed = { section: string; title: string; body: string; pinned?: boolean; replies?: string[] };

const THREADS: Seed[] = [
  {
    section: 'announcements',
    title: 'Welcome to the Neurion community forum',
    pinned: true,
    body: `This is the home of the Neurion community. Neurion runs AI on your own machine — chat, a coding agent and images — and lets people pass models and spare power to each other, with nobody in the middle.

A few house rules:
• Be helpful and respectful — we're building this together.
• Search before posting; use the right section.
• No spam, no scams, no sharing of private keys or seed phrases. Ever.

New here? Say hello in Introductions, and check the FAQ in Guides & FAQ. Welcome aboard. ⚡`,
    replies: [`Great to be here — excited to see where this goes!`],
  },
  {
    section: 'announcements',
    title: 'v1.2 is live — Windows, macOS & Linux clients',
    body: `The desktop app is available for all three platforms on the download page (neurionproject.org). It bundles the database, the UI and a local AI runtime — double-click and go.

Highlights:
• Local chat + agent that works on your files
• In-app model downloader (LM-Studio style)
• Wallet + credits
• Single-instance lock (no more black-screen on relaunch)

Report issues in the Desktop App section.`,
  },
  {
    section: 'introductions',
    title: 'Introduce yourself 👋',
    pinned: true,
    body: `New to Neurion? Tell us a bit about yourself: where you're from, what you'll use Neurion for (running AI, hosting a node, building on top), and your hardware if you plan to contribute compute. No pressure — just say hi.`,
    replies: [`Hi all — software engineer, here to run the agent locally on my projects.`, `Hello from the GPU side — got a couple of cards I'd like to put to work.`],
  },
  {
    section: 'guides-faq',
    title: 'FAQ — Frequently Asked Questions (read me first)',
    pinned: true,
    body: `Q: What is Neurion?
A: AI that runs on your own computer. You can work entirely locally, and you can share models and spare power with other people. A router sends each request to the Fast lane (community nodes), the Grid (job nodes) or the engine on your own machine.

Q: Is it free?
A: Everything on your own machine is free. Using other people's compute spends internal credits; sharing yours earns them back.


Q: Do I need a powerful GPU?
A: To just use AI locally, a normal machine + a small model is enough. To host a node serving bigger models, you need real GPU hardware (see the Running a node section).

Q: Is my data private?
A: Local inference never leaves your machine. For network jobs, privacy-first routing keeps sensitive prompts on verified/confidential nodes. See "Privacy: where does my prompt go?".

Q: How do you stop cheaters?
A: Only verified work is paid. Computations are sampled and re-checked against a trusted reference; cheaters are slashed (lose stake) and lose reputation. See Verification & Trust.

Q: Which model should I download?
A: Start with a small 2–3B model (fast, runs on most machines). See "Which model should I run?".

More questions? Ask in this section.`,
  },
  {
    section: 'guides-faq',
    title: 'How to install Neurion (Windows / macOS / Linux)',
    body: `Windows: download the .exe, run it, follow the installer. First launch takes ~30–45s (it sets up a local database + services) — be patient, the splash shows progress.

macOS: download the .dmg (Apple Silicon). First open: right-click the app → Open (it's not notarized yet, so Gatekeeper warns once).

Linux: download the .AppImage, make it executable (chmod +x), run it.

The app bundles everything — no Docker, no cloud account. If you see a black screen, fully quit the app (check it's not still running in the background) and relaunch.`,
  },
  {
    section: 'run-a-node',
    title: 'Hardware guide: what do I need to run a node?',
    body: `Short answer: it depends on what you want to serve.

• Small/edge node: a single consumer GPU (e.g. 8–24GB VRAM) can serve small models (≤7B) for cheap, lower-tier jobs.
• Serious node: a multi-GPU rig or workstation (48GB+) serves bigger models and earns more.
• Frontier models (100B+ MoE): need datacenter-class hardware (multi-H100/H200) — a separate "GRID-Pro" tier. A laptop cannot serve a frontier model whole.

CPU-only works for tiny models but is slow. More VRAM = bigger models = higher reward tier. Post your specs and we'll tell you what you can serve.`,
  },
  {
    section: 'run-a-node',
    title: 'Running a node: step by step',
    body: `1. Download the node agent from the download page (per-OS zip).
2. Register a node in the app (Network → Nodes → Register). Save the nodeKey shown once.
3. Configure the agent with your nodeKey and start it.
4. The agent advertises your capability (VRAM/GPU) and starts receiving jobs.
5. Verified jobs earn credits; failed verification slashes stake.

Keep the node online and honest — reputation compounds, and your earnings scale with it.`,
  },
  {
    section: 'rewards-nrn',
    title: 'How sharing works',
    body: `You earn credits for each verified job your node completes, and they are yours in full — nothing is taken as a fee. They are a way of keeping track of who has given and who has taken, not money.

Reward scales with: model class × active compute × verification tier × reputation. Bigger/harder jobs on higher-trust nodes pay more. Cheating forfeits your stake and drags your other nodes' reputation — honesty is the profitable strategy.`,
  },
  {
    section: 'rewards-nrn',
    title: 'When do on-chain payouts (Base) go live?',
    body: `Neurion has no token and no payouts. Sharing here works the way file sharing always did: you pass on what you already have because it costs you almost nothing, and because a network where everyone does that cannot be switched off by anyone. Track announcements here.`,
  },
  {
    section: 'verification-trust',
    title: 'How Neurion verifies compute (and slashes cheaters)',
    body: `Neurion's invariant: only verified work is paid. Each completed job goes through:
• L1 sanity checks (well-formed output).
• Probabilistic sampling — a fraction of jobs are deep-checked against a trusted reference (more for new/low-rep nodes, 100% for high-value).
• Reputation (EWMA) updated on deep outcomes; honest nodes get sampled less.
• Slashing — a proven cheat forfeits stake, refunds the user, and drags the owner's other nodes.
• A bonded dispute market lets anyone challenge a result.

For frontier models, full re-execution is too expensive, so the roadmap adds activation-commitment proofs (TopLoc-style) and optional hardware attestation (TEE). Discuss here.`,
  },
  {
    section: 'chat-agent',
    title: 'Tips for using the agent on your files',
    body: `The agent plans, uses tools and works on your files (with approval). Tips:
• Give a clear goal ("analyze this folder and summarize the architecture").
• Drop a project folder into the sidebar to scope it.
• Keep AGENT approvals on for anything that writes/deletes.
• Use a coder model (e.g. qwen2.5-coder) for code-heavy tasks.

Share your best prompts here.`,
  },
  {
    section: 'chat-agent',
    title: 'Privacy: where does my prompt go?',
    body: `If you run a model locally (desktop app), your prompt never leaves your machine — full privacy.

For network jobs, a privacy classifier routes sensitive prompts only to verified/confidential nodes. Note: pipeline-distributed inference across third-party nodes is not fully private (activations transit nodes) — confidential (TEE) routing is the path for strict confidentiality. Run locally for anything sensitive today.`,
  },
  {
    section: 'models',
    title: 'Which model should I run? (size vs speed)',
    body: `Rule of thumb on a normal machine:
• 0.5–2B: very fast, basic. Good for quick chat / low-end hardware.
• 3B (e.g. qwen2.5:3b): best all-round small model. Recommended starting point.
• 7–8B: noticeably smarter, needs more RAM/VRAM, slower on CPU.
• Coder variants (qwen2.5-coder): better for code/agent tasks.

Bigger = smarter but slower. Download from the Models tab and set a default. What are you running? Post your favorites.`,
  },
  {
    section: 'models',
    title: 'Can Neurion run a frontier model (GLM / DeepSeek-scale)?',
    body: `Not on a single consumer node — a 355B–700B MoE needs hundreds of GB of VRAM (multi-H100/H200). The realistic path is a "GRID-Pro" tier: serious rigs serving the model whole, plus pipeline-sharding across capable nodes for capacity. Expect batch-style latency (~1–3 tok/s single stream), not snappy chat. It's feasible as a federated network of serious nodes, not "any laptop runs the 700B". Deep-dive discussions welcome.`,
  },
  {
    section: 'desktop-app',
    title: 'Black screen on launch? Read this',
    body: `The app takes ~30–45s to start the first time (it initializes an embedded database + services). A black window usually means either (a) it's still booting — wait, or (b) a previous instance is still running and holding the ports.

Fix: fully quit Neurion (make sure no leftover process), then relaunch and wait. v1.2 added a single-instance lock + a retry/error page so this should be rare now. Still stuck? Post your OS + what you see.`,
  },
  {
    section: 'desktop-app',
    title: 'Roadmap: bundled AI engine + auto-update',
    body: `Coming: the desktop app will bundle the local AI engine (ollama) and auto-start it, so fresh users get a working engine without a manual install. Auto-update is also planned. What else would make the desktop experience better?`,
  },
  {
    section: 'dev-api',
    title: 'Is there an API? Integrations roadmap',
    body: `The backend exposes a REST API (auth, chat/stream SSE, jobs, nodes, forum, wallet). A documented public API + SDKs are on the roadmap so you can build on Neurion. What integrations would you want first?`,
  },
  {
    section: 'ideas',
    title: 'Share your feature ideas here 💡',
    pinned: true,
    body: `Got an idea to make Neurion better? Post it here — one idea per reply is easiest to discuss and vote on. The team reads this section.`,
    replies: [`Mobile PWA so I can chat from my phone.`, `A leaderboard for top-earning nodes.`],
  },
  {
    section: 'offtopic',
    title: 'Show your rig / setup',
    body: `Post a photo or specs of the machine you run Neurion (or your node) on. Always fun to see what the community is building with.`,
  },
];

async function main(): Promise<void> {
  const author =
    (await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } })) ??
    (await prisma.user.findFirst({ where: { role: 'ADMIN' } })) ??
    (await prisma.user.findFirst());
  if (!author) throw new Error('no user to author forum seed content');

  let created = 0;
  for (const s of THREADS) {
    const existing = await prisma.forumThread.findFirst({ where: { title: s.title } });
    if (existing) continue;
    const section = await prisma.forumSection.findUnique({ where: { id: s.section } });
    if (!section) {
      // eslint-disable-next-line no-console
      console.warn('skip (no section):', s.section, '-', s.title);
      continue;
    }
    const thread = await prisma.forumThread.create({
      data: { authorId: author.id, sectionId: s.section, title: s.title, body: s.body, pinned: s.pinned ?? false },
    });
    for (const r of s.replies ?? []) {
      await prisma.forumPost.create({ data: { threadId: thread.id, authorId: author.id, body: r } });
    }
    await prisma.forumThread.update({ where: { id: thread.id }, data: { lastActivityAt: new Date() } });
    created += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`Forum seed: ${created} threads created (skipped ${THREADS.length - created} existing).`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());

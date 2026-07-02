import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobPrivacyLevel } from '@prisma/client';
import { ProviderResolverService } from '../ai/provider-resolver.service';
import { RealtimePoolService, WarmMatch } from '../ai/realtime-pool.service';
import { CreditsService } from '../credits/credits.service';
import { AgentSettingsService } from './agent-settings.service';
import { AiProvider, ChatMsg } from '../ai/providers/ai-provider.interface';
import { RelayProvider } from '../ai/providers/relay.provider';
import { AgentToolsService } from './agent-tools.service';
import { AgentApprovalService } from './agent-approval.service';
import { AgentMemoryService } from './agent-memory.service';
import { AgentAction, AgentTool, ComputeMode, ToolCtx } from './agent.types';

const MAX_STEPS = 6;
const MAX_DEPTH = 2;
const SUB_MAX_STEPS = 4;
// Tools that mutate the machine or execute code -> require human approval.
const DANGEROUS = new Set([
  'run_command', 'write_file', 'edit_file', 'append_file', 'move_path', 'delete_path', 'create_project', 'apply_patch',
]);

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    private readonly toolsService: AgentToolsService,
    private readonly resolver: ProviderResolverService,
    private readonly config: ConfigService,
    private readonly approvals: AgentApprovalService,
    private readonly memory: AgentMemoryService,
    private readonly pool: RealtimePoolService,
    private readonly credits: CreditsService,
    private readonly settings: AgentSettingsService,
  ) {}

  // Resolve where the LLM brain runs for this run, per the user-chosen mode.
  // Sets ctx.provider / resolvedModel / isNetwork / nodeId. Returns ok:false only
  // when the user forced "network" but no node is available.
  private async resolveCompute(ctx: ToolCtx): Promise<{ ok: true } | { ok: false; reason: string }> {
    const local = await this.resolver.resolveFallback();
    const localModel = ctx.model || this.config.get<string>('AI_AGENT_MODEL') || local.model;
    const mode: ComputeMode = ctx.computeMode || 'ask';
    const netModel = ctx.networkModel || this.config.get<string>('AI_AGENT_NETWORK_MODEL') || localModel;
    const setLocal = () => {
      ctx.provider = local.provider;
      ctx.resolvedModel = localModel;
      ctx.isNetwork = false;
      ctx.nodeId = undefined;
    };
    const setNet = (w: WarmMatch) => {
      ctx.provider = w.provider;
      ctx.resolvedModel = w.model;
      ctx.isNetwork = true;
      ctx.nodeId = w.nodeId;
    };

    if (mode === 'local') {
      setLocal();
      return { ok: true };
    }

    // Relay path (desktop): the shared node pool lives on a REMOTE API, reached via
    // /ai/infer. The agent loop stays local (for file tools); only the LLM is remote.
    // Node-finding + billing happen remotely, so a runtime miss just soft-falls back
    // to local in callLLM.
    if (ctx.relayBase && ctx.relayToken) {
      const setRelay = () => {
        ctx.provider = new RelayProvider(ctx.relayBase as string, ctx.relayToken as string);
        ctx.resolvedModel = netModel;
        ctx.isNetwork = true;
        ctx.relayed = true;
        ctx.nodeId = undefined;
      };
      if (mode === 'network' || mode === 'auto') {
        setRelay();
        return { ok: true };
      }
      // ask
      const id = randomUUID();
      const pending = this.approvals.wait(id);
      ctx.emit('agent.compute_request', { id, model: netModel, nodeId: null });
      if (await pending) setRelay();
      else setLocal();
      return { ok: true };
    }

    const warm = await this.pool.findWarm(netModel, 'PUBLIC' as JobPrivacyLevel).catch(() => null);

    if (mode === 'network') {
      if (!warm) return { ok: false, reason: `no online node serving ${netModel}` };
      setNet(warm);
      return { ok: true };
    }
    if (mode === 'auto') {
      const bal = await this.credits.getBalance(ctx.user.sub).catch(() => 0);
      if (warm && bal > 0) setNet(warm);
      else setLocal();
      return { ok: true };
    }
    // ask: if a node exists, let the user decide (reuses the approval channel)
    if (!warm) {
      setLocal();
      return { ok: true };
    }
    const id = randomUUID();
    const pending = this.approvals.wait(id);
    ctx.emit('agent.compute_request', { id, model: warm.model, nodeId: warm.nodeId });
    if (await pending) setNet(warm);
    else setLocal();
    return { ok: true };
  }

  // Charge the user + reward the node for the network LLM tokens used this run.
  private async meterNetwork(ctx: ToolCtx): Promise<void> {
    if (ctx.relayed) return; // billed + rewarded on the remote /ai/infer endpoint
    if (!ctx.isNetwork || !ctx.nodeId || !ctx.meter || ctx.meter.networkChars <= 0) return;
    const ref = `agent:${ctx.user.sub}:${randomUUID()}`;
    const estTokens = Math.ceil(ctx.meter.networkChars / 4);
    const ratePer1k = Number(this.config.get<string>('AI_REALTIME_REWARD_PER_1K_TOKENS') ?? '1') || 1;
    const cost = Math.max(1, Math.round((estTokens / 1000) * ratePer1k));
    await this.credits.spend(ctx.user.sub, cost, 'AGENT_NETWORK', { idempotencyKey: ref }).catch(() => undefined);
    await this.pool.rewardServe(ctx.nodeId, ctx.meter.networkChars, ref).catch(() => undefined);
    ctx.emit('agent.compute_billed', { credits: cost, nodeId: ctx.nodeId });
  }

  private requireApproval(): boolean {
    return String(this.config.get('AGENT_REQUIRE_APPROVAL') ?? 'true') !== 'false';
  }

  private toolset(ctx: ToolCtx): AgentTool[] {
    let tools = [...this.toolsService.tools()];
    // A coding workspace (a folder is open) hides the network/economy tools —
    // small local models otherwise wander into list_nodes / create_grid_job / wallet
    // for a plain "make a landing page". Those stay only for the no-folder network use.
    if (ctx.cwd) {
      const NETWORK_TOOLS = new Set(['create_grid_job', 'list_nodes', 'get_credits']);
      tools = tools.filter((t) => !NETWORK_TOOLS.has(t.name));
    }
    if (ctx.depth < MAX_DEPTH) {
      tools.push({
        name: 'spawn_agent',
        description: 'Delegate a focused sub-task to a sub-agent and receive its result. Use for independent sub-problems.',
        params: { goal: 'the self-contained sub-task for the sub-agent' },
        run: async (args, c) => {
          const goal = String(args.goal ?? '');
          c.emit('agent.subagent.start', { depth: c.depth + 1, goal });
          const result = await this.run(goal, { ...c, depth: c.depth + 1 }, true);
          c.emit('agent.subagent.end', { depth: c.depth + 1, result });
          return result;
        },
      });
    }
    return tools;
  }

  private systemPrompt(tools: AgentTool[], memories: string[] = [], cwd?: string, goal = ''): string {
    const memBlock =
      memories.length > 0
        ? '\n\nPersistent memory (facts you were told to remember):\n' + memories.map((m) => `- ${m}`).join('\n')
        : '';
    const cwdBlock = cwd
      ? `\n\nProject working directory: ${cwd}\nRelative file paths and run_command resolve inside this directory. Prefer relative paths.`
      : '';
    const list = tools
      .map((t) => {
        const p = Object.entries(t.params).map(([k, d]) => `${k} (${d})`).join(', ');
        return `- ${t.name}(${p}): ${t.description}`;
      })
      .join('\n');
    return [
      'You are Neurion Agent, an autonomous assistant on a distributed AI compute network.',
      'Solve the user GOAL by reasoning step-by-step and using tools.',
      '',
      'Reply with EXACTLY ONE JSON object and nothing else, one of:',
      '1) Use a tool:  {"thought":"brief reason","tool":"tool_name","args":{ ... }}',
      '2) Finish:      {"final":"your complete answer for the user"}',
      '',
      'WRITING FILES — do NOT put the file body inside the JSON (quotes and newlines',
      'break it). Instead put only the path in args, then the RAW content between a',
      '<<<FILE line and a FILE line, like this:',
      '{"thought":"create the page","tool":"write_file","args":{"path":"index.html"}}',
      '<<<FILE',
      '<!DOCTYPE html>',
      '<html> ... the whole file, verbatim, unescaped ... </html>',
      'FILE',
      '',
      'Available tools:',
      list,
      '',
      'After each tool call you get an "Observation:". Use it. Never invent tool results.',
      'In file paths use forward slashes, e.g. "C:/Users/name/file.txt".',
      'For a multi-step goal, FIRST call set_plan with the list of steps, then work through',
      'them, calling update_plan(index, done=true) as you complete each. To scaffold a new',
      'project use create_project. To change several files at once use apply_patch.',
      'You can remember(note) facts for future sessions and recall() them.',
      'Stay strictly on the GOAL. Do NOT explore the network, nodes, credits or run',
      'jobs unless the goal explicitly asks for it. Prefer finishing quickly — when the',
      'goal is done, return {"final": ...}.',
    ].join('\n') + cwdBlock + this.userInstructions(cwd) + this.webGuidance(goal) + memBlock;
  }

  /** Global Settings instructions + a per-project rules file (NEURION.md etc.) if the
   * open folder has one. Project rules come after the global ones (more specific). */
  private allRules(cwd?: string): string {
    const global = this.settings.get().instructions.trim();
    const project = this.projectRules(cwd);
    return [global, project].filter(Boolean).join('\n\n');
  }
  /** First recognised instruction file in the working folder, if any. */
  private projectRules(cwd?: string): string {
    if (!cwd) return '';
    for (const name of ['NEURION.md', 'AGENTS.md', 'CLAUDE.md', '.neurion.md']) {
      try {
        const p = join(cwd, name);
        if (existsSync(p)) return readFileSync(p, 'utf8').slice(0, 12_000).trim();
      } catch {
        /* unreadable — try next */
      }
    }
    return '';
  }

  /** The always-follow rules — high priority (system prompt copy). */
  private userInstructions(cwd?: string): string {
    const rules = this.allRules(cwd);
    if (!rules) return '';
    return '\n\n=== USER INSTRUCTIONS (always follow these) ===\n' + rules + '\n=== END USER INSTRUCTIONS ===';
  }

  /** Same rules, restated in the user turn (where small models actually obey them). */
  private userRulesForTurn(cwd?: string): string {
    const rules = this.allRules(cwd);
    if (!rules) return '';
    return `RULES I must follow for everything below:\n${rules}\n\n`;
  }

  /** Design guidance so even a small local model makes a decent site (Tailwind does
   * the visual heavy lifting; the model just fills structure + content). */
  private webGuidance(goal: string): string {
    if (!/\b(sito|site|website|web|landing|pagina|page|html|homepage|portfolio|blog)\b/i.test(goal)) return '';
    return [
      '',
      '',
      'WEBSITE TASK — this is your ONLY job. Do it in exactly TWO steps:',
      'STEP 1: one write_file of a COMPLETE index.html (using the <<<FILE fence).',
      'STEP 2: {"final":"Ready — open index.html."}. Nothing else.',
      'Do NOT call set_plan, update_plan, edit_file, run_command or read_file. Do NOT',
      'write the file twice or edit it afterwards — get it right in the single write.',
      '',
      'The index.html MUST be a full, good-looking, self-contained page:',
      '- In <head>: <script src="https://cdn.tailwindcss.com"></script> + a Google Font.',
      '- ALL visible content goes INSIDE <body> (nav, hero, sections, footer) — never in',
      '  <head>. Style everything with Tailwind utility classes.',
      '- Structure inside <body>: a sticky top nav; a HERO (min-h-[70vh], flex, centered,',
      '  a big heading text-5xl md:text-6xl font-bold, a subtitle, a CTA button, a',
      '  background gradient or image); then 3–4 <section class="py-20"> relevant to the',
      '  topic (restaurant → Menu with cards, Chi siamo, Galleria as an image grid,',
      '  Contatti with hours); then a <footer>.',
      '- Modern: container mx-auto, generous spacing, rounded-2xl shadow cards, hover',
      '  states, a coherent color palette, responsive (md:/lg: classes everywhere).',
      '- Real Italian copy (menu dishes, prices, address), NOT lorem ipsum. Images from',
      '  https://picsum.photos/seed/<word>/800/600 .',
      '- Aim for a rich page (150+ lines). A near-empty <body> is a FAILURE.',
    ].join('\n');
  }

  private async streamAll(p: AiProvider, messages: ChatMsg[], model: string): Promise<string> {
    let full = '';
    for await (const t of p.streamChat(messages, model)) full += t;
    return full;
  }

  private async callLLM(ctx: ToolCtx, messages: ChatMsg[]): Promise<string> {
    try {
      const full = await this.streamAll(ctx.provider as AiProvider, messages, ctx.resolvedModel as string);
      if (ctx.isNetwork && ctx.meter) ctx.meter.networkChars += full.length;
      return full;
    } catch (e) {
      // soft fallback: a network node failed mid-run -> finish on the local model
      if (ctx.isNetwork) {
        const local = await this.resolver.resolveFallback();
        ctx.provider = local.provider;
        ctx.resolvedModel = ctx.model || this.config.get<string>('AI_AGENT_MODEL') || local.model;
        ctx.isNetwork = false;
        ctx.nodeId = undefined;
        ctx.emit('agent.compute_fallback', { reason: (e as Error).message });
        return this.streamAll(ctx.provider, messages, ctx.resolvedModel as string);
      }
      throw e;
    }
  }

  /** Tolerant extraction of the first JSON object from model output. */
  private parseAction(text: string): AgentAction {
    // Content-fence: small models can't reliably JSON-escape a whole HTML/JS file, so
    // we let them put file content OUTSIDE the JSON, between <<<FILE and FILE. Capture
    // it, strip it, then parse the (now small) JSON and re-attach as args.content.
    let fenced: string | null = null;
    const fence = text.match(/<<<FILE\r?\n([\s\S]*?)\r?\nFILE\b/);
    if (fence) {
      fenced = fence[1] ?? '';
      text = text.slice(0, fence.index) + text.slice((fence.index ?? 0) + fence[0].length);
    }
    const attach = (a: AgentAction): AgentAction => {
      if (fenced !== null && a && a.tool) a.args = { ...(a.args ?? {}), content: fenced };
      return a;
    };
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
    const start = cleaned.indexOf('{');
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') {
          depth--;
          if (depth === 0) {
            const candidate = cleaned.slice(start, i + 1);
            // Windows paths etc.: escape lone backslashes that aren't valid JSON escapes.
            const safe = candidate.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
            try {
              return attach(JSON.parse(candidate) as AgentAction);
            } catch {
              try {
                return attach(JSON.parse(safe) as AgentAction);
              } catch {
                // Small local models emit almost-JSON: curly quotes, a stray single
                // quote closing a double-quoted string ("…estetiche.',), trailing
                // commas. Repair those before giving up.
                const repaired = safe
                  .replace(/[‘’]/g, "'")
                  .replace(/[“”]/g, '"')
                  .replace(/'\s*,/g, '",')
                  .replace(/'\s*([}\]])/g, '"$1')
                  .replace(/,\s*([}\]])/g, '$1');
                try {
                  return attach(JSON.parse(repaired) as AgentAction);
                } catch {
                  break;
                }
              }
            }
          }
        }
      }
    }
    const t = text.trim();
    // Never dump a broken tool-call JSON on the user as the "answer".
    if (/^\{\s*"?thought"?/.test(t) && /"tool"/.test(t)) {
      return { final: 'Il modello ha prodotto un passaggio non valido e la corsa si è fermata. Riprova (di solito al secondo tentativo va), o scegli un modello più adatto al codice come qwen2.5-coder.' };
    }
    return { final: t }; // model didn't follow format -> treat as the answer
  }

  /** Run the agent loop for a goal. Emits agent.* events. Returns the final answer. */
  async run(goal: string, ctx: ToolCtx, isSub = false): Promise<string> {
    if (ctx.depth === 0 && !ctx.provider) {
      ctx.meter = { networkChars: 0 };
      const r = await this.resolveCompute(ctx);
      if (!r.ok) {
        const msg = `No network node is available (${r.reason}). Switch Compute to "Local" or "Auto", or wait for a node to come online.`;
        ctx.emit('agent.final', { depth: 0, text: msg });
        return msg;
      }
      ctx.emit('agent.compute', { lane: ctx.isNetwork ? 'network' : 'local', model: ctx.resolvedModel ?? null, nodeId: ctx.nodeId ?? null });
    }
    try {
      return await this.loop(goal, ctx, isSub);
    } finally {
      if (ctx.depth === 0) await this.meterNetwork(ctx).catch(() => undefined);
    }
  }

  private async loop(goal: string, ctx: ToolCtx, isSub: boolean): Promise<string> {
    const tools = this.toolset(ctx);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const memories = ctx.depth === 0 ? (await this.memory.recent(ctx.user.sub, 15)).map((m) => m.content) : [];
    const messages: ChatMsg[] = [
      { role: 'system', content: this.systemPrompt(tools, memories, ctx.cwd, goal) },
      // Reinforce the user's own rules right next to the GOAL — small models weight the
      // user turn far more than the system prompt, so this is where instructions stick.
      { role: 'user', content: `${this.userRulesForTurn(ctx.cwd)}GOAL: ${goal}` },
    ];
    const maxSteps = isSub ? SUB_MAX_STEPS : MAX_STEPS;

    for (let step = 0; step < maxSteps; step++) {
      const raw = await this.callLLM(ctx, messages);
      const action = this.parseAction(raw);

      if (action.final !== undefined || !action.tool) {
        // Model finished. Some small models emit {"thought":"<the answer>","tool":null}
        // instead of {"final":...} — use the thought rather than dumping raw JSON.
        const answer = action.final ?? ((action.thought && action.thought.trim()) || raw.trim());
        ctx.emit('agent.final', { depth: ctx.depth, text: answer });
        return answer;
      }

      ctx.emit('agent.tool_call', { depth: ctx.depth, step, thought: action.thought ?? '', tool: action.tool, args: action.args ?? {} });
      const tool = byName.get(action.tool);
      let observation: string;
      if (!tool) {
        observation = `error: unknown tool "${action.tool}". Available: ${[...byName.keys()].join(', ')}`;
      } else if (this.requireApproval() && !ctx.autoApprove && DANGEROUS.has(tool.name)) {
        // human-in-the-loop: pause until the user approves or denies this action.
        const approvalId = randomUUID();
        const pending = this.approvals.wait(approvalId); // register BEFORE emit to avoid a fast-approve race
        ctx.emit('agent.approval_request', { id: approvalId, depth: ctx.depth, tool: tool.name, args: action.args ?? {} });
        const approved = await pending;
        ctx.emit('agent.approval_result', { id: approvalId, tool: tool.name, approved });
        if (!approved) {
          observation = 'denied by user — action not executed. Choose a different approach or finish.';
        } else {
          try {
            observation = await tool.run(action.args ?? {}, ctx);
          } catch (e) {
            observation = `error: ${(e as Error).message}`;
          }
        }
      } else {
        try {
          observation = await tool.run(action.args ?? {}, ctx);
        } catch (e) {
          observation = `error: ${(e as Error).message}`;
        }
      }
      ctx.emit('agent.tool_result', { depth: ctx.depth, step, tool: action.tool, result: observation });

      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `Observation: ${observation}` });
    }

    // out of steps -> ask for a final summary
    messages.push({ role: 'user', content: 'Stop using tools. Reply now with {"final": "..."} summarising the result.' });
    const wrap = this.parseAction(await this.callLLM(ctx, messages));
    const answer = wrap.final ?? 'Reached step limit without a final answer.';
    ctx.emit('agent.final', { depth: ctx.depth, text: answer });
    return answer;
  }
}

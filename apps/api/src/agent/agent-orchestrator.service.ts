import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ProviderResolverService } from '../ai/provider-resolver.service';
import { ChatMsg } from '../ai/providers/ai-provider.interface';
import { AgentToolsService } from './agent-tools.service';
import { AgentApprovalService } from './agent-approval.service';
import { AgentMemoryService } from './agent-memory.service';
import { AgentAction, AgentTool, ToolCtx } from './agent.types';

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
  ) {}

  private requireApproval(): boolean {
    return String(this.config.get('AGENT_REQUIRE_APPROVAL') ?? 'true') !== 'false';
  }

  private toolset(ctx: ToolCtx): AgentTool[] {
    const tools = [...this.toolsService.tools()];
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

  private systemPrompt(tools: AgentTool[], memories: string[] = []): string {
    const memBlock =
      memories.length > 0
        ? '\n\nPersistent memory (facts you were told to remember):\n' + memories.map((m) => `- ${m}`).join('\n')
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
      'Available tools:',
      list,
      '',
      'After each tool call you get an "Observation:". Use it. Never invent tool results.',
      'In file paths use forward slashes, e.g. "C:/Users/name/file.txt".',
      'For a multi-step goal, FIRST call set_plan with the list of steps, then work through',
      'them, calling update_plan(index, done=true) as you complete each. To scaffold a new',
      'project use create_project. To change several files at once use apply_patch.',
      'You can remember(note) facts for future sessions and recall() them.',
      'Prefer finishing quickly. When you have enough information, return {"final": ...}.',
    ].join('\n') + memBlock;
  }

  private async callLLM(messages: ChatMsg[], override?: string): Promise<string> {
    const resolved = await this.resolver.resolveFallback();
    const model = override || this.config.get<string>('AI_AGENT_MODEL') || resolved.model;
    let full = '';
    for await (const t of resolved.provider.streamChat(messages, model)) full += t;
    return full;
  }

  /** Tolerant extraction of the first JSON object from model output. */
  private parseAction(text: string): AgentAction {
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
              return JSON.parse(candidate) as AgentAction;
            } catch {
              try {
                return JSON.parse(safe) as AgentAction;
              } catch {
                break;
              }
            }
          }
        }
      }
    }
    return { final: text.trim() }; // model didn't follow format -> treat as the answer
  }

  /** Run the agent loop for a goal. Emits agent.* events. Returns the final answer. */
  async run(goal: string, ctx: ToolCtx, isSub = false): Promise<string> {
    const tools = this.toolset(ctx);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const memories = ctx.depth === 0 ? (await this.memory.recent(ctx.user.sub, 15)).map((m) => m.content) : [];
    const messages: ChatMsg[] = [
      { role: 'system', content: this.systemPrompt(tools, memories) },
      { role: 'user', content: `GOAL: ${goal}` },
    ];
    const maxSteps = isSub ? SUB_MAX_STEPS : MAX_STEPS;

    for (let step = 0; step < maxSteps; step++) {
      const raw = await this.callLLM(messages, ctx.model);
      const action = this.parseAction(raw);

      if (action.final !== undefined || !action.tool) {
        const answer = action.final ?? raw.trim();
        ctx.emit('agent.final', { depth: ctx.depth, text: answer });
        return answer;
      }

      ctx.emit('agent.tool_call', { depth: ctx.depth, step, thought: action.thought ?? '', tool: action.tool, args: action.args ?? {} });
      const tool = byName.get(action.tool);
      let observation: string;
      if (!tool) {
        observation = `error: unknown tool "${action.tool}". Available: ${[...byName.keys()].join(', ')}`;
      } else if (this.requireApproval() && DANGEROUS.has(tool.name)) {
        // human-in-the-loop: pause until the user approves or denies this action.
        const approvalId = randomUUID();
        ctx.emit('agent.approval_request', { id: approvalId, depth: ctx.depth, tool: tool.name, args: action.args ?? {} });
        const approved = await this.approvals.wait(approvalId);
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
    const wrap = this.parseAction(await this.callLLM(messages, ctx.model));
    const answer = wrap.final ?? 'Reached step limit without a final answer.';
    ctx.emit('agent.final', { depth: ctx.depth, text: answer });
    return answer;
  }
}

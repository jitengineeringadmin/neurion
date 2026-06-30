import { AuthUser } from '../common/decorators/current-user.decorator';
import { AiProvider } from '../ai/providers/ai-provider.interface';

export type AgentEmit = (event: string, data: unknown) => void;

// Where the agent's LLM brain runs — chosen by the user (like Claude's permission modes).
export type ComputeMode = 'ask' | 'auto' | 'local' | 'network';

export interface ToolCtx {
  user: AuthUser;
  emit: AgentEmit;
  depth: number;
  model?: string;
  cwd?: string; // project working directory; relative paths + run_command resolve here
  // compute selection (set by the controller from the client):
  computeMode?: ComputeMode;
  networkModel?: string; // the bigger model to look for on a network node
  // resolved once at run start (depth 0), inherited by sub-agents:
  provider?: AiProvider;
  resolvedModel?: string;
  nodeId?: string;
  isNetwork?: boolean;
  meter?: { networkChars: number };
}

export interface AgentTool {
  name: string;
  description: string;
  /** param name -> human description, rendered into the system prompt */
  params: Record<string, string>;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

export interface AgentAction {
  thought?: string;
  tool?: string;
  args?: Record<string, unknown>;
  final?: string;
}

import { AuthUser } from '../common/decorators/current-user.decorator';

export type AgentEmit = (event: string, data: unknown) => void;

export interface ToolCtx {
  user: AuthUser;
  emit: AgentEmit;
  depth: number;
  model?: string;
  cwd?: string; // project working directory; relative paths + run_command resolve here
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

import { AuthUser } from "../common/decorators/current-user.decorator";
import { AiProvider } from "../ai/providers/ai-provider.interface";

export type AgentEmit = (event: string, data: unknown) => void;

// Where the agent's LLM brain runs — chosen by the user (like Claude's permission modes).
export type ComputeMode = "ask" | "auto" | "local" | "network";

export interface ToolCtx {
  user: AuthUser;
  emit: AgentEmit;
  depth: number;
  model?: string;
  cwd?: string; // project working directory; relative paths + run_command resolve here
  confine?: boolean; // when true (+cwd set), the agent may only touch files inside cwd (per-request sandbox)
  autoApprove?: boolean; // Claude-Code "autonomous" mode: run write/shell tools without pausing for approval
  // compute selection (set by the controller from the client):
  computeMode?: ComputeMode;
  networkModel?: string; // the bigger model to look for on a network node
  // desktop relay: reach a REMOTE API's shared pool for the network LLM step while
  // the agent loop stays local. When set, the network lane streams via /ai/infer.
  relayBase?: string;
  relayToken?: string;
  // resolved once at run start (depth 0), inherited by sub-agents:
  provider?: AiProvider;
  resolvedModel?: string;
  nodeId?: string;
  isNetwork?: boolean;
  relayed?: boolean; // network LLM served by the remote relay (billed remotely)
  meter?: { networkChars: number };
  runId?: string;
  parentRunId?: string;
  cancelSignal?: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  /** param name -> human description, rendered into the system prompt */
  params: Record<string, string>;
  inputSchema?: AgentToolInputSchema;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

export interface AgentValueSchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  enum?: string[];
  integer?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  items?: AgentValueSchema;
  properties?: Record<string, AgentValueSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentToolInputSchema {
  properties: Record<string, AgentValueSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentAction {
  thought?: string;
  tool?: string;
  args?: Record<string, unknown>;
  final?: string;
  invalid?: string;
}

import { z } from 'zod';

// Node WebSocket protocol (spec §10.5). Minimal envelope set for bootstrap.

export const NodeHello = z.object({
  type: z.literal('node.hello'),
  nodeId: z.string(),
  nodeKey: z.string(),
  agentVersion: z.string(),
  capabilities: z.object({
    modes: z.array(z.string()),
    os: z.string().optional(),
    arch: z.string().optional(),
    cpuCores: z.number().optional(),
    ramMb: z.number().optional(),
    gpuVendor: z.string().optional(),
    gpuModel: z.string().optional(),
    gpuMemoryMb: z.number().optional(),
    dockerAvailable: z.boolean().optional(),
    nvidiaAvailable: z.boolean().optional(),
    loadedModels: z.array(z.string()).optional(),
    avgFirstTokenMs: z.number().optional(),
    avgTokensPerSecond: z.number().optional(),
  }),
});
export type NodeHello = z.infer<typeof NodeHello>;

export const NodeHeartbeat = z.object({
  type: z.literal('node.heartbeat'),
  nodeId: z.string(),
  metrics: z.object({
    cpuLoad: z.number().optional(),
    ramUsedMb: z.number().optional(),
    gpuLoad: z.number().optional(),
    gpuTempC: z.number().optional(),
    freeDiskMb: z.number().optional(),
    activeRealtimeSessions: z.number().optional(),
    tokensPerSecond: z.number().optional(),
  }),
});
export type NodeHeartbeat = z.infer<typeof NodeHeartbeat>;

export const WorkerOutput = z.object({
  success: z.boolean(),
  result: z.unknown(),
  metrics: z
    .object({
      startedAt: z.string(),
      completedAt: z.string(),
      durationMs: z.number(),
      cpuMs: z.number().optional(),
      gpuMs: z.number().optional(),
      memoryPeakMb: z.number().optional(),
    })
    .optional(),
});
export type WorkerOutput = z.infer<typeof WorkerOutput>;

import { Injectable } from '@nestjs/common';

/**
 * Human-in-the-loop approval gate. The agent loop awaits wait(id); a separate
 * HTTP call (POST /api/agent/approve) resolves it. Times out to denied.
 */
@Injectable()
export class AgentApprovalService {
  private readonly pending = new Map<string, { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }>();

  wait(id: string, timeoutMs = 180_000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(approved);
    return true;
  }
}

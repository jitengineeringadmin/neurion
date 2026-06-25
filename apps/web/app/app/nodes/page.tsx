'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { theme, card, input, button } from '../../../lib/ui';

export default function NodesPage() {
  const [nodes, setNodes] = useState<any[]>([]);
  const [name, setName] = useState('my-node');
  const [secret, setSecret] = useState<{ nodeId: string; nodeKey: string } | null>(null);

  const load = () => api<any[]>('/nodes').then(setNodes).catch(() => undefined);
  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  async function register() {
    const res = await api<{ nodeId: string; nodeKey: string }>('/nodes/register', {
      method: 'POST',
      body: JSON.stringify({ name, supportedJobTypes: ['echo.v1', 'embedding.v1'] }),
    });
    setSecret({ nodeId: res.nodeId, nodeKey: res.nodeKey });
    await load();
  }

  return (
    <div>
      <h2 style={{ fontSize: 20, marginTop: 0 }}>Nodes</h2>
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: theme.muted, marginBottom: 8 }}>Register a compute node</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={input} value={name} onChange={(e) => setName(e.target.value)} />
          <button style={button} onClick={() => void register()}>
            Register
          </button>
        </div>
        {secret && (
          <div style={{ marginTop: 12, fontSize: 12, color: theme.amber }}>
            Save this nodeKey now — shown once:
            <div style={{ color: theme.text, fontFamily: 'monospace', marginTop: 4, wordBreak: 'break-all' }}>
              {secret.nodeId} / {secret.nodeKey}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {nodes.map((n) => (
          <div key={n.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 14 }}>{n.name}</div>
              <div style={{ fontSize: 12, color: theme.muted }}>
                {n.trustLevel} · {n.lifecycleState} · jobs {n.successfulJobs}
              </div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, color: n.status === 'ONLINE' ? theme.green : theme.muted }}>
              {n.status}
            </div>
          </div>
        ))}
        {nodes.length === 0 && <div style={{ color: theme.muted, fontSize: 14 }}>No nodes yet.</div>}
      </div>
    </div>
  );
}

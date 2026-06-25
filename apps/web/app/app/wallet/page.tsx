'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { theme, card, input, button, ghostButton } from '../../../lib/ui';

export default function WalletPage() {
  const [config, setConfig] = useState<any>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [credits, setCredits] = useState(5);
  const [error, setError] = useState('');

  const loadPayouts = () => api<any[]>('/token/payouts').then(setPayouts).catch(() => undefined);
  useEffect(() => {
    void api('/token/config').then(setConfig).catch(() => undefined);
    void api<{ walletAddress: string | null }>('/wallet/me').then((w) => setWallet(w.walletAddress)).catch(() => undefined);
    void loadPayouts();
  }, []);

  async function connect() {
    setError('');
    const eth = (window as any).ethereum;
    if (!eth) {
      setError('No EVM wallet found (install MetaMask).');
      return;
    }
    try {
      const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      const nonceRes = await api<{ nonce: string; message: string }>('/wallet/nonce', {
        method: 'POST',
        body: JSON.stringify({ address }),
      });
      const signature = (await eth.request({ method: 'personal_sign', params: [nonceRes.message, address] })) as string;
      const res = await api<{ walletAddress: string }>('/wallet/verify', {
        method: 'POST',
        body: JSON.stringify({ address, nonce: nonceRes.nonce, signature }),
      });
      setWallet(res.walletAddress);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function requestPayout() {
    setError('');
    try {
      await api('/token/request-payout', { method: 'POST', body: JSON.stringify({ credits }) });
      await loadPayouts();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 20, marginTop: 0 }}>Wallet</h2>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: theme.muted }}>NRN token</div>
        <div style={{ fontSize: 13, marginTop: 4 }}>
          chain {config?.chainId ?? '…'} · payouts {config?.payoutsEnabled ? 'on' : 'off'} · 1 credit ={' '}
          {config ? Number(BigInt(config.creditToNrnWei)) / 1e18 : '…'} NRN
        </div>
        <div style={{ fontSize: 12, color: theme.muted, marginTop: 4, wordBreak: 'break-all' }}>
          token: {config?.tokenAddress ?? 'not deployed'}
        </div>
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        {wallet ? (
          <div style={{ fontSize: 13 }}>
            Linked wallet: <span style={{ fontFamily: 'monospace' }}>{wallet}</span>
          </div>
        ) : (
          <button style={ghostButton} onClick={() => void connect()}>
            Connect wallet (SIWE)
          </button>
        )}
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: theme.muted, marginBottom: 8 }}>Request NRN payout</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...input, width: 120 }}
            type="number"
            value={credits}
            onChange={(e) => setCredits(Number(e.target.value))}
          />
          <button style={button} onClick={() => void requestPayout()} disabled={!wallet}>
            Request {credits} credits
          </button>
        </div>
      </div>

      {error && <div style={{ color: theme.red, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {payouts.map((p) => (
          <div key={p.id} style={{ ...card, display: 'flex', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13 }}>
              {(Number(BigInt(p.amountWei)) / 1e18).toFixed(2)} NRN
              <span style={{ color: theme.muted, marginLeft: 8 }}>{p.txHash ? `${p.txHash.slice(0, 12)}…` : ''}</span>
            </div>
            <div style={{ fontSize: 13, color: p.status === 'CONFIRMED' ? theme.green : theme.muted }}>{p.status}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

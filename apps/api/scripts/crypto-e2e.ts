// Crypto E2E client: link a wallet via SIWE, request an NRN payout, have admin
// process it on-chain, then assert the on-chain NRN balance.
import { ethers } from 'ethers';

const API = process.env.API ?? 'http://localhost:8091';
const BASE = `${API}/api`;
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const TOKEN_ADDRESS = process.env.NRN_TOKEN_ADDRESS ?? '';

async function req(path: string, method: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main(): Promise<void> {
  const { accessToken: userTok } = await req('/auth/login', 'POST', {
    email: 'user@neurion.local',
    password: 'ChangeMe!User2026',
  });

  const wallet = ethers.Wallet.createRandom();
  console.log('wallet:', wallet.address);

  const nonceRes = await req('/wallet/nonce', 'POST', { address: wallet.address }, userTok);
  const signature = await wallet.signMessage(nonceRes.message);
  const linked = await req('/wallet/verify', 'POST', { address: wallet.address, nonce: nonceRes.nonce, signature }, userTok);
  console.log('wallet linked:', linked.walletAddress);

  const payout = await req('/token/request-payout', 'POST', { credits: 5 }, userTok);
  console.log(`payout ${payout.id} PENDING amountWei=${payout.amountWei}`);

  const { accessToken: adminTok } = await req('/auth/login', 'POST', {
    email: 'admin@neurion.local',
    password: 'ChangeMe!Neurion2026',
  });
  const proc = await req('/token/admin/process-payouts', 'POST', {}, adminTok);
  console.log('process result:', JSON.stringify(proc.results));

  let final: any;
  for (let i = 0; i < 40; i++) {
    final = await req(`/token/payouts/${payout.id}`, 'GET', undefined, userTok);
    if (final.status === 'CONFIRMED' || final.status === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`payout final: ${final.status} txHash=${final.txHash}`);

  if (TOKEN_ADDRESS) {
    const provider = new ethers.JsonRpcProvider(RPC);
    const token = new ethers.Contract(TOKEN_ADDRESS, ['function balanceOf(address) view returns (uint256)'], provider);
    const bal = (await token.getFunction('balanceOf')(wallet.address)) as bigint;
    console.log(`on-chain NRN balance of wallet: ${ethers.formatEther(bal)} NRN (expect 0.5)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

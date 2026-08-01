<!-- Prodotto da un'analisi automatica del repository, poi verificata: ogni
     affermazione "si puo togliere" e stata contestata da un secondo passaggio,
     e le smentite sono riportate nella sezione finale invece di essere tolte.
     Riferimento per la rimozione dello strato monetario deciso nella rotta p2p. -->

# Piano di rimozione — money layer di Neurion

Verificato su `main` @ 9a2bf50. Tutti i `file:line` sotto sono stati riletti in questa sessione salvo dove indicato in §7.

---

## 1. Delete outright

### API — modulo crypto (8 file, l'intera directory)
```
apps/api/src/crypto/crypto.module.ts
apps/api/src/crypto/crypto.constants.ts        (VAULT_ABI, TOKEN_ABI)
apps/api/src/crypto/token-config.service.ts    (ethers provider/signer/contract)
apps/api/src/crypto/token-payout.service.ts    (requestPayout / processPayouts)
apps/api/src/crypto/token.controller.ts        (5 rotte /api/token/*)
apps/api/src/crypto/wallet-auth.service.ts     (SIWE)
apps/api/src/crypto/wallet.controller.ts       (4 rotte /api/wallet/*)
apps/api/src/crypto/emission.service.ts        (cap G12)
```
Verificato: gli unici import di `crypto/` fuori dalla directory sono `apps/api/src/app.module.ts:17` e `apps/api/scripts/payout-test.ts:20`. Nessun altro `@Module` importa `CryptoModule`; `exports: [TokenConfigService]` (crypto.module.ts:17) è un export morto.

**Nota su `GET /token/config`** — è `@Public()` (token.controller.ts:25-29) e non tocca i payout. Un verificatore ha proposto di conservare il solo handler `config`. Decisione: **eliminare anche quello**, perché il suo unico consumatore è `apps/web/app/app/wallet/page.tsx:17`, che muore nella stessa change, e `publicConfig()` espone solo `chainId`/`tokenAddress`/`payoutsEnabled` — concetti che non sopravvivono.

### API — script
```
apps/api/scripts/payout-test.ts     (285 righe; orfano dopo la delete del service)
apps/api/scripts/crypto-e2e.ts      (nessuna entry in package.json, già orfano)
```

### Web — route wallet
```
apps/web/app/app/wallet/page.tsx    (l'intera cartella app/app/wallet/)
```

### Contracts (decisione separata, ma va sequenziata qui)
```
packages/contracts/    (NRNToken.sol, ComputeRewardVault.sol,
                        ComputeNodeStakingBond.sol, DisputeResolver.sol,
                        VestingVault.sol + test + deploy-local.ts)
```

### Dipendenza
`apps/api/package.json` — rimuovere `ethers`. Verificato: i 5 import di `ethers` sono `token-config.service.ts:3`, `token-payout.service.ts:8`, `wallet-auth.service.ts:7`, `scripts/crypto-e2e.ts:3`, `scripts/e2e.ts:5`. Tutti muoiono o vengono modificati sotto. Rimuoverla riduce anche il bundle desktop (`apps/api/scripts/bundle.mjs`).

---

## 2. Detach — codice che sopravvive e chiama codice money

**Questa è la sezione critica.** Ordine = rischio decrescente.

| # | file:line | cosa fa oggi | cosa deve fare |
|---|---|---|---|
| D1 | `apps/api/src/app.module.ts:17` + `:50` | import + registrazione `CryptoModule` | Eliminare **entrambe insieme**. Solo `:50` ⇒ import inutilizzato ⇒ `pnpm lint` fallisce (`eslint "src/**/*.ts" --max-warnings 0`, package.json:9). |
| D2 | `apps/api/src/network/network.service.ts:198` | `p.tokenPayout.count({status:"PENDING"})` | Rimuovere l'entry dal `Promise.all`, il nome destrutturato `payoutsPending` (:167), il campo del tipo (:30) e il return (:265). |
| D3 | `apps/api/src/network/network.service.ts:223` | `p.emissionSchedule.findFirst()` | Rimuovere l'entry, il nome `emission` (:183), il blocco `economy` nel tipo (:52-59) e nel return (:291-301), e gli helper ora inutilizzati `weiToNrn` (:69) / `weiPct` (:78). |
| | | | **Perché è il punto più pericoloso:** `compute()` gira a boot (`onModuleInit`) e ogni 120s; il boot è avvolto in try/catch, ma `stats()` no. Se i model Prisma spariscono senza questa edit, la **pubblica non autenticata** `GET /api/network/stats` fa 500 a ogni richiesta e la status page va nera. Fallimento silenzioso allo startup. |
| D4 | `apps/api/src/admin/admin.service.ts:45` | `prisma.tokenPayout.count` | Rimuovere `:45`, il nome `payoutsPending` (:30) e `payouts: { pending }` (:64). Altrimenti `GET /api/admin/dashboard` fa 500. |
| D5 | `apps/api/src/auth/auth.service.ts:270` | `"tokenPayout"` nell'array `tables` (:267-278) | Rimuovere la stringa. Il loop a :279-284 fa `(p as any)[t].deleteMany(...).catch(...)`: se il model sparisce, `undefined.deleteMany` lancia un **TypeError sincrono prima che esista una promise**, quindi il `.catch()` non lo cattura. Cancellazione account GDPR ⇒ 500 per tutti. |
| D6 | `apps/api/src/credits/credits.service.ts:58-66` `collectFee` | take-rate al payout | **Eliminare.** Unico chiamante: `token-payout.service.ts:80`. `PROTOCOL_FEE_BPS` diventa env morta. |
| D7 | `apps/api/src/credits/credits.service.ts:18-27` `treasuryUserId` | risolve `PROTOCOL_TREASURY_USER_ID` o `treasury@neurion.local` | **Eliminare** insieme a D6 e D8. Nessun codice di startup lo richiede: risoluzione lazy, ritorna `null` senza errori. L'utente treasury si può cancellare da prod a codice invariato. |
| D8 | `apps/api/src/credits/credits.service.ts:35-51` `rewardWithFee` | grant netto + fee al treasury | **Semplificare, non eliminare**: ha due chiamanti vivi. Ridurre a `await this.grant(ownerUserId, gross, reason, ref)` — droppare :41-45 e :48-49. `PROTOCOL_REWARD_FEE_BPS` è già default `0`, quindi comportamento invariato. |
| D9 | `apps/api/src/credits/credits.service.ts:6` | `import { protocolFee } from "../jobs/verification/helpers"` | Rimuovere l'import da credits. **NON eliminare** `helpers.ts:13-16` `protocolFee` finché D8 non è applicata — è l'unico punto condiviso tra `collectFee` e `rewardWithFee`. Dopo D6+D8 diventa senza chiamanti e si può eliminare. |
| D10 | `apps/api/src/jobs/verification.service.ts:185` | `credits.rewardWithFee(..., "NODE_REWARD", ...)` | Cambiare in `credits.grant(...)`. Il valore di ritorno alimenta `outstandingOptimisticCredits` (:195), letto dal clawback antifrode a :234-236 — **non toccare quel percorso**. |
| D11 | `apps/api/src/ai/realtime-pool.service.ts:95` | `credits.rewardWithFee(..., "NODE_REALTIME_REWARD", ...)` | Idem: `grant()`. È l'unico segnale positivo che un node operator riceve, esposto come `nodeReward` in `chat.controller.ts:855`. Vedi §5. |
| D12 | `apps/api/src/jobs/verification.service.ts:218` | scrive `nrnPayoutEligible` | **Tenere o rinominare, non cancellare a occhi chiusi.** `network.service.ts:213` conta `job.nrnPayoutEligible: true` e lo pubblica come `health.verifiedJobs` sulla status page pubblica (`apps/web/app/network/page.tsx:47`, `:203`). Rinominare in `deepVerified` (colonna + 3 call site + `finalize()` signature :205-224) o lasciarlo con un commento. |
| D13 | `apps/api/src/compliance/compliance.service.ts:19-62` + `compliance.controller.ts:26`, `:35` | block/unblock-payouts scrivono `User.payoutHold` | **Decisione.** Verificato: `User.payoutHold` ha **un solo lettore in tutto il repo**, `token-payout.service.ts:46`. Se lasci gli endpoint, un admin che "blocca i payout" ottiene 200 e scrive `ComplianceRecord`+`AuditLog` per nulla — no-op silenzioso travestito da tool di moderazione. O elimini i due metodi + le due rotte + la colonna, o ri-punti il flag su una sospensione account reale. `listRecords` (:12-17) e il model `ComplianceRecord` sono generici e sopravvivono. |
| D14 | `apps/api/src/health/health.controller.ts:91-115` | `GET /api/health/contracts` pinga `RPC_URL` | **Eliminare l'endpoint.** Non importa da `crypto/` (fa fetch a mano), quindi continuerebbe a compilare e a rispondere — un health check su una chain che il prodotto non usa più. Fallisce soft (`{status:'down'}`), quindi nessun monitor allerta: resta sbagliato per sempre. |
| D15 | `apps/api/scripts/money-test.ts:224-238` | test `rewardWithFee splits gross...` asserisce `getBalance(treasury) === 10` | Eliminare il caso. Se applichi D8 e lasci il test, `pnpm --filter @neurion/api test` fallisce a money-test (7° della catena, `package.json:11`). |
| D16 | `apps/api/scripts/e2e.ts:173-215` + `:5` | blocco crypto guardato da `if (TOKEN_ADDRESS)`, con SKIP a :214 | Eliminare il blocco, la costante `TOKEN_ADDRESS` e `import { ethers }` a `:5`. Senza rimuovere l'import il file non passa il typecheck. |
| D17 | `apps/api/package.json:11` + `:25` | `test` chain contiene `&& tsx scripts/payout-test.ts`; `test:payout` | Rimuovere entrambe. La chain è un singolo `&&`: se resta, `pnpm test` muore a payout-test e **`knowledge-test.ts` (8°) non gira più**. CI esegue solo `test:unit` (`.github/workflows/ci.yml:33`), quindi questo non si vede in PR — solo in locale/release. |
| D18 | `apps/web/app/app/layout.tsx:29` + `:93` | `["/app/wallet","nav.subnavWallet"]` nel subnav NETWORK; `/app/wallet` nella lista `isNetwork` | Rimuovere entrambe, altrimenti la sidebar linka un 404. |
| D19 | `apps/web/app/network/page.tsx:157` | `<Stat label={t('network.payoutsPending')} .../>` | Rimuovere lo Stat e il campo del tipo a `:28`. |
| D20 | `apps/web/app/network/page.tsx:215-218` | `<Section title={t('network.secEconomy')}>` con due `<Progress>` | Rimuovere la Section e il blocco `economy` del tipo (`:50-57`). **`economy` è dichiarato non-opzionale e dereferenziato senza guard** (`stats.economy.epochPct`): se l'API smette di restituirlo e la pagina non è aggiornata, white-screen. API-side e web-side devono atterrare nella stessa release. |
| D21 | `apps/web/app/manifest.ts:8` | `'chat, agent and wallet over a community grid'` | Riscrivere senza "wallet". |
| D22 | `apps/api/prisma/seed.ts:29-30` | utente `treasury@neurion.local` | Eliminare l'entry `:30` e il commento `:29` (che è già falso: ho tracciato lo slash path a `verification.service.ts:227-291` — non manda nulla al treasury). Correggere il `console.log` a `:64` che dice già "3 users" seminandone 4 → resta corretto a 3. |
| D23 | `.env.example:60-72` | blocco `# Crypto` + `# Feature flags (G13)` | Eliminare `CHAIN_ID`, `RPC_URL`, `NRN_TOKEN_ADDRESS`, `COMPUTE_REWARD_VAULT_ADDRESS`, `REWARD_SIGNER_PRIVATE_KEY`, `CREDIT_TO_NRN_WEI`, `TOKEN_PAYOUTS_ENABLED`, `KYC_PAYOUT_THRESHOLD_CREDITS`, `EMISSION_EPOCH_DAYS`. Purgare anche dal `.env` vivo. **`REWARD_SIGNER_PRIVATE_KEY` è una hot private key che deve smettere di essere provisionata.** |
| D24 | `infra/deploy-vps.sh:51` | `TOKEN_PAYOUTS_ENABLED=false` | Rimuovere la riga. |
| D25 | `.github/workflows/ci.yml:35-49` + `pnpm-workspace.yaml` | job `contracts (compile + test)` → `hardhat test` | Se elimini `packages/contracts`, rimuovi il job. `pnpm-workspace.yaml` usa `packages/*` (glob), quindi non serve editarlo. Senza rimuovere il job, ogni run CI fallisce su filter target mancante. |

---

## 3. Database

### Blocchi da droppare — `apps/api/prisma/schema.prisma`

| righe | blocco | relazioni |
|---|---|---|
| 756-781 | `model TokenPayout` | ha `user User @relation(...)` a :776 |
| 783-792 | `enum PayoutStatus` | — |
| 794-803 | `model WalletNonce` | standalone, nessuna relazione |
| 1154-1166 | `model EmissionSchedule` | standalone, nessuna relazione |
| 46-48 | `User.walletAddress` / `User.kycStatus` / `User.payoutHold` | — |
| 160-166 | `enum KycStatus` | — |
| 60 | `User.tokenPayouts TokenPayout[]` | **lato inverso della relazione** |

### La relazione da rimuovere PRIMA
`User.tokenPayouts` (`schema.prisma:60`) e `TokenPayout.user` (`:776`) sono i due lati della stessa relazione. Prisma rifiuta uno schema con un solo lato: **vanno rimossi nella stessa edit di `prisma validate`**, non in due migration. `WalletNonce` ed `EmissionSchedule` sono completamente standalone — nessun campo li referenzia — quindi si droppano da soli.

### Prerequisiti di codice (non negoziabili)
La migration va applicata **solo dopo** D2, D3, D4, D5. Droppare le tabelle prima produce tre rotture in tre moduli che non importano mai `crypto/`:
- `GET /api/network/stats` → 500 (pubblica, non autenticata)
- `GET /api/admin/dashboard` → 500
- cancellazione account GDPR → 500

### `Job.nrnPayoutEligible` (`schema.prisma:307`)
**Non droppare in questa migration.** Vedi D12 — alimenta `health.verifiedJobs` sulla status page pubblica. Se lo droppi, quella statistica va ri-derivata da `verificationScore` o da `JobVerification.outcome = PASS`.

### Colonne money già morte, incluse gratis
`OwnerReputation.payoutHold` (`:847`) e `OwnerReputation.lifetimePayoutCredits` (`:846`): verificato, **zero lettori in tutto `apps/api/src`** (i 5 hit di `payoutHold` sono tutti su `User.payoutHold`). Si droppano senza edit di codice.

### Dati non-money a rischio
Nessuno. `TokenPayout`, `WalletNonce`, `EmissionSchedule` contengono esclusivamente righe money. `CreditLedger` e `User.creditBalance` **non vengono toccati**. `ComplianceRecord` sopravvive.

`apps/desktop/staging/api/prisma/schema.prisma` e `apps/desktop/dist-installer/.../schema.prisma` sono copie bundled: **rigenerare, non editare a mano** (verificato non tracciate da git).

---

## 4. Copy e traduzioni

### i18n web — `apps/web/lib/i18n/locales/{en,it,de,es,fr,ru,zh}.ts`
Conteggio verificato, **identico in tutti e 7 i file**:

| gruppo | chiavi/locale |
|---|---|
| `wallet.*` | 16 |
| `nav.subnavWallet` | 1 |
| `network.payoutsPending`, `network.secEconomy`, `network.epochEmission`, `network.lifetimeEmission` | 4 |
| **da eliminare** | **21 per locale → 147 totali** |

Inoltre **6 chiavi per locale (42 totali) da riscrivere, non eliminare** — contengono "NRN"/"earn" ma servono feature che sopravvivono:
- `:5` app tagline — "Earn credits and the NRN token"
- `:7` SEO description — "internal credits and an on-chain NRN utility token"
- `:308` — "share idle power, access AI, earn NRN"
- `:313` `splash.bootLedgerOnline` — "> NRN ledger online [OK]"
- `:477` / `:478` — "earn NRN" / "Sharing — earning NRN" (schermata models/node)
- `:655` — hint di login: "share this computer's power ... and earn NRN"

(numeri di riga da `en.ts`; le corrispondenti esistono in tutti i locali)

### Landing — `apps/landing/index.html`
Meta e markup: `:10` (meta description), `:12` (og:description), `:103` (h2 sr-only), `:122` `hero_badge`, `:124` `hero_sub`, `:143-144` `p2_t`/`p2_b`, `:157` `how_title`, `:168-169` `s3_t`/`s3_b`, `:209` `d2_b`.
Tabella i18n inline: le stesse 8 chiavi (`hero_badge`, `hero_sub`, `p2_t`, `p2_b`, `how_title`, `s3_t`, `s3_b`, `d2_b`) × **7 lingue** = 56 stringhe, a partire da `:242` (en), `:267` (it), `:297` (fr), `:350` (de), `:403` (es), `:456` (ru), + zh.

Sostituzioni tipo: `"From download to earning."` → `"From download to sharing."`; `"Share & earn"` → `"Share & contribute"`; `"You only pay for verified work; as a node you earn convertible NRN. Network state settles on-chain on Base."` → una frase su verifica e reputazione, senza chain.

### Forum seed — `apps/api/prisma/forum-seed.ts`
- **Eliminare l'intera sezione `rewards-nrn`**: i due post a `:105-111` ("How rewards and NRN payouts work") e `:112-116` ("When do on-chain payouts (Base) go live?"). Il primo afferma "A protocol fee (currently 10%) goes to the treasury" — falso già oggi (`PROTOCOL_FEE_BPS` default 0).
- Riscrivere i body: `:14`, `:49`, `:52`, `:54-55` (Q "What's the difference between credits and NRN?"), `:100` ("Verified jobs earn credits/NRN").

### node-agent — cosa dire agli operatori
| file:line | oggi | proposta |
|---|---|---|
| `apps/node-agent/cmd/neurion-node/main.go:51` | `# serve chat, earn NRN` | `# serve chat for the network` |
| `apps/node-agent/cmd/neurion-node/main.go:95` | `serve realtime chat (FAST lane) and earn NRN` | `serve realtime chat (FAST lane) for other users` |
| `apps/node-agent/cmd/neurion-tray/main.go:3` | commento "to earn NRN" | "to serve other users' requests" |
| `apps/node-agent/cmd/neurion-tray/main.go:153` | `"● sharing — earning NRN"` | `"● sharing — N requests served"` (contatore, non promessa) |
| `apps/node-agent/neurion-node.example.yaml:23` | `# earn NRN. Two common backends:` | `# serve requests. Two common backends:` |

Il registro giusto per un volontario è **quantità di lavoro fatto**, non ricompensa: vedi §5(c).

### Docs
`docs/FEATURES.md` (:212 stake documentato come vivo — falso, :218/:253/:265 emission), `docs/operations/bootstrap-report.md:31`, `docs/architecture/gaps-g5-g15.md`, `docs/architecture/p2p-roadmap.md`. I 5 documenti sotto `docs/legal/` (`nrn-whitepaper-draft.md`, `nrn-terms-of-use.md`, `nrn-risk-disclosure.md`, `micar-token-classification.md`, `kyc-aml-operating-model.md`) descrivono un token che non esiste più: archiviare o eliminare in blocco.

---

## 5. La questione crediti

### Quando un utente viene addebitato, oggi — l'evidenza

`apps/api/src/chat/chat.controller.ts:99-106`:
```ts
private billable(plan: RoutePlan, rawCost: number): number {
  if (String(this.config.get("NEURION_METER_LOCAL") ?? "false") === "true") return rawCost;
  const servedByNetwork = plan.lane === "GRID" || (plan.lane === "FAST" && !!plan.nodeId);
  return servedByNetwork ? rawCost : 0;
}
```
Tre fatti verificati:
1. `NEURION_METER_LOCAL` **non compare da nessun'altra parte nel repo** — non in `.env.example`, non in `apps/desktop`. Sempre `false`.
2. `apps/api/src/ai/ai-router.service.ts` restituisce solo `lane: "FAST"` (`:103`) o `lane: "FALLBACK"` (`:127`). **Mai `"GRID"`.** Il ramo GRID è morto per la chat.
3. `credits.service.ts:98` — `if (amount <= 0) return this.getBalance(userId);` — `spend(0)` esce senza scrivere riga di ledger e senza 402.

**Conclusione: un utente è addebitato se e solo se un nodo remoto warm ha servito il turno.** Tutto il resto costa 0.

- **Percorso locale (desktop):** il desktop registra il proprio nodo contro il server pubblico, il DB locale non ha righe `ComputeNode`, `findWarm` → null, lane sempre `FALLBACK`, costo sempre 0. Il proprietario desktop parte con `creditBalance` 0 (`schema.prisma:49`) e non riceve mai un errore di pagamento.
- **Percorso hosted:** la lane `FALLBACK` (engine dell'operatore) è **gratuita e non misurata** — `billable()` la azzera. Solo i turni serviti da nodi altrui vengono addebitati.

### Cosa fallisce aperto se i crediti spariscono
Già oggi due dei tre percorsi che consumano hardware altrui **falliscono aperti**: `apps/api/src/ai/infer.controller.ts:85` (relay) e `apps/api/src/agent/agent-orchestrator.service.ts:250` avvolgono `spend()` in `.catch(() => undefined)` e ingoiano il 402. Solo la chat fallisce chiusa (`chat.controller.ts:663`). Il limitatore reale contro un signup anonimo è il `ThrottlerModule` globale (`app.module.ts:35`), non i crediti — non esiste **nessun grant di signup** nel codice, quindi un account nuovo ha 0 crediti in permanenza ed è già bloccato dalla lane FAST.

### Le tre rotture silenziose
**(a)** `agent-orchestrator.service.ts:204` usa `balance > 0` per scegliere network vs locale in modalità `auto`. Eliminare `getBalance` collassa la condizione in "network ogni volta che c'è un nodo warm": **regressione di privacy travestita da pulizia di billing** — il lavoro dell'agente dell'utente parte dalla sua macchina di default. Serve una preferenza esplicita al suo posto.

**(b)** `verification.service.ts:185` alimenta `outstandingOptimisticCredits` (`:195`), letto dal clawback antifrode a `:234-236`. Se elimini il reward ma tieni lo slash, la risposta antifrode diventa un no-op permanente su un contatore sempre 0. **Vanno eliminati insieme**, tenendo sospensione nodo e decay di reputazione — che sono credit-free e restano l'unica conseguenza per un nodo bugiardo.

**(c)** `realtime-pool.service.ts:95` è **l'unico segnale positivo che un node operator riceva**, esposto come `nodeReward` nell'evento SSE finale (`chat.controller.ts:855`). Rimuoverlo senza un contatore di contributi al suo posto lascia i volontari senza feedback di aver servito qualcuno — esattamente la motivazione che Folding@home ed eMule mettono al posto del pagamento.

### Raccomandazione — è una decisione, non un finding
**Tenere i crediti come quota, eliminare solo la metà money.** Concretamente: tenere `spend` / `grant` / `getBalance` / `ledger`; eliminare `collectFee` (D6), `treasuryUserId` (D7) e la metà fee di `rewardWithFee` (D8); tenere `billable()` **rinominandolo** (es. `networkCost()`) perché non è codice di billing, è il predicato locale-vs-network di cui una rete di condivisione ha bisogno.

Due cose da sistemare comunque, indipendentemente dalla decisione:
- `chat.controller.ts:360-422` addebita inference vision che gira **sempre in locale** (il path risolve il proprio fallback provider), ogni volta che un nodo remoto qualsiasi pubblicizza lo stesso modello vision — perché il costo è preso dal piano FAST pre-override. **La rimozione lo corregge.**
- Il bond sybil per i nodi non ha mai addebitato nessuno: `nodes.service.ts:30` legge `NODE_STAKE_CREDITS` (default 0) mentre `.env.example:70` definisce `REGISTRATION_STAKE_CREDITS` — nome diverso. `docs/FEATURES.md:212` lo documenta come vivo ed è falso oggi.

---

## 6. Ordine delle operazioni

`CreditsModule` è `@Global` (`credits.module.ts:5`): non c'è lista di import da grepare, nove costruttori lo risolvono invisibilmente. Va toccato **per ultimo**, lasciando che sia il compilatore a trovare i residui.

**Step 1 — staccare il web** (nessuna dipendenza API)
D18, D19, D20, D21 + eliminare `apps/web/app/app/wallet/` + le 21 chiavi × 7 locali.
*Verifica:* `pnpm --filter @neurion/web typecheck && build`. La pagina `/network` deve renderizzare senza la Section economy.

**Step 2 — smontare il modulo Nest e i suoi script**
Eliminare `apps/api/src/crypto/` + D1 + D14 + eliminare `scripts/payout-test.ts`, `scripts/crypto-e2e.ts` + D16 + D17 + rimuovere `ethers` da package.json.
*Verifica:* `pnpm --filter @neurion/api typecheck && lint && build`. Poi la catena completa: `pnpm --filter @neurion/api test` — deve arrivare fino a `knowledge-test.ts`. (CI da sola non lo cattura: esegue solo `test:unit`.)
A questo punto le 9 rotte `/api/wallet/*` e `/api/token/*` fanno 404 e **nulla le chiama più**.

**Step 3 — de-fee i crediti**
D6, D7, D8, D9, D10, D11, D15, D22.
*Verifica:* `pnpm --filter @neurion/api test:money` deve passare; `getBalance` di un node owner dopo un reward = gross (non net).

**Step 4 — staccare i lettori Prisma delle tabelle money**
D2, D3, D4, D5 + D13 (decisione compliance).
*Verifica prima della migration:* `curl /api/network/stats` (200, senza `economy` né `payoutsPending`), `curl /api/admin/dashboard` (200, senza `payouts`), cancellazione account su un utente di test (200).

**Step 5 — migration**
Rimuovere dallo schema i blocchi di §3 (entrambi i lati della relazione `User↔TokenPayout` nella stessa edit) + `OwnerReputation.payoutHold`/`lifetimePayoutCredits`. `prisma migrate dev`.
*Verifica:* `pnpm --filter @neurion/api db:validate`, poi ri-eseguire i 3 curl dello step 4 — **ora sono il test reale**, perché prima le tabelle esistevano ancora.

**Step 6 — contratti e CI**
Eliminare `packages/contracts/` + D25.
*Verifica:* CI verde su tutti e tre i job rimasti.

**Step 7 — copy**
D23, D24, node-agent, landing, forum-seed, docs, `docs/legal/*`.
*Verifica:* `grep -ri "NRN\|payout\|earn" apps/ packages/ docs/ --exclude-dir=node_modules` — ogni hit residuo deve essere una scelta consapevole.

**Rigenerare i bundle desktop** (`apps/desktop/staging/`, `apps/desktop/dist-installer/`) dopo lo step 5: contengono copie di `schema.prisma` e `seed.ts`. Sono build output — rigenerare, non editare.

---

## 7. Irrisolto

Le voci sotto sono state **refutate o non confermate** da un verificatore. Non sono fatti stabiliti.

1. **"Deleting the Nest module breaks nothing at runtime" — REFUTATO.** La claim su Nest DI è corretta, la claim sulle conseguenze no: `CryptoModule` è l'unico registrar di 9 rotte HTTP, e `apps/web/app/app/wallet/page.tsx:15,17,18` le chiama con `.catch(() => undefined)`, quindi la pagina **degrada in bianco senza errori** invece di fallire. Il piano sopra lo copre schedulando web e API nella stessa change (Step 1 prima di Step 2), ma va detto che l'evidenza originale non lo elencava.

2. **"TokenPayoutService è iniettato solo da token.controller.ts:22" — REFUTATO.** `crypto.module.ts:4` e `:14` sono un secondo riferimento diretto. Irrilevante perché eliminiamo l'intera directory, ma se qualcuno fa una delete parziale, `tsc --noEmit` e `nest build` falliscono entrambi in CI.

3. **"EmissionService è iniettato solo da token-payout.service.ts:25" — REFUTATO.** Stessa cosa: `crypto.module.ts:5` e `:15`.

4. **"L'unico accoppiamento tra crediti e money" — REFUTATO come sovra-affermazione.** Ne esistono altri due in codice che sopravvive: `rewardWithFee` (`credits.service.ts:35-51`, paga il treasury via `PROTOCOL_REWARD_FEE_BPS`, chiamanti `verification.service.ts:185` e `realtime-pool.service.ts:95`) e `protocolFee` (`jobs/verification/helpers.ts:13-16`, condiviso). Coperti da D8/D9, ma la framing originale li nascondeva.

5. **`chat.controller.ts:805` "FAILS OPEN" — REFUTATO, esito incerto.** Il verificatore sostiene che eliminare la `spend` non è neutro ma trasforma due percorsi sopravvissuti in "credit faucet". Il ragionamento è arrivato troncato e **non sono riuscito a verificarlo**. Non eliminare `chat.controller.ts:805` senza aver prima ricostruito quell'argomento. La stringa `"chat.fallback.small"` è comunque una bugia (una riga con `cost>0` implica FAST+nodeId) e va corretta in ogni caso.

6. **Conteggi di riga in produzione non verificati.** L'affermazione "prod ha 7 righe di ledger, 2 job e zero payout" viene dall'evidenza, non da questa sessione — non ho accesso al DB. **Prima dello Step 5, eseguire `SELECT count(*) FROM "TokenPayout"`.** Se non è 0, esiste un obbligo verso utenti reali e questo diventa un problema legale prima che tecnico.

7. **`AI_ONLINE_NO_ENGINE` in produzione: non verificato.** L'analisi dell'esposizione hosted in §5 assume il default `false` di `.env.example:58`. Se in prod è `true`, la lane FALLBACK non serve nulla e le conclusioni sull'esposizione anonima cambiano. Controllare il `.env` vivo.

8. **`packages/contracts` è una decisione di prodotto, non un finding.** I contratti sono self-contained (Solidity + hardhat, indipendenti dal grafo dei moduli API). Si possono lasciare in piedi e non deployati senza rompere nulla — l'unico costo è il job CI a `ci.yml:35-49`. Elencati in §1 perché il resto del piano presuppone che se ne vadano, ma niente nel codice lo impone.
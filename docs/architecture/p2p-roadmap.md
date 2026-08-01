# Da rete con un padrone a rete fra pari

**Scopo:** che l'AI resti in mano alle persone anche il giorno in cui i grandi
fornitori spengono, cambiano prezzo o chiudono la porta. Non un mercato di
calcolo: una rete di sopravvivenza, sul modello di Napster ed eMule — tanti
pari, nessun centro, nessuna moneta.

Questo documento dice **dov'è oggi il codice**, **dove deve arrivare**, e in che
ordine, perché l'ordine è ciò che decide se ci si arriva.

---

## 1. Il punto di partenza, senza sconti

L'intenzione era peer-to-peer. Il codice, oggi, è client-server puro. Verificato
sul repository, non a memoria:

- nessuna traccia di `libp2p`, DHT, BitTorrent, WebRTC o gossip — zero dipendenze
  di quel tipo in tutto il monorepo;
- `apps/node-agent/cmd/neurion-tray/main.go` ha `defaultAPI =
  "https://neurionproject.org"` scritto dentro, e chiede le credenziali di quel
  sito per registrarsi;
- identità, scoperta dei nodi, instradamento dei lavori, contabilità e pagamenti
  passano tutti dalla stessa API.

Cinque funzioni, un solo padrone acceso. **La promessa e l'architettura vanno in
direzioni opposte:** oggi Neurion sostituisce la dipendenza da un fornitore con
la dipendenza da un VPS. Se quel VPS si spegne, la rete muore in blocco.

Non è un fallimento — client-server è il modo in cui si fa funzionare qualcosa in
fretta. Ma è il divario da chiudere.

---

## 2. Dove la visione è già vera, e dove c'è un muro

Conta saperlo prima di scrivere codice, per non sbattere contro la fisica.

**Già vero, e irreversibile.** I pesi aperti esistono e nessuno può revocarli a
distanza: Llama, Qwen, Gemma, Mistral sono su milioni di dischi. Questa parte è
già successa e non si può disfare.

**Vero e sfruttabile.** L'inferenza si spezza benissimo su tante macchine, perché
ogni richiesta è indipendente da tutte le altre: mille PC che rispondono a mille
domande diverse valgono davvero mille volte un PC. È lo stesso terreno su cui
Folding@home ha superato i supercomputer del mondo, **con la potenza donata**.

**Il muro.** *Addestrare* un modello grande su PC sparsi non funziona oggi: i
nodi devono scambiarsi in continuazione enormi quantità di dati, e la banda di
casa strozza tutto. Non è il terreno su cui vincere adesso, e la visione non ne
ha bisogno.

> Non serve un unico cervello gigante distribuito. Servono tanti cervelli interi,
> ognuno completo sul suo PC, che si passano i pesi e si prestano il lavoro.

---

## 3. Sulla moneta

Lo strato monetario va rimosso: NRN, payout, tesoreria, KYC, wallet, catena.

Non per ideologia, per meccanica. I token nelle reti di calcolo non nascono per
avidità, nascono perché condividere calcolo **costa** a chi condivide. Ma la
motivazione non è il problema che credevamo: Folding@home, SETI@home, Tor e il
software libero campano da decenni su potenza e banda donate. La moneta porta
contabilità, saldi, verifica e attenzioni normative — e i progetti affondano lì.

Contro il parassitismo non serve denaro: eMule aveva dei crediti, ma erano
**reciprocità** — chi caricava saliva nella coda degli altri. Quella è la strada.

Stato in produzione al momento della decisione: 8 utenti, 7 movimenti a registro,
**0 pagamenti mai richiesti**, 2 lavori totali. Non c'è valore reale da
distruggere.

---

## 4. La rotta

Ordinata per **cosa regge da sola**, non per difficoltà crescente. Ogni fase è
utile anche se le successive non arrivassero mai.

### Fase 1 — I pesi fra pari *(il Napster dei modelli)*

Chi ha un modello lo serve a chi non ce l'ha. Un GGUF è un file identificato dal
suo hash: o corrisponde o no.

- niente fiducia richiesta: la verifica è l'hash;
- niente contabilità, niente moneta;
- niente HuggingFace e niente neurionproject.org sul percorso critico.

**Perché prima di tutto:** è l'unica fase che il giorno dello spegnimento tiene
in vita l'intero progetto, e non dipende da nulla di ciò che viene dopo. Chiude
anche un buco reale di oggi: il catalogo introdotto in 1.8.17 punta a
HuggingFace, che nello scenario di disastro non c'è.

Da fare:
- annuncio dei modelli posseduti per hash (`sha256` del file, dimensione, nome);
- scambio a blocchi fra pari, con verifica del blocco e ripresa del trasferimento;
- il catalogo esistente (`llama-catalog.ts`) resta come sorgente di primo avvio,
  ma non è più l'unica strada.

### Fase 2 — Identità e scoperta senza registro

- **Identità = coppia di chiavi.** Sei la tua chiave pubblica, non un account sul
  server di qualcuno. Va nella stessa direzione già scelta in 1.8.21: in locale
  nessun utente, nessun login.
- **Scoperta via DHT o gossip**, con più nodi di avvio, gestibili da chiunque.
  Restano una semi-centralizzazione, ma sono replicabili e sostituibili: è
  un'altra cosa rispetto a un unico dominio.

**Effetto:** toglie neurionproject.org dal centro. È il punto in cui la promessa
smette di essere contraddetta dall'architettura.

### Fase 3 — Il lavoro condiviso, a reciprocità

Qui vivono i problemi veri, ed è giusto che sia l'ultima:

- **attraversamento dei NAT:** i PC di casa stanno dietro i router e devono
  trovarsi. Servono hole punching e nodi di appoggio;
- **verifica per ridondanza:** uno può donare in buona fede e mandare comunque
  risultati sbagliati, per un bug o per dispetto. Lo stesso compito a più
  volontari, risultati confrontati — come Folding@home. La base c'è già in
  `apps/api/src/jobs/verification` (`consensus`, `cosine`, `embeddingMatches`);
- **reciprocità al posto del pagamento:** chi presta il PC ha precedenza quando
  chiede; chi non contribuisce va in coda.

### Fase 4 — Il sito diventa un pari fra i pari

`neurionproject.org` smette di essere il centro e resta: pagina di download,
forum, e uno dei nodi di avvio. Se si spegne, la rete continua.

---

## 5. Da rimuovere

Da fare presto, perché è codice che orienta le decisioni finché resta lì:

| Cosa | Dove |
|---|---|
| modulo pagamenti, tesoreria, emissione | `apps/api/src/crypto` |
| pagina Wallet | `apps/web/app/app/wallet` |
| tabelle `TokenPayout`, `WalletNonce` | `apps/api/prisma/schema.prisma` |
| KYC legato ai pagamenti | `apps/api/src/compliance` |
| riferimenti a NRN nell'interfaccia e nel sito | i18n, `apps/landing` |

**Da decidere separatamente:** i crediti come contatore interno. Sul server
pubblico non sono solo denaro, sono anche ciò che impedisce a uno sconosciuto di
consumare risorse all'infinito, e le registrazioni sono aperte. Se la chat
ospitata sparisce insieme al resto, spariscono anche loro; se resta, serve un
freno di qualche tipo.

---

## 6. Cosa non promettiamo

Onestà su ciò che questa rotta **non** dà, per non venderlo a nessuno:

- non addestra modelli in modo distribuito (vedi il muro, §2);
- non è più veloce né più economica di un'API commerciale in condizioni normali:
  è più **indipendente**, che è un'altra cosa e va detta com'è;
- non elimina ogni centralizzazione: i nodi di avvio e quelli di appoggio restano
  punti di coordinamento, solo replicabili da chiunque invece che unici.

---

## 7. Il criterio per sapere se sta funzionando

Una sola domanda, da rifarsi a ogni fase:

> **Se domani neurionproject.org si spegne per sempre, cosa continua a
> funzionare?**

- Oggi: l'app locale sì, la rete no.
- Dopo la fase 1: i modelli continuano a circolare fra le persone.
- Dopo la fase 2: i pari continuano a trovarsi.
- Dopo la fase 3: il lavoro continua a essere condiviso.
- Dopo la fase 4: non cambia niente per nessuno.

Quando la risposta è "tutto", lo scopo è raggiunto.

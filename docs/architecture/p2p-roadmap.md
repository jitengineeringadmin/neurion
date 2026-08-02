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

## 3. Sulla moneta — **FATTO (1.8.23)**

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

### Fase 1 — I pesi fra pari *(il Napster dei modelli)* — **FATTA (1.8.22)**

Chi ha un modello lo serve a chi non ce l'ha. Un GGUF è un file identificato dal
suo hash: o corrisponde o no.

- niente fiducia richiesta: la verifica è l'hash;
- niente contabilità, niente moneta;
- niente HuggingFace e niente neurionproject.org sul percorso critico.

**Perché prima di tutto:** è l'unica fase che il giorno dello spegnimento tiene
in vita l'intero progetto, e non dipende da nulla di ciò che viene dopo. Chiude
anche un buco reale di oggi: il catalogo introdotto in 1.8.17 punta a
HuggingFace, che nello scenario di disastro non c'è.

**Cosa è atterrato in 1.8.22:**

- ogni voce di catalogo porta lo **SHA-256 del pubblicatore** (l'oid LFS di
  HuggingFace per la revisione fissata). Non preso sulla fiducia: dimensioni
  confermate per tutti e 14, e due file realmente presenti su disco ricalcolati
  e combacianti alla cifra;
- `downloadFile` calcola l'hash mentre scarica e **rifiuta prima di rinominare**,
  così una copia avvelenata non resta dove verrebbe caricata al riavvio;
- `PeerService` (`apps/api/src/ai/engine/peer.service.ts`) annuncia in multicast
  sul segmento locale e serve i blob per hash su una porta propria;
- chi scarica prova **prima i pari, poi il pubblicatore**, e in caso di
  fallimento ricade su HuggingFace senza bloccare l'utente;
- la pagina Modelli mostra quanti modelli offri e quanti pari ci sono.

**Limiti deliberati, da superare nella fase 2:**

- **solo i modelli del catalogo** vengono annunciati e serviti. Quelli che
  l'utente indica dal proprio disco non escono mai: potrebbero essere
  addestramenti privati;
- **solo il segmento locale** (TTL multicast 1). Nessuna DHT, nessun nodo di
  avvio, nessuna esposizione su internet;
- il server dei blob è **separato dall'API**, perché l'API sta su loopback: ha
  dentro un agente che esegue comandi e non deve essere raggiungibile dalla rete.

**Ancora aperto:** trasferimento a blocchi con ripresa. Oggi un trasferimento
interrotto riparte da zero — accettabile in LAN, non lo sarà su internet.

### Fase 2 — Identità e scoperta senza registro — **FATTA (1.8.25)**

- **Identità = coppia di chiavi.** Sei la tua chiave pubblica, non un account sul
  server di qualcuno. Va nella stessa direzione già scelta in 1.8.21: in locale
  nessun utente, nessun login.
- **Scoperta via DHT o gossip**, con più nodi di avvio, gestibili da chiunque.
  Restano una semi-centralizzazione, ma sono replicabili e sostituibili: è
  un'altra cosa rispetto a un unico dominio.

**Effetto:** toglie neurionproject.org dal centro. È il punto in cui la promessa
smette di essere contraddetta dall'architettura.

**Cosa è atterrato in 1.8.25:**

- **identità = coppia di chiavi Ed25519**, generata una volta e tenuta accanto ai
  modelli. Il nome di un pari è l'impronta della sua chiave pubblica: nessuno lo
  rilascia, nessuno lo revoca, e sopravvive ai riavvii — quello casuale di prima
  cambiava a ogni accensione, quindi un vicino sembrava uno sconosciuto ogni
  volta che tornava;
- **annunci firmati.** Una firma valida ma con il nome di un altro viene
  rifiutata: si controlla che l'identificativo dichiarato sia l'impronta della
  chiave che ha firmato. Controllare solo la firma non basterebbe;
- **scambio di pari.** Chi risponde dice anche chi conosce, e quegli indirizzi
  vengono verificati interrogandoli di persona — mai per sentito dire;
- **indirizzi manuali**, memorizzati su disco. È ciò che fa funzionare la rete
  **oltre la propria sottorete oggi**: dici a un amico il tuo indirizzo una
  volta, e nessuno dei due ha più bisogno del nostro server per trovare l'altro.

**Ancora aperto:** una DHT, che toglierebbe anche il passaggio manuale. Non è
stata fatta perché è una dipendenza grossa e quanto sopra già assolve il compito
per cui esiste la fase. E resta il NAT: due macchine dietro router diversi non si
raggiungono senza attraversamento — è la fase 3.

### Fase 3 — Il lavoro condiviso, a reciprocità — **FATTA (1.8.27)**

Qui vivono i problemi veri, ed è giusto che sia l'ultima:

- **attraversamento dei NAT:** i PC di casa stanno dietro i router e devono
  trovarsi. Servono hole punching e nodi di appoggio;
- **verifica per ridondanza:** uno può donare in buona fede e mandare comunque
  risultati sbagliati, per un bug o per dispetto. Lo stesso compito a più
  volontari, risultati confrontati — come Folding@home. La base c'è già in
  `apps/api/src/jobs/verification` (`consensus`, `cosine`, `embeddingMatches`);
- **reciprocità al posto del pagamento:** chi presta il PC ha precedenza quando
  chiede; chi non contribuisce va in coda.

**Cosa è atterrato in 1.8.26 — il primo pezzo, quello che regge da solo:**

Un pari può **chiedere a un altro di eseguire un modello per lui**, senza server
in mezzo (`POST /peer/infer`). Con quattro limiti che nascono tutti dal rispetto
per chi possiede la macchina:

- **spento finché non lo accendi.** Passare un file che hai già non ti costa
  nulla; eseguire il prompt di uno sconosciuto ti prende il processore e
  rallenta il tuo lavoro. Non può essere un valore predefinito che scopri dopo;
- **solo il modello già caricato.** Cambiarlo per un estraneo interromperebbe
  chi sta usando il computer. Chi chiede altro riceve un 409 esplicito, così può
  decidere di scaricarsi i pesi invece di indovinare perché è stato respinto;
- **uno per volta**, rifiutato e non accodato: una coda trasforma il portatile di
  qualcuno in un server senza dirglielo;
- **il prompt esce dalla macchina.** Non succede mai in automatico: si va da un
  pari solo perché l'utente ha scelto un modello che solo lui può eseguire.

**Completata in 1.8.27 con gli altri tre pezzi:**

**Reciprocità.** Un registro per pari di favori fatti e ricevuti, tenuto sul nome
stabile della fase 2 — senza un nome che non si può cambiare a piacimento, non
avrebbe alcun valore. Chi ci ha aiutato passa avanti: quando la macchina è
occupata riceve comunque un rifiuto, ma con l'indicazione di ritornare fra 2
secondi invece che fra 30. E quando siamo noi a chiedere, interroghiamo per primo
il pari verso cui siamo **meno** in debito, così il carico gira invece di pesare
sempre sulla stessa macchina generosa. Uno sconosciuto viene servito lo stesso,
solo dopo chi ha già dato: una rete che respinge i nuovi arrivati non ne avrà mai.

**Verifica per ridondanza.** Lo stesso compito a due pari e le risposte
confrontate, come Folding@home. Con un limite dichiarato nel codice invece che
nascosto: i pesi si verificano in modo assoluto (l'hash o torna o no), una
**risposta** no. Lo stesso modello su due macchine diverse non produce testo
identico — CPU diverse, build diverse, virgola mobile — quindi il confronto è
sulla sovrapposizione delle parole. **Coglie** un pari rotto, un modello
sostituito di nascosto, uno che risponde con testo preconfezionato. **Non coglie**
due pari che si mettono d'accordo, né una manipolazione sottile. Perciò la
risposta porta con sé quanto è stata controllata: «due pari concordi» e «un solo
pari, nessun riscontro» sono cose diverse e vengono dette diverse.

**Attraversare i router.** Neurion chiede al router di aprire la porta —
NAT-PMP/PCP, e UPnP come ripiego — implementati qui invece di aggiungere una
dipendenza. Scelta perché è l'unica strada che **non reintroduce un centro**: il
hole punching richiede un server di incontro di cui entrambi si fidino, e un
relay richiede qualcuno che trasporti il traffico. Chiedere al proprio router
non coinvolge nessuno: l'unica parte in causa è una scatola in casa tua. Quando
il router non collabora — capita spesso, e col CGNAT non è proprio possibile —
non è un errore: la rete continua a funzionare sul segmento locale e con i pari
già raggiungibili.

**Cosa resta fuori, dichiarato:** con il CGNAT dell'operatore non c'è apertura
possibile dall'interno, e lì servirebbe un relay — cioè un centro. E la scansione
della sottorete si può spegnere (`NEURION_PEER_SWEEP=false`) per chi sta su una
rete aziendale e non vuole che la propria macchina la sondi.

### Fase 4 — Tanti punti d'ingresso, nessun padrone — **FATTA (1.8.28)**

Il modello è quello di eMule, ed è la cosa che lo ha reso difficile da spegnere:
non aveva **un** server, ne aveva centinaia, gestiti da chiunque, in una lista
che viaggiava fra gli utenti. Chiuderne uno non cambiava niente.

**Cosa è atterrato:**

- **la rete viene ricordata.** I pari che hanno davvero risposto vengono scritti
  su disco e ribussati al riavvio successivo — è `nodes.dat` di eMule. Prima
  l'elenco viveva solo in memoria: si spegneva l'app e si ripartiva da zero,
  dipendendo da qualunque cosa fosse raggiungibile in quel minuto;
- **un elenco iniziale sostituibile** (`starter-nodes.json`), un file semplice
  che chi distribuisce la propria build o una comunità che vuole i propri punti
  d'ingresso può cambiare senza toccare il codice;
- **l'elenco viaggia**: una sola presentazione basta a conoscere il vicinato,
  perché chi risponde racconta anche chi conosce — e ognuno di quelli viene
  verificato di persona, mai creduto sulla parola;
- **chiunque è un punto d'ingresso.** Non c'è una lista di nodi approvati e non
  c'è niente da richiedere: chi tiene Neurion acceso con la porta aperta lo è.

`neurionproject.org` resta quello che deve restare: la pagina da cui si scarica
la prima volta. Non è più un pezzo del funzionamento.

**Ciò che manca ancora, e chiude davvero il cerchio:** una DHT. eMule alla fine
ottenne Kad e smise di aver bisogno di qualsiasi lista. È l'ultimo passo, e la
differenza è precisa: oggi un'installazione nuova ha bisogno di **una**
presentazione — un indirizzo qualsiasi che risponda — mentre con una DHT non
avrebbe bisogno di nessuna.

---

### Fase 5 — L'indice distribuito *(il Kad di Neurion)* — **FATTA (1.9.0)**

Le fasi 1-4 danno un **vicinato**: si trova quello che hanno le macchine che
già si conoscono. Un vicinato però contiene solo quello che i suoi membri hanno,
e la domanda "chi ha questo modello" restava senza risposta appena usciva da lì.

eMule ottenne Kad per ultimo e ne aveva più bisogno di tutto il resto. Prima
aveva i server: centinaia, tenuti da volontari — molto meglio di uno, ma un
server restava una cosa che doveva esistere, essere mantenuta e poteva essere
messa sotto pressione. Kad li tolse di mezzo. L'indice smise di stare da
qualche parte e cominciò a stare nello spazio fra tutti.

**Cosa è atterrato:**

- **si trova un modello su una macchina mai incontrata**, in una manciata di
  salti attraverso sconosciuti, senza che l'indice esista da nessuna parte;
- **l'ID del nodo è l'impronta della sua chiave**, non se lo sceglie: per
  piazzarsi accanto a una chiave — la posizione da cui si potrebbe censurare una
  ricerca — bisognerebbe macinare coppie di chiavi finché una cade dove serve;
- **in tabella entra solo chi ha risposto di persona.** Un pari può nominare i
  contatti che vuole: sono candidati da verificare, mai voci. Senza questa
  regola una sola macchina potrebbe riempire le tabelle di tutti con indirizzi
  scelti da lei, che è esattamente come si acceca una rete;
- **l'indirizzo di chi si annuncia è quello osservato, non quello dichiarato**,
  altrimenti l'indice si potrebbe puntare addosso a un bersaglio qualsiasi;
- **tutto è limitato**: schede per chiave, chiavi in totale, contatti in una
  risposta, salti in una ricerca. Ognuno di quei limiti è un punto in cui
  "quanti ne mandano" avrebbe significato che è un altro a decidere quanta
  memoria usiamo.

Viaggia sulla porta HTTP già aperta invece che su UDP, dove Kademlia di solito
vive. È uno scambio scelto: UDP sarebbe più leggero per salto, ma vorrebbe dire
una seconda porta sul router, un secondo buco nel firewall da aprire a mano, e
renderebbe inutili come via d'ingresso tutti gli indirizzi già scritti — perché
sono tutti quella porta. Un salto un po' più pesante su una porta che funziona
davvero batte uno elegante che mezzo mondo scarta.

**Il costo, detto chiaro:** annunciare di avere un modello pubblica il proprio
indirizzo e quel fatto a chiunque chieda quella chiave. È inerente — BitTorrent
funziona così — ed è il motivo per cui l'annuncio è legato all'interruttore
della condivisione e non riguarda mai i modelli che l'utente ha indicato dal
proprio disco.

**Cosa resta.** Una macchina nuova ha ancora bisogno di **un** primo contatto:
un indirizzo qualsiasi che risponda. Anche eMule, per entrare in Kad la prima
volta, doveva conoscere qualcuno. Da lì in poi non serve più nessuna lista.

---

## 5. Da rimuovere — **FATTO**

Eseguito in sei passi, ognuno verificato prima del successivo. Il piano completo,
con le trappole che ha trovato, è in [money-removal-plan.md](money-removal-plan.md).

| passo | cosa | esito |
|---|---|---|
| 1 | pagina Wallet, sezione Economy, 147 chiavi di traduzione | fatto |
| 2 | modulo `crypto` (8 file, 9 rotte), script, dipendenza `ethers` | fatto |
| 3 | commissioni e tesoreria dai crediti | fatto |
| 4 | lettori delle tabelle monetarie in rete, admin, cancellazione account | fatto |
| 5 | migrazione: 3 tabelle, 5 colonne, 2 enum | fatto |
| 6 | contratti Solidity, configurazione, ogni promessa di guadagno in 7 lingue | fatto |

**I crediti restano**, ed è una conclusione dell'analisi, non una scelta di
comodo: un solo punto in tutto il codice li legava alla catena, tutti gli altri
li usano come quota di risorse. Non erano moneta.

**Tre rotture silenziose evitate**, che nessuna delle due letture superficiali
avrebbe trovato: la pagina pubblica della rete sarebbe andata in errore a ogni
richiesta, la cancellazione account per GDPR si sarebbe rotta di netto, e il
contatore antifrode sarebbe diventato un no-op permanente.

Elenco originale di ciò che è stato rimosso:

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

- Oggi: l'app locale sì, e **dalla 1.8.22 i modelli passano da una macchina
  all'altra sulla stessa rete anche a server spenti**. Il resto della rete no.
- Dopo la fase 1: i modelli continuano a circolare fra le persone.
- Dopo la fase 2: **i pari continuano a trovarsi** — per indirizzo diretto e passandosi chi conoscono, con identità che nessuno rilascia.
- Dopo la fase 3: **il lavoro continua a essere condiviso** — a reciprocità, verificato per ridondanza, e attraverso i router senza intermediari.
- Dopo la fase 4: **non cambia niente per nessuno** — i punti d'ingresso sono tanti, ricordati su disco e scambiati fra le macchine.

- Dopo la fase 5: **si trova un modello su una macchina mai incontrata** — l'indice non sta da nessuna parte e non c'è più niente da spegnere.

Quando la risposta è "tutto", lo scopo è raggiunto. **Da 1.9.0 la risposta è
"tutto", con una riserva onesta: serve un primo contatto, uno qualsiasi.**

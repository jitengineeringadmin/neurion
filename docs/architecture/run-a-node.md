# Tenere aperto un punto d'ingresso

Una rete fra pari ha un solo momento fragile: **il primo contatto.** Una
macchina appena installata non conosce nessuno, e finché non conosce qualcuno
non può conoscere nessun altro. Dopo quel primo contatto non serve più niente —
si ricorda chi ha risposto, si scambiano indirizzi, e l'indice distribuito
raggiunge il resto della rete da solo.

Un punto d'ingresso è la risposta a quel momento. Non è un server: non ha un
ruolo speciale, non decide niente, non vede il lavoro di nessuno, e chiunque può
tenerne uno acceso. Più ce ne sono, meno conta ognuno.

## Cosa serve

- una macchina accesa (un VPS da pochi euro, un Raspberry, un vecchio portatile
  in cantina — davvero non importa);
- **la porta TCP 8097 raggiungibile da fuori.** È l'unica cosa che va fatta
  bene: un nodo che nessuno riesce a contattare non è una via d'ingresso;
- Node.js e questo repository.

Un punto d'ingresso **non ha bisogno di modelli.** Non serve disco, non serve
scheda video, non serve potenza. Instrada domande e tiene qualche appunto che
scade da solo entro l'ora.

## Accenderlo

```bash
NEURION_NODE_DIR=/var/lib/neurion-node npx tsx apps/api/scripts/entry-node.ts
```

Stampa la propria identità all'avvio — l'impronta della chiave che si crea da
sé la prima volta, in `NEURION_NODE_DIR`. Quella cartella è tutto il suo stato:
una coppia di chiavi, gli indirizzi incontrati, e gli appunti temporanei di chi
ha cosa.

Per tenerlo su davvero, su Linux con systemd:

```ini
[Unit]
Description=Neurion entry node
After=network-online.target

[Service]
WorkingDirectory=/opt/neurion
Environment=NEURION_NODE_DIR=/var/lib/neurion-node
ExecStart=/usr/bin/npx tsx apps/api/scripts/entry-node.ts
Restart=always
RestartSec=10
User=neurion
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/neurion-node

[Install]
WantedBy=multi-user.target
```

## Farlo sapere agli altri

Il file `starter-nodes.json` nella cartella impostazioni di Neurion elenca gli
indirizzi da provare la prima volta. Chiunque può aggiungerci il proprio nodo,
o il nodo di un amico, o svuotarlo del tutto:

```json
[{ "address": "il-tuo-indirizzo.example", "port": 8097 }]
```

Neurion lo copia una volta sola alla prima accensione e **non lo tocca mai più**:
se lo modifichi, resta come lo hai lasciato.

## Quanto ti costa

Da 1.9.5 i limiti ci sono e sono prudenti di partenza: **poche copie alla volta,
una sola per macchina** — così un solo pari non si prende tutta la banda — e un
**tetto sulla velocità in salita**. Chi ha la fibra li alza in un secondo; chi ha
una linea sottile non deve scoprire l'impostazione accorgendosi che internet non
va più.

C'è anche una **lista di esclusi**: se una macchina si comporta male la ignori,
senza dover spegnere la condivisione con tutti.

E la porta del router **non si apre più da sola**: te lo chiede, e finché non
rispondi resta chiusa. Sulla rete locale e con chi ha già il tuo indirizzo la
condivisione funziona lo stesso.

## Cosa un nodo d'ingresso non fa

Vale la pena dirlo chiaro, perché chi presta una macchina ha diritto di sapere
esattamente cosa presta:

- **non scandaglia la rete a cui è attaccato.** Su una macchina affittata
  vorrebbe dire sondare il datacenter di qualcun altro;
- **non presta il processore** e non esegue i prompt di nessuno;
- **non vede nessun contenuto.** Passano richieste del tipo "chi ha il modello
  con questa impronta" e risposte del tipo "quella macchina lì". Mai un prompt,
  mai una risposta, mai un file;
- **non ha nessun potere sulla rete.** Non approva nessuno, non può escludere
  nessuno, e se sparisce chi lo usava aveva già imparato altri indirizzi.

## Il costo onesto

Chi si annuncia come detentore di un modello **pubblica il proprio indirizzo** a
chiunque chieda quella chiave. È inerente a come funziona un indice distribuito
— BitTorrent fa lo stesso — ed è il motivo per cui l'annuncio è legato
all'interruttore della condivisione e non riguarda mai i modelli che l'utente ha
indicato dal proprio disco.

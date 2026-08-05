# Dove va la potenza, e cosa si può recuperare

Tutti i numeri di questa pagina sono misurati su una macchina vera — 16 thread
logici, 27,7 GB di RAM, nessuna scheda video usata — con
`Qwen2.5-7B-Instruct-Q4_K_M` (4,36 GB) e llama.cpp b10107. Gli script stanno in
`scratchpad/`. Dove una misura ha smentito qualcosa che credevamo, è scritto.

## Il muro, e perché non è dove sembra

Produrre un token significa **leggere tutti i pesi del modello dalla RAM**. Le
moltiplicazioni che seguono costano quasi niente in confronto. Quindi il tetto è

```
token al secondo  ≈  banda di memoria  /  byte del modello
```

Misurato: 9,13 token/s × 4,36 GB ≈ **40 GB/s di banda utile**. Torna con una
macchina a doppio canale. Non è una teoria: è la spiegazione della tabella qui
sotto.

| thread | lettura del prompt | generazione |
|--------|-------------------|-------------|
| 4      | 17,1 t/s          | 7,4 t/s     |
| 6      | 24,0              | 8,6         |
| 8      | 29,2              | **9,1**     |
| 12     | 34,8              | 8,4         |
| 16     | **35,2**          | 7,4         |

**La generazione peggiora oltre gli otto thread.** Con sedici va come con
quattro. Non sta calcolando: sta aspettando la memoria, e più thread aggiungono
solo contesa sullo stesso bus. La lettura del prompt invece è aritmetica vera e
continua a salire.

Da qui discende tutto il resto. Ogni idea che serve a qualcosa deve **leggere
meno byte per token** oppure **ricavare più token dalla stessa lettura**.

## Cosa è stato cambiato

### Due numeri di thread invece di uno

llama.cpp li tiene separati (`--threads`, `--threads-batch`) e Neurion non ne
impostava nessuno, prendendo otto per entrambi. Otto è già l'ottimo per la
generazione, quindi resta automatico; il batch è alzato a tutti i thread.

**Circa +20% sulla lettura del prompt, a costo zero.** È il tempo che passa
prima che la risposta cominci.

### Prestare la macchina a più persone insieme

Prima: una richiesta alla volta, alla seconda si rispondeva 429.

| chiamanti insieme | produzione totale | tempo per lo stesso lavoro |
|-------------------|-------------------|----------------------------|
| 1                 | 8,06 t/s          | 31,8 s                     |
| 2                 | 10,92 t/s         | 23,4 s                     |
| 4                 | **18,75 t/s**     | 27,3 s                     |
| 8                 | 19,73 t/s         | (satura)                   |

Quattro insieme danno **2,33 volte** i token al secondo di quattro in fila. La
ragione è sempre quella: una lettura dei pesi serve tutte le sequenze che ci
viaggiano sopra.

**Non è una coda.** Nessuno aspetta, e non si chiede al proprietario più di
quanto avesse già concesso — la stessa generosità finisce prima e rende il
doppio. Il prezzo lo paga il singolo chiamante, che vede meno token al secondo:
per questo il numero è piccolo (due) e regolabile con
`NEURION_PEER_COMPUTE_SLOTS`.

Una trappola trovata misurando: **`-c` è il totale, non la dimensione di ogni
slot.** Con `-c 4096 -np 2` ogni slot riceve 2048. Aggiungere slot senza
moltiplicare il contesto avrebbe dimezzato in silenzio la finestra del
proprietario. E gli slot si aggiungono **solo se il prestito è acceso**, perché
la memoria chiave/valore di ogni slot si prenota all'avvio: chi non presta non
deve pagarla.

## Decodifica speculativa: misurata, e non è quello che sembrava

L'idea è giusta e attacca il muro nel punto esatto: qualcosa di economico
propone k token, il modello grande li verifica **in un solo passaggio** — una
lettura dei pesi invece di k.

**Una misura precedente aveva concluso che llama-server ignorasse la bandiera.
Era sbagliato.** `--spec-type` vale `none` per difetto: il modello bozza si
carica e la speculazione resta spenta. Con `--spec-type draft-simple` funziona,
e il registro del server mostra l'accettazione salire fino a 0,82.

Guadagno rispetto al riferimento (8,85 t/s), bozza da 0,5B:

| tipo di richiesta            | guadagno |
|------------------------------|----------|
| riscrivere del codice        | **1,52×** |
| correggere un testo          | **1,51×** |
| produrre JSON                | 1,26×    |
| scrivere codice              | 1,08×    |
| elenco                       | 0,87×    |
| spiegazione                  | 0,71×    |
| prosa libera                 | **0,64×** |
| **media**                    | 1,08×    |

Vince dove la risposta è già dentro la domanda. **Perde molto sulla prosa**: se
la bozza viene rifiutata, si è pagato per niente. In media non vale.

### E un avvertimento che conta più del guadagno

**Solo 3 risposte su 7 erano identiche al riferimento.** A temperatura zero la
decodifica speculativa dovrebbe essere esatta — la bozza propone, il modello
grande decide. Non lo è stata.

Neurion ha dimostrato che due pari onesti producono risposte **identiche byte
per byte** a temperatura zero, ed è quella proprietà che rende verificabile la
potenza prestata. Un pari che usa la bozza e uno che non la usa darebbero
risposte diverse, e il controllo di onestà accuserebbe di menzogna qualcuno che
non ha mentito.

**Quindi: se la speculazione verrà mai accesa, dovrà far parte dei parametri
concordati fra i due pari, esattamente come temperatura e seme.** Fino ad
allora resta spenta.

Le modalità a n-grammi (`ngram-simple`, `ngram-mod`), che non richiedono un
secondo modello, hanno invece dato **7 risposte identiche su 7** — ma con i
valori predefiniti nessun guadagno medio (0,98× e 0,92×). Sono tarate per
contesti lunghi.

## Verificare costa meno che generare

Rileggere token già esistenti: 29 t/s. Generarli: 8 t/s. **Controllare una
risposta costa circa un quarto del produrla.**

Oggi per controllare un pari se ne interrogano due e si confrontano le risposte:
costo, due generazioni. Chiedere invece a un secondo pari di *verificare*
porterebbe il costo del controllo da 100% a circa 28%. Non è implementato — è
scritto qui perché il numero c'è.

## Ciò che non conviene

- **Più thread.** Oltre otto la generazione peggiora. Misurato.
- **Instradare fra specialisti.** Già misurato altrove: +4 su domande nuove,
  dentro il rumore.
- **Bozza speculativa sempre accesa.** 1,08× di media, e rompe l'identità delle
  risposte.

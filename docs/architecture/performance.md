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
risposta costa circa un quarto del produrla**, e questo è implementato:
`/peer/verify`.

Un pari scrive la risposta e ne restituisce i **propri token**. Un secondo pari
riceve quei token, ne infila un pezzo nel modello e guarda se il modello
prosegue come la risposta prosegue.

### Tre cose scoperte misurando, ognuna delle quali avrebbe rotto il tutto

**1. Ri-tokenizzare il testo non ricostruisce i token.** Una risposta di 38
token, ripassata dal tokenizzatore come testo, ne dà 37 diversi. Un prefisso
ri-tokenizzato mette il modello in uno stato in cui non è mai stato. Per questo
chi genera manda i suoi token, e per questo entrambi i lati tokenizzano allo
stesso modo (`add_special: false`) — se uno aggiungesse un marcatore iniziale e
l'altro no, ogni controllo fallirebbe.

**2. Il confronto secco accusa gli onesti.** Rileggere in blocco e generare uno
alla volta non danno numeri identici: le somme avvengono in ordine diverso e su
un pareggio il tondeggiamento decide. Caso reale, un elenco di numeri dove il
modello era indeciso fra virgola e spazio:

```
,   logprob -0,761   ← scelto rileggendo in blocco
    logprob -1,049   ← scelto generando uno alla volta
```

0,29 nat di distanza. Nessuno aveva mentito. La regola quindi non è
l'uguaglianza: una posizione passa se il token dichiarato è **uno di quelli che
il modello considerava seriamente lì**, entro circa il 5% della probabilità del
suo preferito.

**3. Una finestra a caso è quasi inutile.** Presa da sola, coglieva un pari che
restituiva la risposta a un'altra domanda **1 volta su 32.** Il motivo è
strutturale: dai a un modello un prefisso già scorrevole e lui lo prosegue
volentieri. Una finestra a metà chiede "questo testo è coerente con sé stesso",
e lo è anche la risposta sbagliata. **Solo l'inizio è deciso dalla domanda.**

### Quanto vale, misurato

Con inizio + una finestra scelta dopo che la risposta è arrivata:

| | una finestra a caso | inizio + una a caso |
|---|---|---|
| pari onesti respinti | 0 su 32 | **0 su 42** |
| risposta di un'altra domanda | 3% | **88%** |
| frase preconfezionata | 47% | **88%** |
| metà vera, poi inventata | 43% | 48% |
| un solo token cambiato | 39% | 38% |

**88% non è 100%, quindi il controllo non condanna.** Se fallisce, si chiede al
secondo pari una risposta intera e si confronta — cioè quello che si faceva
sempre, ora pagato solo quando qualcosa già non torna.

Su risposte corte il risparmio è modesto; su risposte lunghe è quello che dice
il rapporto 29/8. E un pari più vecchio, che non conosce la richiesta o non manda
i token, fa tornare al confronto di prima invece di fallire.

## Ciò che non conviene

- **Più thread.** Oltre otto la generazione peggiora. Misurato.
- **Instradare fra specialisti.** Già misurato altrove: +4 su domande nuove,
  dentro il rumore.
- **Bozza speculativa sempre accesa.** 1,08× di media, e rompe l'identità delle
  risposte.

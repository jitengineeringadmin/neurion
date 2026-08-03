# La firma delle release

## Il buco che questo chiude

Fino alla 1.9.5 l'app scaricava l'aggiornamento e lo verificava con un'impronta
presa da `latest.json`. Ma `latest.json` stava **sullo stesso server**
dell'installer. Quindi quell'impronta dimostrava una cosa sola: che il download
non si era corrotto per strada.

Chiunque fosse riuscito a scrivere nella cartella web avrebbe potuto pubblicare
un eseguibile **e** l'impronta che lo garantiva, e ogni Neurion installato nel
mondo lo avrebbe scaricato ed **eseguito**. HTTPS non aiuta: dimostra che hai
raggiunto il server giusto, non che il server giusto sia rimasto onesto.

Per un progetto che esiste per non avere un padrone, quello era l'unico padrone
rimasto: chi controlla quel server controlla tutte le macchine.

## Come funziona adesso

Il manifesto è **firmato con una chiave che su quel server non è mai stata**.

- la chiave privata nasce una volta sola sulla macchina di chi pubblica e resta
  in `~/.neurion/release-key.json` — fuori dal repository, fuori dal server;
- la chiave pubblica è dentro l'app (`RELEASE_KEYS` in `apps/desktop/updater.js`);
- la firma copre **versione, nome del file e impronta**: i tre campi che
  decidono cosa viene scaricato ed eseguito. Cambiarne uno qualsiasi dopo la
  firma invalida tutto;
- un manifesto **senza** firma viene rifiutato esattamente come uno falsificato.
  Accettarlo "per compatibilità" vorrebbe dire che a un attaccante basta
  cancellare un campo.

Un server compromesso può servire quello che vuole. Non può farlo verificare.

## La cosa da non sbagliare

**Se la chiave privata va persa, non si può più aggiornare nessuno.** Mai più,
per nessuna macchina già installata. Non c'è recupero: è il senso del sistema.

Quindi: copiala da qualche parte al sicuro, ora. Non nel repository, non sul
VPS, non in un servizio a cui accedi con la stessa password del server.

Per questo `RELEASE_KEYS` è una **lista** e non una chiave sola: permette di
distribuire una release che accetta vecchia e nuova, e togliere la vecchia in
quella dopo. Una rotazione fatta così non lascia indietro nessuno.

## Cosa NON copre

Da dire chiaro, perché è la differenza fra due cose che sembrano uguali:

- **la firma del manifesto** dimostra che l'aggiornamento arriva da chi tiene la
  chiave. È questo documento, ed è fatto;
- **la firma dell'eseguibile** (certificato Authenticode) è un'altra cosa: serve
  a Windows per non mostrare l'avviso "editore sconosciuto" a chi installa la
  prima volta. Costa, e non è fatta.

La prima protegge chi ha già Neurion. La seconda protegge il primo incontro con
chi non ce l'ha ancora. Servono entrambe, ma solo la seconda costa soldi — e la
prima è quella che chiude il rischio più grave.

Nota sul passaggio: le versioni fino alla 1.9.5 non verificano niente, quindi
per le macchine già installate la finestra resta aperta finché non arrivano alla
1.9.6. È inevitabile e vale la pena saperlo invece di raccontarsi che sia chiuso
tutto.

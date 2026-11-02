# WET PAINT


Un gioco di THE WALL ARCADE. I nomi del muro diventano pennellate vive: un nome appare come una goccia di vernice
fresca, poi un pennello parte dalla goccia e lo scrive lungo un percorso fluido. **Metti il dito (o il mouse) sulla
goccia e segui il pennello fino in fondo prima che la vernice si asciughi.** Ogni pennellata completata resta sul muro:
dopo 90 secondi la tua tela è un'opera dipinta con i nomi delle persone del muro.

- 3 s di countdown, poi 90 s. **Dal primo all'ultimo secondo** il pennello accelera (da 0,45 a 1,05 checkpoint per tick,
  ×2,3: l'indicatore BRUSH sotto il timer), i percorsi si allungano (da 16 a 34 checkpoint) e ondeggiano di più, la
  tolleranza si stringe (da 42 a 23 px della tavola) e il tempo per finire si accorcia.
- Un checkpoint conta quando il tuo tratto lo raggiunge, in ordine e mai davanti al pennello; la distanza a cui ci passi
  ne fa la precisione. La qualità di una pennellata è la precisione media, meno il 6 % per ogni sbavatura (un invio di
  punti lontano dal percorso): MASTERSTROKE (90 %+), CLEAN (70 %+), ROUGH, SKETCHY.
- Punti: (60 + 10 × lunghezza) × qualità × moltiplicatore (×2 dopo 3 pennellate pulite di fila, fino a ×5).
- Una pennellata che si asciuga prima che tu la finisca, o che sbavi troppo (8 sbavature), costa 150 punti (mai sotto
  zero) e una delle tre **gocce di vernice**. Zero gocce: la tela è rovinata, fine.
- Tela completata per 90 s: **+3000 e +1000 per ogni goccia rimasta**.
- La fine mostra l'opera con i nomi dipinti, il punteggio, un titolo da artista (MASTER OF THE WALL, VIRTUOSO, IN THE
  FLOW, STEADY HAND, ABSTRACT EXPRESSIONIST, OUT OF PAINT), l'elenco dei nomi sulla tela, SHARE (l'immagine con la
  condivisione del telefono, oppure un post su X), "save the picture" e il record su questo dispositivo.
- Solo grafica: la carta, il pennello, la vernice bagnata che si asciuga, le lettere lungo la pennellata, la scia del
  dito, lo sprite della persona del muro che compare quando il suo nome è fissato, i suoni.

Pratica gratuita con le stesse regole nel browser, niente registrato.

## Pubblicare da Windows

Doppio clic su `PUBBLICA.cmd` (la prima volta e ogni volta che il gioco cambia). Fa tutto `PUBBLICA.ps1`: controlla
Node.js, installa la riga di comando di SuperRare e le dipendenze, aggiorna i nomi del muro, lancia i test, fa il login
se serve. La prima volta collega la cartella all'app: incolli l'App ID (e l'indirizzo) di un'app che esiste gia',
oppure scrivi **NUOVO** e la crea, **una volta sola** (la risposta resta in `deploy/wet-paint.app.json`, che non va su
git; la config in `deploy/wet-paint.config.json`): da li' in poi non ne crea mai un'altra e aggiorna sempre quella.
Alla fine stampa i dati per il modulo di invio e apre il gioco e la pagina di invio. Conserva la cartella `deploy`.

## Dove sta

| Parte | File |
| --- | --- |
| Regole deterministiche (motore, lo stesso modulo nel browser e nel verificatore) | `src/games/wet-paint/core.ts` |
| Schemi della pagina (sono i controlli di `core.ts`) | `src/games/wet-paint/engine.ts` |
| Client: tavola, pennello, tracciamento, opera, schermata finale | `src/games/wet-paint/client.ts` |
| Verificatore (`POST /v1`, senza zod) | `src/verifiers/wet-paint.ts` |
| Ingresso della pagina | `src/entries/wet-paint.ts` |
| Config pubblica, scritta dallo script | `deploy/wet-paint.config.json`, `scripts/wet-paint-config.ts` |
| Test | `tests/wet-paint.test.ts`, `tests/paid-round.test.ts`, `tests/credits-terms.test.ts`, `tests/week.test.ts` |

Gli unici input di gioco sono `{ "action": "trace", "pts": [x0, y0, …] }` (fino a 16 posizioni del puntatore, in unità
intere del campo 6000 × 8000), `{ "action": "lift" }` e `{ "action": "start" }`: mai un punteggio, un tempo, una
precisione o uno stato. Il percorso di ogni pennellata è una funzione pura di (seed, numero, tick di comparsa): non sta
nello stato e non si può manomettere. La pagina invia i punti al massimo ogni 2 tick; con la latenza il server li
applica un po' dopo, quando il pennello è solo più avanti, quindi contano lo stesso. I nomi vengono dallo snapshot del
muro incluso nella build (`src/generated/wall.json`, aggiornabile con `node --import tsx scripts/snapshot-wall.ts`); gli
sprite da people.json, solo grafica.

Input automatici perfettamente legali sono accettati da queste regole: il gioco non è a prova di bot.

# WET PAINT

A game of [THE WALL ARCADE](https://6972mvu4.srstudio.dev/), the arcade played on the names of a real wall in Lisbon
(ON THE WALL by NFC Summit). By osaykancuno (K4NCUN0 on the wall).

**The names of the wall become living brush strokes.** A name appears as a drop of wet paint; a brush runs from it
along a flowing path, writing the name. Put your finger (or the mouse) on the drop and follow the brush to the end
before the paint dries. Every finished stroke stays on the wall: after 90 seconds your canvas is an artwork painted
with the names of the people of the wall.

- 3 s of countdown, then 90 s. From the first second to the last the brush gets faster (×2.3), the paths longer
  (16 → 34 checkpoints) and wavier, the tolerance narrower and the time to finish shorter (BRUSH under the timer).
- Each checkpoint of the path counts when your trace reaches it, in order, never ahead of the brush; how far you pass
  from it sets its precision. A stroke's quality is the mean precision, minus 6 % per slip off the path:
  MASTERSTROKE (90 %+), CLEAN (70 %+), ROUGH, SKETCHY. Points: (60 + 10 × length) × quality × multiplier
  (×2 after 3 clean strokes in a row … ×5).
- A stroke that dries before you finish it, or that you smudge (8 slips), costs 150 points and one of three drops of
  paint. No paint left: the canvas is ruined. Paint the full 90 s: +3000 and +1000 per drop left.
- The end shows the artwork with the names painted, the score, an artist's title, the list of the names on the
  canvas, SHARE (the picture through the phone's share sheet, or a post on X) and the best score on this device.
- Players sign in with SuperRare Connect and spend 1 credit per run; the score is computed by SuperRare's server from
  the game's own rules (`src/games/wet-paint/core.ts`, the very module the verifier runs). Practice is free, local
  and unrecorded. The weekly leaderboard (Friday 15:00 to Friday 15:00, Lisbon) is the platform's.

> A Remix The Wall experiment · NFC Summit 2027 · Lisbon — https://onthewall.nfcsummit.com

## Publish (Windows)

Double-click `PUBBLICA.cmd`. The first time it installs what is missing, logs in to SuperRare Studio and links the
folder to WET PAINT's app: paste the App ID of an existing app, or type NUOVO to create it (once: the answer stays in
`deploy/wet-paint.app.json`, the config in `deploy/wet-paint.config.json`, and no second app is ever created from
them). Then, and every later run, it builds and updates that same app. Details in [docs/wet-paint.md](docs/wet-paint.md)
(Italian).

Elsewhere (Node.js 22+, `npm install --global @rareprotocol/rare-profile@0.1.0`, `rare-profile login`):

```sh
npm ci
npm run typecheck
npm test
npm run build -- --config deploy/wet-paint.config.json --output dist/wet-paint.zip --force
rare-profile app update <app-id> --zip dist/wet-paint.zip --max-attempts 10000 --json
```

## Where things are

| Part | Files |
| --- | --- |
| Rules (deterministic engine, shared by the page and the verifier) | `src/games/wet-paint/core.ts` |
| Page schemas (the verifier's own checks) | `src/games/wet-paint/engine.ts` |
| Client: board, brush, tracing, artwork, end screen | `src/games/wet-paint/client.ts` |
| Server verifier (`POST /v1`, no schema library) | `src/verifiers/wet-paint.ts` |
| Names of the wall (build-time snapshot; the page refreshes them live) | `src/generated/wall.json`, `scripts/snapshot-wall.ts` |
| Tests: rules, forged inputs, replay, timing, latency, tampered states, the built verifier, the paid round | `tests/` |
| Publishing | `PUBBLICA.cmd`, `PUBBLICA.ps1`, `scripts/wet-paint-config.ts` |
| Try the page locally with a fake Connect (no real payment) | `scripts/dev-flow.ts`, `scripts/dev-serve.ts` |

The rest (sign-in, credits, paid start, weekly leaderboard, Practice, the people of the wall's sprites) is
[THE WALL ARCADE's code](https://github.com/hs7j4yk4sz-boop/wall-arcade-connect), itself built on SuperRare's
[studio-games-example](https://github.com/superrare/studio-games-example): see `LICENSE` and `NOTICE` (MIT).

The only game inputs are `{ "action": "trace", "pts": [x0, y0, …] }` (up to 16 pointer positions, integer field units),
`{ "action": "lift" }` and `{ "action": "start" }`: never a score, a time, a precision or a state. Perfectly legal
automated inputs are accepted by these rules: the game is not bot-proof.

// WET PAINT: the rules (core.ts), the page's schemas (engine.ts) and the BUILT verifier, as Studio receives it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { packageGame } from '../scripts/package-game.js';
import { scoringConfiguration, type Configuration } from '../src/shell/config.js';
import { WALL_PANELS } from '../src/generated/wall.js';
import {
  BOX, FIELD_H, FIELD_W, RULES, checkState, createEngine, dryTickOf, geometryOf, headAt, inputSchema, levelAt, parseInput,
  passOffset, runTicks, stateSchema, type WpState,
} from '../src/games/wet-paint/engine.js';
import { mulberry32 } from '../src/common/det.js';
import { Coordinator, loadBuiltVerifier } from './helpers/coordinator.js';

const CONFIG = scoringConfiguration('wet-paint');
const engine = createEngine(WALL_PANELS);
const OPEN = RULES.countdownTicks;
const started = (seed: number): WpState => engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, 0);
const at = (s: WpState): WpState => engine.advance(s, OPEN);
const trace = (s: WpState, pts: number[], tick = s.tick): WpState => engine.applyInput(s, { action: 'trace', pts }, tick);
/** The checkpoints of the current stroke. */
const pathOf = (s: WpState): number[] => engine.geometry(s, s.play.stroke as { n: number; b: number }).pts;
/** A perfect trace of checkpoints [from, to] of the current stroke. */
const along = (s: WpState, from: number, to: number, dx = 0, dy = 0): number[] => {
  const cp = pathOf(s), out: number[] = [];
  for (let k = from; k <= to; k++) out.push(Math.max(0, Math.min(FIELD_W, (cp[2 * k] as number) + dx)), Math.max(0, Math.min(FIELD_H, (cp[2 * k + 1] as number) + dy)));
  return out;
};
/** Plays the current stroke perfectly, following the brush, in batches of up to 16 points; returns the state after it. */
function paintStroke(s0: WpState, offset = 0): WpState {
  let s = s0;
  const st = s.play.stroke;
  if (!st) return s;
  const lv = engine.levelOf(s, st);
  if (s.tick < st.b) s = engine.advance(s, st.b);
  while (!s.gameOver && s.play.stroke && s.play.stroke.n === st.n) {
    const k = s.play.stroke.k, head = headAt(st.b, lv, s.tick);
    const to = Math.min(head, k + RULES.maxPoints - 1, lv.checkpoints - 1);
    if (to >= k) s = trace(s, along(s, k, to, 0, offset), s.tick);
    if (s.play.stroke && s.play.stroke.n === st.n) s = engine.advance(s, s.tick + 1);
  }
  return s;
}

test('the scoring config: 3 s of countdown + 90 s of painting, with room to start', () => {
  assert.deepEqual(CONFIG, { game: 'wet-paint', maxTicks: 2160, roundTicks: 1860 });
  assert.equal(CONFIG.roundTicks, RULES.countdownTicks + RULES.playTicks);
});

test('the ramp: faster brush, longer and wavier paths, narrower tolerance, less time to finish, from the first second to the last', () => {
  const a = levelAt(0), b = levelAt(RULES.playTicks);
  assert.ok(b.speed > 2 * a.speed && b.checkpoints > 2 * a.checkpoints - 1 && b.tolerance < a.tolerance && b.grace < a.grace && b.wave > 3 * a.wave);
  assert.deepEqual(levelAt(-50), a); assert.deepEqual(levelAt(RULES.playTicks + 500), b);
  for (let e = 1; e <= RULES.playTicks; e++) {
    const p = levelAt(e - 1), q = levelAt(e);
    assert.ok(q.speed >= p.speed && q.speed - p.speed <= 1 && q.tolerance <= p.tolerance && q.checkpoints >= p.checkpoints, 'never a jump, never easier');
  }
});

test('paths: deterministic, inside the painting box, a step apart, for every seed and every moment of the run', () => {
  for (let seed = 0; seed < 200; seed++) {
    for (const elapsed of [0, 400, 900, 1400, 1800]) {
      const g = geometryOf(seed * 7919, seed % 50, elapsed);
      assert.deepEqual(g, geometryOf(seed * 7919, seed % 50, elapsed));
      assert.equal(g.pts.length, 2 * g.level.checkpoints);
      for (let i = 0; i < g.pts.length; i += 2) {
        assert.ok(Number.isSafeInteger(g.pts[i]) && Number.isSafeInteger(g.pts[i + 1]));
        assert.ok((g.pts[i] as number) >= BOX.x0 && (g.pts[i] as number) <= BOX.x1 && (g.pts[i + 1] as number) >= BOX.y0 && (g.pts[i + 1] as number) <= BOX.y1);
        if (i) assert.ok(Math.hypot((g.pts[i] as number) - (g.pts[i - 2] as number), (g.pts[i + 1] as number) - (g.pts[i - 1] as number)) <= RULES.step + 2);
      }
    }
  }
});

test('createRun validates its seed and config; same seed and inputs, same run; the state round-trips through JSON', () => {
  assert.throws(() => engine.createRun(-1, CONFIG)); assert.throws(() => engine.createRun(2 ** 32, CONFIG)); assert.throws(() => engine.createRun('1', CONFIG));
  assert.throws(() => engine.createRun(1, { ...CONFIG, game: 'another-game' })); assert.throws(() => engine.createRun(1, { ...CONFIG, maxTicks: 5 }));
  const a = paintStroke(at(started(42))), b = paintStroke(at(started(42)));
  assert.deepEqual(a, b);
  assert.notDeepEqual(pathOf(at(started(42))), pathOf(at(started(43))), 'another seed, another painting');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.deepEqual(checkState(a), a);
  let stepped = started(42); for (let t = 1; t <= 900; t += 7) stepped = engine.advance(stepped, t);
  assert.deepEqual(engine.advance(stepped, 900), engine.advance(started(42), 900), 'many small advances = one big advance');
});

test('names: every stroke a name of the wall, nobody twice before everybody has been painted', () => {
  const seen = new Set<number>();
  for (let n = 0; n < engine.pool.length; n++) seen.add(engine.panelOf(77, n));
  assert.equal(seen.size, engine.pool.length);
  assert.ok(WALL_PANELS.some((p) => p.p === engine.panelOf(77, 0)));
});

test('a perfect trace fixes the stroke on the wall at quality 1000, and scores', () => {
  const s = paintStroke(at(started(1)));
  assert.equal(s.play.fixed, 1); assert.equal(s.play.master, 1);
  assert.deepEqual(s.play.events.map((e) => e.what), ['fixed']);
  assert.equal(s.play.canvas.length, 1); assert.equal(s.play.canvas[0]?.q, 1000);
  assert.equal(s.play.score, 60 + 10 * levelAt(0).checkpoints);
  assert.equal(s.play.combo, 1);
  assert.equal(s.play.stroke?.n, 1, 'the next stroke is on its way');
  assert.equal(s.play.stroke?.b, s.tick + levelAt(0).gap);
});

test('more precision, a better stroke and more points; a trace beyond the tolerance captures nothing', () => {
  const quality = (offset: number): number => { const s = paintStroke(at(started(5)), offset); return s.play.canvas[0]?.q ?? -1; };
  const R = levelAt(0).tolerance;
  const q0 = quality(0), q1 = quality(Math.floor(R / 4)), q2 = quality(Math.floor(R / 2));
  assert.equal(q0, 1000); assert.ok(q1 < q0 && q2 < q1 && q2 > 0, `${q0} ${q1} ${q2}`);
  // a parallel trace far off the path: no checkpoint at all, then the stroke dries
  let s = at(started(5));
  const lv = levelAt(0);
  s = trace(s, along(s, 0, 0, 0, R + 60));
  assert.equal(s.play.stroke?.k, 0);
  s = engine.advance(s, dryTickOf((s.play.stroke as { b: number }).b, lv));
  assert.deepEqual(s.play.events.map((e) => e.what), ['dried']);
});

test('the trace must follow the brush: a checkpoint ahead of the brush cannot be captured yet', () => {
  let s = at(started(9));
  const lv = levelAt(0);
  s = trace(s, along(s, 0, 15));
  assert.equal(s.play.stroke?.k, 1, 'only the drop itself before the brush moves');
  s = engine.advance(s, OPEN + lv.lead + Math.ceil(300 / lv.speed));  // the brush has passed checkpoint 3
  const head = headAt(OPEN, lv, s.tick);
  s = trace(s, along(s, 1, 15));
  assert.equal(s.play.stroke?.k, head + 1, `up to the brush (${head})`);
});

test('checkpoints are captured in order: skipping to the end, or tracing backwards, captures nothing', () => {
  let s = at(started(11));
  const lv = levelAt(0);
  s = engine.advance(s, OPEN + runTicks(lv));          // the brush is at the end
  const M = lv.checkpoints;
  const end = along(s, M - 1, M - 1);
  s = trace(s, end);
  assert.equal(s.play.stroke?.k, 0, 'the end without the start');
  const backwards = along(s, 0, M - 1);
  const rev: number[] = [];
  for (let i = backwards.length - 2; i >= 0; i -= 2) rev.push(backwards[i] as number, backwards[i + 1] as number);
  s = engine.applyInput(s, { action: 'lift' }, s.tick + 1);
  s = trace(s, rev.slice(0, 32), s.tick + 1);
  // backwards, the trace only nears the start at its very end: at most the checkpoints within the tolerance of the drop,
  // badly (they are passed sideways), and nothing after them
  const k = s.play.stroke?.k ?? 0;
  assert.ok(k <= 1 + Math.ceil(lv.tolerance / RULES.step), `backwards: only near the drop, got ${k}`);
  assert.ok((s.play.stroke?.acc ?? 0) < 1000 * k * 0.8, 'and badly');
});

test('a dried stroke and a smudged stroke cost points (never below 0), the streak and a drop; three drops and the canvas is ruined', () => {
  let s = paintStroke(at(started(3)));
  const before = s.play.score;
  // dry: nothing traced
  s = engine.advance(s, dryTickOf((s.play.stroke as { b: number }).b, engine.levelOf(s, s.play.stroke as { b: number })));
  assert.equal(s.play.events.at(-1)?.what, 'dried');
  assert.equal(s.play.score, Math.max(0, before - RULES.failPenalty)); assert.equal(s.play.combo, 0); assert.equal(s.play.drops, RULES.drops - 1);
  // smudge: start it, then wander off the path again and again
  s = engine.advance(s, (s.play.stroke as { b: number }).b);
  s = trace(s, along(s, 0, 0));
  assert.equal(s.play.stroke?.k, 1);
  for (let i = 0; i < RULES.maxSlips; i++) s = trace(s, [i % 2 ? 0 : FIELD_W, FIELD_H], s.tick + 1);
  assert.equal(s.play.events.at(-1)?.what, 'smudged');
  assert.equal(s.play.drops, RULES.drops - 2); assert.equal(s.play.smudged, 1);
  // a third failure ends the run, with no survival bonus
  s = engine.advance(s, dryTickOf((s.play.stroke as { b: number }).b, engine.levelOf(s, s.play.stroke as { b: number })));
  assert.equal(s.gameOver, true); assert.equal(s.play.end, 'ruined'); assert.equal(s.play.bonus, 0); assert.equal(s.play.drops, 0);
  assert.equal(engine.isFinished(s), true);
  // terminal: nothing changes it any more
  assert.deepEqual(trace(s, along(at(started(3)), 0, 3), s.tick + 5).play, s.play);
  assert.deepEqual(engine.advance(s, CONFIG.maxTicks), s);
});

test('a slip costs quality: a stroke finished after wandering off is worth less', () => {
  const clean = paintStroke(at(started(21)));
  let s = at(started(21));
  s = trace(s, along(s, 0, 0));
  s = trace(s, [0, FIELD_H], s.tick + 1); s = trace(s, [0, FIELD_H], s.tick + 1);
  s = engine.applyInput(s, { action: 'lift' }, s.tick + 1);
  s = paintStroke(s);
  assert.equal(s.play.canvas[0]?.q, 1000 - 2 * RULES.slipPenalty);
  assert.ok(s.play.score < clean.play.score);
});

test('the full 90 s pays the big bonus; a clean streak multiplies (×5 at most)', () => {
  let s = at(started(8));
  while (!s.gameOver) s = s.play.stroke ? paintStroke(s) : engine.advance(s, CONFIG.maxTicks);
  assert.equal(s.play.end, 'time');
  assert.equal(s.play.bonus, RULES.survival + RULES.perDrop * RULES.drops);
  assert.equal(s.play.dried + s.play.smudged, 0); assert.equal(s.play.master, s.play.fixed);
  assert.ok(s.play.fixed >= 25, `${s.play.fixed} strokes`);
  assert.equal(engine.multOf(s.play.bestCombo), RULES.multCap);
  assert.ok(s.play.canvas.length === s.play.fixed && s.play.canvas.length <= RULES.canvasMax);
  assert.ok(JSON.stringify(s).length < 8192, 'a small state');
  console.log(`  perfect run: ${s.play.fixed} strokes, score ${s.play.score}`);
});

test('inputs: strict shapes; a wrong action, an extra field, a forged score or a point off the field changes nothing', () => {
  assert.deepEqual(parseInput({ action: 'start' }), { action: 'start' });
  assert.deepEqual(parseInput({ action: 'lift' }), { action: 'lift' });
  assert.deepEqual(parseInput({ action: 'trace', pts: [1, 2] }), { action: 'trace', pts: [1, 2] });
  const bad: unknown[] = [
    null, 7, 'trace', [], {}, { action: 'paint' }, { action: 'hit', targetId: 3 }, { action: 'start', now: 1 }, { action: 'lift', x: 1 },
    { action: 'trace' }, { action: 'trace', pts: [] }, { action: 'trace', pts: [1] }, { action: 'trace', pts: [1, 2, 3] },
    { action: 'trace', pts: [-1, 2] }, { action: 'trace', pts: [FIELD_W + 1, 2] }, { action: 'trace', pts: [1, FIELD_H + 1] },
    { action: 'trace', pts: [1.5, 2] }, { action: 'trace', pts: ['1', 2] }, { action: 'trace', pts: new Array(34).fill(5) },
    { action: 'trace', pts: [1, 2], score: 999999 }, { action: 'trace', pts: [1, 2], q: 1000 }, { action: 'trace', pts: { 0: 1, 1: 2 } },
  ];
  for (const input of bad) assert.equal(parseInput(input), null, JSON.stringify(input));
  const s = at(started(4));
  const good = along(s, 0, 0);
  for (const input of bad) {
    const after = engine.applyInput(s, input, s.tick + 1);
    assert.deepEqual(after.play, engine.advance(s, s.tick + 1).play, `ignored: ${JSON.stringify(input)}`);
  }
  // a trace with a forged extra field is not a trace
  assert.equal(engine.applyInput(s, { action: 'trace', pts: good, score: 5000 }, s.tick).play.stroke?.k, 0);
  assert.equal(trace(s, good).play.stroke?.k, 1);
  assert.ok(inputSchema.safeParse({ action: 'trace', pts: good }).success);
  assert.ok(!inputSchema.safeParse({ action: 'trace', pts: good, score: 1 }).success);
});

test('timing: no trace before the start or during the countdown; starting twice never extends the round; time never moves back', () => {
  const fresh = engine.createRun(6, CONFIG);
  assert.deepEqual(engine.applyInput(fresh, { action: 'trace', pts: [3000, 4000] }, 3).play, fresh.play);
  const s = started(6);
  assert.equal(s.play.stroke?.b, OPEN, 'the first stroke appears when the countdown ends');
  const early = trace(engine.advance(s, 30), along(at(s), 0, 3), 30);
  assert.equal(early.play.stroke?.k, 0); assert.deepEqual(early.play.pen, []);
  const again = engine.applyInput(engine.advance(s, 500), { action: 'start' }, 501);
  assert.equal(again.startTick, 0, 'start does not move');
  assert.equal(engine.endTickOf(again), CONFIG.roundTicks);
  assert.throws(() => engine.advance(engine.advance(s, 100), 99));
  assert.throws(() => engine.applyInput(engine.advance(s, 100), { action: 'lift' }, 50));
  // nobody started: the horizon ends the run with nothing
  const idle = engine.advance(engine.createRun(6, CONFIG), CONFIG.maxTicks);
  assert.equal(idle.play.end, 'horizon'); assert.equal(idle.play.score, 0);
  // no stroke in the last second and a half
  let late = at(started(6));
  while (!late.gameOver) late = late.play.stroke ? paintStroke(late) : engine.advance(late, CONFIG.maxTicks);
  assert.ok(late.play.canvas.every((f) => f.b < CONFIG.roundTicks - RULES.lastStrokeBeforeEnd));
});

test('replay: the same input sent again after the stroke is fixed scores nothing more', () => {
  let s = at(started(13));
  s = paintStroke(s);
  const score = s.play.score, pts = along({ ...s, play: { ...s.play, stroke: { n: 0, b: OPEN, k: 0, acc: 0, slips: 0 } } }, 0, 15);
  for (let i = 0; i < 5; i++) s = trace(s, pts, s.tick + 1);
  assert.equal(s.play.score, score);
  assert.equal(s.play.fixed, 1);
});

test('latency: the server applies a trace a few ticks after the finger, and it still counts (the brush is only further ahead)', () => {
  const lv = levelAt(0);
  let local = at(started(17)), server = at(started(17));
  for (let t = OPEN; local.play.fixed === 0 && t < OPEN + 400; t += 2) {
    local = engine.advance(local, t);
    const st = local.play.stroke!;
    const head = headAt(st.b, lv, t);
    const to = Math.min(head, st.k + RULES.maxPoints - 1, lv.checkpoints - 1);
    if (to < st.k) continue;
    const pts = along(local, st.k, to);
    local = trace(local, pts, t);
    server = trace(server, pts, t + 3);                 // 150 ms later
  }
  assert.equal(server.play.fixed, 1); assert.equal(server.play.canvas[0]?.q, 1000);
});

test('passOffset: a trace reaches a checkpoint only once it gets to it along the path; the offset is the sideways error', () => {
  const cp = [0, 0, 100, 0, 200, 0];
  assert.equal(passOffset(cp, 1, 0, 0, 50, 0), -1, 'not there yet');
  assert.equal(passOffset(cp, 1, 0, 30, 150, 30), 30);
  assert.equal(passOffset(cp, 1, 0, 0, 100, 0), 0);
  assert.ok(Math.abs(passOffset(cp, 1, 150, 40, 160, 40) - Math.hypot(50, 40)) < 1e-9, 'already beyond: the closest point');
});

test('tampered states are refused by the verifier\'s own checks', () => {
  const s = paintStroke(at(started(31)));
  assert.doesNotThrow(() => checkState(s));
  assert.ok(stateSchema.safeParse(s).success);
  const tamper = (f: (x: any) => void): unknown => { const x = structuredClone(s) as any; f(x); return x; };
  const cases: unknown[] = [
    tamper((x) => { x.extra = 1; }), tamper((x) => { x.play.extra = 1; }), tamper((x) => { x.play.score = -5; }),
    tamper((x) => { x.play.score = 1.5; }), tamper((x) => { x.play.drops = 4; }), tamper((x) => { x.play.end = 'won'; }),
    tamper((x) => { x.play.canvas[0].q = 1001; }), tamper((x) => { x.play.canvas[0].hack = 1; }),
    tamper((x) => { x.play.stroke.k = 99; }), tamper((x) => { x.play.stroke.acc = 1_000_000; }), tamper((x) => { x.play.stroke.slips = RULES.maxSlips + 1; }),
    tamper((x) => { x.play.pen = [1, 2, 3]; }), tamper((x) => { x.play.pen = [FIELD_W + 1, 0]; }),
    tamper((x) => { x.play.master = x.play.fixed + 1; }), tamper((x) => { x.play.qSum = 1000 * x.play.fixed + 1; }),
    tamper((x) => { x.gameOver = true; }), tamper((x) => { x.play.combo = x.play.bestCombo + 1; }),
    tamper((x) => { x.rules.game = 'another-game'; }), tamper((x) => { x.play.events[0].what = 'bonus'; }),
    tamper((x) => { x.play.canvas = new Array(RULES.canvasMax + 1).fill({ n: 0, b: 60, q: 1 }); }),
    tamper((x) => { x.started = false; }), tamper((x) => { x.tick = CONFIG.maxTicks + 1; }),
  ];
  for (const c of cases) { assert.throws(() => checkState(c)); assert.ok(!stateSchema.safeParse(c).success); }
});

/* ------------------------------ the BUILT verifier ------------------------------ */
const ARCHIVE: Configuration = {
  appId: '00000000-0000-4000-8000-00000000b001', groupId: '60faaf46-ba4b-460c-a82a-adb852371a94', studioUrl: 'https://studio.superrare.com',
  apiUrl: 'https://api.superrare.com', connectUrl: 'https://connect.superrare.com', appOrigin: 'https://wet-paint-test.srstudio.dev',
  display: 'embed', game: 'wet-paint', hubUrl: 'https://6972mvu4.srstudio.dev/',
};
async function built() {
  const files = unzipSync(zipSync(await packageGame(ARCHIVE)));
  const verifier = await loadBuiltVerifier(files['server-verifier.js'] as Uint8Array);
  return { files, verifier, config: JSON.parse(strFromU8(files['scoring-config.json'] as Uint8Array)) as Record<string, unknown> };
}

test('wet-paint: the archive has Studio\'s root layout, the credit line, a zod-free verifier under 256 KB, no debug hook', async () => {
  const { files, config } = await built();
  for (const required of ['index.html', 'config.json', 'server-verifier.js', 'scoring-config.json']) assert.ok(files[required], `missing ${required}`);
  assert.ok(Object.keys(files).some((name) => /^assets\/app-[0-9a-f]{16}\.js$/.test(name)), 'content-hashed app bundle');
  assert.deepEqual(config, CONFIG);
  const verifier = files['server-verifier.js'] as Uint8Array;
  assert.ok(verifier.byteLength < 256_000, `${verifier.byteLength} B`);
  assert.ok(!/ZodError|\$ZodType/.test(strFromU8(verifier)), 'zod-free verifier');
  const html = strFromU8(files['index.html'] as Uint8Array);
  assert.ok(html.includes('<title>WET PAINT · THE WALL ARCADE</title>'));
  assert.ok(/remix the wall experiment/i.test(html) && html.includes('https://onthewall.nfcsummit.com'), 'the credit line, linked');
  const app = strFromU8(files[Object.keys(files).find((n) => n.startsWith('assets/app-')) as string] as Uint8Array);
  assert.ok(!app.includes('__wpDebug'), 'the dev-only debug hook is not in the published bundle');
  const publicConfig = strFromU8(files['config.json'] as Uint8Array);
  assert.ok(!/secret|token|private|treasury|0x[0-9a-fA-F]{40}/i.test(publicConfig));
  assert.equal(JSON.parse(publicConfig).groupId, '60faaf46-ba4b-460c-a82a-adb852371a94');
});

test('wet-paint: the BUILT verifier answers the conformance probe and rejects everything else', async () => {
  const { verifier, config } = await built();
  const probe = new Coordinator(verifier, config, 0);
  const state = await probe.create() as WpState;
  assert.equal(state.rules.game, 'wet-paint');
  assert.equal(await probe.score(), 0); assert.equal(await probe.isFinished(), false); assert.deepEqual(await probe.view(), state);
  const post = (payload: unknown) => verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
  assert.equal((await post({ version: '1', op: 'createRun', seed: 1, config })).status, 400, 'version must be the number 1');
  assert.equal((await post({ version: 1, op: 'score', state: { ...state, bogus: 9 } })).status, 400);
  assert.equal((await post({ version: 1, op: 'submitScore', score: 999999 })).status, 400);
  assert.equal((await post({ version: 1, op: 'advance', state, serverTick: -1 })).status, 400);
  assert.equal((await post({ version: 1, op: 'advance', state, serverTick: 3, extra: true })).status, 400, 'strict envelope');
  assert.equal((await post({ version: 1, op: 'createRun', seed: 1, config: { ...config, game: 'another-game' } })).status, 400);
  assert.equal((await verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'GET' }))).status, 404);
  assert.equal((await verifier.fetch(new Request('https://verifier.invalid/other', { method: 'POST', body: '{}' }))).status, 404);
  // a forged input through the protocol is a no-op, never a score
  const started1 = await probe.input({ action: 'start' }, 1) as WpState;
  const forged = await probe.input({ action: 'trace', pts: [3000, 4000], score: 99999 }, 70) as WpState;
  assert.equal(forged.play.score, 0); assert.deepEqual(forged.play.pen, []);
  assert.equal(started1.startTick, 1);
});

test('wet-paint: whole runs through the BUILT verifier, one input per tick like the platform, equal the engine and replay exactly', async () => {
  const { verifier: raw, config } = await built();
  const times: number[] = [];
  const verifier = { fetch: async (request: Request): Promise<Response> => { const t0 = performance.now(); const r = await raw.fetch(request); times.push(performance.now() - t0); return r; } };
  for (const seed of [123456, 0, 0xfeedface]) {
    const run = new Coordinator<WpState>(verifier, config, seed);
    let local = engine.createRun(seed, config);
    await run.create();
    const sent: { input: unknown; tick: number }[] = [];
    const send = async (input: unknown, tick: number): Promise<void> => { await run.input(input, tick); sent.push({ input, tick: run.tick }); local = engine.applyInput(local, input, run.tick); };
    await send({ action: 'start' }, 2);
    const rnd = mulberry32(seed ^ 0x77);
    // a fallible painter: a sideways error of up to ±noise, now and then a lift, a slip or a stroke left to dry
    const noise = 120 + Math.floor(rnd() * 120);
    let skip = -1;
    while (!run.state.gameOver && run.tick < (config.maxTicks as number)) {
      await run.advanceTo(run.tick + 1); local = engine.advance(local, run.tick);
      const st = run.state.play.stroke;
      if (!st || run.tick < st.b || st.n === skip) continue;
      if (rnd() < 0.004) { skip = st.n; continue; }
      if (rnd() < 0.5) continue;                         // one input every other tick or so, like the page
      const lv = engine.levelOf(run.state, st), head = headAt(st.b, lv, run.tick + 1);
      const to = Math.min(head, st.k + RULES.maxPoints - 1, lv.checkpoints - 1);
      if (rnd() < 0.02) { await send({ action: 'lift' }, run.tick + 1); continue; }
      if (rnd() < 0.01) { await send({ action: 'trace', pts: [Math.floor(rnd() * FIELD_W), Math.floor(rnd() * FIELD_H)] }, run.tick + 1); continue; }
      if (to < st.k) continue;
      const pts: number[] = [];
      const cp = engine.geometry(run.state, st).pts;
      for (let k = st.k; k <= to; k++) pts.push(Math.max(0, Math.min(FIELD_W, (cp[2 * k] as number) + Math.round((rnd() * 2 - 1) * noise))), Math.max(0, Math.min(FIELD_H, (cp[2 * k + 1] as number) + Math.round((rnd() * 2 - 1) * noise))));
      await send({ action: 'trace', pts }, run.tick + 1 + Math.floor(rnd() * 3));
    }
    await run.advanceTo(config.maxTicks as number); local = engine.advance(local, run.tick);
    assert.equal(run.state.gameOver, true);
    assert.deepEqual(run.state, local, 'bundled verifier state equals the engine in-process');
    assert.equal(await run.isFinished(), true); assert.equal(await run.score(), run.state.play.score);
    const again = new Coordinator<WpState>(verifier, config, seed);
    await again.create();
    for (const { input, tick } of sent) await again.input(input, tick);
    await again.advanceTo(run.tick);
    assert.deepEqual(again.state, run.state, 'same seed, same inputs at the same ticks: same run');
    const p = run.state.play;
    console.log(`  wet-paint built verifier (seed ${seed}): ${run.calls} calls, end ${p.end}, score ${p.score}, fixed ${p.fixed} (avg q ${Math.round(p.qSum / Math.max(1, p.fixed))}), dried ${p.dried}, smudged ${p.smudged}, largest state ${run.largestState} B`);
    assert.ok(run.largestState < 8192);
    for (const { input } of sent) assert.ok(JSON.stringify({ type: 'input', seq: 99999, input }).length <= 1024, 'every message under 1 KiB');
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] as number, p99 = times[Math.floor(times.length * 0.99)] as number;
  console.log(`  wet-paint built verifier: ${times.length} calls, median ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${(times.at(-1) as number).toFixed(2)} ms`);
  assert.ok(p99 < 3, `p99 ${p99} ms`);
});

test('wet-paint: the heaviest calls (a full 16-point trace, an idle run advanced in one go) stay far under 10 ms', async () => {
  const { verifier, config } = await built();
  let worst = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const run = new Coordinator<WpState>(verifier, config, seed);
    await run.create(); await run.input({ action: 'start' }, 1);
    await run.advanceTo(1500);
    const pts: number[] = [];
    for (let i = 0; i < RULES.maxPoints; i++) pts.push(300 + i * 300, 7900 - i * 400);
    for (let i = 0; i < 20; i++) await run.input({ action: 'trace', pts });
    await run.advanceTo(config.maxTicks as number);
    worst = Math.max(worst, run.worstMs);
  }
  console.log(`  wet-paint built verifier: worst call ${worst.toFixed(2)} ms`);
  assert.ok(worst < 10);
});

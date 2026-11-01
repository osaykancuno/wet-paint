// WET PAINT: the deterministic rules, shared by the browser (prediction, practice) and the server verifier (zod-free).
//
// The names of the wall become live brush strokes. A stroke appears as a drop of wet paint; then a brush runs along a
// flowing path, writing a name of the wall. The player follows it with a finger or the mouse, from the drop to the end,
// before the paint dries. Every checkpoint of the path is captured when the player's trace passes close enough to it,
// in order and never ahead of the brush; how close decides the stroke's quality. A finished stroke is FIXED on the
// digital wall (the collective artwork) and scores by its quality; a stroke that dries before it is finished, or that
// the player smudges by wandering off the path too long, costs points and one of three drops of paint. 90 s; the brush
// gets faster, the paths longer and wavier and the tolerance narrower from the first second to the last. Finishing the
// 90 s with paint left pays a big bonus.
//
// The only inputs: { action: 'start' }, { action: 'trace', pts: [x0, y0, x1, y1, …] } (up to 16 points of the pointer,
// integer field units, in the order drawn) and { action: 'lift' } (the finger left the screen). Never a score, a time,
// a precision or a state: the rules measure the trace against the path they generate themselves.
//
// Arithmetic: + - * / sqrt floor round and the Taylor sin/cos of src/common/det.ts only (exact or correctly rounded in
// every JS engine), a seeded generator, a state that round-trips through JSON exactly, no clock, no network. The path
// of stroke n is a pure function of (seed, n, the tick it appeared): it is never stored in the state, so it cannot be
// tampered with.
import { fnv1a, mulberry32, sinCos100 } from '../../common/det.js';

/* ================================ RULES ==================================== */
/** The field, in integer units (10 units = 1 px of the 600 × 800 board). */
export const FIELD_W = 6000, FIELD_H = 8000;
/** Where paths may run: below the score bar, inside a margin. */
export const BOX = { x0: 450, x1: 5550, y0: 1250, y1: 7550 } as const;
export const RULES = {
  countdownTicks: 60,                         // 3 s between the start and the first brush
  playTicks: 1800,                            // 90 s
  drops: 3,                                   // three drops of paint: a dried or smudged stroke costs one
  step: 180,                                  // field units between two checkpoints of a path
  maxPoints: 16,                              // points of the pointer in one trace input
  jump: 1500,                                 // a gap wider than this between two points is a new touch, not a line
  maxSlips: 8,                                // trace inputs off the path before the stroke is smudged
  slipPenalty: 60,                            // quality lost per slip (out of 1000)
  cleanQuality: 700,                          // a stroke at least this good keeps the streak going
  masterQuality: 900,                         // MASTERSTROKE
  comboEvery: 3, multCap: 5,                  // ×2 after 3 clean strokes in a row, … ×5 at most
  failPenalty: 150,                           // a dried or smudged stroke (the score never goes below 0)
  survival: 3000, perDrop: 1000,              // the 90 s held: +3000 and +1000 per drop of paint left
  lastStrokeBeforeEnd: 30,                    // no new stroke in the last 1.5 s
  canvasMax: 80, eventsMax: 8,
  /** The ramp, even from the first brush to the end (linear in the elapsed ticks, integer steps). */
  ramp: {
    checkpoints: [16, 34],                    // length of a path
    tolerance: [420, 230],                    // field units: how close the trace must pass to a checkpoint
    speed: [45, 105],                         // hundredths of a checkpoint per tick the brush moves
    lead: [16, 8],                            // ticks the drop waits before the brush moves
    grace: [36, 18],                          // ticks left to finish after the brush reached the end
    gap: [12, 6],                             // ticks between a stroke and the next
    wave: [500, 1800],                        // hundredths of a degree: how much the path turns per step
    freq: [1500, 3600],                       // hundredths of a degree: how fast the turning oscillates
  },
};
/** fixed: a stroke completed and fixed on the wall · dried: not finished in time · smudged: too far off the path. */
export const WHATS = ['fixed', 'dried', 'smudged'] as const;
export type What = (typeof WHATS)[number];

/* ============================ TYPES & VALIDATION ============================= */
export type NamedPanel = { p: number; n: string };
export type WpConfig = { game: 'wet-paint'; maxTicks: number; roundTicks: number };
/** The stroke on the board (it may still be waiting to appear: tick < b). */
export type Stroke = {
  /** Stroke number in this run: its path and its name come from (seed, n, b). */
  n: number;
  /** Tick it appears. */
  b: number;
  /** Checkpoints captured so far (the next one to capture). */
  k: number;
  /** Sum of the precision of the captured checkpoints (0…1000 each). */
  acc: number;
  /** Trace inputs that wandered off the path. */
  slips: number;
};
/** A stroke fixed on the wall: the artwork. q is its quality, 0…1000. */
export type Fixed = { n: number; b: number; q: number };
export type WpEvent = { seq: number; tick: number; n: number; b: number; what: What; q: number; gain: number };
export type End = 'none' | 'time' | 'ruined' | 'horizon';
export type Play = {
  score: number; combo: number; bestCombo: number; drops: number;
  fixed: number; master: number; dried: number; smudged: number; qSum: number;
  bonus: number; end: End;
  stroke: Stroke | null;
  /** The last point of the trace, [x, y], or [] when the finger is up. */
  pen: number[];
  canvas: Fixed[];
  events: WpEvent[]; eventSeq: number;
};
export type WpState = { tick: number; gameOver: boolean; started: boolean; startTick: number | null; seed: number; rules: WpConfig; play: Play };
export type WpInput = { action: 'start' } | { action: 'lift' } | { action: 'trace'; pts: number[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const MAX_INT = Number.MAX_SAFE_INTEGER;
const MAX_N = 100_000;
function exactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const fail = (what: string): never => { throw new Error(`Invalid WET PAINT ${what}`); };

/* ================================ LEVEL ==================================== */
export type Level = { checkpoints: number; tolerance: number; speed: number; lead: number; grace: number; gap: number; wave: number; freq: number };
/** The difficulty of a stroke that appears `elapsed` ticks after the first brush (0…playTicks, clamped). */
export function levelAt(elapsed: number): Level {
  const e = Math.max(0, Math.min(RULES.playTicks, Math.floor(elapsed)));
  const r = RULES.ramp;
  const lerp = (pair: readonly number[]): number => (pair[0] as number) + Math.floor(((pair[1] as number) - (pair[0] as number)) * e / RULES.playTicks);
  return {
    checkpoints: lerp(r.checkpoints), tolerance: lerp(r.tolerance), speed: lerp(r.speed), lead: lerp(r.lead),
    grace: lerp(r.grace), gap: lerp(r.gap), wave: lerp(r.wave), freq: lerp(r.freq),
  };
}
const openOf = (startTick: number | null): number => (startTick ?? 0) + RULES.countdownTicks;
/** Ticks from the stroke's appearance to the brush reaching the last checkpoint. */
export const runTicks = (lv: Level): number => lv.lead + Math.floor(((lv.checkpoints - 1) * 100 + lv.speed - 1) / lv.speed);
/** The tick the stroke dries (it fails if not finished before). */
export const dryTickOf = (b: number, lv: Level): number => b + runTicks(lv) + lv.grace;
/** The furthest checkpoint the brush has reached at `tick` (0 while the drop waits). */
export function headAt(b: number, lv: Level, tick: number): number {
  const t = tick - b - lv.lead;
  return t <= 0 ? 0 : Math.min(lv.checkpoints - 1, Math.floor(t * lv.speed / 100));
}

/* ============================ STATE VALIDATION ============================== */
export function parseSeed(seed: unknown): number { return isInt(seed, 0, 0xffffffff) ? seed : fail('seed'); }
/** The scoring config (extra keys are dropped, like a non-strict object schema). */
export function parseConfig(value: unknown): WpConfig {
  if (!isObject(value) || value.game !== 'wet-paint' || !isInt(value.maxTicks, 1, 100_000) || !isInt(value.roundTicks, RULES.countdownTicks + 1, 100_000)
    || value.maxTicks < value.roundTicks) return fail('config');
  return { game: 'wet-paint', maxTicks: value.maxTicks, roundTicks: value.roundTicks };
}
/** An input, or null when it is not one (unknown action, extra field, a point off the field, too many points). */
export function parseInput(value: unknown): WpInput | null {
  if (!isObject(value)) return null;
  if (value.action === 'start') return exactKeys(value, ['action']) ? { action: 'start' } : null;
  if (value.action === 'lift') return exactKeys(value, ['action']) ? { action: 'lift' } : null;
  if (value.action === 'trace' && exactKeys(value, ['action', 'pts'])) {
    const pts = value.pts;
    if (!Array.isArray(pts) || pts.length < 2 || pts.length > 2 * RULES.maxPoints || pts.length % 2 !== 0) return null;
    for (let i = 0; i < pts.length; i += 2) if (!isInt(pts[i], 0, FIELD_W) || !isInt(pts[i + 1], 0, FIELD_H)) return null;
    return { action: 'trace', pts: pts.slice() as number[] };
  }
  return null;
}
const STROKE_KEYS = ['n', 'b', 'k', 'acc', 'slips'] as const;
const FIXED_KEYS = ['n', 'b', 'q'] as const;
const EVENT_KEYS = ['seq', 'tick', 'n', 'b', 'what', 'q', 'gain'] as const;
const PLAY_KEYS = ['score', 'combo', 'bestCombo', 'drops', 'fixed', 'master', 'dried', 'smudged', 'qSum', 'bonus', 'end',
  'stroke', 'pen', 'canvas', 'events', 'eventSeq'] as const;
const STATE_KEYS = ['tick', 'gameOver', 'started', 'startTick', 'seed', 'rules', 'play'] as const;
function checkStroke(s: unknown, maxTicks: number): Stroke {
  if (!isObject(s) || !exactKeys(s, STROKE_KEYS)) return fail('stroke');
  if (!isInt(s.n, 0, MAX_N) || !isInt(s.b, 0, maxTicks + 1000) || !isInt(s.slips, 0, RULES.maxSlips)) return fail('stroke');
  if (!isInt(s.k, 0, RULES.ramp.checkpoints[1] as number) || !isInt(s.acc, 0, 1000 * (s.k as number))) return fail('stroke');
  return { n: s.n, b: s.b, k: s.k, acc: s.acc, slips: s.slips };
}
function checkFixed(f: unknown, maxTicks: number): Fixed {
  if (!isObject(f) || !exactKeys(f, FIXED_KEYS) || !isInt(f.n, 0, MAX_N) || !isInt(f.b, 0, maxTicks + 1000) || !isInt(f.q, 0, 1000)) return fail('artwork');
  return { n: f.n, b: f.b, q: f.q };
}
function checkEvent(e: unknown, maxTicks: number): WpEvent {
  if (!isObject(e) || !exactKeys(e, EVENT_KEYS)) return fail('event');
  if (!isInt(e.seq, 1, MAX_INT) || !isInt(e.tick, 0, MAX_INT) || !isInt(e.n, 0, MAX_N) || !isInt(e.b, 0, maxTicks + 1000) || !oneOf(e.what, WHATS)
    || !isInt(e.q, 0, 1000) || !isInt(e.gain, 0, 1_000_000)) return fail('event');
  return { seq: e.seq, tick: e.tick, n: e.n, b: e.b, what: e.what, q: e.q, gain: e.gain };
}
/** A run state as the coordinator hands it back: strict shape, bounded numbers, a coherent timeline. Throws otherwise. */
export function checkState(value: unknown): WpState {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return fail('state');
  const p = value.play;
  if (!isObject(p) || !exactKeys(p, PLAY_KEYS)) return fail('state');
  for (const k of ['score', 'combo', 'bestCombo', 'fixed', 'master', 'dried', 'smudged', 'qSum', 'bonus', 'eventSeq'] as const) {
    if (!isInt(p[k], 0, MAX_INT)) return fail('state');
  }
  if (!isInt(p.drops, 0, RULES.drops) || !oneOf(p.end, ['none', 'time', 'ruined', 'horizon'] as const)) return fail('state');
  const { tick, gameOver, started, startTick, seed } = value;
  if (!isInt(tick, 0, MAX_INT) || typeof gameOver !== 'boolean' || typeof started !== 'boolean'
    || (startTick !== null && !isInt(startTick, 0, MAX_INT)) || !isInt(seed, 0, 0xffffffff)) return fail('state');
  const rules = parseConfig(value.rules);
  const { pen, canvas, events } = p;
  if (!Array.isArray(pen) || !(pen.length === 0 || (pen.length === 2 && isInt(pen[0], 0, FIELD_W) && isInt(pen[1], 0, FIELD_H)))) return fail('state');
  if (!Array.isArray(canvas) || canvas.length > RULES.canvasMax) return fail('state');
  if (!Array.isArray(events) || events.length > RULES.eventsMax) return fail('state');
  const stroke = p.stroke === null ? null : checkStroke(p.stroke, rules.maxTicks);
  const art = canvas.map((f) => checkFixed(f, rules.maxTicks)), log = events.map((e) => checkEvent(e, rules.maxTicks));
  if (stroke) {
    const lv = levelAt(stroke.b - openOf(startTick));
    if (stroke.k >= lv.checkpoints || gameOver) return fail('timeline');
  }
  if (started !== (startTick !== null) || (startTick !== null && startTick > tick) || tick > rules.maxTicks
    || (p.end !== 'none') !== gameOver || (p.drops === 0 && !gameOver) || (p.combo as number) > (p.bestCombo as number)
    || (!started && (stroke !== null || art.length > 0)) || (p.master as number) > (p.fixed as number) || (p.qSum as number) > 1000 * (p.fixed as number)
    || art.length > (p.fixed as number) || log.some((e) => e.seq > (p.eventSeq as number))) return fail('timeline');
  return {
    tick, gameOver, started, startTick, seed, rules,
    play: {
      score: p.score as number, combo: p.combo as number, bestCombo: p.bestCombo as number, drops: p.drops,
      fixed: p.fixed as number, master: p.master as number, dried: p.dried as number, smudged: p.smudged as number, qSum: p.qSum as number,
      bonus: p.bonus as number, end: p.end, stroke, pen: pen.slice() as number[], canvas: art, events: log, eventSeq: p.eventSeq as number,
    },
  };
}

/* ================================ GEOMETRY ================================== */
export type Geometry = { level: Level; pts: number[] };
/**
 * The path of stroke n of a run, appearing `elapsed` ticks after the first brush: `checkpoints` points, `step` apart,
 * inside BOX, as a flat integer array [x0, y0, x1, y1, …]. A wave of turning (and a slow curl) makes it flow; the first
 * attempts that fit in the box are kept, the last one bounces off the edges.
 */
export function geometryOf(seed: number, n: number, elapsed: number): Geometry {
  const level = levelAt(elapsed);
  const M = level.checkpoints, L = RULES.step;
  let pts: number[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const rnd = mulberry32(fnv1a(`stroke:${seed}:${n}:${attempt}`));
    let x = BOX.x0 + 300 + Math.floor(rnd() * (BOX.x1 - BOX.x0 - 600));
    let y = BOX.y0 + 300 + Math.floor(rnd() * (BOX.y1 - BOX.y0 - 600));
    let heading = Math.floor(rnd() * 36000);
    const curl = Math.floor(rnd() * 601) - 300;
    const phase = Math.floor(rnd() * 36000);
    const amp = Math.floor(level.wave * (6 + Math.floor(rnd() * 5)) / 10);
    const last = attempt === 7;
    let inside = true;
    pts = [Math.round(x), Math.round(y)];
    for (let i = 1; i < M; i++) {
      const [s] = sinCos100((phase + level.freq * i) % 36000);
      heading = (((heading + curl + Math.round(amp * s)) % 36000) + 36000) % 36000;
      let [sy, cx] = sinCos100(heading);
      let nx = x + L * cx, ny = y + L * sy;
      if (nx < BOX.x0 || nx > BOX.x1 || ny < BOX.y0 || ny > BOX.y1) {
        inside = false;
        if (!last) break;
        // the last attempt bounces off the edge it would cross
        if (nx < BOX.x0 || nx > BOX.x1) heading = ((18000 - heading) % 36000 + 36000) % 36000;
        if (ny < BOX.y0 || ny > BOX.y1) heading = (36000 - heading) % 36000;
        [sy, cx] = sinCos100(heading);
        nx = Math.max(BOX.x0, Math.min(BOX.x1, x + L * cx)); ny = Math.max(BOX.y0, Math.min(BOX.y1, y + L * sy));
      }
      x = nx; y = ny;
      pts.push(Math.round(x), Math.round(y));
    }
    if (inside && pts.length === 2 * M) break;
  }
  return { level, pts };
}

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}
/** Distance from a point to the part of a path from checkpoint `from` to its end. */
export function distToPath(px: number, py: number, pts: readonly number[], from: number): number {
  const M = pts.length / 2;
  let best = Infinity;
  if (from >= M - 1) {
    const i = 2 * (M - 1);
    return distToSegment(px, py, pts[i] as number, pts[i + 1] as number, pts[i] as number, pts[i + 1] as number);
  }
  for (let i = Math.max(0, from); i < M - 1; i++) {
    const d = distToSegment(px, py, pts[2 * i] as number, pts[2 * i + 1] as number, pts[2 * i + 2] as number, pts[2 * i + 3] as number);
    if (d < best) best = d;
  }
  return best;
}
/**
 * How far from checkpoint k the trace segment (ax, ay)→(qx, qy) passes it, or -1 if the trace has not reached it yet.
 * "Reached": the segment ends at or beyond the checkpoint along the path's direction there. The offset is measured where
 * the segment crosses the path's normal at the checkpoint (or, for a segment entirely beyond it, at its closest point),
 * so a trace that runs along the path scores by its sideways error only, however densely the pointer was sampled.
 */
export function passOffset(cp: readonly number[], k: number, ax: number, ay: number, qx: number, qy: number): number {
  const M = cp.length / 2;
  const cx = cp[2 * k] as number, cy = cp[2 * k + 1] as number;
  const i0 = Math.max(0, k - 1), i1 = Math.min(M - 1, k + 1);
  const tx = (cp[2 * i1] as number) - (cp[2 * i0] as number), ty = (cp[2 * i1 + 1] as number) - (cp[2 * i0 + 1] as number);
  const dq = (qx - cx) * tx + (qy - cy) * ty;
  if (dq < 0) return -1;
  const da = (ax - cx) * tx + (ay - cy) * ty;
  if (da > 0) return distToSegment(cx, cy, ax, ay, qx, qy);
  const u = da === dq ? 0 : da / (da - dq);
  const ex = ax + u * (qx - ax) - cx, ey = ay + u * (qy - ay) - cy;
  return Math.sqrt(ex * ex + ey * ey);
}
/** A stroke's final quality (0…1000): the mean precision of its checkpoints, less the slips. */
export const qualityOf = (stroke: Stroke, checkpoints: number): number =>
  Math.max(0, Math.floor(stroke.acc / checkpoints) - RULES.slipPenalty * stroke.slips);
export const gradeOf = (q: number): 'MASTERSTROKE' | 'CLEAN' | 'ROUGH' | 'SKETCHY' =>
  q >= RULES.masterQuality ? 'MASTERSTROKE' : q >= RULES.cleanQuality ? 'CLEAN' : q >= 450 ? 'ROUGH' : 'SKETCHY';

/* ================================ ENGINE ==================================== */
export const display = (name: string): string => name.trim().toUpperCase();
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function createEngine(panels: readonly NamedPanel[]) {
  const pool = panels.filter((panel) => /^[\x20-\x7E]{1,32}$/.test(display(panel.n))).map((panel) => ({ p: panel.p, n: display(panel.n) }));
  if (pool.length < 8) throw new Error('WET PAINT needs at least 8 named panels');
  /** Stroke n's name: a seeded walk through the pool that repeats nobody before everybody has been painted. */
  let stride = 7 + Math.floor(pool.length / 3);
  while (gcd(stride, pool.length) !== 1) stride++;
  const panelOf = (seed: number, n: number): number => (pool[(fnv1a(`names:${seed}`) % pool.length + n * stride) % pool.length] as NamedPanel).p;
  const nameOf = (seed: number, n: number): string => (pool[(fnv1a(`names:${seed}`) % pool.length + n * stride) % pool.length] as NamedPanel).n;

  const openTickOf = (state: WpState): number => openOf(state.startTick);
  function endTickOf(state: WpState): number {
    return state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  }
  const elapsedOf = (state: WpState, tick: number): number => tick - openTickOf(state);
  const levelOf = (state: WpState, stroke: { b: number }): Level => levelAt(stroke.b - openTickOf(state));
  const geometry = (state: WpState, stroke: { n: number; b: number }): Geometry => geometryOf(state.seed, stroke.n, stroke.b - openTickOf(state));
  const multOf = (combo: number): number => 1 + Math.min(RULES.multCap - 1, Math.floor(combo / RULES.comboEvery));

  function event(state: WpState, stroke: Stroke, what: What, q: number, gain: number): void {
    const play = state.play;
    play.eventSeq++;
    play.events.push({ seq: play.eventSeq, tick: state.tick, n: stroke.n, b: stroke.b, what, q, gain });
    if (play.events.length > RULES.eventsMax) play.events.shift();
  }
  /** The stroke after this one, `gap` ticks from now, unless the round is about to end. */
  function next(state: WpState, after: Stroke | null): void {
    const play = state.play;
    const n = after ? after.n + 1 : 0;
    const b = after ? state.tick + levelOf(state, after).gap : openTickOf(state);
    play.stroke = b < endTickOf(state) - RULES.lastStrokeBeforeEnd ? { n, b, k: 0, acc: 0, slips: 0 } : null;
  }
  function fixStroke(state: WpState, stroke: Stroke, lv: Level): void {
    const play = state.play;
    const q = qualityOf(stroke, lv.checkpoints);
    const gain = Math.floor((60 + 10 * lv.checkpoints) * q / 1000) * multOf(play.combo);
    play.score += gain; play.fixed++; play.qSum += q;
    if (q >= RULES.masterQuality) play.master++;
    if (q >= RULES.cleanQuality) { play.combo++; if (play.combo > play.bestCombo) play.bestCombo = play.combo; } else play.combo = 0;
    play.canvas.push({ n: stroke.n, b: stroke.b, q });
    if (play.canvas.length > RULES.canvasMax) play.canvas.shift();
    event(state, stroke, 'fixed', q, gain);
    next(state, stroke);
  }
  function failStroke(state: WpState, stroke: Stroke, what: 'dried' | 'smudged'): void {
    const play = state.play;
    play.score = Math.max(0, play.score - RULES.failPenalty);
    play.combo = 0; play.drops--;
    if (what === 'dried') play.dried++; else play.smudged++;
    event(state, stroke, what, 0, 0);
    next(state, stroke);
  }

  function finish(state: WpState, end: End): void {
    const play = state.play;
    state.gameOver = true; play.end = end; play.stroke = null; play.pen = [];
    if (end === 'time') { play.bonus = RULES.survival + RULES.perDrop * play.drops; play.score += play.bonus; }
  }
  /** Mutating advance: a stroke dries on its own tick, even when no input arrives. */
  function advanceInPlace(state: WpState, serverTick: number): WpState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver) return state;
    const end = endTickOf(state);
    const target = Math.min(serverTick, end);
    if (state.started) {
      // jump from one drying to the next: nothing else happens without an input
      for (;;) {
        const stroke = state.play.stroke;
        if (!stroke) break;
        const dry = dryTickOf(stroke.b, levelOf(state, stroke));
        if (dry > target) break;
        state.tick = Math.max(state.tick, dry);
        failStroke(state, stroke, 'dried');
        if (state.play.drops <= 0) { finish(state, 'ruined'); return state; }
      }
    }
    state.tick = Math.max(state.tick, target);
    if (state.tick >= end) finish(state, state.started ? 'time' : 'horizon');
    return state;
  }
  const clone = (state: WpState): WpState => structuredClone(state);

  /** A trace: each point, joined to the one before, captures the next checkpoints it passes close to. */
  function trace(state: WpState, pts: readonly number[]): void {
    const play = state.play;
    const stroke = play.stroke;
    let pen = play.pen.length === 2 ? play.pen : null;
    if (!stroke || state.tick < stroke.b) { play.pen = [pts[pts.length - 2] as number, pts[pts.length - 1] as number]; return; }
    const geo = geometry(state, stroke), lv = geo.level, cp = geo.pts;
    const head = headAt(stroke.b, lv, state.tick), R = lv.tolerance, slipR = R * 5 / 2;
    let off = false;
    for (let i = 0; i < pts.length; i += 2) {
      const qx = pts[i] as number, qy = pts[i + 1] as number;
      const linked = pen !== null && Math.abs(qx - (pen[0] as number)) + Math.abs(qy - (pen[1] as number)) <= RULES.jump;
      const ax = linked ? pen![0] as number : qx, ay = linked ? pen![1] as number : qy;
      if (stroke.k > 0 && distToPath(qx, qy, cp, stroke.k - 1) > slipR) off = true;
      while (stroke.k < lv.checkpoints && stroke.k <= head) {
        const d = passOffset(cp, stroke.k, ax, ay, qx, qy);
        if (d < 0 || d > R) break;
        stroke.acc += 1000 - Math.min(1000, Math.floor(1000 * d / R));
        stroke.k++;
      }
      pen = [qx, qy];
      if (stroke.k >= lv.checkpoints) break;
    }
    play.pen = pen ? [pen[0] as number, pen[1] as number] : [];
    if (stroke.k >= lv.checkpoints) { fixStroke(state, stroke, lv); return; }
    if (off) {
      stroke.slips++;
      if (stroke.slips >= RULES.maxSlips) { failStroke(state, stroke, 'smudged'); if (play.drops <= 0) finish(state, 'ruined'); }
    }
  }

  function createRun(seed: unknown, config: unknown): WpState {
    const validSeed = parseSeed(seed);
    const rules = parseConfig(config);
    return {
      tick: 0, gameOver: false, started: false, startTick: null, seed: validSeed, rules,
      play: {
        score: 0, combo: 0, bestCombo: 0, drops: RULES.drops, fixed: 0, master: 0, dried: 0, smudged: 0, qSum: 0, bonus: 0, end: 'none',
        stroke: null, pen: [], canvas: [], events: [], eventSeq: 0,
      },
    };
  }
  function advance(state: WpState, serverTick: number): WpState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    return advanceInPlace(clone(state), serverTick);
  }
  function applyInputInPlace(state: WpState, input: unknown, serverTick: number): WpState {
    advanceInPlace(state, serverTick);
    if (state.gameOver) return state;
    const action = parseInput(input);
    if (!action) return state;
    if (action.action === 'start') {
      if (!state.started) { state.started = true; state.startTick = state.tick; next(state, null); }
      return state;
    }
    if (!state.started || state.tick < openTickOf(state)) return state;
    if (action.action === 'lift') { state.play.pen = []; return state; }
    trace(state, action.pts);
    return state;
  }
  function applyInput(state: WpState, input: unknown, serverTick: number): WpState {
    return applyInputInPlace(clone(state), input, serverTick);
  }
  const view = (state: WpState): WpState => state;
  const isFinished = (state: WpState): boolean => state.gameOver;
  const score = (state: WpState): number => state.play.score;

  return {
    createRun, advance, applyInput, view, isFinished, score,
    advanceInPlace, applyInputInPlace, clone, endTickOf, openTickOf, elapsedOf, levelOf, geometry, multOf, panelOf, nameOf, pool,
  };
}
export type WetPaintEngine = ReturnType<typeof createEngine>;

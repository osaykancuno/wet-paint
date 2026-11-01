// WET PAINT: the browser side. The page paints the board with the platform's authoritative state (the player's own
// queued traces applied by the very module the verifier runs, then brought to "now" by that same module) and turns the
// finger or the mouse into ordered inputs: { action: 'trace', pts } with up to 16 points of the pointer, and
// { action: 'lift' } when it leaves the screen. It never sends a score, a time, a precision or a state: which
// checkpoints a trace captured, how well, and what a stroke is worth are decided by the rules on SuperRare's server.
//
// Everything drawn here is display only: the brush, the wet paint, the ribbons and their lettering, the trail of the
// finger, the people of the wall (their walking sprite from people.json, or a pixel stand-in), the sounds, the artwork
// and the end card.
import type { EndStats, GameAdapter, Stage, StageIO } from '../../shell/adapter.js';
import { createSavedRoundParser } from '../../shell/saved-round.js';
import { scoringConfiguration } from '../../shell/config.js';
import { HitFeed } from '../../shell/hits.js';
import { infoOf } from '../../shell/wall-data.js';
import { loadPeople, onPeople, sheetOfName } from '../../shell/people.js';
import { DIR, drawSprite, stepAt, type SpriteSheet } from '../../share/sprite.js';
import { fitTweet, intentHref, tag } from '../../share/post.js';
import { WALL_PANELS } from '../../generated/wall.js';
import { fnv1a, mulberry32 } from '../../common/det.js';
import {
  BOX, FIELD_H, FIELD_W, RULES, dryTickOf, engine, gradeOf, inputSchema, runTicks, snapshotSchema, stateSchema,
  type Fixed, type Level, type WpEvent, type WpState, type What,
} from './engine.js';

/* ================================ LOOK ==================================== */
const W = 600, H = 800, TICK_MS = 50, UNIT = FIELD_W / W;     // 10 field units per board pixel
const INK = '#0B0B0B', CHALK = '#F2F0EB', CONCRETE = '#DEDBD3', BLUE = '#2E7FD6', LABEL = '#6B685F', FAINT = '#D6D2C8';
const PAPER = '#F4F1EA', DRY = '#B9B4A8', RED = '#D64532';
const F_ANTON = 'Anton, Impact, "Arial Narrow", sans-serif', F_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const HUD_H = 84;
/** The palette of the wall's paint: one blue, inks and a few bright pigments. [colour, lettering on it] */
const PALETTE: readonly (readonly [string, string])[] = [
  [BLUE, CHALK], ['#E4572E', CHALK], ['#F2B134', INK], [INK, CHALK], ['#1B998B', CHALK], ['#C04ABC', CHALK],
  ['#6C63FF', CHALK], ['#FF8FAB', INK], ['#3D5A80', CHALK], ['#9BC53D', INK],
];
const SNAPSHOT = new Map(WALL_PANELS.map((p) => [p.p, p]));
const nameOfPanel = (panel: number): string => SNAPSHOT.get(panel)?.n.toUpperCase() ?? '';
const handleOf = (panel: number): string => infoOf(panel).handle || SNAPSHOT.get(panel)?.h || '';
/** "#3" -> 3; "—" or "Not top 10" -> undefined. */
const rankOf = (rank: string | undefined): number | undefined => { const m = rank ? /^#(\d+)$/.exec(rank) : null; return m ? Number(m[1]) : undefined; };
const fmtScore = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const colourOf = (seed: number, n: number): readonly [string, string] => PALETTE[fnv1a(`colour:${seed}:${n}`) % PALETTE.length] as readonly [string, string];
const GRADE_COLOUR: Record<string, string> = { MASTERSTROKE: BLUE, CLEAN: INK, ROUGH: LABEL, SKETCHY: LABEL };
const COMBO_BANNERS = ['', '×2 IN THE FLOW', '×3 STEADY HAND', '×4 VIRTUOSO', '×5 MASTERPIECE'];
const RAMP_BANNERS: readonly [number, string][] = [[0, 'FOLLOW THE BRUSH'], [600, 'THE BRUSH SPEEDS UP'], [1200, 'LAST 30 SECONDS'], [1600, 'FINAL STROKES']];
const LOCAL_BEST = { paid: 'wet-paint:best', practice: 'wet-paint:best-practice' } as const;

type Mode = 'idle' | 'play' | 'end';
type Pt = { x: number; y: number };
type Pop = { seq: number; what: What; text: string; sub: string; colour: string; x: number; y: number; t0: number };
type Bit = { x: number; y: number; vx: number; vy: number; life: number; c: string; s: number };
type Cameo = { panel: number; x: number; y: number; t0: number };

/** The artist's title of a run (display only). */
export function artistTitle(play: WpState['play']): { title: string; line: string; good: boolean } {
  const avg = play.fixed ? Math.round(play.qSum / play.fixed / 10) : 0;
  if (play.end === 'ruined') return { title: 'OUT OF PAINT', line: `${play.fixed} names on the wall before the paint ran out.`, good: false };
  if (play.fixed === 0) return { title: 'BLANK CANVAS', line: 'Not a single stroke this time.', good: false };
  if (avg >= 90 && play.dried + play.smudged === 0) return { title: 'MASTER OF THE WALL', line: `${play.fixed} names, ${avg}% precision, not a drop wasted.`, good: true };
  if (play.master >= 10) return { title: 'VIRTUOSO', line: `${play.master} masterstrokes on one canvas.`, good: true };
  if (play.bestCombo >= 12) return { title: 'IN THE FLOW', line: `${play.bestCombo} clean strokes in a row.`, good: true };
  if (avg >= 70) return { title: 'STEADY HAND', line: `${play.fixed} names painted at ${avg}% precision.`, good: true };
  return { title: 'ABSTRACT EXPRESSIONIST', line: `${play.fixed} names, painted with feeling (${avg}% precision).`, good: true };
}

/* ------------------------------ brush geometry ------------------------------ */
/** A smooth curve through the checkpoints (Catmull-Rom, a few samples per segment), in board pixels. */
function smooth(pts: readonly number[], scale = 1 / UNIT, dx = 0, dy = 0, per = 5): Pt[] {
  const n = pts.length / 2, out: Pt[] = [];
  const P = (i: number): Pt => { const j = Math.max(0, Math.min(n - 1, i)); return { x: (pts[2 * j] as number) * scale + dx, y: (pts[2 * j + 1] as number) * scale + dy }; };
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(P(n - 1));
  return out;
}
/** The first `fraction` (0…1) of a curve. */
function part(curve: Pt[], fraction: number): Pt[] {
  const f = Math.max(0, Math.min(1, fraction)) * (curve.length - 1), i = Math.floor(f);
  const out = curve.slice(0, i + 1);
  const a = curve[i], b = curve[i + 1];
  if (a && b && f > i) out.push({ x: a.x + (b.x - a.x) * (f - i), y: a.y + (b.y - a.y) * (f - i) });
  return out;
}
const lengthOf = (c: Pt[]): number => { let L = 0; for (let i = 1; i < c.length; i++) L += Math.hypot((c[i] as Pt).x - (c[i - 1] as Pt).x, (c[i] as Pt).y - (c[i - 1] as Pt).y); return L; };

/**
 * A brush stroke: a tapered ribbon with bristle streaks. Quality (0…1000) makes it crisp and saturated; a poor one is
 * wobbly, frayed and splattered. `seedKey` keeps the same stroke looking the same every time it is drawn.
 */
function ribbon(g: CanvasRenderingContext2D, curve: Pt[], colour: string, width: number, q: number, seedKey: string, alpha = 1, taperEnd = true): void {
  if (curve.length < 2) return;
  const rnd = mulberry32(fnv1a(seedKey));
  const rough = (1000 - q) / 1000;
  const jitter = rough * width * 0.45;
  const left: Pt[] = [], right: Pt[] = [];
  const n = curve.length;
  let wob = 0;
  for (let i = 0; i < n; i++) {
    const a = curve[Math.max(0, i - 1)] as Pt, b = curve[Math.min(n - 1, i + 1)] as Pt, p = curve[i] as Pt;
    let tx = b.x - a.x, ty = b.y - a.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const t = i / (n - 1);
    const taper = Math.pow(Math.sin(Math.PI * Math.min(1, taperEnd ? t : t * 0.5 + 0.5 * Math.min(1, t * 4))) , 0.45);
    wob = wob * 0.8 + (rnd() - 0.5) * jitter;
    const w = width * (0.28 + 0.72 * taper) * (1 + (rnd() - 0.5) * rough * 0.5) / 2;
    left.push({ x: p.x - ty * (w + wob), y: p.y + tx * (w + wob) });
    right.push({ x: p.x + ty * (w - wob), y: p.y - tx * (w - wob) });
  }
  g.save();
  g.globalAlpha = alpha * (0.78 + 0.22 * (1 - rough));
  g.fillStyle = colour;
  g.beginPath();
  g.moveTo((left[0] as Pt).x, (left[0] as Pt).y);
  for (const p of left) g.lineTo(p.x, p.y);
  for (let i = right.length - 1; i >= 0; i--) g.lineTo((right[i] as Pt).x, (right[i] as Pt).y);
  g.closePath(); g.fill();
  // bristles: thin lighter and darker streaks along the ribbon
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (let s = 0; s < 6; s++) {
    const off = (s / 5 - 0.5) * 0.8;
    g.globalAlpha = alpha * (0.10 + rnd() * 0.12);
    g.strokeStyle = s % 2 ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.6)';
    g.lineWidth = 0.6 + rnd() * 1.1;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const l = left[i] as Pt, r = right[i] as Pt;
      const k = 0.5 + off, x = l.x + (r.x - l.x) * k, y = l.y + (r.y - l.y) * k;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  // a rough stroke splatters
  const drops = Math.floor(rough * 9);
  g.fillStyle = colour;
  for (let d = 0; d < drops; d++) {
    const p = curve[Math.floor(rnd() * n)] as Pt, a = rnd() * Math.PI * 2, r = width * (0.7 + rnd() * 1.4);
    g.globalAlpha = alpha * (0.35 + rnd() * 0.4);
    g.beginPath(); g.arc(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 0.8 + rnd() * width * 0.16, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
/** The name, letter by letter along the ribbon (reading left to right whichever way the stroke ran). */
function lettering(g: CanvasRenderingContext2D, curve: Pt[], name: string, colour: string, size: number, alpha = 1, upTo = 1): void {
  if (curve.length < 2 || !name) return;
  const first = curve[0] as Pt, last = curve[curve.length - 1] as Pt;
  const path = last.x < first.x ? [...curve].reverse() : curve;
  const reversed = path !== curve;
  const total = lengthOf(path);
  let font = size;
  g.font = `${font}px ${F_ANTON}`;
  const spacing = (): number => g.measureText(name).width + (name.length - 1) * font * 0.12;
  while (font > 7 && spacing() > total * 0.86) { font -= 1; g.font = `${font}px ${F_ANTON}`; }
  const textW = spacing();
  let at = (total - textW) / 2;
  g.save();
  g.fillStyle = colour; g.textAlign = 'left'; g.textBaseline = 'middle';
  // walk the path to place each letter on its tangent
  let seg = 0, segStart = 0;
  const pointAt = (dist: number): { p: Pt; a: number } => {
    while (seg < path.length - 2) {
      const len = Math.hypot((path[seg + 1] as Pt).x - (path[seg] as Pt).x, (path[seg + 1] as Pt).y - (path[seg] as Pt).y);
      if (segStart + len >= dist) break;
      segStart += len; seg++;
    }
    const a = path[seg] as Pt, b = path[seg + 1] as Pt;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, t = Math.max(0, Math.min(1, (dist - segStart) / len));
    return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, a: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  for (const ch of name) {
    const cw = g.measureText(ch).width;
    const mid = at + cw / 2;
    const shownFrac = reversed ? 1 - mid / total : mid / total;
    if (shownFrac <= upTo) {
      const { p, a } = pointAt(mid);
      g.globalAlpha = alpha;
      g.save(); g.translate(p.x, p.y); g.rotate(a); g.fillText(ch, -cw / 2, 1); g.restore();
    }
    at += cw + font * 0.12;
  }
  g.restore();
}

/* ------------------------------ a pixel stand-in ------------------------------ */
// A person of the wall without a character yet: a 16 × 16 pixel figure, colours from their name, four walking steps.
const SKIN = ['#F1C9A5', '#D9A47E', '#A8714F', '#6B4430', '#E8B98F'];
const TOP = ['#2E7FD6', '#3E7D4F', '#7A4FA3', '#D9A62E', '#5C6B78', '#B5462F', '#C7B9A6'];
const HAIR = ['#0B0B0B', '#5A3A22', '#C9A16B', '#8E2F1E', '#DEDBD3'];
function drawStandIn(g: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, step: number): void {
  const h = fnv1a(name), px = size / 16;
  const skin = SKIN[h % SKIN.length] as string, top = TOP[(h >>> 3) % TOP.length] as string, hair = HAIR[(h >>> 6) % HAIR.length] as string;
  const r = (cx: number, cy: number, w: number, hh: number, c: string): void => { g.fillStyle = c; g.fillRect(Math.round(x + cx * px), Math.round(y + cy * px), Math.ceil(w * px), Math.ceil(hh * px)); };
  const bob = step % 2 ? 0.5 : 0;
  r(5, 1 + bob, 6, 2, hair); r(5, 3 + bob, 6, 4, skin); r(6, 4 + bob, 1, 1, INK); r(9, 4 + bob, 1, 1, INK);
  r(4, 7 + bob, 8, 5, top); r(3, 8 + bob, 1, 3, skin); r(12, 8 + bob, 1, 3, skin);
  const a = step % 4 === 1 ? 1 : step % 4 === 3 ? -1 : 0;
  r(5, 12, 2, 3 + (a > 0 ? 0 : 1), INK); r(9, 12, 2, 3 + (a < 0 ? 0 : 1), INK);
}
function drawPerson(g: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, step: number): void {
  const sheet: SpriteSheet | null = sheetOfName(name);
  if (sheet) drawSprite(g, sheet, x, y, size, step, DIR.DOWN);
  else drawStandIn(g, name, x, y, size, step);
}

/* --------------------------------- sound --------------------------------- */
const SOUND_KEY = 'wet-paint:sound';
let audio: AudioContext | null = null;
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } })();
const PENTA = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98];
function tone(freqs: number[], len = 0.18, type: OscillatorType = 'sine', gain = 0.05): void {
  if (!soundOn) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    let t = audio.currentTime;
    for (const f of freqs) {
      const o = audio.createOscillator(), v = audio.createGain();
      o.type = type; o.frequency.value = f;
      v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(gain, t + 0.015); v.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(v).connect(audio.destination); o.start(t); o.stop(t + len + 0.02); t += len * 0.55;
    }
  } catch { /* no sound on this device */ }
}

function readBest(practice: boolean): number { try { return Number(localStorage.getItem(practice ? LOCAL_BEST.practice : LOCAL_BEST.paid)) || 0; } catch { return 0; } }
function writeBest(practice: boolean, score: number): void { try { localStorage.setItem(practice ? LOCAL_BEST.practice : LOCAL_BEST.paid, String(score)); } catch { /* storage unavailable */ } }

/* ================================ STAGE =================================== */
declare const __DEV_ANY_ORIGIN__: boolean | undefined;
function createStage(host: HTMLElement, io: StageIO): Stage {
  host.classList.add('wp-arena', 'own-end');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'ub-canvas wp-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'WET PAINT. A name of the wall appears as a drop of wet paint, then a brush paints it along a flowing path. Follow the brush with your finger or the mouse, from the drop to the end, before the paint dries: the closer you stay, the better the stroke and the more points. Finished strokes stay on the wall and make the artwork.');
  const soundButton = document.createElement('button');
  soundButton.type = 'button'; soundButton.className = 'ub-sound secondary';
  const label = (): void => { soundButton.textContent = soundOn ? 'Sound on' : 'Sound off'; };
  label();
  soundButton.addEventListener('click', () => { soundOn = !soundOn; label(); try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch { /* storage unavailable */ } });
  const endPanel = document.createElement('section');
  endPanel.className = 'end-panel wp-end'; endPanel.hidden = true; endPanel.setAttribute('aria-label', 'Your artwork');
  host.append(canvas, endPanel, soundButton);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  void loadPeople();
  onPeople(() => { dirty = true; });

  /* ------------------------------ stage state ------------------------------ */
  let mode: Mode = 'idle';
  let practice = false;
  let finalScore: number | null = null;
  let view: WpState | null = null;          // the latest authoritative (or predicted) state
  let shown: WpState | null = null;         // that state brought to "now" by the rules: what is drawn
  let nowTick = 0, tickAt = 0;
  let seen = new Set<number>();             // event seqs already played
  let pops: Pop[] = [];
  let bits: Bit[] = [];
  let cameos: Cameo[] = [];
  let banner: { text: string; t0: number; gold: boolean } | null = null;
  let lastRamp = -1, lastDrops = RULES.drops;
  let flash = 0;
  let endStats: EndStats | null = null;
  let dirty = true, DPR = 1;
  let hits = new HitFeed('wet-paint', false);
  // the finger: local trail (display), the points waiting to be sent (field units), the pointer state
  let trail: { x: number; y: number; t: number }[] = [];
  let outbox: number[] = [];
  let down = false, lastSentTick = -99, lastPoint: Pt | null = null, liftPending = false;

  function reset(isPractice: boolean): void {
    view = null; shown = null; nowTick = 0; seen = new Set(); pops = []; bits = []; cameos = []; banner = null;
    lastRamp = -1; lastDrops = RULES.drops; flash = 0; finalScore = null; endStats = null; practice = isPractice;
    trail = []; outbox = []; down = false; lastSentTick = -99; lastPoint = null; liftPending = false;
    artKey = ''; art = null;
    hits = new HitFeed('wet-paint', isPractice ? false : undefined);
  }

  /* ------------------------------ text helpers ----------------------------- */
  function text(s: string, x: number, y: number, font: string, colour: string, align: CanvasTextAlign = 'center', g: CanvasRenderingContext2D = ctx): void {
    g.font = font; g.fillStyle = colour; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y);
  }
  function fitFont(s: string, maxW: number, size: number, family: string, g: CanvasRenderingContext2D = ctx): string {
    let sz = size;
    g.font = `${sz}px ${family}`;
    while (sz > 8 && g.measureText(s).width > maxW) { sz -= 1; g.font = `${sz}px ${family}`; }
    return `${sz}px ${family}`;
  }

  /* -------------------------------- input ----------------------------------- */
  // Pointer positions become field units; points closer than MIN_GAP to the last one are skipped. The batch goes out
  // every second tick at most (the platform takes one input per tick), up to 16 points; a long batch is thinned evenly.
  const MIN_GAP = 35;
  function toField(e: PointerEvent): Pt {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(FIELD_W, Math.round((e.clientX - r.left) * W / r.width * UNIT))),
      y: Math.max(0, Math.min(FIELD_H, Math.round((e.clientY - r.top) * H / r.height * UNIT))),
    };
  }
  const playing = (): boolean => mode === 'play' && !!shown && shown.started && !shown.gameOver && nowTick >= engine.openTickOf(shown);
  function addPoint(p: Pt): void {
    trail.push({ x: p.x / UNIT, y: p.y / UNIT, t: performance.now() });
    if (trail.length > 90) trail.shift();
    if (lastPoint && Math.abs(p.x - lastPoint.x) + Math.abs(p.y - lastPoint.y) < MIN_GAP) return;
    lastPoint = p;
    outbox.push(p.x, p.y);
    if (outbox.length > 200) outbox.splice(0, outbox.length - 200);
  }
  function flush(force = false): void {
    if (!playing() || !io.canInput()) { if (!down) { outbox = []; liftPending = false; } return; }
    const tick = io.estimatedTick();
    if (!force && tick - lastSentTick < 2) return;
    if (io.pendingCount() > 20) return;
    if (outbox.length) {
      let pts = outbox; outbox = [];
      const max = 2 * RULES.maxPoints;
      if (pts.length > max) {
        const n = pts.length / 2, keep: number[] = [];
        for (let i = 0; i < RULES.maxPoints; i++) { const j = Math.round(i * (n - 1) / (RULES.maxPoints - 1)); keep.push(pts[2 * j] as number, pts[2 * j + 1] as number); }
        pts = keep;
      }
      io.sendInput({ action: 'trace', pts });
      lastSentTick = tick;
      return;
    }
    if (liftPending) { io.sendInput({ action: 'lift' }); liftPending = false; lastSentTick = tick; }
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'play') return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    down = true; liftPending = false; lastPoint = null;
    trail = [];
    addPoint(toField(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!down || mode !== 'play') return;
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const c of events.length ? events : [e]) addPoint(toField(c));
  });
  const up = (e: PointerEvent): void => {
    if (!down) return;
    down = false;
    if (mode === 'play') { addPoint(toField(e)); liftPending = true; }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ------------------------------ state follow ------------------------------ */
  function burst(x: number, y: number, count: number, colour: string): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 220;
      bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0.5 + Math.random() * 0.7, c: i % 4 === 0 ? CHALK : colour, s: 2 + Math.random() * 5 });
    }
  }
  function endOf(s: WpState, e: { n: number; b: number }): Pt {
    const geo = engine.geometry(s, e);
    const M = geo.pts.length / 2;
    return { x: (geo.pts[2 * (M - 1)] as number) / UNIT, y: (geo.pts[2 * (M - 1) + 1] as number) / UNIT };
  }
  function follow(s: WpState): void {
    for (const e of s.play.events) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      onEvent(e, s);
    }
    if (s.play.drops < lastDrops) flash = 1;
    lastDrops = s.play.drops;
    if (s.gameOver) hits.flush();
  }
  function onEvent(e: WpEvent, s: WpState): void {
    const at = endOf(s, e);
    const [colour] = colourOf(s.seed, e.n);
    const panel = engine.panelOf(s.seed, e.n);
    const x = Math.max(70, Math.min(W - 70, at.x)), y = Math.max(HUD_H + 40, Math.min(H - 30, at.y - 26));
    if (e.what === 'fixed') {
      const grade = gradeOf(e.q);
      pops.push({ seq: e.seq, what: e.what, text: grade, sub: `${nameOfPanel(panel)} · ${Math.round(e.q / 10)}% · +${fmtScore(e.gain)}`, colour: GRADE_COLOUR[grade] ?? INK, x, y, t0: performance.now() });
      burst(at.x, at.y, grade === 'MASTERSTROKE' ? 36 : 18, colour);
      cameos.push({ panel, x: at.x, y: at.y, t0: performance.now() });
      if (cameos.length > 3) cameos.shift();
      const step = Math.min(PENTA.length - 3, s.play.combo);
      tone(grade === 'MASTERSTROKE' ? [PENTA[step] as number, PENTA[step + 2] as number] : [PENTA[step] as number], 0.22, 'sine', 0.06);
      if (!practice) hits.add(panel);
      if (s.play.combo > 0 && s.play.combo % RULES.comboEvery === 0) {
        const m = s.play.combo / RULES.comboEvery;
        if (m < COMBO_BANNERS.length) banner = { text: COMBO_BANNERS[m] as string, t0: performance.now(), gold: true };
      }
    } else {
      pops.push({ seq: e.seq, what: e.what, text: e.what === 'dried' ? 'DRIED' : 'SMUDGED', sub: `${nameOfPanel(panel)} · −${RULES.failPenalty}`, colour: RED, x, y, t0: performance.now() });
      tone([196, 147], 0.2, 'triangle', 0.06);
    }
    if (pops.length > 4) pops.shift();
  }
  /** The state shown: the latest one, brought to the estimated server tick by the rules themselves. */
  function catchUp(): void {
    if (!view || mode !== 'play') return;
    const tick = Math.max(view.tick, io.estimatedTick());
    if (shown && tick === nowTick) return;
    if (tick !== nowTick) tickAt = performance.now();
    nowTick = tick;
    shown = tick > view.tick ? engine.advance(view, tick) : view;
    follow(shown);
  }

  /* --------------------------------- drawing -------------------------------- */
  let backdrop: HTMLCanvasElement | null = null;
  /** The wall under the paint: warm paper, a little grain, the names of the wall in faint rows. */
  function paper(): HTMLCanvasElement {
    if (backdrop) return backdrop;
    const c = document.createElement('canvas'); c.width = W * DPR; c.height = H * DPR;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.scale(DPR, DPR);
    g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
    const rnd = mulberry32(7);
    for (let i = 0; i < 1600; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(11,11,11,0.035)' : 'rgba(255,255,255,0.5)'; g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 1.5, 1 + rnd() * 1.5); }
    const names = WALL_PANELS.map((p) => p.n.toUpperCase());
    g.font = `10px ${F_ANTON}`; g.fillStyle = 'rgba(11,11,11,0.06)'; g.textBaseline = 'top';
    let i = 0;
    for (let y = HUD_H + 6; y < H; y += 15) {
      let x = -((y * 7) % 50);
      while (x < W) { const n = names[i++ % names.length] as string; g.fillText(n, x, y); x += g.measureText(n).width + 12; }
    }
    g.strokeStyle = FAINT; g.lineWidth = 1; g.strokeRect(BOX.x0 / UNIT - 24, BOX.y0 / UNIT - 24, (BOX.x1 - BOX.x0) / UNIT + 48, (BOX.y1 - BOX.y0) / UNIT + 48);
    backdrop = c;
    return c;
  }
  /** The artwork so far: every fixed stroke, cached until a new one is fixed. */
  let art: HTMLCanvasElement | null = null, artKey = '';
  function artwork(s: WpState): HTMLCanvasElement {
    const key = `${s.seed}:${s.play.canvas.map((f) => `${f.n}.${f.q}`).join(',')}:${DPR}`;
    if (art && key === artKey) return art;
    const c = art && art.width === W * DPR ? art : document.createElement('canvas');
    c.width = W * DPR; c.height = H * DPR;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    paintArtwork(g, s.seed, s.play.canvas, (f) => engine.geometry(s, f).pts, 1 / UNIT, 0, 0, 1);
    art = c; artKey = key;
    return c;
  }
  function paintArtwork(g: CanvasRenderingContext2D, seed: number, list: readonly Fixed[], pathOf: (f: Fixed) => number[], scale: number, dx: number, dy: number, size: number): void {
    for (const f of list) {
      const [colour, ink] = colourOf(seed, f.n);
      const curve = smooth(pathOf(f), scale, dx, dy);
      const width = (12 + 10 * f.q / 1000) * size;
      ribbon(g, curve, colour, width, f.q, `ribbon:${seed}:${f.n}`);
      lettering(g, curve, nameOfPanel(engine.panelOf(seed, f.n)), ink, width * 0.78, 0.92);
    }
  }

  function drop(x: number, y: number, full: boolean, colour: string): void {
    ctx.save();
    ctx.fillStyle = full ? colour : '#3A3936';
    ctx.beginPath();
    ctx.moveTo(x, y - 11);
    ctx.bezierCurveTo(x + 9, y - 1, x + 8, y + 9, x, y + 9);
    ctx.bezierCurveTo(x - 8, y + 9, x - 9, y - 1, x, y - 11);
    ctx.fill();
    if (full) { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.arc(x - 3, y + 2, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  function hud(s: WpState | null): void {
    ctx.fillStyle = INK; ctx.fillRect(0, 0, W, HUD_H);
    if (!s) { text('WET PAINT', W / 2, HUD_H / 2, `40px ${F_ANTON}`, CHALK); return; }
    const end = engine.endTickOf(s), open = engine.openTickOf(s);
    const secs = Math.ceil(Math.max(0, end - Math.max(nowTick, open)) * TICK_MS / 1000);
    const urgent = nowTick >= open && secs <= 10 && !s.gameOver;
    text(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, W / 2, 30, `34px ${F_ANTON}`, urgent ? '#F2B134' : CHALK);
    // the brush speeds up all along: how much faster than at the first stroke
    const lv = engine.levelOf(s, { b: Math.max(nowTick, open) });
    const flow = lv.speed / (RULES.ramp.speed[0] as number);
    text(`BRUSH ×${flow.toFixed(1)}`, W / 2, 64, `500 11px ${F_MONO}`, flow >= 2 ? '#F2B134' : '#B0ACA2');
    // the top-left corner belongs to the page (← and the PRACTICE tag): the score sits low on the left
    for (let i = 0; i < RULES.drops; i++) drop(W - 26 - i * 24, 30, i < s.play.drops, BLUE);
    text(fmtScore(s.play.score), 16, 64, `30px ${F_ANTON}`, CHALK, 'left');
    const mult = engine.multOf(s.play.combo);
    if (s.play.combo >= 1) text(`${mult > 1 ? `×${mult} · ` : ''}${s.play.combo} CLEAN`, W - 16, 66, `500 11px ${F_MONO}`, mult > 1 ? '#F2B134' : '#B0ACA2', 'right');
    else text(`${s.play.fixed} ON THE WALL`, W - 16, 66, `500 11px ${F_MONO}`, '#B0ACA2', 'right');
  }

  /** The stroke being painted: the drop, the brush running ahead, the wet paint, what the player has fixed so far. */
  function activeStroke(s: WpState, now: number): void {
    const st = s.play.stroke;
    if (!st) return;
    const sub = Math.min(1, (now - tickAt) / TICK_MS);
    const t = nowTick + (s.gameOver ? 0 : sub);
    const geo = engine.geometry(s, st), lv: Level = geo.level, M = lv.checkpoints;
    const [colour] = colourOf(s.seed, st.n);
    const curve = smooth(geo.pts);
    const per = (curve.length - 1) / (M - 1);
    const start = curve[0] as Pt, last = curve[curve.length - 1] as Pt;
    const name = nameOfPanel(engine.panelOf(s.seed, st.n));
    if (t < st.b) {
      // the next drop forms
      const k = Math.max(0, 1 - (st.b - t) / Math.max(1, lv.gap));
      ctx.globalAlpha = 0.25 + 0.5 * k; ctx.fillStyle = colour;
      ctx.beginPath(); ctx.arc(start.x, start.y, 4 + 8 * k, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      return;
    }
    const headF = Math.max(0, Math.min(M - 1, (t - st.b - lv.lead) * lv.speed / 100));
    const dry = dryTickOf(st.b, lv), reached = st.b + runTicks(lv);
    const wetness = t <= reached ? 1 : Math.max(0, (dry - t) / Math.max(1, lv.grace));
    // the path ahead, faint dots
    ctx.save();
    ctx.setLineDash([2, 9]); ctx.lineCap = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = colour; ctx.globalAlpha = 0.28;
    ctx.beginPath(); curve.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    ctx.restore();
    // the wet paint the brush has laid (drying after the brush reached the end)
    const wet = part(curve, headF / (M - 1));
    const wetColour = wetness < 1 ? DRY : colour;
    ribbon(ctx, wet, wetColour, 26, 950, `wet:${s.seed}:${st.n}`, 0.18 + 0.2 * wetness, false);
    lettering(ctx, curve, name, wetColour, 20, 0.35 + 0.35 * wetness, headF / (M - 1));
    // what the player fixed so far
    if (st.k > 0) {
      const mine = part(curve, Math.min(1, (st.k - 1) * per / (curve.length - 1)));
      ribbon(ctx, mine, colour, 18, 1000, `mine:${s.seed}:${st.n}`, 0.95, false);
    }
    // the brush
    const tip = (wet[wet.length - 1] ?? start);
    ctx.save();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.arc(tip.x, tip.y, 9 + Math.sin(now / 90) * 1.5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = colour; ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(tip.x, tip.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // the next checkpoint to pass, with its tolerance
    const next = st.k < M ? { x: (geo.pts[2 * st.k] as number) / UNIT, y: (geo.pts[2 * st.k + 1] as number) / UNIT } : last;
    const R = lv.tolerance / UNIT;
    ctx.save();
    ctx.strokeStyle = colour; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(next.x, next.y, R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.12; ctx.fillStyle = colour; ctx.fill();
    ctx.restore();
    if (st.k === 0) {
      // the drop: start here
      const pulse = 1 + 0.15 * Math.sin(now / 140);
      ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(start.x, start.y, 11 * pulse, 0, Math.PI * 2); ctx.fill();
      text('START', start.x, start.y - 24, `500 10px ${F_MONO}`, INK);
    }
    // the end, and how long the paint stays wet once the brush is there
    ctx.save();
    ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.arc(last.x, last.y, 7, 0, Math.PI * 2); ctx.stroke();
    if (t > reached) {
      ctx.strokeStyle = RED; ctx.globalAlpha = 0.9; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(last.x, last.y, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * wetness); ctx.stroke();
    }
    ctx.restore();
    // who is being painted, under the score bar
    text(`PAINTING  ${name}`, W / 2, HUD_H + 16, fitFont(`PAINTING  ${name}`, W - 40, 12, F_MONO), LABEL);
  }
  function fingerTrail(now: number): void {
    const keep = trail.filter((p) => now - p.t < 420);
    trail = keep;
    if (keep.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 1; i < keep.length; i++) {
      const a = keep[i - 1] as { x: number; y: number; t: number }, b = keep[i] as { x: number; y: number; t: number };
      const life = 1 - (now - b.t) / 420;
      ctx.strokeStyle = INK; ctx.globalAlpha = 0.55 * life; ctx.lineWidth = 1 + 3 * life;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }
  function popups(now: number): void {
    pops = pops.filter((p) => now - p.t0 < 1300);
    for (const p of pops) {
      const k = (now - p.t0) / 1300;
      ctx.globalAlpha = Math.min(1, 2.2 * (1 - k));
      text(p.text, p.x, p.y - 22 * k, fitFont(p.text, 220, 28, F_ANTON), p.colour);
      text(p.sub, p.x, p.y + 20 - 22 * k, fitFont(p.sub, 240, 11, F_MONO), INK);
      ctx.globalAlpha = 1;
    }
    cameos = cameos.filter((c) => now - c.t0 < 1600);
    for (const c of cameos) {
      const k = (now - c.t0) / 1600, size = 40;
      ctx.globalAlpha = Math.min(1, 3 * (1 - k));
      drawPerson(ctx, nameOfPanel(c.panel), Math.max(4, Math.min(W - size - 4, c.x - size / 2)), Math.max(HUD_H + 4, c.y - size - 18 - 30 * k), size, stepAt(now));
      ctx.globalAlpha = 1;
    }
  }
  function banners(now: number, s: WpState): void {
    const open = engine.openTickOf(s);
    if (nowTick >= open && !s.gameOver) {
      const e = nowTick - open;
      let idx = -1;
      RAMP_BANNERS.forEach(([at], i) => { if (e >= at) idx = i; });
      if (idx !== lastRamp && idx >= 0) { lastRamp = idx; banner = { text: (RAMP_BANNERS[idx] as [number, string])[1], t0: now, gold: idx >= 2 }; }
    }
    if (!banner) return;
    const k = (now - banner.t0) / 1500;
    if (k >= 1) { banner = null; return; }
    ctx.globalAlpha = Math.min(1, 3 * (1 - k));
    ctx.fillStyle = banner.gold ? INK : 'rgba(11,11,11,0.82)'; ctx.fillRect(0, H - 92, W, 50);
    text(banner.text, W / 2, H - 67, fitFont(banner.text, W - 40, 30, F_ANTON), banner.gold ? '#F2B134' : CHALK);
    ctx.globalAlpha = 1;
  }
  function countdown(s: WpState, now: number): void {
    const open = engine.openTickOf(s);
    if (nowTick >= open || s.gameOver) return;
    const left = Math.ceil((open - nowTick) * TICK_MS / 1000);
    ctx.fillStyle = 'rgba(244,241,234,0.7)'; ctx.fillRect(0, HUD_H, W, H - HUD_H);
    text(String(left), W / 2, 380, `${120 + 12 * Math.sin(now / 120)}px ${F_ANTON}`, INK);
    text('FOLLOW THE BRUSH WITH YOUR FINGER', W / 2, 470, `500 13px ${F_MONO}`, LABEL);
    text('CLOSER = MORE BEAUTIFUL = MORE POINTS', W / 2, 494, `500 13px ${F_MONO}`, LABEL);
  }

  function draw(now: number): void {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.drawImage(paper(), 0, 0, W, H);
    const s = shown ?? view;
    if (mode === 'play' && s) {
      ctx.drawImage(artwork(s), 0, 0, W, H);
      activeStroke(s, now);
      fingerTrail(now);
      popups(now);
      hud(s);
      banners(now, s);
      countdown(s, now);
      if (s.gameOver) {
        ctx.fillStyle = 'rgba(244,241,234,.9)'; ctx.fillRect(0, 330, W, 170);
        const done = s.play.end === 'time';
        const title = done ? 'THE WALL IS PAINTED!' : 'OUT OF PAINT';
        text(title, W / 2, 395, fitFont(title, W - 40, 60, F_ANTON), done ? BLUE : RED);
        if (s.play.bonus) text(`FULL 90 SECONDS: +${fmtScore(s.play.bonus)}`, W / 2, 455, `500 14px ${F_MONO}`, INK);
      }
    } else if (mode === 'end' && s) {
      // under the end screen: the finished artwork
      ctx.drawImage(artwork(s), 0, 0, W, H);
      hud(s);
    } else {
      // the entry: names paint themselves slowly behind the page's own overlay
      idleArt(now);
      hud(null);
    }
    for (const b of bits) { ctx.globalAlpha = Math.min(1, b.life); ctx.fillStyle = b.c; ctx.beginPath(); ctx.arc(b.x, b.y, b.s / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
    if (flash > 0) { ctx.fillStyle = `rgba(214,69,50,${(flash * 0.22).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  }
  /** Behind the entry overlay: a few names of the wall painting themselves, again and again. */
  function idleArt(now: number): void {
    const cycle = 2600, i = Math.floor(now / cycle);
    for (let j = Math.max(0, i - 6); j <= i; j++) {
      const geo = engine.geometry({ seed: 99, startTick: 0 } as WpState, { n: j, b: 60 + (j * 97) % 1500 });
      const curve = smooth(geo.pts);
      const [colour, ink] = colourOf(99, j);
      const k = j === i ? (now % cycle) / cycle : 1;
      const shownCurve = part(curve, Math.min(1, k * 1.4));
      ribbon(ctx, shownCurve, colour, 18, 980, `idle:${j}`, j === i ? 0.95 : 0.25 + 0.1 * (j - i + 6), false);
      if (k >= 0.7) lettering(ctx, curve, nameOfPanel(engine.panelOf(99, j)), ink, 15, j === i ? 0.9 : 0.25);
    }
  }

  /* ------------------------------- end screen ------------------------------- */
  /** The end card, 1080 × 1440: the artwork with the names painted, the score, the artist's title. */
  function endCard(s: WpState | null, score: number): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1440;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = PAPER; g.fillRect(0, 0, 1080, 1440);
    const rnd = mulberry32(11);
    for (let i = 0; i < 5000; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(11,11,11,0.03)' : 'rgba(255,255,255,0.5)'; g.fillRect(rnd() * 1080, rnd() * 1440, 1 + rnd() * 2, 1 + rnd() * 2); }
    g.fillStyle = INK; g.fillRect(0, 0, 1080, 110);
    text('WET PAINT', 50, 58, `66px ${F_ANTON}`, CHALK, 'left', g);
    text(practice ? 'PRACTICE' : 'THE WALL ARCADE', 1030, 58, `500 24px ${F_MONO}`, practice ? '#7FB4EA' : '#B0ACA2', 'right', g);
    const p = s?.play;
    // the artwork: the field's painting box, scaled into the card
    const scale = 0.168, dx = 540 - ((BOX.x0 + BOX.x1) / 2) * scale, dy = 690 - ((BOX.y0 + BOX.y1) / 2) * scale;
    if (s && p) {
      paintArtwork(g, s.seed, p.canvas, (f) => engine.geometry(s, f).pts, scale, dx, dy, 1.68);
      if (!p.canvas.length) text('AN EMPTY WALL, READY FOR NEXT TIME', 540, 690, `500 26px ${F_MONO}`, LABEL, 'center', g);
    }
    g.fillStyle = 'rgba(11,11,11,.14)'; g.fillRect(50, 1222, 980, 2);
    if (p) {
      const t = artistTitle(p);
      text(t.title, 50, 1272, fitFont(t.title, 620, 56, F_ANTON, g), t.good ? BLUE : RED, 'left', g);
      text(t.line, 50, 1322, fitFont(t.line, 640, 22, F_MONO, g), INK, 'left', g);
    }
    text(fmtScore(score), 1030, 1268, `76px ${F_ANTON}`, INK, 'right', g);
    const rank = practice ? undefined : rankOf(endStats?.rank);
    text(`POINTS${rank ? ` · #${rank} THIS WEEK` : ''}`, 1030, 1322, `500 22px ${F_MONO}`, LABEL, 'right', g);
    const player = endStats?.player;                    // an ENS name only: an address says nothing on a card
    if (player && !/^0x[0-9a-f]{40}$/i.test(player)) text(`by ${player}`, 50, 1356, `500 20px ${F_MONO}`, LABEL, 'left', g);
    g.fillStyle = INK; g.fillRect(0, 1380, 1080, 60);
    text('A REMIX THE WALL EXPERIMENT · NFC SUMMIT 2027 · LISBON', 540, 1411, `500 22px ${F_MONO}`, CHALK, 'center', g);
    return c;
  }
  function paintedPanels(s: WpState): number[] { return [...new Set(s.play.canvas.map((f) => engine.panelOf(s.seed, f.n)))]; }
  function renderEnd(): void {
    const s = shown ?? view;
    const score = finalScore ?? s?.play.score ?? 0;
    const best = readBest(practice);
    if (score > best) writeBest(practice, score);
    const card = endCard(s, score);
    card.className = 'end-card wp-card';
    card.setAttribute('role', 'img');
    const panels = s ? paintedPanels(s) : [];
    card.setAttribute('aria-label', `Your artwork: ${panels.length} names of the wall painted, ${score} points.`);
    const nodes: HTMLElement[] = [card];
    // the names in the artwork
    const list = document.createElement('div');
    list.className = 'wp-names';
    const head = document.createElement('p');
    head.className = 'wp-names-head';
    head.textContent = panels.length ? `On this artwork: ${panels.length} ${panels.length === 1 ? 'name' : 'names'} of the wall` : 'No name on this artwork yet';
    list.append(head);
    const ul = document.createElement('ul');
    for (const panel of panels) {
      const li = document.createElement('li');
      const handle = handleOf(panel);
      li.textContent = nameOfPanel(panel);
      if (handle) li.title = `@${handle}`;
      ul.append(li);
    }
    list.append(ul);
    // share (the system share sheet with the picture where the browser has one; X otherwise) and save
    const share = document.createElement('a');
    share.className = 'end-post'; share.href = '#'; share.textContent = 'Share the artwork';
    const gameUrl = `${location.origin}/`;
    const tags = panels.map((panel) => tag(SNAPSHOT.get(panel)?.n ?? '', handleOf(panel))).filter(Boolean);
    const title = s ? artistTitle(s.play).title : 'WET PAINT';
    const tweet = fitTweet(tags, (names, more) => `I painted ${panels.length} names of the wall on WET PAINT: ${score} points, ${title}.${names ? ` On my canvas: ${names}${more ? ' …' : ''}` : ''} ${gameUrl}`, gameUrl);
    share.addEventListener('click', (e) => {
      e.preventDefault();
      card.toBlob((blob) => {
        const file = blob ? new File([blob], 'wet-paint.png', { type: 'image/png' }) : null;
        const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
        if (file && typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
          nav.share({ files: [file], text: tweet }).catch(() => undefined);
        } else {
          window.open(intentHref(tweet), '_blank', 'noopener');
        }
      }, 'image/png');
    });
    nodes.push(share);
    const row = document.createElement('p');
    row.className = 'wp-row';
    const save = document.createElement('a');
    save.textContent = 'save the picture'; save.download = 'wet-paint.png'; save.href = '#';
    save.addEventListener('click', () => { save.href = card.toDataURL('image/png'); });
    const bestNote = document.createElement('span');
    bestNote.textContent = `${practice ? 'practice ' : ''}best on this device: ${fmtScore(Math.max(best, score))}${score > best && best > 0 ? ' · new!' : ''}`;
    const wall = document.createElement('a');
    wall.href = 'https://onthewall.nfcsummit.com'; wall.target = '_blank'; wall.rel = 'noopener';
    wall.textContent = 'get on the wall';
    row.append(save, bestNote, wall);
    nodes.push(row, list);
    endPanel.replaceChildren(...nodes);
  }

  /* ---------------------------- layout and main loop ------------------------ */
  const frameEl = host.parentElement ?? host;
  function layout(): void {
    const availW = frameEl.clientWidth || W, availH = frameEl.clientHeight || H;
    const cssW = Math.max(220, Math.floor(Math.min(availW, availH * W / H)));
    const cssH = Math.floor(cssW * H / W);
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    host.style.width = `${cssW}px`; host.style.height = `${cssH}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    DPR = canvas.width / W;
    backdrop = null; art = null; artKey = ''; dirty = true;
  }
  new ResizeObserver(() => layout()).observe(frameEl);
  layout();
  void Promise.race([
    Promise.all([document.fonts.load('40px Anton'), document.fonts.load('500 12px "IBM Plex Mono"')]),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]).then(() => { backdrop = null; art = null; artKey = ''; dirty = true; }).catch(() => undefined);

  let lastFrame = performance.now(), idleT = 0;
  function frame(t: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (t - lastFrame) / 1000); lastFrame = t;
    if (flash > 0) flash = Math.max(0, flash - dt * 3);
    for (const b of bits) { b.x += b.vx * dt; b.y += b.vy * dt; b.vy += 300 * dt; b.vx *= 0.98; b.life -= dt; }
    if (bits.length) bits = bits.filter((b) => b.life > 0);
    if (mode === 'play') { catchUp(); flush(); draw(t); }
    else if (mode === 'idle' && t - idleT > 50) { idleT = t; draw(t); }
    else if (dirty) { draw(t); dirty = false; }
  }
  requestAnimationFrame(frame);

  // DEV builds only (scripts/dev-flow.ts defines __DEV_ANY_ORIGIN__; the published bundle drops this): lets a test
  // driver read what is on screen. Nothing here can change a run.
  if (typeof __DEV_ANY_ORIGIN__ !== 'undefined' && __DEV_ANY_ORIGIN__) {
    (window as unknown as { __wpDebug?: unknown }).__wpDebug = () => ({ shown, nowTick, mode, rect: canvas.getBoundingClientRect().toJSON() });
  }

  /* -------------------------------- Stage API ------------------------------- */
  return {
    setMessage(_text: string, extra?: { final?: number; view?: unknown; practice?: boolean; idle?: boolean }): void {
      dirty = true;
      if (extra?.idle) { mode = 'idle'; endPanel.hidden = true; return; }
      if (extra && typeof extra.final === 'number') {
        finalScore = extra.final;
        practice = Boolean(extra.practice);
        // the final state (the server's, or the practice's): the card is drawn from it, never from a prediction
        if (extra.view && typeof extra.view === 'object') { view = extra.view as WpState; shown = view; }
        mode = 'end';
        hits.flush();
        renderEnd(); endPanel.hidden = false;
      } else if (mode !== 'end') { mode = 'idle'; endPanel.hidden = true; }
    },
    hideRun(): void {
      if (mode !== 'play') return;
      mode = view?.gameOver ? 'end' : 'idle';
      if (mode === 'end') { renderEnd(); endPanel.hidden = false; }
      dirty = true;
    },
    endStats(stats: EndStats): void {
      endStats = stats;
      if (mode === 'end') renderEnd();
    },
    showRun(next: WpState, info): void {
      const nextPractice = Boolean(info.practice);
      if (mode !== 'play' || nextPractice !== practice || (view && view.seed !== next.seed)) {
        reset(nextPractice); mode = 'play'; endPanel.hidden = true;
      }
      if (next !== view) { view = next; shown = null; nowTick = -1; }
      catchUp();
    },
  };
}

export const wetPaintAdapter: GameAdapter = {
  id: 'wet-paint',
  title: 'WET PAINT',
  heading: 'Paint the wall',
  tagline: 'The names of the wall become living brush strokes. Follow the brush before the paint dries. 90 seconds, one artwork.',
  lede: 'A name of the wall appears as a drop of wet paint; then a brush paints it along a flowing path. Put your finger (or the mouse) on the drop and follow the brush to the end before the paint dries. The closer you stay to the path, the cleaner the stroke and the more points: a finished stroke stays on the wall and becomes part of your artwork, painted with the names. A stroke that dries before you finish it, or that you smudge by wandering off the path, costs points and one of your three drops of paint. The brush gets faster, the strokes longer and wavier and the path narrower all the way to the end; clean strokes in a row multiply your points; paint for the full 90 seconds for a big bonus. One credit per run, scored by the server.',
  stateSchema: stateSchema as never,
  snapshotSchema: snapshotSchema as never,
  parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
  applyInput: (state: WpState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
  scoreOf: (state: WpState) => state.play.score,
  statusLine(state: WpState, tick: number): string {
    if (state.gameOver) return 'Waiting for the platform’s recorded result…';
    if (!state.started) return 'Starting your server-validated round…';
    const open = engine.openTickOf(state);
    if (tick < open) return `The brush starts in ${Math.ceil((open - tick) * TICK_MS / 1000)}`;
    const left = Math.max(0, engine.endTickOf(state) - tick) * TICK_MS / 1000;
    return `Score ${state.play.score} · paint ${state.play.drops}/${RULES.drops} · ${Math.ceil(left)} s left`;
  },
  createStage,
  diagSummary: (s: WpState) => ({ tick: s.tick, started: s.started, startTick: s.startTick, gameOver: s.gameOver, score: s.play.score, drops: s.play.drops, stroke: s.play.stroke, pen: s.play.pen, last: s.play.events.at(-1) ?? null }),
  practice: {
    createRun: (seed: number) => engine.createRun(seed, scoringConfiguration('wet-paint')),
    advance: (state: WpState, tick: number) => engine.advance(state, tick),
  },
};

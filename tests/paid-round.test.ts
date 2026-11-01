// The paid-start / server-run state machine, with the game plugged in through its adapter. The first three tests are
// the upstream recovery regressions (studio-games-example/tests/recovery.test.ts) run unchanged against OUR shell;
// the rest cover what the adapter seam adds: prediction, snapshots, the start handshake and the stage hand-offs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PaidRound } from '../src/shell/paid-round.js';
import { wetPaintAdapter } from '../src/games/wet-paint/client.js';
import { engine as wpEngine, type WpState } from '../src/games/wet-paint/engine.js';
import { scoringConfiguration } from '../src/shell/config.js';

const appId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const address = '0x1111111111111111111111111111111111111111';
const authorization = { appId, groupId, address };
const terms = { credits: 1, title: 'Integration test' };
type PaidRequest = { idempotencyKey: string; fingerprint: string; expectedCredits: number };
type RunRequest = { sessionToken: string; eventId: string; idempotencyKey: string };

const PaidRoundAny = PaidRound as unknown as new (options: any) => any;
// the WET PAINT adapter (its canvas stage is never created here: these tests need no browser)
const wpAdapter = wetPaintAdapter as any;

class RoundHarness extends PaidRoundAny {
  saved: string[] = [];
  messages: string[] = [];
  save(): void { this.saved.push(JSON.stringify(this.state)); }
  clearActions(): void { /* DOM is irrelevant to protocol assertions. */ }
  announce(message: string): void { this.messages.push(message); }
  showRecoveryError(error: unknown): void { this.messages.push(error instanceof Error ? error.message : String(error)); }
  showRunError(error: unknown): void { this.messages.push(error instanceof Error ? error.message : String(error)); }
}
const base = { root: null, getBalance: () => ({ available: 10 }), getAddress: () => address, storageKey: 'test' };

test('uncertain paid start and server-run retry retain original keys, event, and session after reload', async () => {
  const paid: PaidRequest[] = []; const recovered: string[] = []; const runs: RunRequest[] = [];
  let round: any;
  const game = {
    getAuthorization: () => authorization,
    requestConsent: async (request: PaidRequest) => { assert.ok(round.saved.length, 'paid and run keys are saved before consent'); paid.push(request); return { consent: { token: 'test-only-consent' }, recovery: 'persistent' }; },
    startWithConsent: async (request: PaidRequest) => { paid.push(request); throw new Error('lost paid start response'); },
    recoverStart: async (request: { idempotencyKey: string }) => { recovered.push(request.idempotencyKey); return { session: { id: 'paid-session', token: 'test-only-session', expiresAt: '2099-01-01T00:00:00Z' }, game: {} }; },
  };
  const options = { ...base, adapter: wpAdapter, game, scoringGame: {
    startServerValidatedRun: async (request: RunRequest) => { runs.push(request); throw new Error('lost run response'); },
    getActiveScoringEvent: async () => { throw new Error('must not rediscover event during recovery'); },
  } };
  round = new RoundHarness(options);
  round.storageKey = round.accountStorageKey();
  await round.confirmRound(terms, 'original-paid-key', eventId);
  assert.equal(round.state.key, 'original-paid-key');
  assert.equal(paid.length, 2); assert.equal(paid[0]?.idempotencyKey, 'original-paid-key'); assert.equal(paid[1]?.idempotencyKey, 'original-paid-key');
  const originalRunKey = round.state.run.key;
  assert.match(originalRunKey, /^[0-9a-f]{64}$/);
  await round.recover();
  assert.deepEqual(recovered, ['original-paid-key']);
  assert.deepEqual(runs[0], { sessionToken: 'test-only-session', eventId, idempotencyKey: originalRunKey });
  const restored = new RoundHarness(options);
  restored.storageKey = restored.accountStorageKey();
  restored.state = wpAdapter.parseSavedRound(JSON.parse(round.saved.at(-1) as string));
  await restored.recover();
  assert.equal(paid.length, 2, 'reload/recover must not request new consent or a new paid start');
  assert.equal(recovered.length, 1, 'known paid session is reused');
  assert.deepEqual(runs[1], runs[0], 'same event/run key/session are replayed, even when active-event discovery fails');
});

test('wallet replacement during consent never starts or transfers the old wallet play', async () => {
  let currentAddress = address; let starts = 0;
  const game = { getAuthorization: () => authorization,
    requestConsent: async () => { currentAddress = '0x2222222222222222222222222222222222222222'; return { consent: {} }; },
    startWithConsent: async () => { starts += 1; throw new Error('must never run'); } };
  const round: any = new RoundHarness({ ...base, adapter: wpAdapter, game, scoringGame: {}, getAddress: () => currentAddress });
  round.storageKey = round.accountStorageKey();
  const originalStorageKey = round.storageKey;
  await round.confirmRound(terms, 'original-paid-key', eventId);
  assert.equal(starts, 0); assert.equal(round.accountStorageKey(), null); assert.equal(round.storageKey, originalStorageKey);
  assert.equal(round.state.request.idempotencyKey, 'original-paid-key'); assert.ok(round.saved.length, 'original wallet recovery is retained');
  currentAddress = address.toUpperCase();
  assert.equal(round.accountStorageKey(), originalStorageKey, 'wallet boundary is case-insensitive');
});

test('memory-only consent never sends a paid start and retains the original attempt for recovery', async () => {
  let starts = 0, recoveries = 0, recovery = 'memory';
  const game = { getAuthorization: () => authorization,
    requestConsent: async () => ({ consent: { token: 'memory-only' }, recovery }),
    startWithConsent: async () => { starts += 1; throw new Error('Paid start must not run without durable consent'); },
    recoverStart: async () => { recoveries += 1; throw new Error('Lost recovery response'); } };
  const round: any = new RoundHarness({ ...base, adapter: wpAdapter, game, scoringGame: {} });
  round.storageKey = round.accountStorageKey();
  await round.confirmRound(terms, 'original-paid-key', eventId);
  assert.equal(starts, 0); assert.equal(round.state.key, 'original-paid-key'); assert.equal(round.state.phase, 'pending');
  assert.equal(wpAdapter.parseSavedRound(JSON.parse(round.saved.at(-1) ?? 'null')).request && (wpAdapter.parseSavedRound(JSON.parse(round.saved.at(-1) as string)) as any).request.idempotencyKey, 'original-paid-key');
  await round.recover();
  assert.equal(recoveries, 0, 'Continue must not bypass the failed durability check');
  recovery = 'persistent';
  await round.recover();
  assert.equal(recoveries, 1); assert.equal(round.state.request.idempotencyKey, 'original-paid-key');
});

/* ---- the adapter seam ---- */
const wpConfig = scoringConfiguration('wet-paint');
const configDigest = 'a'.repeat(64);
function playingRound(adapter: typeof wpAdapter, state0: unknown) {
  const sent: string[] = []; const stageCalls: string[] = [];
  const round: any = new RoundHarness({ ...base, adapter, game: { getAuthorization: () => authorization }, scoringGame: {} });
  round.storageKey = round.accountStorageKey();
  round.stage = { hideRun: () => stageCalls.push('hideRun'), setMessage: (text: string, extra?: unknown) => stageCalls.push(`setMessage:${text}:${JSON.stringify(extra ?? null)}`), showRun: () => stageCalls.push('showRun') };
  round.socket = { readyState: 1, send: (message: string) => sent.push(message), close: () => undefined };
  round.scoreNode = { textContent: '' };
  round.state = { version: 2, key: 'k', phase: 'playing', createdAt: Date.now(), request: { idempotencyKey: 'k', fingerprint: 'f', expectedCredits: 1 },
    session: { id: 's', token: 't', expiresAt: '2099-01-01T00:00:00Z' },
    run: { eventId, key: 'r'.repeat(64), runId, configDigest, serverTick: -1, inputSeq: 0, inputTick: -1, pendingInputs: [], view: state0 } };
  round.lastPacketAt = performance.now();
  const packet = (state: unknown, serverTick: number, extra: Record<string, unknown> = {}) => ({ runId, configDigest, serverTick, inputSeq: 0, inputTick: -1,
    expiresAt: '2099-01-01T00:00:00Z', state, result: null, ...extra });
  return { round, sent, stageCalls, packet };
}
/** A run on its first stroke, the brush not yet moving, and a trace on its drop. */
function onFirstStroke(seed: number): { state: WpState; drop: number[] } {
  const state = wpEngine.advance(wpEngine.applyInput(wpEngine.createRun(seed, wpConfig), { action: 'start' }, 0), 64);
  const pts = wpEngine.geometry(state, state.play.stroke!).pts;
  return { state, drop: [pts[0] as number, pts[1] as number] };
}

test('a first snapshot of an unstarted run queues exactly one start, which is sent as an ordered input (no score, no time)', () => {
  const { round, sent, packet } = playingRound(wpAdapter, wpEngine.createRun(5, wpConfig));
  round.lastPacketAt = performance.now() - 120;
  round.acceptSnapshot(wpAdapter.snapshotSchema.parse(packet(wpEngine.createRun(5, wpConfig), 3)));
  assert.equal(round.state.run.pendingInputs.length, 1);
  assert.deepEqual(round.state.run.pendingInputs[0].input, { action: 'start' });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0] as string), { type: 'input', seq: 1, input: { action: 'start' } });
  round.acceptSnapshot(wpAdapter.snapshotSchema.parse(packet(wpEngine.createRun(5, wpConfig), 4)));
  assert.equal(round.state.run.pendingInputs.length, 1, 'the start is not queued twice');
});

test('prediction: a queued trace is applied where the player made it, then replaced by the next server snapshot', () => {
  const { state, drop } = onFirstStroke(8);
  const { round, sent, packet } = playingRound(wpAdapter, state);
  round.acceptSnapshot(wpAdapter.snapshotSchema.parse(packet(state, 64)));
  round.lastPacketAt = performance.now() - 100;                    // ~2 ticks after that snapshot
  round.userInput({ action: 'trace', pts: drop });
  assert.equal(round.predictedView.play.stroke.k, 1, 'the drop is caught immediately on screen');
  assert.deepEqual(round.predictedView.play.pen, drop);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0] as string), { type: 'input', seq: 1, input: { action: 'trace', pts: drop } }, 'points only: no score, no time');
  // the server accepted it as input #1 at tick 67: its snapshot replaces the guess and clears the queue
  const accepted = wpEngine.applyInput(state, { action: 'trace', pts: drop }, 67);
  round.acceptSnapshot(wpAdapter.snapshotSchema.parse(packet(accepted, 68, { inputSeq: 1, inputTick: 67 })));
  assert.equal(round.state.run.pendingInputs.length, 0);
  assert.equal(round.predictedView.play.stroke.k, 1);
  // refused once the round is finishing
  round.state.phase = 'finalizing'; round.userInput({ action: 'lift' });
  assert.equal(sent.length, 1, 'inputs are dropped once the round is finishing');
});

test('a terminal snapshot with the platform result finalizes the round and hands the official score to the stage', () => {
  const { state } = onFirstStroke(8);
  const over = wpEngine.advance(state, wpConfig.maxTicks);
  assert.equal(over.gameOver, true);
  const { round, stageCalls, packet } = playingRound(wpAdapter, state);
  (round as any).submitAndComplete = async () => undefined;       // completion is the SDK's business, not under test here
  round.acceptSnapshot(wpAdapter.snapshotSchema.parse(packet(over, over.tick, { result: { runId, score: String(over.play.score), status: 'completed' } })));
  assert.equal(round.state.phase, 'finalizing'); assert.equal(round.state.result.score, over.play.score);
  assert.ok(stageCalls.some((call) => call.startsWith(`setMessage:Server-verified score: ${over.play.score}.`)), stageCalls.join(' | '));
  assert.equal(round.socket, null, 'the socket is released');
});

test('snapshots of another run, another verifier or another game are refused', () => {
  const state0 = wpEngine.createRun(3, wpConfig);
  const { round, packet } = playingRound(wpAdapter, state0);
  assert.throws(() => round.acceptSnapshot({ ...packet(state0, 2), runId: '55555555-5555-4555-8555-555555555555' }), /different run or verifier/);
  assert.throws(() => round.acceptSnapshot({ ...packet(state0, 2), configDigest: 'b'.repeat(64) }), /different run or verifier/);
  const otherGame = { ...state0, rules: { game: 'another-game', maxTicks: 2160, roundTicks: 1860 } };
  assert.throws(() => wpAdapter.snapshotSchema.parse(packet(otherGame, 2)));
});

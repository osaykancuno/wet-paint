// DEV ONLY (never packaged): a stand-in for @rareprotocol/connect, bundled in place of the real SDK by
// scripts/dev-flow.ts, so the whole game page (PLAY sequence, buy screen, consent, paid run, end screen, wallet menu,
// recovery) can be walked in a browser without a wallet, a payment or SuperRare's servers. It proves the page, not the
// platform: sign-in, checkout, claim and the coordinator are simulated here.
//
// Query parameters: ?credits=N (starting balance, default 0) · ?signed=1 (start signed in) · ?ticks=N (run length in
// 50 ms ticks, default 400) · ?mismatch=1 (the claim is refused as "does not match this payment quote") · ?address=0x…
// (sign in as that wallet) · ?lag=MS (one-way network delay).
import { WALL_PANELS } from '../generated/wall.js';
import { createEngine as createWetPaint } from '../games/wet-paint/core.js';
import { scoringConfiguration } from '../shell/config.js';
import { PACK, formatPrice } from '../shell/credits.js';


const params = new URLSearchParams(location.search);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/.test(params.get('address') ?? '') ? (params.get('address') as string).toLowerCase() : '0xdec0de0000000000000000000000000000000001';
const TREASURY = '0x000000000000000000000000000000000000dEaD';   // a placeholder: the fake never pays anyone
const engine = createWetPaint(WALL_PANELS);
const lagMs = Number(params.get('lag') ?? 0);          // one-way network delay, both directions
const runTicks = Number(params.get('ticks') ?? scoringConfiguration('wet-paint').roundTicks);
const uuid = (): string => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] as number) & (15 >> (Number(c) / 4))).toString(16)));
const later = (ms: number): string => new Date(Date.now() + ms).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args: unknown[]): void => { (window as any).__fakeLog ??= []; (window as any).__fakeLog.push(args.map(String).join(' ')); console.info('[fake-connect]', ...args); };

/** Fictitious ENS names, so the screens show how ENS replaces addresses (the real ones come from Studio). */
const fakePlayer = () => ({ kind: 'wallet', id: null, handle: null, displayName: ADDRESS, avatarUrl: null, ensName: FAKE_ENS[ADDRESS] ?? null });
const FAKE_ENS: Record<string, string> = { [ADDRESS]: 'player.eth', '0xaaaa00000000000000000000000000000000beef': 'wallhero.eth' };
const store = {
  get session(): any { const raw = localStorage.getItem('fake:session'); return raw ? JSON.parse(raw) : undefined; },
  set session(value: any) { if (value) localStorage.setItem('fake:session', JSON.stringify(value)); else localStorage.removeItem('fake:session'); },
  get balance(): number { return Number(localStorage.getItem('fake:balance') ?? params.get('credits') ?? 0); },
  set balance(value: number) { localStorage.setItem('fake:balance', String(value)); },
  purchases: new Map<string, any>(),
  board: [
    { name: '0xaaaa00000000000000000000000000000000beef', score: 35 },
    { name: '0x510f00000000000000000000000000000000c839', score: 22 },
    { name: '0x7c3e000000000000000000000000000000004d21', score: 18 },
  ] as { name: string; score: number }[],
};
if (params.get('signed') === '1' && !store.session) store.session = { address: ADDRESS, sessionId: 'fake', expiresAt: later(3_600_000) };
const listeners = new Set<(session: any) => void>();
let authorization: any;

export class ConnectEmbedUnavailableError extends Error { code = 'embed_unavailable'; }

/** Opens the page's embed window with a fake hosted step; resolves false if the player closes it first. */
async function hosted(options: any, label: string, ms: number): Promise<boolean> {
  const win = options.embed?.open(`about:blank#${label}`);
  if (!win) return true;
  const frame = document.querySelector<HTMLIFrameElement>('#connect-embed iframe');
  frame?.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (doc) doc.body.innerHTML = `<div style="font:16px system-ui;padding:40px;text-align:center">FAKE SuperRare Connect<br><b>${label}</b><br><small>auto-approves in ${ms / 1000}s · close to cancel</small></div>`;
  }, { once: true });
  for (let waited = 0; waited < ms; waited += 100) { await sleep(100); if (win.closed) return false; }
  return true;
}

export function createSuperRareClient(options: any = {}) {
  const auth = {
    getSession: () => store.session,
    getRemoteSession: async () => ({ authenticated: Boolean(store.session) }),
    login: async () => {
      log('login');
      if (!(await hosted(options, 'Sign in', 1500))) return { status: 'cancelled' };
      store.session = { address: ADDRESS, sessionId: 'fake', expiresAt: later(3_600_000) };
      for (const listener of listeners) listener(store.session);
      return { status: 'authenticated' };
    },
    logout: async () => { store.session = undefined; authorization = undefined; for (const listener of listeners) listener(undefined); },
    onChange: (listener: (session: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const actions = {
    transfer: async (request: any) => {
      log('transfer', request.amount, request.currency, 'to', request.to);
      const intent = { intentId: uuid() };
      request.beforeOpen?.(intent);
      void (async () => {
        const approved = await hosted(options, `Pay ${formatPrice(request.amount, request.currency)} to ${request.to}`, 2000);
        const result = approved ? { intentId: intent.intentId, status: 'completed', result: { transactionHash: `0x${'ab'.repeat(32)}` } } : { intentId: intent.intentId, status: 'cancelled' };
        log('intent settled', result.status);
        options.onIntentSettled?.(result);
      })();
      return intent;
    },
    getStatus: async ({ intentId }: { intentId: string }) => ({ intentId, status: 'completed', result: { transactionHash: `0x${'ab'.repeat(32)}` } }),
  };
  const games = {
    forGame: ({ appId, groupId }: { appId: string; groupId?: string }) => ({
      getAuthorization: () => (authorization && store.session ? { ...authorization } : undefined),
      connect: async () => {
        log('game.connect (API only)');
        if (!store.session) throw Object.assign(new Error('signed out'), { name: 'ConnectSessionRequiredError' });
        authorization = { appId, groupId, address: store.session.address, expiresAt: later(900_000) };
        return { ...authorization };
      },
      getTerms: async () => ({ title: 'WET PAINT', credits: 1 }),
      credits: {
        getBalance: async () => ({ accountId: 'a', groupId, chainId: 1, address: ADDRESS, balance: store.balance, reserved: 0, available: store.balance }),
        createPurchase: async () => {
          const purchase = { id: uuid(), accountId: 'a', paymentConfigId: 'p', chainId: 1, address: ADDRESS, treasuryAddress: TREASURY, currency: PACK.currency, tokenAddress: PACK.tokenAddress,
            packPriceAtomic: PACK.priceAtomic, packCredits: PACK.credits, minBlock: '1', createdAt: new Date().toISOString(), expiresAt: later(600_000), transactionHash: null, creditedAt: null };
          store.purchases.set(purchase.id, purchase);
          log('quote', purchase.id);
          return purchase;
        },
        getPurchase: async (id: string) => store.purchases.get(id),
        claimPurchase: async ({ purchaseId, transactionHash }: { purchaseId: string; transactionHash: string }) => {
          log('claim', purchaseId);
          if (params.get('mismatch') === '1') throw Object.assign(new Error(`API error 422 on /api/v1/credit-groups/x/purchases/${purchaseId}/claim: The transaction does not match this payment quote.`), { status: 422 });
          const purchase = { ...store.purchases.get(purchaseId), transactionHash, creditedAt: new Date().toISOString() };
          store.purchases.set(purchaseId, purchase);
          store.balance += 50;
          return { purchase, balance: { accountId: 'a', groupId, chainId: 1, address: ADDRESS, balance: store.balance, reserved: 0, available: store.balance } };
        },
      },
      requestConsent: async () => { log('consent'); return { consent: { token: 'fake' }, recovery: 'persistent' }; },
      startWithConsent: async () => {
        if (store.balance < 1) throw Object.assign(new Error('insufficient'), { code: 'CREDIT_GROUP_INSUFFICIENT_CREDITS' });
        store.balance -= 1;
        log('paid start: 1 credit spent, balance', store.balance);
        return { session: { id: uuid(), token: 'fake-session', expiresAt: later(3_600_000) }, game: {}, player: fakePlayer() };
      },
      recoverStart: async () => ({ session: { id: uuid(), token: 'fake-session', expiresAt: later(3_600_000) }, game: {}, player: fakePlayer() }),
      complete: async () => { log('complete'); return {}; },
      getActiveScoringEvent: async () => ({ eventId: '11111111-1111-4111-8111-111111111111' }),
      // ?empty=1: nobody on the board (the ENS of the player then comes from the paid start's player view)
      getServerLeaderboard: async () => (params.get('empty') === '1' ? [] : [...store.board]).sort((a, b) => b.score - a.score).slice(0, 10).map((entry, index) => ({
        rank: index + 1, scoreId: `s${index}`, score: String(entry.score), secondaryValue: null, trustLevel: 'server_verified', achievedAt: new Date().toISOString(),
        player: { kind: 'wallet', id: null, handle: null, displayName: entry.name, ensName: FAKE_ENS[entry.name] ?? null, avatarUrl: null }, isCurrentPlayer: false })),
      startServerValidatedRun: async ({ idempotencyKey }: { idempotencyKey: string }) => {
        const known = JSON.parse(localStorage.getItem(`fake:run:${idempotencyKey}`) ?? 'null');
        if (known) { runs.set(known.run.runId, runs.get(known.run.runId) ?? known.run.state); log('server run recovered', known.run.runId); return known; }
        const runId = uuid();
        const config = { game: 'wet-paint', maxTicks: runTicks + 100, roundTicks: runTicks };
        const state = engine.createRun(Math.floor(Math.random() * 2 ** 32), config);
        runs.set(runId, state);
        log('server run', runId);
        const response = { run: { runId, eventId: '11111111-1111-4111-8111-111111111111', engine: 'custom', engineVersion: 'custom-v1', configDigest: 'c'.repeat(64),
          startedAt: new Date().toISOString(), expiresAt: later(900_000), state, webSocketUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/server-game-runs/${runId}/connect` } };
        localStorage.setItem(`fake:run:${idempotencyKey}`, JSON.stringify(response));
        return response;
      },
    }),
  };
  return { auth, actions, games };
}

/* A stand-in coordinator socket: server ticks every 50 ms, at most one input per tick, a snapshot per tick. */
const runs = new Map<string, any>();
const RealWebSocket = window.WebSocket;
class FakeSocket extends EventTarget {
  readyState = 0;
  private tick = 0;
  private seq = 0;
  private inputTick = -1;
  private queue: { seq: number; input: unknown }[] = [];
  private timer: number;
  constructor(url: string | URL) {
    super();
    const runId = String(url).split('/').at(-2) as string;
    let state = runs.get(runId);
    const saved = JSON.parse(localStorage.getItem(`fake:sock:${runId}`) ?? 'null');
    if (saved) { state = saved.state; this.seq = saved.seq; this.inputTick = saved.inputTick; }
    // the server clock kept running while the page was away
    this.tick = saved ? saved.tick + Math.floor((Date.now() - saved.at) / 50) : 0;
    setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 30);
    this.timer = window.setInterval(() => {
      this.tick++;
      state = engine.advance(state, Math.max(state.tick, this.tick));
      const next = this.queue.shift();
      if (next && !state.gameOver) { state = engine.applyInput(state, next.input, this.tick); this.seq = next.seq; this.inputTick = this.tick; }
      localStorage.setItem(`fake:sock:${runId}`, JSON.stringify({ state, seq: this.seq, inputTick: this.inputTick, tick: this.tick, at: Date.now() }));
      const done = state.gameOver;
      const score = engine.score(state);
      if (done) { store.board.push({ name: ADDRESS, score }); log('run finished, score', score); }
      const data = JSON.stringify({ runId, configDigest: 'c'.repeat(64), serverTick: this.tick, inputSeq: this.seq,
        inputTick: this.inputTick, expiresAt: later(900_000), state, result: done ? { runId, score: String(score), status: 'completed' } : null });
      const deliver = (): void => { this.dispatchEvent(new MessageEvent('message', { data })); };
      if (lagMs > 0) setTimeout(deliver, lagMs); else deliver();
      if (done) window.clearInterval(this.timer);
    }, 50);
  }
  send(message: string): void {
    const packet = JSON.parse(message);
    const arrive = (): void => { this.queue.push({ seq: packet.seq, input: packet.input }); (window as any).__fakeInputs = [...((window as any).__fakeInputs ?? []), { at: this.tick, input: packet.input }]; };
    if (lagMs > 0) setTimeout(arrive, lagMs); else arrive();
  }
  close(): void { window.clearInterval(this.timer); this.readyState = 3; }
}
(window as any).WebSocket = function (url: string | URL, protocols?: string | string[]) {
  return String(url).includes('/api/v1/server-game-runs/') ? new FakeSocket(url) : new RealWebSocket(url, protocols);
} as unknown as typeof WebSocket;
(window as any).WebSocket.OPEN = 1;

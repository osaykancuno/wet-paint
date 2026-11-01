// Adapted from studio-games-example/src/round.js, itself from @rareprotocol/connect examples/target-game
// (MIT, Copyright 2026 SuperRare). The paid-start, consent, recovery and server-run state machine is unchanged;
// what is game-specific (rules for prediction, state/snapshot schemas, the arena a player sees) now comes from a
// GameAdapter (see ./adapter.ts) instead of the Target Rush / Color Match engine.
//
// The page around it (src/shell/app.ts) owns the buttons a player sees: this class reports where the round stands
// through `onView(kind, detail)` and only renders its own recovery buttons (Continue / Retry) into `nodes.actions`.
// Kinds: 'signed-out', 'ready' (a new paid play may start; detail.terms), 'busy', 'recovery', 'playing',
// 'finished' (detail.score: the platform's recorded score).

import { diag } from './diagnostics.js';

const TICK_MILLISECONDS = 50;
const MAX_PENDING_INPUTS = 32;
const STORAGE_PREFIX = 'studio-games-round:';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function newKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function unusedReplacementKey(previousKey, credits) {
  const input = new TextEncoder().encode(`target-game-unused-renewal:v1:${previousKey}:${credits}`);
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function serverRunKey(paidKey) {
  const input = new TextEncoder().encode(`target-game-server-run:v1:${paidKey}`);
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isKnownUnusedConsent(error) {
  return error?.code === 'CREDIT_GROUP_CONSENT_EXPIRED';
}

function recoveryMessage(error) {
  const code = error?.code;
  if (error?.name === 'ConnectSessionRequiredError' || code === 'CONNECT_UNAUTHORIZED') {
    return 'Sign in to SuperRare, then continue. Your play is saved.';
  }
  if (code === 'authorization_required' || error?.status === 401) {
    return 'Your game connection needs renewing. Continue will reconnect and retry your saved play.';
  }
  if (code === 'CREDIT_GROUP_INSUFFICIENT_CREDITS') {
    return 'Buy credits, then continue your saved play.';
  }
  if (code === 'CREDIT_GROUP_NEW_USES_PAUSED' || code === 'CREDIT_GROUP_NOT_ACTIVE') {
    return 'This game is temporarily paused. Your saved play is kept.';
  }
  if (code === 'CREDIT_GROUP_APP_NOT_APPROVED' || code === 'FORBIDDEN') {
    return 'This game is not currently approved to start a play. Your saved play is kept.';
  }
  return 'Could not start the game. Continue safely retries your saved play.';
}

export class PaidRound {
  constructor({ game, scoringGame, adapter, root, getBalance, getAddress, storageKey, stage, nodes, onView }) {
    this.game = game;
    this.scoringGame = scoringGame;
    this.adapter = adapter;
    this.variant = adapter.id;
    this.root = root;
    this.nodes = nodes ?? null;
    this.onView = onView ?? (() => {});
    this.viewKind = null;
    this.terms = null;
    this.getBalance = getBalance;
    this.getAddress = getAddress;
    this.baseStorageKey = storageKey;
    this.state = null;
    this.storageKey = null;
    this.timer = null;
    this.statusNode = null;
    this.actionNode = null;
    this.stage = stage ?? null;
    this.scoreNode = null;
    this.socket = null;
    this.runConnecting = false;
    this.completing = false;
    this.connectTimer = null;
    this.predictedView = null;
    this.lastPacketAt = 0;
    this.lastSentTick = -1;
    this.receivedSnapshot = false;
    this.startingRound = false;
    this.playActionGeneration = 0;
  }

  render() {
    if (!this.nodes || !this.stage) throw new Error('PaidRound needs the page nodes and the shared stage.');
    this.statusNode = this.nodes.status;
    this.actionNode = this.nodes.actions;
    this.scoreNode = this.nodes.score;
    this.stage.setMessage('Start a round to play.');
    void this.refresh();
    return this;
  }

  /** Tell the page where the round stands (only when it changes, except for 'finished' which carries a score). */
  view(kind, detail = {}) {
    if (kind === this.viewKind && kind !== 'finished' && kind !== 'ready') return;
    this.viewKind = kind;
    this.onView(kind, detail);
  }

  /** Diagnostics: a compact view of a state (the adapter's own summary when it has one). */
  summary(state) {
    try { return this.adapter.diagSummary ? this.adapter.diagSummary(state) : { tick: state?.tick, started: state?.started, gameOver: state?.gameOver }; }
    catch { return null; }
  }

  announce(message) {
    if (this.statusNode) this.statusNode.textContent = message;
  }

  accountStorageKey() {
    const authorization = this.game.getAuthorization();
    if (!authorization?.address || authorization.address.toLowerCase() !== this.getAddress()?.toLowerCase()) return null;
    const appId = authorization.appId;
    const groupId = authorization.groupId;
    return `${STORAGE_PREFIX}${encodeURIComponent(this.baseStorageKey)}:${encodeURIComponent(appId)}:${encodeURIComponent(groupId)}:${encodeURIComponent(authorization.address.toLowerCase())}`;
  }

  save() {
    if (!this.storageKey || !this.state) throw new Error('The paid round cannot be saved for this account.');
    // A failed storage write must stop before any consent or payment-facing call.
    localStorage.setItem(this.storageKey, JSON.stringify(this.state));
  }

  load() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      return this.adapter.parseSavedRound(JSON.parse(raw));
    } catch (error) {
      throw new Error(`Could not read this account's saved round: ${errorMessage(error)}`);
    }
  }

  clearActions() {
    this.actionNode.replaceChildren();
  }

  button(label, action, className) {
    const button = element('button', label, className);
    button.type = 'button';
    button.addEventListener('click', action);
    this.actionNode.append(button);
    return button;
  }

  async refresh() {
    if (!this.actionNode) return;
    const key = this.accountStorageKey();
    if (key === this.storageKey && (this.socket || this.runConnecting || this.completing || this.startingRound)) return;
    this.disconnectRun();
    this.clearActions();
    this.stage.hideRun();
    if (!key) {
      this.storageKey = null;
      this.state = null;
      this.scoreNode.textContent = 'Score: 0';
      this.announce('Sign in to play.');
      this.view('signed-out');
      return;
    }
    this.storageKey = key;
    try {
      this.state = this.load();
    } catch (error) {
      this.announce(errorMessage(error));
      this.view('recovery');
      return;
    }
    if (this.state?.phase === 'terminal' && this.state.unused === true) {
      this.scoreNode.textContent = 'Score: 0';
      this.stage.setMessage('Start a round to play.');
      this.announce(`A paid play you approved has not started yet. Continue starts it (${this.state.request.expectedCredits} credit).`);
      this.button('Continue', () => void this.recover());
      this.view('recovery');
      return;
    }
    if (!this.state || ['terminal', 'completed'].includes(this.state.phase)) {
      this.scoreNode.textContent = this.state?.result
        ? `Verified score: ${this.state.result.score}`
        : 'Score: 0';
      this.stage.setMessage(this.state?.phase === 'terminal'
        ? this.state.diagnostic : 'Start a server-validated round to play.');
      this.announce(this.state?.phase === 'terminal'
        ? `${this.state.diagnostic} Any credits already used remain charged.`
        : 'Ready for a server-validated paid round.');
      await this.showPlayAction();
      return;
    }
    this.scoreNode.textContent = `Score: ${this.state.run?.view?.score ?? 0}`;
    this.stage.setMessage('Continue reconnects this same paid round; its server clock does not restart.');
    this.announce('You have a paid round in progress. Continue reconnects it on the same server clock, without using another credit.');
    this.button('Continue', () => void this.recover());
    this.view('recovery');
  }

  async showPlayAction() {
    const generation = ++this.playActionGeneration;
    const accountKey = this.storageKey;
    const previous = this.state;
    this.clearActions();
    try {
      const [terms] = await Promise.all([this.game.getTerms(), this.scoringGame.getActiveScoringEvent()]);
      if (terms.credits !== 1) throw new Error('This example requires exactly 1 credit per play. Ask the organizer to correct its terms.');
      if (generation !== this.playActionGeneration || this.storageKey !== accountKey || this.state !== previous) return;
      this.terms = terms;
      this.view('ready', { terms });
    } catch (error) {
      if (generation !== this.playActionGeneration || this.storageKey !== accountKey || this.state !== previous) return;
      this.announce(`Could not load the game price: ${errorMessage(error)} No new play was started.`);
      this.button('Retry', () => void this.showPlayAction());
      this.view('recovery');
    }
  }

  async prepareRound(displayedCredits) {
    if (this.startingRound || !Number.isSafeInteger(displayedCredits) || displayedCredits <= 0) return;
    if (this.state && !['completed', 'terminal'].includes(this.state.phase)) {
      await this.recover();
      return;
    }
    this.startingRound = true;
    this.playActionGeneration += 1;
    const accountKey = this.storageKey;
    const previous = this.state;
    this.clearActions();
    this.announce('Starting your game…');
    this.view('busy');
    try {
      if (!this.game.getAuthorization()) await this.game.connect();
      const [terms, balance, event] = await Promise.all([
        this.game.getTerms(), this.getBalance(), this.scoringGame.getActiveScoringEvent(),
      ]);
      if (this.storageKey !== accountKey || this.state !== previous || this.accountStorageKey() !== accountKey) return;
      if (!terms || !balance) throw new Error('Could not read the game terms or credit balance.');
      if (terms.credits !== 1) throw new Error('The configured price must be exactly 1 credit per play.');
      if (terms.credits !== displayedCredits) {
        this.announce(`The price changed to ${terms.credits} credits. Click the updated Play button to approve that cost.`);
        await this.showPlayAction();
        return;
      }
      if (balance.available < terms.credits) {
        this.announce(`Not enough credits for ${terms.title}. Buy credits, then try again.`);
        await this.showPlayAction();
        return;
      }
      await this.confirmRound(terms, undefined, event.eventId);
    } catch (error) {
      if (this.storageKey !== accountKey) return;
      if (this.state !== previous) this.showRecoveryError(error);
      else {
        this.announce(`Could not start a round: ${errorMessage(error)}`);
        await this.showPlayAction();
      }
    } finally {
      this.startingRound = false;
    }
  }

  async confirmRound(terms, replacementKey, eventId) {
    if (!this.storageKey) return;
    this.clearActions();
    const accountKey = this.storageKey;
    const key = replacementKey ?? newKey();
    let run;
    try {
      const activeEvent = eventId ?? (await this.scoringGame.getActiveScoringEvent()).eventId;
      run = {
        eventId: activeEvent, key: await serverRunKey(key),
        serverTick: -1, inputSeq: 0, inputTick: -1, pendingInputs: [],
      };
    } catch (error) {
      this.announce(`Could not prepare the server-validated game: ${errorMessage(error)} No credits were used.`);
      void this.showPlayAction();
      return;
    }
    if (this.storageKey !== accountKey || this.accountStorageKey() !== accountKey) return;
    this.state = {
      version: 2,
      key,
      phase: 'pending',
      score: 0,
      createdAt: Date.now(),
      run,
      request: {
        idempotencyKey: key,
        fingerprint: `${this.variant}:${key}`,
        expectedCredits: terms.credits,
        metadata: { arcade: 'the-wall-arcade', game: this.variant },
      },
      terms: { title: terms.title, credits: terms.credits },
    };
    // Both the paid-start key and server-run key are durable before either POST.
    const attempt = this.state;
    try {
      this.save();
    } catch (error) {
      this.state = null;
      this.announce(`Cannot safely start: ${errorMessage(error)}`);
      void this.showPlayAction();
      return;
    }
    this.announce(`Starting ${terms.title}…`);
    try {
      if (!this.game.getAuthorization()) await this.game.connect();
      if (this.storageKey !== accountKey || this.state !== attempt) return;
      if (this.accountStorageKey() !== accountKey) {
        this.showRecoveryError(new Error('The current wallet does not own this saved play.'),
          'Switch back to the wallet that owns this saved play, then continue.');
        return;
      }
      const { consent, recovery } = await this.game.requestConsent(attempt.request);
      if (this.storageKey !== accountKey || this.state !== attempt || this.accountStorageKey() !== accountKey) return;
      if (recovery !== 'persistent') {
        attempt.memoryOnlyConsent = true;
        this.save();
        this.showRecoveryError(new Error('Consent recovery could not be saved.'),
          'Keep this page open and restore browser storage before continuing. No paid start was sent.');
        return;
      }
      const session = await this.game.startWithConsent({ ...attempt.request, consent });
      diag.add('paid-start', { ok: true, credits: attempt.request.expectedCredits });
      if (this.storageKey !== accountKey || this.state !== attempt) return;
      this.acceptSession(session);
      await this.beginPlay();
    } catch (error) {
      if (this.storageKey !== accountKey || this.state !== attempt) return;
      await this.handleAttemptError(error);
    }
  }

  acceptSession(session) {
    // the platform's public view of the player (ENS when it resolved one): cosmetic, kept out of the saved state
    this.sessionPlayer = session.player ?? null;
    this.state.session = session.session;
    this.state.game = session.game;
    this.state.phase = 'ready';
    this.save();
  }

  async handleAttemptError(error) {
    if (isKnownUnusedConsent(error)) {
      const diagnostic = 'Studio confirmed this attempt expired without using credits.';
      const previousPhase = this.state.phase;
      try {
        localStorage.setItem(`${this.storageKey}:diagnostic:${this.state.key}`, JSON.stringify({
          key: this.state.key, phase: 'terminal', diagnostic, createdAt: this.state.createdAt, endedAt: Date.now(),
        }));
        this.state.phase = 'terminal';
        this.state.diagnostic = diagnostic;
        this.state.unused = true;
        this.save();
      } catch (storageError) {
        this.state.phase = previousPhase;
        delete this.state.diagnostic;
        delete this.state.unused;
        this.showRecoveryError(storageError, 'Allow this page to save its round before continuing.');
        return;
      }
      await this.restartUnusedRound();
      return;
    }
    this.showRecoveryError(error);
  }

  showRecoveryError(error, message = recoveryMessage(error)) {
    diag.add('recovery', { message, error: errorMessage(error), code: error?.code, status: error?.status });
    this.announce(message);
    this.clearActions();
    this.button('Continue', () => void this.recover());
    const details = element('details', undefined, 'error-details');
    details.append(element('summary', 'Error details'), element('p', errorMessage(error)));
    this.actionNode.append(details);
    this.view('recovery');
  }

  async restartUnusedRound() {
    const previous = this.state;
    const accountKey = this.storageKey;
    this.clearActions();
    this.announce('Starting your game…');
    try {
      const terms = await this.game.getTerms();
      if (this.storageKey !== accountKey || this.state !== previous) return;
      if (terms.credits !== previous.request.expectedCredits) {
        this.announce(`The price changed to ${terms.credits} credits. Click Play to approve the new cost.`);
        this.button(`Play · ${terms.credits} credit${terms.credits === 1 ? '' : 's'}`, () => void this.prepareRound(terms.credits));
        this.button('Cancel', () => void this.refresh());
        this.view('recovery');
        return;
      }
      const key = await unusedReplacementKey(previous.key, terms.credits);
      if (this.storageKey !== accountKey || this.state !== previous) return;
      await this.confirmRound(terms, key);
    } catch (error) {
      if (this.storageKey === accountKey && this.state === previous) this.showRecoveryError(error);
    }
  }

  async recover() {
    if (!this.state || !this.storageKey) return;
    const accountKey = this.storageKey;
    const previous = this.state;
    this.clearActions();
    this.announce('Starting your game…');
    this.view('busy');
    try {
      if (!this.game.getAuthorization()) await this.game.connect();
      if (this.storageKey !== accountKey || this.state !== previous) return;
      if (this.accountStorageKey() !== accountKey) {
        this.showRecoveryError(new Error('The current wallet does not own this saved play.'),
          'Switch back to the wallet that owns this saved play, then continue.');
        return;
      }
      if (previous.memoryOnlyConsent) {
        const { recovery } = await this.game.requestConsent(previous.request);
        if (this.storageKey !== accountKey || this.state !== previous || this.accountStorageKey() !== accountKey) return;
        if (recovery !== 'persistent') {
          this.showRecoveryError(new Error('Consent recovery is still memory-only.'),
            'Keep this page open and restore browser storage before continuing. No paid start was sent.');
          return;
        }
        delete previous.memoryOnlyConsent;
        this.save();
      }
      if (previous.session) {
        if (previous.result) await this.submitAndComplete();
        else await this.beginPlay();
        return;
      }
      const session = await this.game.recoverStart({ idempotencyKey: previous.key });
      if (this.storageKey !== accountKey || this.state !== previous) return;
      this.acceptSession(session);
      await this.beginPlay();
    } catch (error) {
      if (this.storageKey !== accountKey || this.state !== previous) return;
      if (error?.status === 410) {
        this.markExpired(errorMessage(error));
        return;
      }
      await this.handleAttemptError(error);
    }
  }

  markExpired(diagnostic = 'The saved PlaySession has expired.') {
    diag.add('expired', { diagnostic });
    this.disconnectRun();
    try {
      localStorage.setItem(`${this.storageKey}:diagnostic:${this.state.key}`, JSON.stringify({
        key: this.state.key,
        phase: 'terminal',
        diagnostic,
        createdAt: this.state.createdAt,
        endedAt: Date.now(),
      }));
    } catch { /* Keep the active record when diagnostic storage is unavailable. */ }
    this.stage.setMessage(diagnostic);
    this.state.phase = 'terminal';
    this.state.diagnostic = diagnostic;
    try { this.save(); } catch { /* Do not imply a refund or create another start automatically. */ }
    this.announce(`${diagnostic} Any credits already used remain charged; no refund is initiated, and this old round cannot be replayed. You may explicitly start a new round.`);
    this.clearActions();
    void this.showPlayAction();
  }

  disconnectRun() {
    clearInterval(this.timer);
    clearTimeout(this.connectTimer);
    this.timer = null;
    this.connectTimer = null;
    this.runConnecting = false;
    this.receivedSnapshot = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
  }

  async beginPlay() {
    if (!this.state?.session || !this.storageKey || this.runConnecting || this.socket) return;
    if (this.accountStorageKey() !== this.storageKey) {
      this.showRecoveryError(new Error('Wallet changed.'), 'Switch back to the wallet that owns this saved play, then continue.');
      return;
    }
    const attempt = this.state;
    const accountKey = this.storageKey;
    this.runConnecting = true;
    this.clearActions();
    this.announce('Connecting to the platform’s server-validated game…');
    this.view('busy');
    try {
      if (!attempt.run) throw new Error('The saved paid round is missing its original server-run identity.');
      attempt.phase = 'run_pending';
      this.save();
      diag.add('run-req', { eventId: attempt.run.eventId, recovering: Boolean(attempt.run.runId) });
      const response = await this.scoringGame.startServerValidatedRun({
        sessionToken: attempt.session.token,
        eventId: attempt.run.eventId,
        idempotencyKey: attempt.run.key,
      });
      if (this.state !== attempt || this.storageKey !== accountKey) return;
      const run = response.run;
      diag.add('run', { runId: run.runId, eventId: run.eventId, engine: run.engine, configDigest: run.configDigest, startedAt: run.startedAt, expiresAt: run.expiresAt, state: this.summary(run.state) });
      if (run.eventId !== attempt.run.eventId || run.engine !== 'custom' || run.engineVersion !== 'custom-v1'
        || (attempt.run.runId && run.runId !== attempt.run.runId)
        || (attempt.run.configDigest && run.configDigest !== attempt.run.configDigest)) {
        throw new Error('The platform returned a different run or verifier for this paid play.');
      }
      const initialView = this.adapter.stateSchema.parse(run.state);
      if (initialView.rules.game !== this.variant) throw new Error('The server verifier does not match this game variant.');
      const socketUrl = new URL(run.webSocketUrl);
      const expectedProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (socketUrl.protocol !== expectedProtocol || socketUrl.host !== location.host
        || socketUrl.pathname !== `/api/v1/server-game-runs/${run.runId}/connect`) {
        throw new Error('The platform game socket must belong to this hosted game origin.');
      }
      attempt.run = {
        ...attempt.run, runId: run.runId, configDigest: run.configDigest,
        startedAt: run.startedAt, expiresAt: run.expiresAt, view: initialView,
        pendingInputs: attempt.run.pendingInputs.map((input) => ({ ...input, sent: false })),
      };
      attempt.phase = 'connecting';
      this.save();
      this.predictedView = initialView;
      this.lastSentTick = -1;
      this.receivedSnapshot = false;
      const socket = new WebSocket(socketUrl);
      this.socket = socket;
      diag.add('socket', { connecting: socketUrl.pathname });
      socket.addEventListener('open', () => diag.add('socket', { open: true, estTick: this.estimatedServerTick() }));
      const ownsSocket = () => this.socket === socket && this.state === attempt
        && this.storageKey === accountKey && this.accountStorageKey() === accountKey;
      this.connectTimer = setTimeout(() => {
        if (ownsSocket()) this.showRunError(new Error('The platform game socket did not return its initial state.'));
      }, 12000);
      socket.addEventListener('message', (event) => {
        if (!ownsSocket()) return;
        this.logPacket(event.data);
        try {
          this.acceptSnapshot(this.adapter.snapshotSchema.parse(JSON.parse(event.data)));
        } catch (error) {
          this.showRunError(error);
        }
      });
      socket.addEventListener('error', () => {
        diag.add('socket', { error: true });
        if (ownsSocket()) this.showRunError(new Error('The platform game socket could not connect.'));
      });
      socket.addEventListener('close', (event) => {
        diag.add('socket', { close: event.code, reason: event.reason, hadResult: Boolean(attempt.result) });
        if (ownsSocket() && !attempt.result) this.showRunError(new Error('The platform game socket was interrupted.'));
      });
      this.timer = setInterval(() => {
        if (ownsSocket() && this.receivedSnapshot && !attempt.result) {
          this.flushInputs();
          this.renderRun();
        }
      }, 25);
    } catch (error) {
      if (this.state !== attempt || this.storageKey !== accountKey) return;
      this.runConnecting = false;
      diag.add('run-err', { message: errorMessage(error), status: error?.status, code: error?.code });
      if (error?.status === 410 || error?.code === 'RUN_EXPIRED') this.markExpired('The platform reports this paid run has expired.');
      else this.showRunError(error);
    }
  }

  /** Diagnostics: every packet from the game socket, folded when nothing but the server tick changed. */
  logPacket(raw) {
    if (!diag.enabled) return;
    let packet;
    try { packet = JSON.parse(raw); } catch { diag.add('recv-bad', { raw: String(raw).slice(0, 300) }); return; }
    const estTick = this.state?.run ? this.estimatedServerTick() : null;
    if (packet.error) { diag.add('recv-err', { error: packet.error, serverTick: packet.serverTick, estTick, pending: this.state?.run?.pendingInputs?.map((i) => i.seq) }); return; }
    const state = this.summary(packet.state);
    const { tick: _tick, ...unchanged } = state ?? {};          // folded while only the clock moves
    const key = JSON.stringify([packet.inputSeq, packet.inputTick, unchanged, packet.result]);
    diag.add('recv', { serverTick: packet.serverTick, estTick, inputSeq: packet.inputSeq, inputTick: packet.inputTick, state, result: packet.result ?? null, expiresAt: packet.expiresAt }, 'recv:' + key);
  }

  estimatedServerTick() {
    return Math.max(0, this.state.run.serverTick) + Math.floor((performance.now() - this.lastPacketAt) / TICK_MILLISECONDS);
  }

  acceptSnapshot(packet) {
    if ('error' in packet) {
      if (['INPUT_RATE_LIMITED', 'RUN_CATCHING_UP', 'INPUT_OUT_OF_ORDER'].includes(packet.error)) {
        this.state.run.pendingInputs = this.state.run.pendingInputs.map((input) => ({ ...input, sent: false }));
        this.lastSentTick = Math.max(this.state.run.inputTick, packet.serverTick ?? this.estimatedServerTick());
        this.save();
        return;
      }
      if (packet.error === 'RUN_FINISHED') {
        this.stage.hideRun();
        this.announce('Waiting for the platform’s recorded result…');
        return;
      }
      throw new Error(`Platform game: ${packet.error}`);
    }
    const run = this.state.run;
    if (packet.runId !== run.runId || packet.configDigest !== run.configDigest) {
      throw new Error('The platform snapshot belongs to a different run or verifier.');
    }
    if (packet.state.rules.game !== this.variant) throw new Error('The platform snapshot belongs to another game variant.');
    if (packet.serverTick < run.serverTick || packet.inputSeq < run.inputSeq) return;
    if (packet.result?.runId && packet.result.runId !== run.runId) {
      throw new Error('The platform result belongs to a different run.');
    }
    this.receivedSnapshot = true;
    this.runConnecting = false;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.lastPacketAt = performance.now();
    this.state.run = {
      ...run, view: packet.state, serverTick: packet.serverTick,
      inputSeq: packet.inputSeq, inputTick: packet.inputTick,
      pendingInputs: run.pendingInputs.filter((input) => input.seq > packet.inputSeq),
    };
    if (packet.result?.status === 'expired') {
      this.markExpired('The platform reports this paid run has expired.');
      return;
    }
    if (packet.result && 'score' in packet.result) {
      diag.add('result', { result: packet.result, serverTick: packet.serverTick, final: this.summary(packet.state) });
      this.state.result = packet.result;
      this.state.score = packet.result.score;
      this.state.phase = 'finalizing';
      this.save();
      this.disconnectRun();
      this.stage.setMessage(`Server-verified score: ${packet.result.score}. Completing this paid round…`, { final: packet.result.score, view: packet.state });
      this.view('busy');
      void this.submitAndComplete();
      return;
    }
    this.state.phase = packet.state.gameOver ? 'finalizing' : 'playing';
    this.save();
    if (!packet.state.started && !packet.state.gameOver
      && !this.state.run.pendingInputs.some(({ input }) => input.action === 'start')) {
      this.queueInput({ action: 'start' });
    } else {
      this.reconcilePrediction();
      this.flushInputs();
      this.renderRun();
    }
  }

  reconcilePrediction() {
    let predicted = this.state.run.view;
    for (const pending of this.state.run.pendingInputs) {
      // Prediction only: apply each queued input where the player made it (the server applies it a little later, on
      // its own tick, and its snapshot replaces this guess as soon as it arrives).
      predicted = this.adapter.applyInput(predicted, pending.input, Math.max(predicted.tick, this.state.run.serverTick, pending.tick ?? 0));
    }
    this.predictedView = predicted;
  }

  queueInput(input) {
    if (!this.receivedSnapshot || !this.socket || this.state.run.pendingInputs.length >= MAX_PENDING_INPUTS) return;
    const run = this.state.run;
    const last = run.pendingInputs.at(-1);
    const seq = (last?.seq ?? run.inputSeq) + 1;
    this.state.run.pendingInputs = [...run.pendingInputs, { seq, input, sent: false, tick: this.estimatedServerTick() }];
    diag.add('queue', { seq, input, estTick: this.estimatedServerTick(), serverTick: run.serverTick, inputSeq: run.inputSeq, inputTick: run.inputTick, pending: this.state.run.pendingInputs.length });
    this.save();
    this.reconcilePrediction();
    this.flushInputs();
    this.renderRun();
  }

  flushInputs() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.receivedSnapshot || this.state.result) return;
    const tick = this.estimatedServerTick();
    if (tick <= Math.max(this.lastSentTick, this.state.run.inputTick)) {
      const waiting = this.state.run.pendingInputs.find((input) => !input.sent);
      if (waiting) diag.add('wait', { seq: waiting.seq, estTick: tick, lastSentTick: this.lastSentTick, inputTick: this.state.run.inputTick }, 'wait:' + waiting.seq);
      return;
    }
    const next = this.state.run.pendingInputs.find((input) => !input.sent);
    if (!next) return;
    try {
      diag.add('send', { seq: next.seq, input: next.input, estTick: tick, queuedAt: next.tick, lastSentTick: this.lastSentTick, inputTick: this.state.run.inputTick, serverTick: this.state.run.serverTick });
      this.socket.send(JSON.stringify({ type: 'input', seq: next.seq, input: next.input }));
      this.state.run.pendingInputs = this.state.run.pendingInputs.map((input) => input.seq === next.seq ? { ...input, sent: true, tick } : input);
      this.lastSentTick = tick;
    } catch (error) {
      this.showRunError(error);
    }
  }

  canInput() {
    return this.state?.phase === 'playing' && Boolean(this.predictedView?.started) && !this.predictedView.gameOver
      && (this.state.run?.pendingInputs.length ?? MAX_PENDING_INPUTS) < MAX_PENDING_INPUTS;
  }

  /** An ordered input from the stage (a shot, an answer). Only ever a game action: never a score, time or state. */
  userInput(input) {
    if (!this.canInput()) {
      diag.add('refused', { input, phase: this.state?.phase, started: this.predictedView?.started, gameOver: this.predictedView?.gameOver, pending: this.state?.run?.pendingInputs?.length });
      return;
    }
    try {
      this.queueInput(input);
    } catch (error) {
      this.showRunError(error);
    }
  }

  renderRun() {
    const view = this.predictedView;
    if (!view) return;
    const tick = this.estimatedServerTick();
    const pending = this.state.run.pendingInputs.length;
    this.stage.showRun(view, { tick, pending, serverTick: this.state.run.serverTick, practice: false });
    this.scoreNode.textContent = `Score: ${this.adapter.scoreOf(view)}${pending ? ' (pending server confirmation)' : ''}`;
    this.announce(this.adapter.statusLine(view, tick));
    this.clearActions();
    this.view(view.gameOver ? 'busy' : 'playing');
  }

  showRunError(error) {
    diag.add('run-err', { message: errorMessage(error) });
    this.disconnectRun();
    this.stage.setMessage('Continue reconnects this same paid round; its server clock does not restart.');
    this.showRecoveryError(error, 'Game connection interrupted. Continue recovers this same paid round without using another credit.');
  }

  async submitAndComplete() {
    if (!this.state?.result || this.completing) return;
    const attempt = this.state;
    const accountKey = this.storageKey;
    this.completing = true;
    this.clearActions();
    this.announce(`The platform recorded verified score ${attempt.result.score}. Completing this round…`);
    try {
      this.save();
      if (!attempt.completed) {
        await this.game.complete({ sessionId: attempt.session.id, sessionToken: attempt.session.token });
        diag.add('complete', { ok: true, score: attempt.result.score });
        if (this.state !== attempt || this.storageKey !== accountKey) return;
        attempt.completed = true;
      }
      attempt.phase = 'completed';
      this.save();
      this.scoreNode.textContent = `Verified score: ${attempt.result.score}`;
      this.stage.setMessage(`Round complete. Server-verified score: ${attempt.result.score}.`, { final: attempt.result.score, view: attempt.run?.view });
      this.announce(`Round complete. Server-verified score: ${attempt.result.score}.`);
      await this.getBalance();
      this.view('finished', { score: Number(attempt.result.score) });
      await this.showPlayAction();
    } catch (error) {
      if (this.state === attempt && this.storageKey === accountKey) {
        this.showRecoveryError(error, `The platform already recorded score ${attempt.result.score}. Continue only retries this round’s completion.`);
      }
    } finally {
      this.completing = false;
    }
  }
}

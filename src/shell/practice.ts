// PRACTICE: the game's own rules run in this browser. No sign-in, no server run, no credit, no score sent anywhere
// (not to SuperRare, not to the NFC Survivor feed). The stage is the same one a paid round uses; only the clock and
// the inputs stay local. A practice score is never shown as a verified score.
import type { GameAdapter, Stage } from './adapter.js';

const TICK_MS = 50;

export class Practice {
  private state: any = null;
  private t0 = 0;
  private timer: number | undefined;
  private running = false;

  constructor(private adapter: GameAdapter, private stage: Stage, private onEnd: (score: number) => void) {}

  get available(): boolean { return Boolean(this.adapter.practice); }
  get active(): boolean { return this.running; }

  start(): void {
    const rules = this.adapter.practice;
    if (!rules) return;
    this.stop();
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] as number;
    this.t0 = performance.now();
    this.state = this.adapter.applyInput(rules.createRun(seed), { action: 'start' }, 0);
    this.running = true;
    this.show();
    // Advance the authoritative local copy a few times a second (the stage animates in between, like between snapshots).
    this.timer = window.setInterval(() => this.step(), 200);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
  }

  tick(): number { return Math.floor((performance.now() - this.t0) / TICK_MS); }

  canInput(): boolean { return this.running && this.state?.started && !this.state.gameOver; }

  input(input: Record<string, unknown>): void {
    if (!this.canInput()) return;
    this.state = this.adapter.applyInput(this.state, input, Math.max(this.state.tick, this.tick()));
    this.show();
  }

  private step(): void {
    const rules = this.adapter.practice;
    if (!this.running || !rules) return;
    const next = rules.advance(this.state, Math.max(this.state.tick, this.tick()));
    if (next !== this.state) { this.state = next; this.show(); }
    if (this.state.gameOver) {
      const score = this.adapter.scoreOf(this.state);
      this.stop();
      this.stage.setMessage(`Practice score: ${score}. Practice scores don't count.`, { final: score, view: this.state, practice: true });
      this.onEnd(score);
    }
  }

  private show(): void {
    const tick = Math.max(this.state.tick, this.tick());
    this.stage.showRun(this.state, { tick, pending: 0, serverTick: this.state.tick, practice: true });
  }
}

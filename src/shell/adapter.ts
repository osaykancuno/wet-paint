import type * as z from 'zod/mini';

/** What PaidRound (the paid-start / server-run state machine) needs from one game. */
export interface GameAdapter {
  /** Matches the public config's `game` and the state's `rules.game`. */
  id: 'wet-paint';
  /** Page and arena label. */
  title: string;
  /** Section heading above the game card. */
  heading: string;
  /** Explainer of the rules (a few sentences). */
  lede: string;
  /** One line for the entry overlay; falls back to `lede`. */
  tagline?: string;
  /** The verifier's own validation of a run state / of the coordinator's socket packets. */
  stateSchema: z.ZodMiniType;
  snapshotSchema: z.ZodMiniType;
  parseSavedRound(value: unknown): Record<string, unknown>;
  /** Pure rules, the same module the verifier runs: used only to predict the display between server snapshots. */
  applyInput(state: any, input: unknown, tick: number): any;
  scoreOf(state: any): number;
  statusLine(state: any, tick: number): string;
  createStage(host: HTMLElement, io: StageIO): Stage;
  /** Diagnostics only: a compact, JSON-friendly view of a state (no secret ever lives in a state). */
  diagSummary?(state: any): unknown;
  /**
   * Practice: the same rules run in the browser, with no server run, no credit and no score sent anywhere.
   * Absent for a game that offers no practice.
   */
  practice?: {
    createRun(seed: number): any;
    advance(state: any, tick: number): any;
  };
}

export interface StageIO {
  /** Queue an ordered game input; PaidRound drops it unless a paid round is running. */
  sendInput(input: Record<string, unknown>): void;
  canInput(): boolean;
  /** The platform tick the player is at right now, estimated from the last server snapshot. */
  estimatedTick(): number;
  pendingCount(): number;
  /** The signed-in wallet (lowercase), if any: cosmetic use only (a game may greet a holder of the wall). */
  playerAddress?(): string | undefined;
}

export interface RunInfo {
  tick: number;
  pending: number;
  serverTick: number;
  /** A practice run: nothing is recorded, and the stage must not report hits to the Survivor feed. */
  practice?: boolean;
}

export interface Stage {
  /**
   * Idle / waiting / finished: hide the running game and show this text. `extra.final` is the final score: the
   * official one, or a practice score when `extra.practice` is set. `extra.idle` clears a finished run off the screen.
   */
  setMessage(text: string, extra?: { final?: number; view?: unknown; practice?: boolean; idle?: boolean }): void;
  hideRun(): void;
  /** A round is running: `view` is the authoritative state with the player's unacknowledged inputs applied. */
  showRun(view: any, info: RunInfo): void;
  /**
   * Optional: the end-of-run figures the page computed (rank and best come from the server leaderboard, refreshed a
   * moment after the run), for a game that draws its own end screens. `player` is the best known public name of the
   * signed-in wallet (ENS from the leaderboard), if any.
   */
  endStats?(stats: EndStats): void;
}

export interface EndStats {
  score: number;
  practice: boolean;
  rank: string;
  best: string;
  bestLabel: string;
  player?: string;
}

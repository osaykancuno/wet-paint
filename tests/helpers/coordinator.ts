// A stand-in for Studio's coordinator, just enough to exercise a BUILT verifier module exactly as the platform would:
// JSON requests to POST /v1, ordered inputs (at most one per server tick), server-owned ticks, bounded payloads.
export type Verifier = { fetch(request: Request): Promise<Response> };

export class Coordinator<State = any> {
  state!: State;
  tick = 0;
  calls = 0;
  worstMs = 0;
  largestState = 0;
  constructor(private readonly verifier: Verifier, private readonly config: unknown, private readonly seed: number) {}

  async call(op: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const body = JSON.stringify({ version: 1, op, ...fields });
    const t0 = process.hrtime.bigint();
    const response = await this.verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    this.calls++; this.worstMs = Math.max(this.worstMs, ms);
    if (response.status !== 200) throw new Error(`${op}: HTTP ${response.status} ${await response.text()}`);
    const payload = await response.json() as { version: number; result: unknown };
    if (JSON.stringify(Object.keys(payload).sort()) !== '["result","version"]' || payload.version !== 1) throw new Error(`${op}: bad envelope`);
    return payload.result;
  }
  async create(): Promise<State> {
    this.state = await this.call('createRun', { seed: this.seed, config: this.config }) as State;
    this.record();
    return this.state;
  }
  private record(): void { this.largestState = Math.max(this.largestState, JSON.stringify(this.state).length); }
  async advanceTo(tick: number): Promise<State> {
    this.tick = Math.max(this.tick, tick);
    this.state = await this.call('advance', { state: this.state, serverTick: this.tick }) as State; this.record();
    return this.state;
  }
  /** One ordered input; the coordinator advances time first, then applies it on its own tick. */
  async input(input: unknown, atTick = this.tick + 1): Promise<State> {
    this.tick = Math.max(this.tick + 1, atTick);
    this.state = await this.call('applyInput', { state: this.state, input, serverTick: this.tick }) as State; this.record();
    return this.state;
  }
  isFinished = async (): Promise<boolean> => await this.call('isFinished', { state: this.state }) as boolean;
  score = async (): Promise<number> => await this.call('score', { state: this.state }) as number;
  view = async (): Promise<unknown> => this.call('view', { state: this.state });
}

export async function loadBuiltVerifier(source: Uint8Array | string): Promise<Verifier> {
  const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
  const module = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`) as { default: Verifier };
  return module.default;
}

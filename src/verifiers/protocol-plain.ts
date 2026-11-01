// The Worker request/response adapter of studio-games-example/src/server-verifier.ts (protocol version 1: the six operations, strict request
// envelopes, HTTP 400 for a malformed request, 404 for anything but POST /v1), with hand-written checks instead of a
// schema library: for a game whose engine validates its own state (WET PAINT), so the verifier module loads in a cold
// isolate without parsing a validation library first. tests/wet-paint.test.ts runs the rejection cases on the built module.
export interface PlainVerifierEngine<State> {
  /** Returns a clean copy of a well-formed state; throws on anything else. */
  checkState(value: unknown): State;
  createRun(seed: unknown, config: unknown): State;
  advance(state: State, serverTick: number): State;
  applyInput(state: State, input: unknown, serverTick: number): State;
  view(state: State): unknown;
  isFinished(state: State): boolean;
  score(state: State): number;
}

const ALLOWED: Record<string, readonly string[]> = {
  createRun: ['version', 'op', 'seed', 'config'],
  advance: ['version', 'op', 'state', 'serverTick'],
  applyInput: ['version', 'op', 'state', 'input', 'serverTick'],
  view: ['version', 'op', 'state'],
  isFinished: ['version', 'op', 'state'],
  score: ['version', 'op', 'state'],
};

export function makePlainVerifier<State>(engine: PlainVerifierEngine<State>): { fetch(request: Request): Promise<Response> } {
  function envelope(payload: unknown): Record<string, unknown> {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('Invalid verifier request');
    const body = payload as Record<string, unknown>;
    const allowed = typeof body.op === 'string' && Object.prototype.hasOwnProperty.call(ALLOWED, body.op) ? ALLOWED[body.op] as readonly string[] : null;
    if (!allowed) throw new Error('Unsupported operation');
    if (body.version !== 1) throw new Error('Unsupported protocol version');
    for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new Error(`Unexpected field: ${key}`);
    if (allowed.includes('serverTick') && !(Number.isSafeInteger(body.serverTick) && (body.serverTick as number) >= 0)) throw new Error('Invalid serverTick');
    return body;
  }
  async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1') return new Response('Not found', { status: 404 });
    try {
      const body = envelope(await request.json() as unknown);
      const state = (): State => engine.checkState(body.state);
      let result: unknown;
      switch (body.op) {
        case 'createRun': result = engine.createRun(body.seed, body.config); break;
        case 'advance': result = engine.advance(state(), body.serverTick as number); break;
        case 'applyInput': result = engine.applyInput(state(), body.input, body.serverTick as number); break;
        case 'view': result = engine.view(state()); break;
        case 'isFinished': result = engine.isFinished(state()); break;
        case 'score': result = engine.score(state()); break;
      }
      return Response.json({ version: 1, result });
    } catch (error: unknown) {
      return Response.json({ error: error instanceof Error ? error.message : 'Invalid verifier request' }, { status: 400 });
    }
  }
  return { fetch: handle };
}

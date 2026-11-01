// WET PAINT's verifier: the rules (core.ts) behind the protocol envelope, without a schema library, so a cold isolate
// starts fast. The names of the wall are the build-time snapshot (the verifier has no network).
import { checkState, createEngine } from '../games/wet-paint/core.js';
import { WALL_PANELS } from '../generated/wall.js';
import { makePlainVerifier } from './protocol-plain.js';

const engine = createEngine(WALL_PANELS);
export default makePlainVerifier({
  checkState,
  createRun: engine.createRun, advance: engine.advance, applyInput: engine.applyInput,
  view: engine.view, isFinished: engine.isFinished, score: engine.score,
});

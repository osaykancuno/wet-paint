// WET PAINT for the page: the rules (core.ts, the very module the verifier runs) plus the zod schemas the shared shell
// uses to parse the coordinator's snapshots and the saved paid round. The state and input schemas ARE core.ts's
// hand-written checks (checkState, parseInput), so the page accepts exactly what the verifier accepts.
import * as z from 'zod/mini';
import { WALL_PANELS } from '../../generated/wall.js';
import { checkState, createEngine, parseInput, type WpState } from './core.js';

export * from './core.js';

/** The one engine of the page, on the same snapshot of the wall as the verifier. */
export const engine = createEngine(WALL_PANELS);

const accepts = (check: (value: unknown) => unknown) => (value: unknown): boolean => { try { return check(value) !== null; } catch { return false; } };
export const stateSchema = z.custom<WpState>(accepts(checkState), 'Invalid WET PAINT state');
export const inputSchema = z.custom<Record<string, unknown>>(accepts(parseInput), 'Invalid WET PAINT input');

/* The coordinator's snapshot envelope (same shape as the other games'; only `state` differs). */
const nonNegInt = z.int().check(z.gte(0));
const finalScoreSchema = z.union([nonNegInt, z.pipe(z.pipe(z.string().check(z.regex(/^\d+$/)), z.transform(Number)), nonNegInt)]);
const finalResultSchema = z.looseObject({ runId: z.optional(z.uuid()), score: finalScoreSchema, status: z.optional(z.string()) });
const expiredResultSchema = z.looseObject({ runId: z.optional(z.uuid()), score: z.optional(z.never()), status: z.literal('expired') });
export const snapshotSchema = z.union([
  z.object({
    runId: z.uuid(), configDigest: z.string().check(z.regex(/^[0-9a-f]{64}$/i)),
    serverTick: nonNegInt, inputSeq: nonNegInt, inputTick: z.int().check(z.gte(-1)),
    expiresAt: z.string().check(z.refine((v) => Number.isFinite(Date.parse(v)), 'Invalid expiry')),
    state: stateSchema,
    result: z.nullable(z.union([finalResultSchema, expiredResultSchema])),
    status: z.optional(z.string()),
  }),
  z.object({ error: z.string(), serverTick: z.optional(nonNegInt) }),
]);

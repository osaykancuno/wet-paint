// The durable record of one paid play (consent, session, server-run identity, queued inputs), validated on load.
// Same shape as studio-games-example's savedRoundSchema; only the game's own state/input schemas are injected.
import * as z from 'zod/mini';

const tick = z.int().check(z.gte(0));
const positive = tick.check(z.gte(1));
const savedKey = z.string().check(z.regex(/^[A-Za-z0-9_-]+$/));
const savedDate = z.string().check(z.refine((value) => Number.isFinite(Date.parse(value)), 'Invalid date'));
const savedTick = z.int().check(z.gte(-1));
const finalScore = z.union([tick, z.pipe(z.pipe(z.string().check(z.regex(/^\d+$/)), z.transform(Number)), tick)]);
const finalResult = z.looseObject({ runId: z.optional(z.uuid()), score: finalScore, status: z.optional(z.string()) });

export function createSavedRoundParser(stateSchema: z.ZodMiniType, inputSchema: z.ZodMiniType): (value: unknown) => Record<string, unknown> {
  const savedRound = z.looseObject({
    version: z.literal(2),
    key: savedKey,
    phase: z.enum(['pending', 'ready', 'run_pending', 'connecting', 'playing', 'finalizing', 'submitting', 'completed', 'terminal']),
    score: z.optional(tick),
    session: z.optional(z.looseObject({ id: z.string().check(z.minLength(1)), token: z.string().check(z.minLength(1)), expiresAt: savedDate })),
    request: z.looseObject({
      idempotencyKey: z.string().check(z.minLength(1)),
      fingerprint: z.string().check(z.minLength(1)),
      expectedCredits: positive,
      metadata: z.optional(z.record(z.string(), z.unknown())),
    }),
    result: z.optional(finalResult),
    completed: z.optional(z.boolean()),
    run: z.optional(z.looseObject({
      eventId: z.uuid(),
      key: savedKey,
      runId: z.optional(z.uuid()),
      configDigest: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/i))),
      startedAt: z.optional(savedDate),
      expiresAt: z.optional(savedDate),
      view: z.optional(stateSchema),
      serverTick: savedTick,
      inputSeq: tick,
      inputTick: savedTick,
      pendingInputs: z.array(z.object({ seq: positive, input: inputSchema, sent: z.optional(z.boolean()), tick: z.optional(tick) })),
    })),
  });
  return (value) => savedRound.parse(value) as Record<string, unknown>;
}

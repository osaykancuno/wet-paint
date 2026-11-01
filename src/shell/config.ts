// Public per-game configuration (config.json at the root of every game archive). Identity and routing only: no
// treasury, key, token or secret ever belongs here -- payment terms come from Studio's authoritative quote.
// Adapted from studio-games-example/src/config.ts (MIT, Copyright 2026 SuperRare).
import { z } from 'zod';

const originSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
    && !url.hostname.endsWith('.invalid');
}, 'Use an exact HTTPS origin, not a placeholder, path, or credential-bearing URL');

const publicHttpsUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hostname.endsWith('.invalid');
}, 'Must be a public HTTPS URL');

export const GAME_IDS = ['wet-paint'] as const;
export type GameId = (typeof GAME_IDS)[number];

export const configurationSchema = z.object({
  appId: z.string().uuid(),
  groupId: z.string().uuid(),
  studioUrl: originSchema,
  apiUrl: originSchema,
  connectUrl: originSchema,
  appOrigin: originSchema,
  /** How SuperRare Connect's hosted sign-in and checkout open: a window over the page (embed) or a browser popup. */
  display: z.enum(['popup', 'embed']),
  game: z.enum(GAME_IDS),
  /** The arcade hub (the NFC arcade page), and optionally another game of the arcade to link to. */
  hubUrl: publicHttpsUrl.optional(),
  siblingUrl: publicHttpsUrl.optional(),
  siblingLabel: z.string().min(1).max(40).optional(),
  /** Diagnostic build: the page journals its game-socket traffic and offers COPY LOG on the end screen. */
  diagnostics: z.boolean().optional(),
}).strict();
export type Configuration = z.infer<typeof configurationSchema>;

/** Defined (true) only by scripts/dev-flow.ts: the fake-Connect page may then be opened from a phone on the LAN. */
declare const __DEV_ANY_ORIGIN__: boolean | undefined;

export function parseConfiguration(value: unknown, currentOrigin?: string): Configuration {
  const configuration = configurationSchema.parse(value);
  const devBuild = typeof __DEV_ANY_ORIGIN__ !== 'undefined' && __DEV_ANY_ORIGIN__ === true;
  const localDevelopment = currentOrigin !== undefined
    && (devBuild || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(currentOrigin));
  if (currentOrigin !== undefined && !localDevelopment && configuration.appOrigin !== currentOrigin) {
    throw new Error('This game is not running at its configured Studio-approved appOrigin.');
  }
  return configuration;
}

/**
 * The scoring configuration published with each deployment (scoring-config.json, pasted into the verifier version).
 * Ticks are the platform's 50 ms server ticks. A run lasts at most `roundTicks` after its explicit start and never
 * more than `maxTicks` after creation: WET PAINT 3 s of countdown and 90 s of painting (a run ends before when the three
 * drops of paint are lost), with 15 s of room to start.
 */
export function scoringConfiguration(game: GameId): { game: GameId; maxTicks: number; roundTicks: number } {
  return { game, maxTicks: 2160, roundTicks: 1860 };
}

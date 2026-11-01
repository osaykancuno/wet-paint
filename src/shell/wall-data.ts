// The wall's names, for display only. The build-time snapshot is shown immediately; the live /positions of the NFC
// backend (public, no key) refines it. Nothing here is score-relevant: the verifier only ever sees panel numbers.
import { WALL_PANELS } from '../generated/wall.js';

export const WALL_API = 'https://otw-arcade.netlify.app';
export type PanelInfo = { name: string; handle: string };

const panels = new Map<number, PanelInfo>(WALL_PANELS.map((panel) => [panel.p, { name: panel.n, handle: panel.h ?? '' }]));
const owners = new Map<number, string>();          // live only (the snapshot carries no wallet): panel -> owner, lowercase
let live = false;

export const nameOf = (position: number): string => panels.get(position)?.name ?? '';
export const infoOf = (position: number): PanelInfo => panels.get(position) ?? { name: '', handle: '' };
export const wallIsLive = (): boolean => live;
export const namedPanelCount = (): number => panels.size;
export const allNames = (): string[] => [...panels.values()].map((panel) => panel.name).filter(Boolean);
/** The panels a wallet holds on the wall, ascending (empty until the live data arrived). */
export const panelsOwnedBy = (address: string | undefined): number[] =>
  address ? [...owners].filter(([, owner]) => owner === address.toLowerCase()).map(([position]) => position).sort((a, b) => a - b) : [];

type Item = { position?: number; tier?: string; idx?: number; minted?: boolean; name?: string; xHandle?: string; owner?: string };
export async function refreshWall(timeoutMs = 7000): Promise<boolean> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await fetch(`${WALL_API}/positions`, { signal: controller?.signal });
    if (!response.ok) return false;
    const raw = await response.json() as Item[] | { positions?: Item[] };
    const items = Array.isArray(raw) ? raw : (raw.positions ?? []);
    let seen = 0;
    for (const item of items) {
      if (!item.minted || (item.tier !== 'name' && item.tier !== 'pfp') || typeof item.idx !== 'number' || !item.name) continue;
      const position = item.tier === 'pfp' ? 501 + item.idx : item.idx + 1;
      panels.set(position, { name: item.name, handle: (item.xHandle ?? '').replace(/^@/, '') });
      if (typeof item.owner === 'string' && /^0x[0-9a-fA-F]{40}$/.test(item.owner)) owners.set(position, item.owner.toLowerCase());
      seen++;
    }
    live = seen > 0;
    return live;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

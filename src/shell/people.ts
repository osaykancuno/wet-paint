// The people of the wall in the games: the card service's people.json (one object per named panel, its walking sprite
// or null), read once per page, display only. Names match as on the card service (no case, spaces or accents); a sheet
// is loaded on first use (CORS *, so it can be drawn on a canvas) and `onPeople` is told when it arrives. The Sprite
// Party capture link is never in the page: at the click, the page sends its Connect session to the card service (POST
// /people/capture), which checks it with SuperRare and answers a link signed for that wallet's name (2 minutes to open it).
import { CARD_SERVICE } from '../share/post.js';
import { nameKey, type SpriteSheet } from '../share/sprite.js';

export type Person = { panel: number; name: string; wallet?: string; sprite: { url: string } | null };
const SHEET_URL = /^https:\/\/wall-arcade-cards\.netlify\.app\/people\/sprites\/[0-9a-f-]{36}\.png$/;

let people: Person[] = [];
let byName = new Map<string, Person>();
let loading: Promise<Person[]> | null = null;
const sheets = new Map<string, HTMLImageElement>();
const listeners: (() => void)[] = [];

function valid(p: unknown): p is Person {
  const o = p as Person | null;
  return Boolean(o && typeof o.name === 'string' && typeof o.panel === 'number'
    && (o.sprite === null || (typeof o.sprite?.url === 'string' && SHEET_URL.test(o.sprite.url))));
}
/** people.json, once per page (again after a failure). */
export function loadPeople(): Promise<Person[]> {
  loading ??= fetch(`${CARD_SERVICE}/people.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((list: unknown) => {
      people = Array.isArray(list) ? list.filter(valid) : [];
      byName = new Map(people.map((p) => [nameKey(p.name), p]));
      for (const f of listeners) f();
      return people;
    }, () => { loading = null; return []; });
  return loading;
}
/** The panels a wallet holds, as people.json has them (empty before it is read). */
export const peopleOf = (wallet: string | undefined): Person[] => (wallet ? people.filter((p) => p.wallet === wallet.toLowerCase()) : []);
/** A holder of a name of the wall whose names have no character yet: their first name, else null. */
export function missingCharacter(wallet: string | undefined): string | null {
  const mine = peopleOf(wallet);
  return mine.length && !mine.some((p) => p.sprite) ? (mine[0] as Person).name : null;
}
const CAPTURE = /^https:\/\/www\.spriteparty\.com\/p\/[A-Za-z0-9_-]+\/capture#handoff=[\w-]+\.[\w-]+\.[\w-]+$/;
/**
 * Opens Sprite Party's capture for the signed-in holder of a name: a window in the instant of the click (no popup
 * blocker), sent to the link once the card service has signed it; every click asks for a new token. Null when it opened,
 * else the line to show.
 */
export async function openCapture(accessToken: () => Promise<string>): Promise<string | null> {
  const win = window.open('', '_blank');
  try {
    const response = await fetch(`${CARD_SERVICE}/people/capture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: await accessToken() }) });
    const data = await response.json().catch(() => ({})) as { url?: unknown };
    if (!response.ok || typeof data.url !== 'string' || !CAPTURE.test(data.url)) {
      win?.close();
      return response.status === 401 ? 'Sign in again: your SuperRare session is not valid any more.' : 'Sprite Party could not be opened. Try again.';
    }
    if (win && !win.closed) { win.opener = null; win.location.href = data.url; } else window.location.href = data.url;
    return null;
  } catch {
    win?.close();
    return 'Sprite Party could not be opened. Try again.';
  }
}
/** Called when people.json or a sheet arrives (a game redraws). */
export const onPeople = (f: () => void): void => { listeners.push(f); };

function sheet(url: string): SpriteSheet | null {
  let img = sheets.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => { for (const f of listeners) f(); };
    img.src = url;
    sheets.set(url, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}
/** The sprite sheet of a name of the wall, once loaded; null if it has none (or not yet). */
export function sheetOfName(name: string): SpriteSheet | null {
  const url = byName.get(nameKey(name))?.sprite?.url;
  return url ? sheet(url) : null;
}
/** The sprite sheet of a wallet's first name that has one, once loaded. */
export function sheetOfWallet(wallet: string | undefined): SpriteSheet | null {
  const url = peopleOf(wallet).find((p) => p.sprite)?.sprite?.url;
  return url ? sheet(url) : null;
}

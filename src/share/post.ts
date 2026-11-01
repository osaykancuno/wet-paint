// POST ON X: one button, one ready tweet. The card is created by the arcade's card service (a Netlify function on its
// own site): it renders the image server-side and answers a link, /r/<id>, whose preview in X is the card and which
// sends people on to the game. The button is a plain link to x.com/intent/post (the X app on a phone), filled in
// as soon as the card exists, so the tap itself opens X: no share sheet, no download, no copy.
import { beacon } from './beacon.js';

export const CARD_SERVICE = 'https://wall-arcade-cards.netlify.app';

export type RowCardRequest = { kind: 'row'; names: string[]; line?: string; score: number; grid?: number[]; rank?: number; player?: string; practice?: boolean };
export type BounceCardRequest = { kind: 'bounce'; names: string[]; people: number; score: number; rank?: number; player?: string; practice?: boolean };
export type BoardCardRequest = { kind: 'board'; game: 'full-row' | 'unbreakable'; me?: string };
export type CardRequest = RowCardRequest | BounceCardRequest | BoardCardRequest;

/** Creates (or finds) the card; resolves its link. */
export async function createCard(body: CardRequest, timeoutMs = 8000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${CARD_SERVICE}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`card service: HTTP ${response.status}`);
    const { url } = await response.json() as { url?: string };
    if (typeof url !== 'string' || !url.startsWith(`${CARD_SERVICE}/r/`)) throw new Error('card service: no link');
    return url;
  } finally {
    clearTimeout(timer);
  }
}

export const intentHref = (text: string): string => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

/** X counts every link as 23 characters. */
const weighted = (text: string, link: string): number => text.replace(link, '').length + 23;
/**
 * The tweet `before(names) + link`, at most 280 characters as X counts them: names are dropped from the end (with " …")
 * until it fits. Repeated handles are written once.
 */
export function fitTweet(names: string[], build: (names: string, more: boolean) => string, link: string): string {
  const unique = [...new Set(names)];
  for (let n = unique.length; n >= 0; n--) {
    const text = build(unique.slice(0, n).join(' · '), n < unique.length);
    if (weighted(text, link) <= 280) return text;
  }
  return build('', true);
}
/** "@handle" when the panel has one, else the name as painted on the wall. */
export const tag = (name: string, handle: string): string => (handle ? `@${handle}` : name.toUpperCase());

/**
 * Turns an <a> into the POST ON X button: disabled while the card is made, then a link to the X composer with the text
 * and the card's link. If the card service cannot be reached, the tweet links to the game instead.
 */
export function wirePostLink(anchor: HTMLAnchorElement, card: CardRequest, textFor: (link: string) => string, fallbackLink: string, label: string, preparing = 'Preparing the card…'): void {
  anchor.target = '_blank'; anchor.rel = 'noopener';
  anchor.setAttribute('aria-disabled', 'true'); anchor.classList.add('is-preparing'); anchor.removeAttribute('href');
  anchor.textContent = preparing;
  let cardId = '';
  anchor.addEventListener('click', () => { if (anchor.getAttribute('aria-disabled') !== 'true') beacon('post_on_x', cardId ? { cardId } : {}); });
  const ready = (link: string): void => {
    cardId = /\/r\/([A-Za-z0-9_-]{16})$/.exec(link)?.[1] ?? '';
    anchor.href = intentHref(textFor(link));
    anchor.removeAttribute('aria-disabled'); anchor.classList.remove('is-preparing');
    anchor.textContent = label;
  };
  createCard(card).then(ready, () => ready(fallbackLink));
}

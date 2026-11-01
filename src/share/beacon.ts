// The arcade's own tags, for /stats on the arcade's card service: fire and forget. navigator.sendBeacon
// (text/plain, no preflight, still sent while the page closes), fetch keepalive otherwise; an error is ignored, nothing
// waits for it, and nothing here touches a run or a score. No cookie, no device id: the signed-in wallet, if any.
import { CARD_SERVICE } from './post.js';

type Fields = { wallet?: string | undefined; practice?: boolean; score?: number; cardId?: string; extra?: Record<string, string | number | boolean> };
let context: { game?: string; wallet?: () => string | undefined } = {};

/** The game and the signed-in wallet every tag of this page carries. */
export function setBeaconContext(next: typeof context): void { context = next; }

export function beacon(event: string, fields: Fields = {}): void {
  try {
    const wallet = fields.wallet ?? context.wallet?.();
    const body = JSON.stringify({
      event, ...(context.game ? { game: context.game } : {}), ...(wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet) ? { wallet } : {}),
      ...(fields.practice !== undefined ? { practice: fields.practice } : {}), ...(fields.score !== undefined ? { score: fields.score } : {}),
      ...(fields.cardId ? { cardId: fields.cardId } : {}), ...(fields.extra ? { extra: fields.extra } : {}),
    });
    const url = `${CARD_SERVICE}/api/events`;
    if (!navigator.sendBeacon?.(url, body)) void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
  } catch { /* stats only */ }
}

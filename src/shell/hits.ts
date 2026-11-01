// The only thing these games still send to the NFC backend: which minted names players hit (the weekly Survivor).
// Best effort, batched, never blocks play, silent on failure. Not part of the official (server-verified) score.
import { WALL_API } from './wall-data.js';

export const keyOfPosition = (position: number): string | null =>
  position <= 0 ? null : (position <= 500 ? `name-${position - 1}` : `pfp-${position - 501}`);

function isLocalHost(host: string): boolean {
  return host === '' || host === 'localhost' || /\.localhost$/.test(host) || /^127\./.test(host) || /^192\.168\./.test(host)
    || /^10\./.test(host) || host === '::1' || host === '[::1]' || host === '0.0.0.0';
}

export class HitFeed {
  private buffer: Record<string, number> = {};
  private failures = 0;
  private readonly enabled: boolean;
  constructor(private readonly game: string, enabled?: boolean) {
    this.enabled = enabled ?? (!isLocalHost(location.hostname) && location.protocol !== 'file:' && !/-dev$/.test(game));
  }
  add(position: number): void {
    const key = keyOfPosition(position);
    if (key) this.buffer[key] = (this.buffer[key] ?? 0) + 1;
  }
  flush(): void {
    const hits = this.buffer;
    this.buffer = {};
    if (!this.enabled || this.failures >= 2 || Object.keys(hits).length === 0) return;
    fetch(`${WALL_API}/hits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: this.game, hits }), keepalive: true,
    }).then((response) => { if (!response.ok) this.failures++; }).catch(() => { this.failures++; });
  }
}

// Diagnostics (only when config.json says `"diagnostics": true`): a bounded journal of everything the page sends to and
// receives from the platform's game socket, with the client's and the server's ticks, so one real run can be replayed
// on paper. Never contains a credential: tokens and keys are not logged (only run ids, ticks, inputs and game state).
type Entry = { ms: number; kind: string; data: unknown };
const MAX_ENTRIES = 4000;
const STORAGE_KEY = 'wall-arcade:diagnostics';

class DiagnosticLog {
  enabled = false;
  entries: Entry[] = [];
  private t0 = performance.now();
  private last: { key: string; entry: Entry; repeats: number } | null = null;
  private saveTimer: number | undefined;

  enable(context: Record<string, unknown>): void {
    this.enabled = true;
    this.add('page', { ...context, ua: navigator.userAgent, at: new Date().toISOString(), asset: document.querySelector<HTMLScriptElement>('script[type=module]')?.src.split('/').pop() });
  }

  /** `dedupeKey`: consecutive entries with the same key are folded into one with a repeat count and the last data. */
  add(kind: string, data: unknown, dedupeKey?: string): void {
    if (!this.enabled) return;
    const ms = Math.round(performance.now() - this.t0);
    if (dedupeKey && this.last && this.last.key === dedupeKey) {
      this.last.repeats++;
      this.last.entry.data = { ...(data as object), repeats: this.last.repeats, firstMs: (this.last.entry.data as { firstMs?: number }).firstMs ?? this.last.entry.ms };
      this.last.entry.ms = ms;
      this.schedule();
      return;
    }
    const entry = { ms, kind, data };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(1, this.entries.length - MAX_ENTRIES);   // keep the page header
    this.last = dedupeKey ? { key: dedupeKey, entry, repeats: 1 } : null;
    this.schedule();
  }

  text(): string {
    return this.entries.map((e) => `${String(e.ms).padStart(7)} ${e.kind.padEnd(10)} ${JSON.stringify(e.data)}`).join('\n');
  }

  /** The journal of the previous page load, if the page was reloaded mid-run. */
  previous(): string {
    try { return localStorage.getItem(STORAGE_KEY + ':previous') ?? ''; } catch { return ''; }
  }

  rotate(): void {
    try { const old = localStorage.getItem(STORAGE_KEY); if (old) localStorage.setItem(STORAGE_KEY + ':previous', old); } catch { /* storage unavailable */ }
  }

  private schedule(): void {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      try { localStorage.setItem(STORAGE_KEY, this.text().slice(-1_500_000)); } catch { /* storage full or unavailable */ }
    }, 1500);
  }
}

export const diag = new DiagnosticLog();

/** Copies text to the clipboard; falls back to a selected textarea the player can copy by hand. */
export async function copyText(text: string, fallbackHost: HTMLElement): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* clipboard refused: show it */ }
  const area = document.createElement('textarea');
  area.className = 'diag-text';
  area.readOnly = true;
  area.value = text;
  fallbackHost.append(area);
  area.focus();
  area.select();
  try { return document.execCommand('copy'); } catch { return false; }
}

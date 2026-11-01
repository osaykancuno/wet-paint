// Fetches the public wall data from the NFC backend and writes the named-panel snapshot that both the browser
// bundle (fallback names) and the server verifier (eligible positions: it has no network) are built from.
import { writeFile } from 'node:fs/promises';

const SOURCE = 'https://otw-arcade.netlify.app/positions';
type Item = { position: number; tier: string; idx: number; minted: boolean; name?: string; xHandle?: string };

const response = await fetch(SOURCE, { headers: { 'User-Agent': 'wall-arcade-connect-snapshot' } });
if (!response.ok) throw new Error(`${SOURCE}: HTTP ${response.status}`);
const raw = await response.json() as Item[] | { positions: Item[] };
const items = Array.isArray(raw) ? raw : raw.positions;
const positions = items
  .filter((item) => item.minted && (item.tier === 'name' || item.tier === 'pfp') && typeof item.name === 'string' && item.name.length > 0)
  .map((item) => ({
    p: item.tier === 'pfp' ? 501 + item.idx : item.idx + 1,
    n: item.name as string,
    ...(item.xHandle ? { h: item.xHandle.replace(/^@/, '') } : {}),
  }))
  .sort((a, b) => a.p - b.p);
if (positions.length < 8) throw new Error(`Only ${positions.length} named panels: refusing to write a degenerate snapshot`);
const out = { source: SOURCE, takenAt: new Date().toISOString(), count: positions.length, positions };
await writeFile(new URL('../src/generated/wall.json', import.meta.url), `${JSON.stringify(out)}\n`);
console.log(`wall snapshot: ${positions.length} named panels (${positions.filter((p) => p.p > 500).length} pfp)`);

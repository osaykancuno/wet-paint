// WET PAINT, once: turns the JSON answer of the bootstrap `rare-profile app deploy … --json` into the game's public
// config (deploy/wet-paint.config.json: the app id and its HTTPS origin, the arcade's shared credit group) and
// prints the command that builds and updates that same app. Never a key, token or secret: only what config.json holds.
// The answer may be NDJSON (one JSON object per line) and, saved by Windows PowerShell, UTF-16 or carry a BOM.
// Usage: npx tsx scripts/wet-paint-config.ts <app-deploy-output.json>
import { readFile, writeFile } from 'node:fs/promises';
import { parseConfiguration } from '../src/shell/config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const file = process.argv[2];
if (!file) throw new Error('Usage: npx tsx scripts/wet-paint-config.ts <app-deploy-output.json>');
const bytes = await readFile(file);
const text = (bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')).replace(/^﻿/, '');
// the last line that is a successful answer with data
const answer = text.split(/\r?\n/).map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
  .filter((v): v is Record<string, unknown> => v !== null && v.ok !== false && typeof v.data === 'object' && v.data !== null).at(-1)
  ?? (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })();
if (!answer) throw new Error(`${file} holds no JSON answer: is it the --json output of rare-profile app deploy?`);
/** The first value of one of these keys, anywhere in the answer (depth first). */
function find(value: unknown, keys: readonly string[], ok: (v: unknown) => boolean): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  for (const key of keys) { const v = (value as Record<string, unknown>)[key]; if (ok(v)) return v as string; }
  for (const v of Object.values(value)) { const found = find(v, keys, ok); if (found) return found; }
  return undefined;
}
const data = answer.data ?? answer;
const appId = find(data, ['id', 'product_id', 'productId', 'app_id', 'appId'], (v) => typeof v === 'string' && UUID.test(v));
const appUrl = find(data, ['app_url', 'appUrl'], (v) => typeof v === 'string' && v.startsWith('https://'));
if (!appId || !appUrl) throw new Error(`No app id and app_url in ${file}: is it the --json answer of rare-profile app deploy?`);

const configuration = parseConfiguration({
  appId,
  groupId: '60faaf46-ba4b-460c-a82a-adb852371a94',          // THE WALL ARCADE's shared credit group: never create another
  studioUrl: 'https://studio.superrare.com',
  apiUrl: 'https://api.superrare.com',
  connectUrl: 'https://connect.superrare.com',
  appOrigin: new URL(appUrl).origin,                          // scheme + host, no path, no trailing slash
  display: 'embed',
  game: 'wet-paint',
  hubUrl: 'https://6972mvu4.srstudio.dev/',
});
await writeFile(new URL('../deploy/wet-paint.config.json', import.meta.url), `${JSON.stringify(configuration, null, 2)}\n`);
console.log(`deploy/wet-paint.config.json written: app ${configuration.appId} at ${configuration.appOrigin}

Every time the game changes, build and update this same app (on Windows: double-click PUBBLICA.cmd):
npm run build -- --config deploy/wet-paint.config.json --output dist/wet-paint.zip --force
rare-profile app update ${configuration.appId} --zip dist/wet-paint.zip --max-attempts 10000 --json`);

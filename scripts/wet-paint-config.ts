// WET PAINT, once per computer: writes the game's public config (deploy/wet-paint.config.json: the app id, its HTTPS
// origin, the arcade's shared credit group) and prints the command that builds and updates that same app.
// Never a key, token or secret: only what config.json holds.
// Usage: npx tsx scripts/wet-paint-config.ts <app-deploy-output.json>   (the --json answer of the one app deploy;
//        NDJSON, and UTF-16 or with a BOM when saved by Windows PowerShell, are fine)
//    or: npx tsx scripts/wet-paint-config.ts --app-id <uuid> --origin https://<host>.srstudio.dev   (an existing app)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseConfiguration } from '../src/shell/config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
let appId: string | undefined, appUrl: string | undefined;
if (args[0] === '--app-id') {
  appId = (args[1] ?? '').trim();
  if (!UUID.test(appId)) throw new Error(`Not an App ID: "${appId}". It looks like 1a2b3c4d-1a2b-4c3d-8e9f-0123456789ab.`);
  appUrl = (args[2] === '--origin' ? args[3] ?? '' : '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.srstudio\.dev\/?$/i.test(appUrl)) throw new Error(`Not an app address: "${appUrl}". It looks like https://abcd1234.srstudio.dev`);
} else {
  const file = args[0];
  if (!file) throw new Error('Usage: npx tsx scripts/wet-paint-config.ts <app-deploy-output.json>  (or --app-id <uuid> --origin <https://….srstudio.dev>)');
  const bytes = await readFile(file);
  const text = (bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')).replace(/^\uFEFF/, '');
  // the last line that is a successful answer with data
  const answer = text.split(/\r?\n/).map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
    .filter((v): v is Record<string, unknown> => v !== null && v.ok !== false && typeof v.data === 'object' && v.data !== null).at(-1)
    ?? (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })();
  if (!answer) throw new Error(`${file} holds no JSON answer: is it the --json output of rare-profile app deploy?`);
  /** The first value of one of these keys, anywhere in the answer (depth first). */
  const find = (value: unknown, keys: readonly string[], ok: (v: unknown) => boolean): string | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;
    for (const key of keys) { const v = (value as Record<string, unknown>)[key]; if (ok(v)) return v as string; }
    for (const v of Object.values(value)) { const found = find(v, keys, ok); if (found) return found; }
    return undefined;
  };
  const data = answer.data ?? answer;
  appId = find(data, ['id', 'product_id', 'productId', 'app_id', 'appId'], (v) => typeof v === 'string' && UUID.test(v));
  appUrl = find(data, ['app_url', 'appUrl'], (v) => typeof v === 'string' && v.startsWith('https://'));
  if (!appId || !appUrl) throw new Error(`No app id and app_url in ${file}: is it the --json answer of rare-profile app deploy?`);
}
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
await mkdir(new URL('../deploy/', import.meta.url), { recursive: true });
await writeFile(new URL('../deploy/wet-paint.config.json', import.meta.url), `${JSON.stringify(configuration, null, 2)}\n`);
console.log(`deploy/wet-paint.config.json written: app ${configuration.appId} at ${configuration.appOrigin}

Every time the game changes, build and update this same app (on Windows: double-click PUBBLICA.cmd):
npm run build -- --config deploy/wet-paint.config.json --output dist/wet-paint.zip --force
rare-profile app update ${configuration.appId} --zip dist/wet-paint.zip --max-attempts 10000 --json`);

// DEV ONLY: builds the real game page with the Connect SDK swapped for src/dev/fake-connect.ts, into an output folder
// served at its root (the page reads /config.json). Usage: node --import tsx scripts/dev-flow.ts <output-dir>
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

const out = process.argv[2];
const game = 'wet-paint';
if (!out) throw new Error('Usage: dev-flow.ts <output-dir>');
await mkdir(join(out, 'assets'), { recursive: true });
await build({
  entryPoints: [`src/entries/${game}.ts`], define: { __DEV_ANY_ORIGIN__: 'true' }, outfile: join(out, 'assets/app.js'), bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', alias: { '@rareprotocol/connect': './src/dev/fake-connect.ts' }, sourcemap: true,
});
// A game not deployed yet has no deploy/<game>.config.json: the page runs on localhost with placeholder identifiers
// (never valid on Studio; the origin check is skipped on localhost only).
const config = await readFile(`deploy/${game}.config.json`, 'utf8').then((text) => JSON.parse(text)).catch(() => ({
  appId: '00000000-0000-4000-8000-00000000f001', groupId: '00000000-0000-4000-8000-00000000f002',
  studioUrl: 'https://studio.superrare.com', apiUrl: 'https://api.superrare.com', connectUrl: 'https://connect.superrare.com',
  appOrigin: 'https://wet-paint.example.com', display: 'embed', game, hubUrl: 'https://6972mvu4.srstudio.dev/',
}));
await writeFile(join(out, 'config.json'), JSON.stringify(config, null, 2));
await writeFile(join(out, 'assets/styles.css'), await readFile('src/shell/styles.css'));
const page = (await readFile('src/index.html', 'utf8')).replace('<body>', '<body>\n    <p style="position:fixed;z-index:9;left:0;bottom:0;margin:0;padding:2px 6px;background:#c00;color:#fff;font:10px monospace">DEV · FAKE CONNECT · NO REAL PAYMENT</p>');
await writeFile(join(out, 'index.html'), page);
console.log(`dev flow page built: ${out}`);

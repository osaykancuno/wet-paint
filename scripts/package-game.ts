// Builds one game archive: the browser bundle, the server verifier and the matching scoring configuration, kept together.
// Adapted from studio-games-example/scripts/package-game.ts (MIT, Copyright 2026 SuperRare).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { strToU8 } from 'fflate';
import { scoringConfiguration, type Configuration } from '../src/shell/config.js';

export type GameFiles = Record<string, Uint8Array>;
const root = fileURLToPath(new URL('../', import.meta.url));
const TITLES: Record<Configuration['game'], string> = { 'wet-paint': 'WET PAINT' };

const common = { absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'inline' } as const;

export async function packageGame(configuration: Configuration): Promise<GameFiles> {
  const [browser, verifier, template, stylesheet, license, notice] = await Promise.all([
    // __DEV_ANY_ORIGIN__ is false in a published build: dev-only code (scripts/dev-flow.ts) is dropped from the bundle
    build({ ...common, entryPoints: [`src/entries/${configuration.game}.ts`], define: { __DEV_ANY_ORIGIN__: 'false' } }),
    build({ ...common, entryPoints: [`src/verifiers/${configuration.game}.ts`] }),
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/shell/styles.css', import.meta.url)),
    readFile(new URL('../LICENSE', import.meta.url)),
    readFile(new URL('../NOTICE', import.meta.url)),
  ]);
  const appBundle = browser.outputFiles[0];
  const verifierBundle = verifier.outputFiles[0];
  if (!appBundle || !verifierBundle) throw new Error('Bundler returned no application or verifier output.');
  if (verifierBundle.contents.byteLength > 256_000) throw new Error('Server verifier exceeds Studio’s 256 KB module limit.');
  const appPath = `assets/app-${createHash('sha256').update(appBundle.contents).digest('hex').slice(0, 16)}.js`;
  const stylePath = `assets/styles-${createHash('sha256').update(stylesheet).digest('hex').slice(0, 16)}.css`;
  const index = template
    .replace('<head>', `<head>\n    <meta name="play-factory-game-id" content="${configuration.appId}">\n    <link data-rare-app-metadata="true" rel="canonical" href="${configuration.appOrigin}/">`)
    .replace('<title>THE WALL ARCADE</title>', `<title>${TITLES[configuration.game]} · THE WALL ARCADE</title>`)
    .replace('./assets/app.js', `./${appPath}`)
    .replace('./assets/styles.css', `./${stylePath}`);
  if (!index.includes(appPath) || !index.includes(stylePath)) throw new Error('index.html template placeholders were not replaced.');
  return {
    'index.html': strToU8(index),
    'config.json': strToU8(`${JSON.stringify(configuration, null, 2)}\n`),
    [appPath]: appBundle.contents,
    [stylePath]: stylesheet,
    'server-verifier.js': verifierBundle.contents,
    'scoring-config.json': strToU8(`${JSON.stringify(scoringConfiguration(configuration.game), null, 2)}\n`),
    LICENSE: license,
    NOTICE: notice,
  };
}

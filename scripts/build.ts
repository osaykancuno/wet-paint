import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { zipSync } from 'fflate';
import { parseConfiguration } from '../src/shell/config.js';
import { packageGame } from './package-game.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args,
    options: { config: { type: 'string' }, output: { type: 'string' }, force: { type: 'boolean', default: false } }, strict: true });
  if (!values.config || !values.output) throw new Error('Usage: npm run build -- --config <public-config.json> --output <game.zip> [--force]');
  const configuration = parseConfiguration(JSON.parse(await readFile(resolve(values.config), 'utf8')) as unknown);
  const output = resolve(values.output);
  let exists = false;
  try { await access(output); exists = true; } catch { /* A new output is expected. */ }
  if (exists && !values.force) throw new Error(`Output exists: ${output}. Use another path or --force.`);
  const archive = zipSync(await packageGame(configuration), { level: 9 });
  if (archive.byteLength > 50_000_000) throw new Error('Archive exceeds Studio’s 50 MB limit.');
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try { await writeFile(temporary, archive, { flag: 'wx' }); await rename(temporary, output); } finally { await rm(temporary, { force: true }); }
  process.stdout.write(`Game: ${configuration.game}\nArchive: ${output}\nSDK: @rareprotocol/connect@0.11.0 (published npm package)\nSHA-256: ${createHash('sha256').update(archive).digest('hex')}\nSize: ${archive.byteLength} bytes\n`);
}
void main().catch((error: unknown) => {
  process.stderr.write(`Build failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});

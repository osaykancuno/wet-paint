// DEV ONLY: serves a dev-flow page (scripts/dev-flow.ts) over HTTPS with a throwaway self-signed certificate, so a phone
// on the same wifi gets a secure context (the paid flow hashes with crypto.subtle, which plain http on a LAN address
// does not offer). The phone shows a certificate warning once: accept it for this address.
//   node --import tsx scripts/dev-serve.ts <dir> [--lan] [--port 8443]
// Without --lan it listens on 127.0.0.1 only. With --lan it listens on every interface of this Mac: anyone on the
// same network can open the page (fake Connect, no real payment). Stop it with Ctrl-C when the test is over.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { lan: { type: 'boolean', default: false }, port: { type: 'string', default: '8443' } } });
const root = resolve(positionals[0] ?? 'dist/dev-wet-paint');
if (!existsSync(join(root, 'index.html'))) throw new Error(`${root}/index.html not found: build it first with scripts/dev-flow.ts`);
const certDir = resolve('dist/dev-cert');
if (!existsSync(join(certDir, 'cert.pem'))) {
  mkdirSync(certDir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
    '-days', '30', '-subj', '/CN=wall-arcade-dev'], { stdio: 'ignore' });
}
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.jpg': 'image/jpeg' };
const host = values.lan ? '0.0.0.0' : '127.0.0.1', port = Number(values.port);
createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'https://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body); }
  catch { response.writeHead(404).end('not found'); }
}).listen(port, host, () => {
  console.log(`dev page (fake Connect, no real payment): https://localhost:${port}/?credits=5&signed=1`);
  if (values.lan) for (const list of Object.values(networkInterfaces())) for (const net of list ?? []) {
    if (net.family === 'IPv4' && !net.internal) console.log(`on the phone (same wifi):           https://${net.address}:${port}/?credits=5&signed=1`);
  }
});

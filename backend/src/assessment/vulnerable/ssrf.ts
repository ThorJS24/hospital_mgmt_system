/**
 * INTENTIONALLY VULNERABLE (HMS-V13): server-side request forgery scenario.
 * Containment: the ONLY outbound client in the application. It refuses every destination that is not a
 * loopback IP literal, so it can never reach the internet or the LAN. Responses are capped at 4 KB.
 */
import http from 'node:http';
import { createServer, type Server } from 'node:http';
import net from 'node:net';

const isLoopbackLiteral = (host: string) => (net.isIPv4(host) && host.startsWith('127.')) || host === '::1' || host === '[::1]';

/** VULNERABLE filter: blocks only the literal hostname "localhost" and the default admin port, nothing else. */
export function naiveSsrfCheck(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'http:') throw new Error('Only http: URLs are supported');
  if (u.hostname.toLowerCase() === 'localhost') throw new Error('Internal hosts are not allowed'); // bypassable with 127.0.0.1 / [::1]
  return u;
}

export function fetchLoopbackOnly(u: URL): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // lab containment guard (not part of the weakness): never leave the loopback interface
    if (!isLoopbackLiteral(u.hostname)) return reject(new Error('Destination is outside the lab network'));
    const req = http.get(u, { timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size <= 4096) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

/** Tiny "internal-only" service the SSRF scenario can reach. Bound to 127.0.0.1 and serves synthetic text. */
export function startInternalService(port = 4100): Server {
  const s = createServer((req, res) => {
    if (req.url === '/internal/metadata') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('INTERNAL-SERVICE-MARKER: synthetic internal metadata (lab only)\nservice=hms-internal-billing-sync\n');
    } else {
      res.writeHead(404).end();
    }
  });
  s.on('error', () => { /* port busy: the scenario is simply unavailable */ });
  s.listen(port, '127.0.0.1');
  s.unref();
  return s;
}

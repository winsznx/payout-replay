// Minimal webhook receiver. Verifies the HMAC signature, rejects stale
// timestamps and drops event IDs it has already handled, then logs the event.
//
//   WEBHOOK_SECRET=whsec_... PORT=4400 pnpm webhooks
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error('set WEBHOOK_SECRET to the secret shown when the endpoint was created');
const port = Number(process.env.PORT ?? 4400);
const TOLERANCE_SECONDS = 300;
const seen = new Set<string>();

export function verifySignature(header: string | undefined, body: string, key: string, now = Date.now()): boolean {
  const parts = Object.fromEntries((header ?? '').split(',').map((part) => part.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS || !parts.v1) return false;
  const expected = createHmac('sha256', key).update(`${timestamp}.${body}`).digest();
  const received = Buffer.from(parts.v1, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (!verifySignature(request.headers['x-payout-replay-signature'] as string | undefined, body, secret)) {
      response.writeHead(401).end();
      return;
    }
    const eventId = request.headers['x-payout-replay-event-id'] as string;
    if (seen.has(eventId)) {
      response.writeHead(200).end();
      return;
    }
    seen.add(eventId);
    const event = JSON.parse(body) as { type: string; data: Record<string, unknown> };
    console.log(`${new Date().toISOString()} ${event.type}`, event.data);
    response.writeHead(200).end();
  });
}).listen(port, () => console.log(`listening for Payout Replay webhooks on :${port}`));

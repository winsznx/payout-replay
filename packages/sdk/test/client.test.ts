import { describe, expect, it, vi } from 'vitest';

import { PayoutReplayApiError, PayoutReplayClient, parseManifest, validateManifest } from '../src/index.js';

function mockFetch(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } }));
}

describe('PayoutReplayClient', () => {
  it('should send the API key and an idempotency key on writes', async () => {
    // #given a client with a mocked transport
    const fetcher = mockFetch(200, { runId: 'pr_1' });
    const client = new PayoutReplayClient({ baseUrl: 'https://api.test/', apiKey: 'prk_x', fetch: fetcher });
    // #when a write is made with a caller-chosen key
    await client.reconcile('pr_1');
    await client.attachTransaction('pr_1', { obligationId: '0x01', txHash: '0x02' }, 'retry-safe-key-1');
    // #then both requests carry auth and the second reuses the given key
    const [, first] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const [url, second] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect({
      url,
      auth: (first.headers as Record<string, string>).authorization,
      key: (second.headers as Record<string, string>)['idempotency-key'],
      hasFirstKey: Boolean((first.headers as Record<string, string>)['idempotency-key']),
    }).toEqual({ url: 'https://api.test/api/v1/runs/pr_1/external-transactions', auth: 'Bearer prk_x', key: 'retry-safe-key-1', hasFirstKey: true });
  });

  it('should surface the structured API error', async () => {
    const client = new PayoutReplayClient({
      baseUrl: 'https://api.test',
      apiKey: 'prk_x',
      fetch: mockFetch(409, { error: { code: 'PLAN_STALE', message: 'stale', retryable: false, traceId: 'trc_1' } }),
    });
    await expect(client.reconcile('pr_1')).rejects.toMatchObject({ name: 'PayoutReplayApiError', code: 'PLAN_STALE', status: 409, traceId: 'trc_1' });
  });

  it('should return CSV exports as text', async () => {
    const client = new PayoutReplayClient({ baseUrl: 'https://api.test', apiKey: 'prk_x', fetch: mockFetch(200, 'line_id\r\nA\r\n', 'text/csv') });
    expect(await client.exportCsv('pr_1')).toBe('line_id\r\nA\r\n');
  });

  it('should expose the error class for instanceof checks', () => {
    expect(new PayoutReplayApiError(400, 'X', 'm', false, undefined)).toBeInstanceOf(Error);
  });
});

describe('spec-named helpers', () => {
  const context = { assets: [], payers: {}, ss58Prefix: 42 };

  it('should report blocking issues through validateManifest', () => {
    expect(validateManifest('line_id\nA', context).map((issue) => issue.code)).toContain('MISSING_COLUMN');
  });

  it('should return the full report through parseManifest', () => {
    expect(parseManifest('line_id\nA', context).ok).toBe(false);
  });
});

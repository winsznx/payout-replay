import type { ReconciliationResult, RecoveryPlan, ValidationReport } from '@payout-replay/core';

export interface PayoutReplayClientOptions {
  /** Base URL of the Payout Replay API, e.g. https://api.example.com */
  baseUrl: string;
  /** Organisation API key (`prk_…`). Keys can read and register data; they can never sign. */
  apiKey: string;
  fetch?: typeof fetch;
}

export class PayoutReplayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly traceId: string | undefined,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PayoutReplayApiError';
  }
}

export interface RunSummary {
  runId: string;
  manifestVersion: number;
  manifestDigest: string;
  status: string;
  counts: Record<string, number>;
  partition: { environment: string; assetId: string; symbol: string; total: string; verified: string; outstanding: string }[];
  exceptions: number;
  lastVerifiedAt: string | null;
}

export interface RunRecord {
  id: string;
  orgId: string;
  name: string;
  status: string;
  currentVersion: number;
  lastReconciledAt: string | null;
}

export interface LineRecord {
  obligationId: string;
  lineId: string;
  environment: 'native' | 'evm';
  assetId: string;
  symbol: string;
  destination: string;
  amount: string;
  amountBaseUnits: string;
  status: ReconciliationResult['obligations'][number]['status'];
  explanation: string;
  attempts: { id: string; txHash: string | null; outcome: { kind: string } }[];
}

/**
 * Typed client for the REST API. Every write sends an Idempotency-Key, so a
 * retried call after a network error replays the original response instead
 * of repeating the action.
 */
export class PayoutReplayClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: PayoutReplayClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': idempotencyKey ?? crypto.randomUUID() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed: unknown = text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
    if (!response.ok) {
      const error = (parsed as { error?: { code: string; message: string; retryable: boolean; traceId: string; details?: unknown } }).error;
      throw new PayoutReplayApiError(
        response.status,
        error?.code ?? 'HTTP_ERROR',
        error?.message ?? `HTTP ${response.status}`,
        error?.retryable ?? false,
        error?.traceId,
        error?.details,
      );
    }
    return parsed as T;
  }

  listRuns(orgId: string): Promise<RunRecord[]> {
    return this.request('GET', `/api/v1/orgs/${orgId}/runs`);
  }

  createRun(orgId: string, name: string, idempotencyKey?: string): Promise<RunRecord> {
    return this.request('POST', `/api/v1/orgs/${orgId}/runs`, { name }, idempotencyKey);
  }

  importCsv(runId: string, csv: string, options: { fileName?: string; columnMapping?: Record<string, string> } = {}): Promise<{ importId: string; report: ValidationReport }> {
    return this.request('POST', `/api/v1/runs/${runId}/import`, { csv, ...options });
  }

  getRun(runId: string): Promise<{ run: RunRecord; summary: RunSummary | null; latestPlan: { id: string; plan: RecoveryPlan } | null }> {
    return this.request('GET', `/api/v1/runs/${runId}`);
  }

  async listLines(runId: string): Promise<LineRecord[]> {
    const page = await this.request<{ items: LineRecord[] }>('GET', `/api/v1/runs/${runId}/lines?limit=500`);
    return page.items;
  }

  /** Asks the server to re-read the chain now (debounced server-side). */
  reconcile(runId: string): Promise<RunSummary> {
    return this.request('POST', `/api/v1/runs/${runId}/reconcile`, {});
  }

  /** Attaches an out-of-band transaction to an obligation; it only counts after chain verification. */
  attachTransaction(runId: string, input: { obligationId: string; txHash: string; blockHash?: string }, idempotencyKey?: string): Promise<{ id: string }> {
    return this.request('POST', `/api/v1/runs/${runId}/external-transactions`, input, idempotencyKey);
  }

  exportCsv(runId: string): Promise<string> {
    return this.request('GET', `/api/v1/runs/${runId}/export.csv`);
  }

  exceptionsCsv(runId: string): Promise<string> {
    return this.request('GET', `/api/v1/runs/${runId}/exceptions.csv`);
  }

  evidence(runId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/runs/${runId}/evidence.json`);
  }
}

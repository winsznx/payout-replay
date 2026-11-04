export interface ApiErrorBody {
  error: { code: string; message: string; retryable: boolean; traceId: string; details?: unknown };
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly traceId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiRequestError(response.status, error?.code ?? 'HTTP_ERROR', error?.message ?? `request failed (${response.status})`, error?.details, error?.traceId);
  }
  return body as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'same-origin', cache: 'no-store' });
  return parse<T>(response);
}

/**
 * Every write carries a fresh Idempotency-Key unless the caller supplies one;
 * callers that may retry (attempt registration) pass a stable key.
 */
export async function apiPost<T>(path: string, body: unknown = {}, options: { idempotencyKey?: string } = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'idempotency-key': options.idempotencyKey ?? newIdempotencyKey() },
    body: JSON.stringify(body),
  });
  return parse<T>(response);
}

export const fetcher = <T,>(path: string): Promise<T> => apiGet<T>(path);

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VERSION_CONFLICT'
  | 'PLAN_STALE'
  | 'PLAN_EXPIRED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'UNPROCESSABLE'
  | 'WRONG_WALLET'
  | 'WRONG_NETWORK'
  | 'TX_OUTCOME_UNKNOWN'
  | 'RATE_LIMITED'
  | 'CHAIN_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  WRONG_WALLET: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  PLAN_STALE: 409,
  PLAN_EXPIRED: 409,
  IDEMPOTENCY_MISMATCH: 409,
  TX_OUTCOME_UNKNOWN: 409,
  UNPROCESSABLE: 422,
  WRONG_NETWORK: 422,
  RATE_LIMITED: 429,
  CHAIN_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = STATUS[code];
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; retryable: boolean; traceId: string; details?: unknown };
}

export function errorBody(error: ApiError, traceId: string): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      traceId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

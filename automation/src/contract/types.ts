// What every platform implementation of the networking module has to agree on.
// The native SDKs would have their own Kotlin / Swift types; this is the shape
// of the *results* the shared scenarios are checked against.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type ErrorCode =
  | 'CLIENT_ERROR' // 4xx other than 401 / 429
  | 'UNAUTHENTICATED' // 401, the auth module decides what to do about it
  | 'RATE_LIMITED' // 429 that we did not (or could not safely) wait out
  | 'SERVER_ERROR' // 5xx after the retries ran out
  | 'TIMEOUT'
  | 'NETWORK' // connection dropped / refused
  | 'DECODE_ERROR'; // 2xx but the body is not the JSON we promised

export interface SdkRequest {
  method: HttpMethod;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
}

export interface SdkConfig {
  baseUrl: string;
  requestTimeoutMs: number;
  // Injected so tests don't sit through real backoff. A native build would
  // get the same thing through a test-only configuration flag.
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export interface Success {
  ok: true;
  status: number;
  body: unknown;
  attempts: number;
  requestId: string;
  waitsMs: number[];
}

export interface Failure {
  ok: false;
  code: ErrorCode;
  status?: number;
  attempts: number;
  requestId: string;
  waitsMs: number[];
  // true when the server may have acted on the request and the result doesn't
  // tell us: it was sent and no answer came back, or the answer was a 5xx or a
  // 429, which don't promise that nothing happened. false when nothing was sent
  // (connection refused) or the answer settles it (2xx, 4xx other than 429).
  // A caller uses it to decide whether to check the status before trying again.
  outcomeUnknown: boolean;
  retryAfterMs?: number;
  message: string;
}

export type Outcome = Success | Failure;

export interface SdkDriver {
  platform: 'android' | 'ios';
  sdkVersion: string;
  execute(request: SdkRequest, config: SdkConfig): Promise<Outcome>;
}

// Retry policy as agreed in the spec. Both platforms must use the same numbers.
export const POLICY = {
  maxAttempts: 3,
  baseDelayMs: 200,
  // Low on purpose: with 3 attempts the second wait would be 400ms, so a 300ms
  // cap actually binds and can be tested. A real SDK would choose its own.
  maxDelayMs: 300,
  // If the server asks us to wait longer than this we don't sit on it, we
  // tell the caller and let the app decide.
  maxRetryAfterMs: 10_000,
  jitterFloor: 0.5, // wait is between 50% and 100% of the nominal delay
} as const;

export const USER_AGENT_PATTERN = /^PlatformSDK\/\d+\.\d+\.\d+ \((android|ios)\)$/;

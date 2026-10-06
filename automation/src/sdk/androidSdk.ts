import { randomUUID } from 'node:crypto';
import { POLICY, type ErrorCode, type Failure, type Outcome, type SdkConfig, type SdkDriver, type SdkRequest } from '../contract/types.js';
import { singleAttempt } from './transport.js';
import { fault } from './faults.js';

// Stand-in for the Android networking module (think OkHttp interceptors).
// It is written the way an interceptor chain reads: add ids, decide on retry,
// map the result. The iOS one is deliberately structured differently so the
// parity checks have something real to compare.

const VERSION = '3.4.0';

class AndroidNetworking {
  constructor(private cfg: SdkConfig) {}

  async call(req: SdkRequest): Promise<Outcome> {
    let requestId = randomUUID();
    const waitsMs: number[] = [];
    const maxAttempts = fault('android:four-attempts') ? POLICY.maxAttempts + 1 : POLICY.maxAttempts;
    const canRepeat = req.method !== 'POST' || Boolean(req.idempotencyKey);
    const url = this.cfg.baseUrl + req.path;
    const bodyText = req.body === undefined ? undefined : JSON.stringify(req.body);

    for (let attempt = 1; ; attempt++) {
      if (fault('android:new-request-id-per-attempt') && attempt > 1) requestId = randomUUID();
      const sentBody = fault('android:retry-body-changes') && attempt > 1 && bodyText !== undefined ? JSON.stringify({ ...(req.body as object), retry: true }) : bodyText;
      const result = await singleAttempt(url, req.method, this.headersFor(req, requestId, attempt), sentBody, this.cfg.requestTimeoutMs);
      const last = attempt >= maxAttempts;
      const base = { attempts: attempt, requestId, waitsMs };

      if (result.kind === 'timeout' || result.kind === 'network') {
        const code: ErrorCode = result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK';
        // If the request never left the client, repeating it is safe for any method.
        const sent = result.sent || fault('android:not-sent-treated-as-sent');
        if ((canRepeat || !sent) && !last) {
          await this.backoff(attempt, undefined, waitsMs);
          continue;
        }
        return { ok: false, code, outcomeUnknown: sent, message: `${req.method} ${pathOnly(req.path)} got no response (${code})`, ...base };
      }

      const { status } = result;
      if (status >= 200 && status < 300) {
        if (status === 204 || result.text === '') return { ok: true, status, body: null, ...base };
        try {
          return { ok: true, status, body: JSON.parse(result.text), ...base };
        } catch {
          return fail(base, 'DECODE_ERROR', `${req.method} ${pathOnly(req.path)} returned a body that is not JSON`, status);
        }
      }
      if (status === 401) return fail(base, 'UNAUTHENTICATED', 'not authenticated', status);

      if (status === 429 || status === 503) {
        const retryAfterMs = fault('android:ignore-retry-after') ? undefined : parseRetryAfter(result.headers['retry-after']);
        const code: ErrorCode = status === 429 ? 'RATE_LIMITED' : 'SERVER_ERROR';
        const withHint = retryAfterMs !== undefined ? { retryAfterMs } : {};
        if (retryAfterMs !== undefined && retryAfterMs > POLICY.maxRetryAfterMs && !fault('android:retry-after-too-long-waited')) {
          return { ...fail(base, code, `${status}, retry-after too long to wait`, status), ...withHint };
        }
        // Without an idempotency key a POST is not repeated, even here: a 503 can
        // come from a gateway after the backend acted (see the questions list).
        if ((canRepeat || fault('android:retry-unkeyed-post-on-429-503')) && !last) {
          await this.backoff(attempt, retryAfterMs, waitsMs);
          continue;
        }
        return { ...fail(base, code, `${status} after ${attempt} attempts`, status), ...withHint };
      }

      if (status >= 500) {
        if (canRepeat && !last) {
          await this.backoff(attempt, undefined, waitsMs);
          continue;
        }
        return fail(base, 'SERVER_ERROR', `${req.method} ${pathOnly(req.path)} failed with ${status}`, status);
      }

      if (fault('android:retry-404') && status === 404 && !last) {
        await this.backoff(attempt, undefined, waitsMs);
        continue;
      }
      return fail(base, 'CLIENT_ERROR', `${req.method} ${pathOnly(req.path)} rejected with ${status}`, status);
    }
  }

  private headersFor(req: SdkRequest, requestId: string, attempt: number): Record<string, string> {
    return {
      ...req.headers,
      'user-agent': `PlatformSDK/${VERSION} (android)`,
      'x-request-id': requestId,
      'x-attempt': String(attempt),
      ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(req.idempotencyKey ? { 'idempotency-key': req.idempotencyKey } : {}),
    };
  }

  private async backoff(failedAttempt: number, retryAfterMs: number | undefined, waits: number[]): Promise<void> {
    const uncapped = POLICY.baseDelayMs * 2 ** (failedAttempt - 1);
    const nominal = fault('android:no-delay-cap') ? uncapped : Math.min(POLICY.maxDelayMs, uncapped);
    const jittered = nominal * (POLICY.jitterFloor + (1 - POLICY.jitterFloor) * this.cfg.random());
    const wait = Math.round(Math.max(jittered, retryAfterMs ?? 0));
    waits.push(wait);
    await this.cfg.sleep(wait);
  }
}

function fail(base: { attempts: number; requestId: string; waitsMs: number[] }, code: ErrorCode, message: string, status?: number): Failure {
  // A 5xx or a 429 doesn't promise that the server did nothing.
  const outcomeUnknown = status !== undefined && (status === 429 || status >= 500);
  return { ok: false, code, outcomeUnknown, message, ...(status !== undefined ? { status } : {}), ...base };
}

// Query strings can carry tokens, so they never go into messages.
function pathOnly(path: string): string {
  return fault('android:leak-query-in-message') ? path : (path.split('?')[0] ?? path);
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // delta-seconds only: digits, nothing else. HTTP-dates are not supported (a question for the team).
  return /^\d+$/.test(value.trim()) ? Number(value) * 1000 : undefined;
}

export const androidDriver: SdkDriver = {
  platform: 'android',
  sdkVersion: VERSION,
  execute: (request, config) => new AndroidNetworking(config).call(request),
};

import { randomUUID } from 'node:crypto';
import { POLICY, type ErrorCode, type Outcome, type SdkConfig, type SdkDriver, type SdkRequest } from '../contract/types.js';
import { singleAttempt, type AttemptResult } from './transport.js';
import { fault } from './faults.js';

// Stand-in for the iOS networking module (think URLSession + a retry policy
// type). Structured differently from the Android one on purpose: here the
// decision is a separate function that returns a verdict, and the loop just
// obeys it.
//
// IOS_SDK_VERSION=3.5.0 switches on a planted regression (see faults.ts): a
// change that "unified" transient error handling and quietly started retrying
// POSTs after a timeout. It is test data, not a claim about any real SDK.

const VERSION = process.env.IOS_SDK_VERSION ?? '3.4.0';

type Verdict =
  | { do: 'return'; failure: { code: ErrorCode; status?: number; unknown?: boolean; retryAfterMs?: number; message: string } }
  | { do: 'success'; status: number; body: unknown }
  | { do: 'retry'; retryAfterMs?: number };

function isSafeToRepeat(req: SdkRequest): boolean {
  return req.method !== 'POST' || Boolean(req.idempotencyKey);
}

function decide(req: SdkRequest, result: AttemptResult, attempt: number): Verdict {
  const last = attempt >= POLICY.maxAttempts;
  const route = req.path.split('?')[0];

  if (result.kind !== 'response') {
    const code: ErrorCode = result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK';
    // 3.5.0: "transient errors are always retried". Fine for GET, not for a POST
    // without an idempotency key, where the first attempt may have gone through.
    // If the request never left the client, repeating it is safe for any method.
    const mayRepeat = fault('ios:retry-post-on-timeout') ? true : isSafeToRepeat(req) || !result.sent;
    if (mayRepeat && !last) return { do: 'retry' };
    return { do: 'return', failure: { code, unknown: result.sent, message: `${req.method} ${route}: no response (${code})` } };
  }

  const { status, text, headers } = result;

  if (status >= 200 && status < 300) {
    if (status === 204 || text === '') return { do: 'success', status, body: null };
    try {
      return { do: 'success', status, body: JSON.parse(text) };
    } catch {
      return { do: 'return', failure: { code: 'DECODE_ERROR', status, message: `${req.method} ${route}: body is not JSON` } };
    }
  }
  if (status === 401) {
    if (fault('ios:retry-401') && !last) return { do: 'retry' };
    return { do: 'return', failure: { code: 'UNAUTHENTICATED', status, message: 'not authenticated' } };
  }

  if (status === 429 || status === 503) {
    const header = headers['retry-after'];
    const lenient = fault('ios:lenient-retry-after');
    const retryAfterMs =
      header === undefined
        ? undefined
        : lenient
          ? Number.isFinite(Number(header)) ? Number(header) * 1000 : undefined
          : /^\d+$/.test(header.trim()) ? Number(header) * 1000 : undefined;
    const code: ErrorCode = status === 429 ? 'RATE_LIMITED' : 'SERVER_ERROR';
    const hint = retryAfterMs !== undefined ? { retryAfterMs } : {};
    if (retryAfterMs !== undefined && retryAfterMs > POLICY.maxRetryAfterMs) {
      return { do: 'return', failure: { code, status, ...hint, message: `${status}, retry-after too long to wait` } };
    }
    if (!last && isSafeToRepeat(req)) return { do: 'retry', ...hint };
    const finalCode: ErrorCode = status === 429 && fault('ios:wrong-code-after-last-429') ? 'SERVER_ERROR' : code;
    return { do: 'return', failure: { code: finalCode, status, ...hint, message: `${status} after ${attempt} attempts` } };
  }

  if (status >= 500) {
    if (!last && isSafeToRepeat(req)) return { do: 'retry' };
    return { do: 'return', failure: { code: 'SERVER_ERROR', status, message: `${req.method} ${route}: server answered ${status}` } };
  }

  if (fault('ios:retry-408') && status === 408 && !last) return { do: 'retry' };
  return { do: 'return', failure: { code: 'CLIENT_ERROR', status, message: `${req.method} ${route}: rejected with ${status}` } };
}

async function run(req: SdkRequest, cfg: SdkConfig): Promise<Outcome> {
  const requestId = randomUUID();
  const waitsMs: number[] = [];
  const bodyText = req.body === undefined ? undefined : JSON.stringify(req.body);

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const headers: Record<string, string> = {
      ...req.headers,
      'user-agent': `PlatformSDK/${VERSION} (ios)`,
      'x-request-id': requestId,
      'x-attempt': String(attempt),
    };
    if (bodyText !== undefined) headers['content-type'] = fault('ios:wrong-content-type') ? 'text/plain' : 'application/json';
    if (req.idempotencyKey && !(fault('ios:drop-idempotency-key-on-retry') && attempt > 1)) {
      headers['idempotency-key'] = req.idempotencyKey;
    }

    const result = await singleAttempt(cfg.baseUrl + req.path, req.method, headers, bodyText, cfg.requestTimeoutMs);
    const verdict = decide(req, result, attempt);

    if (verdict.do === 'success') {
      return { ok: true, status: verdict.status, body: verdict.body, attempts: attempt, requestId, waitsMs };
    }
    if (verdict.do === 'return') {
      const f = verdict.failure;
      return {
        ok: false,
        code: f.code,
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}),
        // A 5xx or a 429 doesn't promise that the server did nothing.
        outcomeUnknown:
          f.unknown ??
          (f.status !== undefined && (f.status === 429 || (f.status >= 500 && !fault('ios:5xx-outcome-known')))),
        message: f.message,
        attempts: attempt,
        requestId,
        waitsMs,
      };
    }

    const nominal = Math.min(POLICY.maxDelayMs, POLICY.baseDelayMs * Math.pow(2, attempt - 1));
    const jitter = fault('ios:no-jitter') ? 1 : POLICY.jitterFloor + (1 - POLICY.jitterFloor) * cfg.random();
    const wait = Math.round(Math.max(nominal * jitter, verdict.retryAfterMs ?? 0));
    waitsMs.push(wait);
    await cfg.sleep(wait);
  }
}

export const iosDriver: SdkDriver = {
  platform: 'ios',
  sdkVersion: VERSION,
  execute: run,
};

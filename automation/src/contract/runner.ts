import { FaultServer, type Received } from '../mock/faultServer.js';
import { USER_AGENT_PATTERN, type Outcome, type SdkDriver } from './types.js';
import { loadCatalogue, type Scenario } from './scenarios.js';

// The checker holds the SDKs to the policy written in the catalogue, not to the
// constants the stand-in SDKs happen to use.
const POLICY = loadCatalogue().policy;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ScenarioResult {
  outcome: Outcome;
  received: Received[];
}

// Small seeded generator so a failing run can be replayed exactly.
export function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// Different seeds per platform, so the two stand-ins don't get the same jitter
// by construction and "parity" isn't a foregone conclusion.
const SEED: Record<SdkDriver['platform'], number> = { android: 42, ios: 7 };

// Generous on purpose: only scenarios that are *about* timeouts override it,
// and they make the server answer far later than their short timeout.
const DEFAULT_TIMEOUT_MS = 2_000;

export async function runScenario(driver: SdkDriver, server: FaultServer, scenario: Scenario): Promise<ScenarioResult> {
  const { id, baseUrl } = server.script(scenario.server);
  const outcome = await driver.execute(scenario.request, {
    baseUrl,
    requestTimeoutMs: scenario.config?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    sleep: async () => {}, // we assert on the requested waits, we don't live through them
    random: makeRandom(SEED[driver.platform]),
  });
  // The SDK says how many requests it sent. Give the server a moment to have
  // logged that many before comparing, so a busy machine can't make a correct
  // SDK look wrong. If the server never sees them, that is a real failure.
  await server.waitForRequests(id, outcome.attempts);
  return { outcome, received: server.received(id) };
}

/**
 * Compare what happened with what the scenario says should happen.
 * Returns plain sentences, one per violation, so a red test explains itself.
 * The wire checks at the bottom apply to every scenario.
 */
export function check(scenario: Scenario, { outcome, received }: ScenarioResult): string[] {
  const e = scenario.expect;
  const problems: string[] = [];
  const expectEq = (what: string, actual: unknown, wanted: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      problems.push(`${what}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
    }
  };

  expectEq('ok', outcome.ok, e.ok);
  expectEq('attempts', outcome.attempts, e.attempts);
  if (outcome.ok) {
    if (e.status !== undefined) expectEq('status', outcome.status, e.status);
    if ('body' in e) expectEq('body', outcome.body, e.body);
  } else {
    expectEq('error code', outcome.code, e.code);
    if (e.status !== undefined) expectEq('status', outcome.status, e.status);
    if (e.outcomeUnknown !== undefined) expectEq('outcomeUnknown', outcome.outcomeUnknown, e.outcomeUnknown);
    if (e.retryAfterMs !== undefined) expectEq('retryAfterMs', outcome.retryAfterMs, e.retryAfterMs);
  }

  // Exactly one backoff wait between consecutive attempts, each inside the policy window.
  expectEq('number of backoff waits', outcome.waitsMs.length, outcome.attempts - 1);
  outcome.waitsMs.forEach((wait, i) => {
    const nominal = Math.min(POLICY.maxDelayMs, POLICY.baseDelayMs * 2 ** i);
    const floor = e.waitAtLeastMs ?? 0;
    const lo = Math.max(nominal * POLICY.jitterFloor, floor);
    const hi = Math.max(nominal, floor);
    if (wait < lo || wait > hi) problems.push(`wait #${i + 1}: ${wait}ms is outside the allowed ${lo}-${hi}ms`);
  });

  if (e.mustNotLeak) {
    const dump = JSON.stringify(outcome);
    for (const secret of e.mustNotLeak) if (dump.includes(secret)) problems.push(`result leaks "${secret}"`);
  }

  // --- wire contract, same for every scenario -------------------------------
  // What actually reached the server must line up with what the SDK says it did.
  expectEq('requests seen by the server vs attempts reported', received.length, outcome.attempts);

  received.forEach((r, i) => {
    const h = r.headers;
    if (r.method !== scenario.request.method) problems.push(`attempt ${i + 1}: method was ${r.method}`);
    if (!USER_AGENT_PATTERN.test(h['user-agent'] ?? '')) problems.push(`attempt ${i + 1}: user-agent "${h['user-agent']}" does not match PlatformSDK/x.y.z (platform)`);
    if (h['x-attempt'] !== String(i + 1)) problems.push(`attempt ${i + 1}: x-attempt was "${h['x-attempt']}"`);
    if (h['x-request-id'] !== received[0]?.headers['x-request-id']) problems.push(`attempt ${i + 1}: x-request-id changed between attempts`);
    if (scenario.request.idempotencyKey && h['idempotency-key'] !== scenario.request.idempotencyKey) {
      problems.push(`attempt ${i + 1}: idempotency-key not preserved`);
    }
    // Compared as parsed JSON: real stacks differ in key order, spacing and escaping.
    const wanted = scenario.request.body === undefined ? '' : canonical(scenario.request.body);
    const got = r.body === '' ? '' : canonical(safeParse(r.body));
    if (got !== wanted) problems.push(`attempt ${i + 1}: body was ${r.body || '(empty)'}, expected ${wanted || '(empty)'}`);
    if (scenario.request.body !== undefined && mediaType(h['content-type']) !== 'application/json') {
      problems.push(`attempt ${i + 1}: content-type was "${h['content-type']}", expected application/json`);
    }
    const auth = scenario.request.headers?.['authorization'];
    if (auth && h['authorization'] !== auth) problems.push(`attempt ${i + 1}: authorization header not forwarded unchanged`);
  });
  const id = received[0]?.headers['x-request-id'];
  if (id !== undefined && !UUID.test(id)) problems.push(`x-request-id "${id}" is not a UUID`);
  if (id !== undefined && id !== outcome.requestId) problems.push('requestId in the result is not the one sent on the wire');

  return problems;
}

/**
 * The part of an outcome that has to be identical on every platform.
 * Left out on purpose: message text, the request id value, the exact jittered
 * waits. Those may differ; the behaviour may not.
 */
export function normalise(outcome: Outcome) {
  return outcome.ok
    ? { ok: true, status: outcome.status, attempts: outcome.attempts, waitCount: outcome.waitsMs.length, body: outcome.body }
    : {
        ok: false,
        code: outcome.code,
        status: outcome.status ?? null,
        attempts: outcome.attempts,
        waitCount: outcome.waitsMs.length,
        outcomeUnknown: outcome.outcomeUnknown,
        retryAfterMs: outcome.retryAfterMs ?? null,
      };
}

// The headers the SDK itself is responsible for. Anything else on the wire
// (accept-encoding, connection, accept-language...) belongs to the platform's
// HTTP stack and is allowed to differ between iOS and Android.
const SDK_HEADERS = ['authorization', 'content-type', 'idempotency-key', 'user-agent', 'x-attempt', 'x-request-id'];
// Of those, the ones whose value must also match. The request ID is random and
// the user agent names the platform; both are checked on their own in check().
const SAME_VALUE_HEADERS = ['authorization', 'content-type', 'idempotency-key', 'x-attempt'];

/** What the SDK put on the wire, per attempt, minus values that are allowed to vary. */
export function wireShape(received: Received[]) {
  return received.map((r) => ({
    method: r.method,
    path: r.path,
    sdkHeaders: SDK_HEADERS.filter((h) => r.headers[h] !== undefined),
    headerValues: Object.fromEntries(
      SAME_VALUE_HEADERS.filter((h) => r.headers[h] !== undefined).map((h) => [
        h,
        h === 'content-type' ? mediaType(r.headers[h]) : r.headers[h],
      ]),
    ),
    body: r.body === '' ? '' : canonical(safeParse(r.body)),
  }));
}

// "application/json; charset=utf-8" and "application/json" mean the same thing,
// and OkHttp and URLSession don't agree on adding the charset.
function mediaType(value: string | undefined): string | undefined {
  return value?.split(';')[0]?.trim().toLowerCase();
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return `(not JSON) ${text}`;
  }
}

/** JSON with sorted keys, so two encoders that order keys differently compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

import { describe, expect, it } from 'vitest';
import { check, makeRandom } from '../src/contract/runner.js';
import { loadScenarios, type Scenario } from '../src/contract/scenarios.js';
import type { Outcome } from '../src/contract/types.js';

// Tests for the test code. If check() can't fail, the contract suite proves nothing.

const base: Scenario = loadScenarios().find((s) => s.id === 'post-timeout-no-key')!;

function received(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    method: 'POST',
    path: '/payments',
    body: '{"amount":10}',
    headers: {
      'user-agent': 'PlatformSDK/3.5.0 (ios)',
      'content-type': 'application/json',
      'x-request-id': '11111111-1111-4111-8111-111111111111',
      'x-attempt': String(i + 1),
    },
  }));
}

describe('check()', () => {
  it('passes a result that matches the scenario', () => {
    const outcome: Outcome = {
      ok: false, code: 'TIMEOUT', attempts: 1, outcomeUnknown: true, waitsMs: [],
      requestId: '11111111-1111-4111-8111-111111111111', message: 'x',
    };
    expect(check(base, { outcome, received: received(1) })).toEqual([]);
  });

  it('reports a duplicated POST in plain words', () => {
    const outcome: Outcome = {
      ok: false, code: 'TIMEOUT', attempts: 3, outcomeUnknown: true, waitsMs: [150, 300],
      requestId: '11111111-1111-4111-8111-111111111111', message: 'x',
    };
    const problems = check(base, { outcome, received: received(3) });
    expect(problems).toContain('attempts: expected 1, got 3');
  });

  it('notices spurious or missing backoff waits, even when the attempt count is right', () => {
    const outcome: Outcome = {
      ok: false, code: 'TIMEOUT', attempts: 1, outcomeUnknown: true, waitsMs: [200],
      requestId: '11111111-1111-4111-8111-111111111111', message: 'x',
    };
    expect(check(base, { outcome, received: received(1) })).toContain('number of backoff waits: expected 0, got 1');
  });

  it('notices a wait outside the jitter window', () => {
    const retrying = loadScenarios().find((s) => s.id === 'get-503-then-200')!;
    const outcome: Outcome = {
      ok: true, status: 200, body: {}, attempts: 2, waitsMs: [900], // nominal is 200ms
      requestId: '11111111-1111-4111-8111-111111111111',
    };
    const problems = check(retrying, { outcome, received: received(2).map((r) => ({ ...r, method: 'GET', body: '' })) });
    expect(problems.join('\n')).toMatch(/wait #1: 900ms is outside the allowed 100-200ms/);
  });

  it('notices a request body that changes between attempts', () => {
    const outcome: Outcome = {
      ok: true, status: 201, body: {}, attempts: 2, waitsMs: [150],
      requestId: '11111111-1111-4111-8111-111111111111',
    };
    const withKey = loadScenarios().find((s) => s.id === 'post-key-500-then-201')!;
    const attempts = received(2).map((r) => ({ ...r, body: '{"amount":10}', headers: { ...r.headers, 'idempotency-key': 'key-456' } }));
    attempts[1]!.body = '{"amount":10,"retry":true}';
    expect(check(withKey, { outcome, received: attempts }).join('\n')).toMatch(/attempt 2: body was/);
  });

  it('accepts a body that is the same JSON written differently (key order, spacing)', () => {
    const outcome: Outcome = {
      ok: true, status: 201, body: {}, attempts: 2, waitsMs: [150],
      requestId: '11111111-1111-4111-8111-111111111111',
    };
    const withKey = loadScenarios().find((s) => s.id === 'post-key-500-then-201')!;
    const attempts = received(2).map((r) => ({ ...r, body: '{ "amount" : 10 }', headers: { ...r.headers, 'idempotency-key': 'key-456' } }));
    expect(check(withKey, { outcome, received: attempts })).toEqual([]);
  });

  it('notices when the SDK and the server disagree about how many requests were sent', () => {
    const outcome: Outcome = {
      ok: false, code: 'TIMEOUT', attempts: 1, outcomeUnknown: true, waitsMs: [],
      requestId: '11111111-1111-4111-8111-111111111111', message: 'x',
    };
    expect(check(base, { outcome, received: received(2) }).join('\n')).toMatch(/requests seen by the server/);
  });
});

describe('makeRandom()', () => {
  it('is repeatable for the same seed and stays in [0,1)', () => {
    const a = makeRandom(7), b = makeRandom(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

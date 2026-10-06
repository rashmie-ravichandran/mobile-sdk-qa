import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { makeRandom } from '../src/contract/runner.js';
import { drivers } from '../src/sdk/drivers.js';

// A request that never reached the server is different from one that got no
// answer: nothing can have happened on the other side, so even a POST without
// an idempotency key may be repeated, and the outcome is known.
//
// This isn't in the scenario file because the mock server can't refuse a
// connection for one scenario while serving the others. A native runner would
// do the same as this test: point the SDK at a port nobody listens on.

async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.each(drivers)('connection refused ($platform)', (driver) => {
  it('is retried even for a POST without a key, and reported as not sent', async () => {
    const port = await closedPort();
    const outcome = await driver.execute(
      { method: 'POST', path: '/payments', body: { amount: 10 } },
      { baseUrl: `http://127.0.0.1:${port}`, requestTimeoutMs: 2_000, sleep: async () => {}, random: makeRandom(1) },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NETWORK');
    expect(outcome.outcomeUnknown).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(outcome.waitsMs).toHaveLength(2);
  });
});

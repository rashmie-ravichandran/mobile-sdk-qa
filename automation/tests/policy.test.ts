import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FaultServer } from '../src/mock/faultServer.js';
import { loadCatalogue } from '../src/contract/scenarios.js';
import { POLICY } from '../src/contract/types.js';
import { drivers } from '../src/sdk/drivers.js';

// Backoff numbers, pinned with literals rather than with the constants the
// SDKs use, so changing the constants on their own fails something.
//
// The scenarios only look at wait *windows*, and the stand-ins get a fixed
// random source, so on their own they can't tell "capped" from "not capped" or
// "jittered" from "not jittered". Pushing the random source to its extremes can.

const server = new FaultServer();
beforeAll(() => server.start());
afterAll(() => server.stop());

describe('the SDK constants match the written policy', () => {
  it('has the same numbers as the catalogue', () => {
    expect({ ...POLICY }).toEqual(loadCatalogue().policy);
  });
});

describe.each(drivers)('backoff: $platform SDK', (driver) => {
  async function waitsWithRandom(random: number): Promise<number[]> {
    const { baseUrl } = server.script([{ status: 500 }]);
    const outcome = await driver.execute(
      { method: 'GET', path: '/orders' },
      { baseUrl, requestTimeoutMs: 2_000, sleep: async () => {}, random: () => random },
    );
    return outcome.waitsMs;
  }

  it('waits half of the nominal delay when the jitter draw is 0', async () => {
    // nominal: 200ms, then 400ms capped at 300ms
    expect(await waitsWithRandom(0)).toEqual([100, 150]);
  });

  it('waits the full nominal delay when the jitter draw is just under 1, and the cap holds', async () => {
    const [first, second] = await waitsWithRandom(0.999999);
    expect(first).toBeGreaterThanOrEqual(199);
    expect(first).toBeLessThanOrEqual(200);
    expect(second).toBeGreaterThanOrEqual(299);
    expect(second).toBeLessThanOrEqual(300); // an uncapped 400ms doubling would land here at ~400
  });

  it('actually varies the wait with the random draw', async () => {
    const low = await waitsWithRandom(0.1);
    const high = await waitsWithRandom(0.9);
    expect(high[0]).toBeGreaterThan(low[0]!);
  });
});

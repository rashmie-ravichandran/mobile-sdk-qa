import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FaultServer } from '../src/mock/faultServer.js';
import { loadScenarios } from '../src/contract/scenarios.js';
import { check, runScenario } from '../src/contract/runner.js';
import { drivers } from '../src/sdk/drivers.js';

// One scenario catalogue, run against every platform implementation.
// A red test prints the sentences from check(), not a diff of two big objects.

const scenarios = loadScenarios();
const server = new FaultServer();

beforeAll(() => server.start());
afterAll(() => server.stop());

describe.each(drivers)('networking contract: $platform SDK $sdkVersion', (driver) => {
  describe.concurrent.each(scenarios)('$id', (scenario) => {
    it(`${scenario.title}`, async () => {
      const result = await runScenario(driver, server, scenario);
      expect(check(scenario, result), `why this scenario exists: ${scenario.why}`).toEqual([]);
    });
  });
});

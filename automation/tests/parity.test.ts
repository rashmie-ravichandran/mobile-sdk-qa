import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FaultServer } from '../src/mock/faultServer.js';
import { loadScenarios } from '../src/contract/scenarios.js';
import { normalise, runScenario, wireShape } from '../src/contract/runner.js';
import { androidDriver } from '../src/sdk/androidSdk.js';
import { iosDriver } from '../src/sdk/iosSdk.js';

// The contract tests check each platform against the written spec. This file
// checks the two platforms against each other, which catches drift in things
// the spec doesn't pin down yet (an extra header, a different body encoding).

const scenarios = loadScenarios();
const server = new FaultServer();

beforeAll(() => server.start());
afterAll(() => server.stop());

describe.concurrent.each(scenarios)('parity: $id', (scenario) => {
  it('iOS and Android behave the same and put the same thing on the wire', async () => {
    const [android, ios] = await Promise.all([
      runScenario(androidDriver, server, scenario),
      runScenario(iosDriver, server, scenario),
    ]);

    expect(normalise(ios.outcome), 'observable behaviour').toEqual(normalise(android.outcome));
    expect(wireShape(ios.received), 'what was sent to the server').toEqual(wireShape(android.received));
  });
});

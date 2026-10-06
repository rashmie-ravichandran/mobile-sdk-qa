import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FaultServer } from '../src/mock/faultServer.js';
import { loadScenarios } from '../src/contract/scenarios.js';
import { buildOutcomeFile, verifyOutcomeFiles, type OutcomeFile } from '../src/contract/outcomeFile.js';
import { androidDriver } from '../src/sdk/androidSdk.js';
import { iosDriver } from '../src/sdk/iosSdk.js';

// The file hand-over used between platform jobs and the parity job: build both
// files, then verify them with nothing but the files and the catalogue.

const scenarios = loadScenarios();
const server = new FaultServer();
let android: OutcomeFile;
let ios: OutcomeFile;

beforeAll(async () => {
  await server.start();
  [android, ios] = await Promise.all([buildOutcomeFile(androidDriver, scenarios, server), buildOutcomeFile(iosDriver, scenarios, server)]);
});
afterAll(() => server.stop());

describe('outcome files', () => {
  it('verify cleanly for two platforms that follow the spec', () => {
    expect(verifyOutcomeFiles([android, ios], scenarios)).toEqual([]);
  });

  it('survive a round trip through JSON (what a CI artifact does to them)', () => {
    const roundTripped = JSON.parse(JSON.stringify([android, ios])) as OutcomeFile[];
    expect(verifyOutcomeFiles(roundTripped, scenarios)).toEqual([]);
  });

  it('report a platform that is missing a scenario', () => {
    const missing: OutcomeFile = { ...ios, results: ios.results.filter((r) => r.id !== 'get-404') };
    expect(verifyOutcomeFiles([android, missing], scenarios)).toContain(`ios ${ios.sdkVersion}: no result for scenario "get-404"`);
  });

  it('report a platform that disagrees with the other one', () => {
    const tampered: OutcomeFile = JSON.parse(JSON.stringify(ios));
    const r = tampered.results.find((x) => x.id === 'get-404')!;
    if (r.outcome.ok) throw new Error('unexpected');
    r.outcome.attempts = 2;
    const problems = verifyOutcomeFiles([android, tampered], scenarios).join('\n');
    expect(problems).toContain(`ios ${ios.sdkVersion}: get-404: attempts: expected 1, got 2`);
    expect(problems).toContain('parity: get-404: attempts: android 1, ios 2');
  });

  it('say what differs on the wire, not only that something does', () => {
    const tampered: OutcomeFile = JSON.parse(JSON.stringify(ios));
    const r = tampered.results.find((x) => x.id === 'get-200')!;
    delete r.received[0]!.headers['x-attempt'];
    const problems = verifyOutcomeFiles([android, tampered], scenarios);
    expect(problems).toContain(
      'parity: get-200: request[0].sdkHeaders: android sent ["authorization","user-agent","x-attempt","x-request-id"], ios sent ["authorization","user-agent","x-request-id"]',
    );
  });
});

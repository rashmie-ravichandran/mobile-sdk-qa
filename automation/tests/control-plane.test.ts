import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FaultServer } from '../src/mock/faultServer.js';
import { loadScenarios } from '../src/contract/scenarios.js';
import { verifyOutcomeFiles, type OutcomeFile } from '../src/contract/outcomeFile.js';
import { makeRandom } from '../src/contract/runner.js';
import { androidDriver } from '../src/sdk/androidSdk.js';
import { iosDriver } from '../src/sdk/iosSdk.js';
import type { SdkDriver } from '../src/contract/types.js';

// The flow a native runner would follow, over HTTP only: one run per platform
// covers the whole catalogue (register script, run SDK, post outcome), then the
// host fetches the merged file. Here the stand-in SDKs play the native runners.

const scenarios = loadScenarios();
const server = new FaultServer();
beforeAll(() => server.start());
afterAll(() => server.stop());

async function post(path: string, body: unknown) {
  const res = await fetch(server.baseUrl + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return res.status === 204 ? undefined : ((await res.json()) as Record<string, any>);
}

async function playRunner(driver: SdkDriver, seed: number): Promise<void> {
  for (const scenario of scenarios) {
    const { id, baseUrl } = (await post('/__control/scripts', { steps: scenario.server }))!;
    const outcome = await driver.execute(scenario.request, {
      baseUrl,
      requestTimeoutMs: scenario.config?.requestTimeoutMs ?? 2_000,
      sleep: async () => {},
      random: makeRandom(seed),
    });
    await server.waitForRequests(id, outcome.attempts);
    await post('/__control/outcomes', { platform: driver.platform, sdkVersion: driver.sdkVersion, scenarioId: scenario.id, scriptId: id, outcome });
  }
}

describe('control plane', () => {
  it('lets one run per platform cover the whole catalogue, and the merged files verify', async () => {
    await Promise.all([playRunner(androidDriver, 1), playRunner(iosDriver, 2)]);
    const files = await Promise.all(
      ['android', 'ios'].map(async (p) => (await (await fetch(`${server.baseUrl}/__control/outcome-file/${p}`)).json()) as OutcomeFile),
    );
    expect(files.map((f) => f.results.length)).toEqual([scenarios.length, scenarios.length]);
    expect(verifyOutcomeFiles(files, scenarios)).toEqual([]);
  });

  it('says so when asked for a platform that posted nothing', async () => {
    const res = await fetch(`${server.baseUrl}/__control/outcome-file/windows`);
    expect(res.status).toBe(404);
  });

  it('rejects a malformed script instead of crashing', async () => {
    const res = await fetch(`${server.baseUrl}/__control/scripts`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed server script with the reason', async () => {
    const res = await fetch(server.baseUrl + '/__control/scripts', { method: 'POST', body: JSON.stringify({ steps: [{ status: 'soon' }] }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/steps\.0/);
  });

  it('refuses outcomes from two SDK versions in one file until reset', async () => {
    const { id } = (await post('/__control/scripts', { steps: [{ status: 200 }] }))!;
    const outcome = { ok: true, status: 200, body: null, attempts: 1, requestId: 'x', waitsMs: [] };
    const send = (sdkVersion: string) =>
      fetch(server.baseUrl + '/__control/outcomes', {
        method: 'POST',
        body: JSON.stringify({ platform: 'test', sdkVersion, scenarioId: 'get-200', scriptId: id, outcome }),
      });
    expect((await send('1.0.0')).status).toBe(204);
    expect((await send('2.0.0')).status).toBe(400);
    await fetch(server.baseUrl + '/__control/reset', { method: 'POST' });
    expect((await send('2.0.0')).status).toBe(204);
  });
});

import { FaultServer, type Received } from '../mock/faultServer.js';
import type { Scenario } from './scenarios.js';
import { check, normalise, runScenario, wireShape } from './runner.js';
import type { Outcome, SdkDriver } from './types.js';

// The hand-over format between a platform's native runner and the comparison
// step. In the real setup:
//
//   1. a host-side script starts the mock server and launches the native run
//      (instrumented tests on Android, XCTest on iOS) with the control URL;
//   2. the native runner reads the scenario file itself, registers each
//      server script through the control plane, calls the real SDK and posts
//      back only the `outcome`;
//   3. the mock server joins each outcome with what it received, and the host
//      script downloads the result as one file per platform;
//   4. the comparison step reads those files, nothing else.
//
// Because step 4 only needs files, "parity" can be its own CI job that depends
// on the two platform jobs and uploads/downloads their artifacts.

export interface OutcomeFile {
  schemaVersion: 1;
  platform: string;
  sdkVersion: string;
  results: { id: string; outcome: Outcome; received: Received[] }[];
}

export async function buildOutcomeFile(driver: SdkDriver, scenarios: Scenario[], server: FaultServer): Promise<OutcomeFile> {
  const results: OutcomeFile['results'] = [];
  for (const scenario of scenarios) {
    const { outcome, received } = await runScenario(driver, server, scenario);
    results.push({ id: scenario.id, outcome, received });
  }
  return { schemaVersion: 1, platform: driver.platform, sdkVersion: driver.sdkVersion, results };
}

/** Check each file against the scenarios, then the files against each other. Returns plain sentences. */
export function verifyOutcomeFiles(files: OutcomeFile[], scenarios: Scenario[]): string[] {
  const problems: string[] = [];

  for (const file of files) {
    const label = `${file.platform} ${file.sdkVersion}`;
    for (const scenario of scenarios) {
      const result = file.results.find((r) => r.id === scenario.id);
      if (!result) {
        problems.push(`${label}: no result for scenario "${scenario.id}"`);
        continue;
      }
      for (const p of check(scenario, result)) problems.push(`${label}: ${scenario.id}: ${p}`);
    }
    for (const r of file.results) {
      if (!scenarios.some((s) => s.id === r.id)) problems.push(`${label}: result for unknown scenario "${r.id}"`);
    }
  }

  const [first, ...others] = files;
  for (const other of others) {
    if (!first) break;
    for (const scenario of scenarios) {
      const a = first.results.find((r) => r.id === scenario.id);
      const b = other.results.find((r) => r.id === scenario.id);
      if (!a || !b) continue;
      for (const d of differences(normalise(a.outcome), normalise(b.outcome))) {
        problems.push(`parity: ${scenario.id}: ${d.path}: ${first.platform} ${d.left}, ${other.platform} ${d.right}`);
      }
      for (const d of differences(wireShape(a.received), wireShape(b.received), 'request')) {
        problems.push(`parity: ${scenario.id}: ${d.path}: ${first.platform} sent ${d.left}, ${other.platform} sent ${d.right}`);
      }
    }
  }
  return problems;
}

/** Where two JSON-like values differ, as readable paths ("attempts", "request[1].sdkHeaders"). */
export function differences(left: unknown, right: unknown, path = ''): { path: string; left: string; right: string }[] {
  const show = (v: unknown) => (v === undefined ? '(missing)' : JSON.stringify(v));
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      const flat = [...left, ...right].every((v) => v === null || typeof v !== 'object');
      return flat
        ? [{ path: path || 'value', left: show(left), right: show(right) }]
        : [{ path: `${path || 'value'} count`, left: String(left.length), right: String(right.length) }];
    }
    return left.flatMap((v, i) => differences(v, right[i], `${path}[${i}]`));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    return keys.flatMap((k) =>
      differences((left as Record<string, unknown>)[k], (right as Record<string, unknown>)[k], path ? `${path}.${k}` : k),
    );
  }
  return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ path: path || 'value', left: show(left), right: show(right) }];
}

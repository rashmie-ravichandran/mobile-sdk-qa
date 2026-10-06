import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { makeRandom } from '../src/contract/runner.js';
import type { RunRecord } from './flake-triage.js';

// Made-up CI history for the 3.4 -> 3.5 investigation scenario. Nothing in it
// comes from a real system. `npm run triage` generates it into data/ (not
// committed) and then analyses it.
//
// The planted cause, so the triage tool has something to find:
//   iOS only, and only when payments@3.5.0 AND telemetry@3.5.0 are both in the
//   build, and only when the test runs late in the order (so something earlier
//   already touched the shared state). That fails about a third of the time.
// Plus background noise that has nothing to do with it: one simulator pool
// that times out now and then, and a very low random failure rate everywhere.

export function generateRuns(count = 8_000, seed = 20260105): RunRecord[] {
const rnd = makeRandom(seed);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

const tests = ['checkout_flow', 'login_flow', 'profile_load', 'settings_sync'];
const records: RunRecord[] = [];

for (let i = 0; i < count; i++) {
  const platform = pick(['ios', 'android'] as const);
  const payments = pick(['3.4.0', '3.5.0']);
  const telemetry = pick(['3.4.0', '3.5.0']);
  const osVersion = platform === 'ios' ? pick(['17.5', '18.0']) : pick(['13', '14']);
  const runner = platform === 'ios' ? pick(['sim-pool-1', 'sim-pool-2']) : pick(['emu-pool-1', 'emu-pool-2']);
  const test = pick(tests);
  const orderIndex = Math.floor(rnd() * 8); // position of the test within its run, 0-7

  const planted =
    platform === 'ios' && payments === '3.5.0' && telemetry === '3.5.0' && orderIndex >= 3 && test === 'checkout_flow';
  const poolNoise = runner === 'sim-pool-2' && rnd() < 0.04;
  const background = rnd() < 0.004;
  const failed = (planted && rnd() < 0.35) || poolNoise || background;

  records.push({
    runId: `run-${String(i).padStart(4, '0')}`,
    test,
    platform,
    osVersion,
    runner,
    modules: { payments, telemetry, auth: '3.4.0' },
    orderIndex,
    result: failed ? 'fail' : 'pass',
    // Intermittent means it often passes when you simply run it again.
    passedOnRerun: failed ? rnd() < 0.7 : null,
    durationMs: Math.round((poolNoise ? 30_000 : 4_000) + rnd() * 1_500),
  });
}

return records;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = new URL('../data/synthetic-runs.json', import.meta.url);
  mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
  const records = generateRuns();
  writeFileSync(out, JSON.stringify(records));
  console.log(`wrote ${records.length} synthetic runs, ${records.filter((r) => r.result === 'fail').length} failures, to data/synthetic-runs.json`);
}

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Takes run history (one record per test execution) and ranks the conditions
// that best explain the failures of one test. It does not prove a cause. It
// turns "it fails sometimes and nobody can reproduce it" into a short list of
// things to try to reproduce on purpose.

export interface RunRecord {
  runId: string;
  test: string;
  platform: string;
  osVersion: string;
  runner: string;
  modules: Record<string, string>;
  orderIndex: number;
  result: 'pass' | 'fail';
  passedOnRerun: boolean | null;
  durationMs: number;
}

export interface Suspect {
  conditions: string[];
  runs: number;
  failures: number;
  precision: number; // when these conditions hold, how often does it fail
  recall: number; // of all failures, how many had these conditions
  score: number;
  lift: number; // precision relative to the overall failure rate of the test
}

const MIN_RUNS = 15; // a group smaller than this tells us nothing
const MIN_LIFT = 2; // a group that fails less than twice as often as average explains little
const MAX_CONDITIONS = 4;

function featuresOf(r: RunRecord): string[] {
  return [
    `platform=${r.platform}`,
    `os=${r.osVersion}`,
    `runner=${r.runner}`,
    ...Object.entries(r.modules).map(([m, v]) => `${m}@${v}`),
    // Position in the run is a number, so offer several cut-offs and let the
    // data pick one. Nothing here knows where the real threshold is.
    ...[2, 3, 4, 5].map((k) => `order${r.orderIndex >= k ? '>=' : '<'}${k}`),
  ];
}

function combinations<T>(items: T[], max: number): T[][] {
  const out: T[][] = [];
  const walk = (start: number, chosen: T[]) => {
    if (chosen.length > 0) out.push([...chosen]);
    if (chosen.length === max) return;
    for (let i = start; i < items.length; i++) walk(i + 1, [...chosen, items[i]!]);
  };
  walk(0, []);
  return out;
}

export function rankSuspects(records: RunRecord[], test: string): Suspect[] {
  const runs = records.filter((r) => r.test === test);
  const totalFailures = runs.filter((r) => r.result === 'fail').length;
  if (totalFailures === 0) return [];

  const rows = runs.map((r) => ({ features: new Set(featuresOf(r)), failed: r.result === 'fail' }));
  // A condition that is true for every run (auth@3.4.0 in the sample data) can't
  // explain why only some runs fail, so it is left out.
  const allFeatures = [...new Set(rows.flatMap((r) => [...r.features]))]
    .filter((f) => rows.some((r) => !r.features.has(f)))
    .sort();

  const suspects: Suspect[] = [];
  for (const conditions of combinations(allFeatures, MAX_CONDITIONS)) {
    const matching = rows.filter((r) => conditions.every((c) => r.features.has(c)));
    if (matching.length < MIN_RUNS) continue;
    const failures = matching.filter((r) => r.failed).length;
    if (failures === 0) continue;
    const precision = failures / matching.length;
    const recall = failures / totalFailures;
    const lift = precision / (totalFailures / runs.length);
    if (lift < MIN_LIFT) continue;
    suspects.push({ conditions, runs: matching.length, failures, precision, recall, lift, score: (2 * precision * recall) / (precision + recall) });
  }

  // Best explanation first. On a tie prefer fewer conditions: don't add a
  // condition that doesn't earn its place.
  return suspects.sort((a, b) => b.score - a.score || a.conditions.length - b.conditions.length);
}

/** How many times to run something to see a failure at least once, with the given confidence. */
export function runsNeeded(failureRate: number, confidence = 0.95): number {
  return Math.ceil(Math.log(1 - confidence) / Math.log(1 - failureRate));
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: tsx tools/flake-triage.ts <runs.json> [test-name]');
    process.exit(2);
  }
  const records = JSON.parse(readFileSync(file, 'utf8')) as RunRecord[];

  // Default to the test with the most failures.
  const failuresByTest = new Map<string, number>();
  for (const r of records) if (r.result === 'fail') failuresByTest.set(r.test, (failuresByTest.get(r.test) ?? 0) + 1);
  const test = process.argv[3] ?? [...failuresByTest.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!test) {
    console.log('no failures in this data set');
    return;
  }

  const runs = records.filter((r) => r.test === test);
  const failed = runs.filter((r) => r.result === 'fail');
  const rerunPass = failed.filter((r) => r.passedOnRerun).length;
  const overall = failed.length / runs.length;

  console.log(`Data: ${file} (${records.length} runs)`);
  console.log(`Test: ${test}: ${failed.length} failures in ${runs.length} runs (${(overall * 100).toFixed(1)}%), ${rerunPass} of them passed when re-run\n`);
  console.log('Best explanations (precision = how often it fails when this holds, recall = share of all failures it covers):\n');

  for (const s of rankSuspects(records, test).slice(0, 6)) {
    console.log(
      `  ${s.conditions.join(' + ').padEnd(60)} runs ${String(s.runs).padStart(3)}  fails ${String(s.failures).padStart(3)}  ` +
        `precision ${(s.precision * 100).toFixed(0).padStart(3)}%  recall ${(s.recall * 100).toFixed(0).padStart(3)}%  lift ${s.lift.toFixed(1)}x`,
    );
  }

  const top = rankSuspects(records, test)[0];
  if (top) {
    console.log(`\nTo reproduce on purpose, run exactly that combination. At ${(top.precision * 100).toFixed(0)}% per run you need about ${runsNeeded(top.precision)} runs to see it with 95% confidence.`);
    console.log('This is a search over many combinations, so some of what it finds is chance. Treat it as a list of hypotheses to test, not as the answer.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

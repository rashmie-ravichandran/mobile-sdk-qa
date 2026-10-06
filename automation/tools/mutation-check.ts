import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAULTS } from '../src/sdk/faults.js';

// "Do the tests notice when the code is wrong?" is a different question from
// "do the tests pass?". This switches on one planted mistake at a time (see
// src/sdk/faults.ts) and requires the suite to go red for each. A survivor
// means there is a behaviour nobody is checking.
//
// Two guards against fooling ourselves:
//   - a baseline run with no fault must be fully green, otherwise "red" means nothing;
//   - a fault only counts as caught if real tests ran and at least one failed,
//     so a crashing harness can't pass as "caught".
//
// It is a hand-made version of mutation testing: a few realistic mistakes, not
// thousands of automatic ones. On real native code I'd use a mutation tool.

const TESTS = ['tests/networking.contract.test.ts', 'tests/parity.test.ts', 'tests/module-interaction.test.ts', 'tests/policy.test.ts', 'tests/not-sent.test.ts'];
const PARALLEL = 3;

interface Run {
  fault: string;
  total: number;
  failed: string[];
  harnessError?: string;
}

function run(fault: string): Promise<Run> {
  return new Promise((resolve) => {
    // The JSON report goes to a file of its own, so nothing else printed on
    // stdout can break the parsing (and newer Vitest versions write it to a file anyway).
    const dir = mkdtempSync(join(tmpdir(), 'mutation-'));
    const reportFile = join(dir, 'report.json');
    const child = spawn('npx', ['vitest', 'run', '--reporter=json', `--outputFile.json=${reportFile}`, ...TESTS], {
      env: { ...process.env, SDK_FAULTS: fault, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', () => {
      try {
        const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
          numTotalTests: number;
          testResults: { assertionResults: { status: string; fullName: string }[] }[];
        };
        const failed = report.testResults.flatMap((f) => f.assertionResults).filter((a) => a.status === 'failed').map((a) => a.fullName);
        resolve({ fault, total: report.numTotalTests, failed });
      } catch {
        resolve({ fault, total: 0, failed: [], harnessError: (err || out).slice(0, 300) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

async function main(): Promise<void> {
  const baseline = await run('');
  if (baseline.harnessError || baseline.total === 0 || baseline.failed.length > 0) {
    console.error(`The unmodified suite is not green (${baseline.total} tests, ${baseline.failed.length} failed). Fix that before mutating.`);
    if (baseline.harnessError) console.error(baseline.harnessError);
    process.exit(2);
  }
  console.log(`Baseline: ${baseline.total} tests, all green.\n`);

  const results: Run[] = [];
  const queue = [...FAULTS];
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      for (let f = queue.shift(); f !== undefined; f = queue.shift()) results.push(await run(f));
    }),
  );
  results.sort((a, b) => FAULTS.indexOf(a.fault as (typeof FAULTS)[number]) - FAULTS.indexOf(b.fault as (typeof FAULTS)[number]));

  console.log('Planted fault'.padEnd(42), 'Result'.padEnd(10), 'Failing tests');
  const survivors: string[] = [];
  for (const r of results) {
    const caught = !r.harnessError && r.total > 0 && r.failed.length > 0;
    if (!caught) survivors.push(r.fault + (r.harnessError ? ' (harness error)' : ''));
    console.log(r.fault.padEnd(42), (caught ? 'caught' : 'MISSED').padEnd(10), caught ? r.failed.length : '-');
  }
  console.log(`\n${results.length - survivors.length} of ${results.length} planted faults caught.`);
  if (survivors.length > 0) {
    console.error(`Not caught: ${survivors.join(', ')}`);
    process.exit(1);
  }
}

void main();

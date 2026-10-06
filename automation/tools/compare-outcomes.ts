import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadScenarios } from '../src/contract/scenarios.js';
import { verifyOutcomeFiles, type OutcomeFile } from '../src/contract/outcomeFile.js';

// usage: tsx tools/compare-outcomes.ts <android.json> <ios.json>
// The "parity" job: reads the two platform artifacts, checks each against the
// scenario catalogue, then against each other. Exit 1 if anything differs.

const paths = process.argv.slice(2);
if (paths.length < 2) {
  console.error('usage: tsx tools/compare-outcomes.ts <platform-a.json> <platform-b.json>');
  process.exit(2);
}

// Native runners produce these files, so check them instead of trusting them.
const outcomeFile = z.object({
  schemaVersion: z.literal(1),
  platform: z.string().min(1),
  sdkVersion: z.string().min(1),
  results: z.array(z.object({ id: z.string(), outcome: z.object({ ok: z.boolean(), attempts: z.number().int() }).passthrough(), received: z.array(z.any()) })),
});

const files = paths.map((p) => {
  const parsed = outcomeFile.safeParse(JSON.parse(readFileSync(p, 'utf8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    console.error(`${p}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    process.exit(2);
  }
  const ids = parsed.data.results.map((r) => r.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) {
    console.error(`${p}: scenario "${dup}" appears more than once`);
    process.exit(2);
  }
  return parsed.data as unknown as OutcomeFile;
});
const platforms = files.map((f) => f.platform);
if (new Set(platforms).size !== platforms.length) {
  console.error(`the same platform was given twice (${platforms.join(', ')})`);
  process.exit(2);
}
const scenarios = loadScenarios();
const problems = verifyOutcomeFiles(files, scenarios);

if (problems.length === 0) {
  console.log(`${scenarios.length} scenarios x ${files.length} platforms: all as specified, and the platforms agree.`);
} else {
  console.error(`${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

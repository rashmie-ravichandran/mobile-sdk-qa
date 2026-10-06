import { describe, expect, it } from 'vitest';
import { rankSuspects, runsNeeded } from '../tools/flake-triage.js';
import { generateRuns } from '../tools/make-synthetic-runs.js';

// The ranking is computed once; it is the slow part.
const records = generateRuns();
const ranked = rankSuspects(records, 'checkout_flow');

describe('flake triage on the synthetic data', () => {
  it('puts a combination containing the planted conditions first', () => {
    // The generator plants "late in the run" as position >= 3. The tool is only
    // offered several cut-offs, so landing on 3 is the data's doing.
    const top = ranked[0]!;
    expect(top.conditions).toEqual(expect.arrayContaining(['order>=3', 'payments@3.5.0', 'telemetry@3.5.0', 'platform=ios']));
    expect(top.lift).toBeGreaterThan(5);
  });

  it('shows the noisy simulator pool as a weaker lead, not the answer', () => {
    expect(ranked.findIndex((s) => s.conditions.includes('runner=sim-pool-2'))).toBeGreaterThan(0);
  });

  it('does not blame a test that never fails', () => {
    expect(rankSuspects(records.map((r) => ({ ...r, result: 'pass' as const })), 'checkout_flow')).toEqual([]);
  });

  it('ignores conditions that are true for every run', () => {
    expect(ranked.flatMap((s) => s.conditions)).not.toContain('auth@3.4.0');
  });

  it('is repeatable for the same seed and differs for another', () => {
    expect(generateRuns(500, 1)).toEqual(generateRuns(500, 1));
    expect(generateRuns(500, 1)).not.toEqual(generateRuns(500, 2));
  });
});

describe('runsNeeded()', () => {
  it('matches the textbook number: a 1-in-10 failure needs 29 runs for 95% confidence', () => {
    expect(runsNeeded(0.1)).toBe(29);
  });
});

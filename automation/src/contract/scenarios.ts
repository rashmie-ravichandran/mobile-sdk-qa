import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// The scenario catalogue is plain JSON on purpose. The Kotlin and Swift test
// targets read the same file, so "what should the SDK do when the server says
// 503" is written down once and not once per platform.
//
// zod is only here to reject a malformed catalogue early, with a message that
// says where. The shape of the file is documented for the native runners in
// native-runners/README.md.

const method = z.enum(['GET', 'POST', 'PUT', 'DELETE']);
const errorCode = z.enum(['CLIENT_ERROR', 'UNAUTHENTICATED', 'RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK', 'DECODE_ERROR']);

export const stepSchema = z.union([
  z
    .object({
      status: z.number().int().min(100).max(599),
      headers: z.record(z.string()).optional(),
      json: z.unknown().optional(),
      raw: z.string().optional(),
      delayMs: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ drop: z.literal(true), delayMs: z.number().int().positive().optional() }).strict(),
]);

const scenario = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(5),
    why: z.string().min(10), // the failure this scenario exists to catch
    request: z
      .object({
        method,
        path: z.string().startsWith('/'),
        headers: z.record(z.string()).optional(),
        body: z.unknown().optional(),
        idempotencyKey: z.string().optional(),
      })
      .strict(),
    server: z.array(stepSchema).min(1),
    config: z.object({ requestTimeoutMs: z.number().int().positive() }).strict().optional(),
    expect: z
      .object({
        ok: z.boolean(),
        status: z.number().int().optional(),
        code: errorCode.optional(),
        attempts: z.number().int().min(1),
        outcomeUnknown: z.boolean().optional(),
        retryAfterMs: z.number().int().optional(),
        body: z.unknown().optional(),
        // Floor for every backoff wait, for scenarios where the server said how long to wait.
        waitAtLeastMs: z.number().int().positive().optional(),
        // Strings that must not appear anywhere in the result.
        mustNotLeak: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (!s.expect.ok && !s.expect.code) ctx.addIssue({ code: 'custom', message: 'a failing scenario must name the expected error code' });
    if (s.expect.ok && s.expect.code) ctx.addIssue({ code: 'custom', message: 'a successful scenario cannot have an error code' });
  });

// The policy the checker holds the SDKs to. It is deliberately a separate copy
// of the numbers the stand-in SDKs use (POLICY in types.ts): if only one side is
// changed, a test fails.
const policy = z
  .object({
    maxAttempts: z.number().int().min(1),
    baseDelayMs: z.number().int().positive(),
    maxDelayMs: z.number().int().positive(),
    jitterFloor: z.number().min(0).max(1),
    maxRetryAfterMs: z.number().int().positive(),
  })
  .strict();

const catalogue = z
  .object({ schemaVersion: z.literal(1), policy, scenarios: z.array(scenario).min(1) })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    for (const s of c.scenarios) {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', message: `duplicate scenario id "${s.id}"` });
      seen.add(s.id);
    }
  });

export type Scenario = z.infer<typeof scenario>;
export type Policy = z.infer<typeof policy>;
export interface Catalogue {
  policy: Policy;
  scenarios: Scenario[];
}

const CATALOGUE_PATH = fileURLToPath(new URL('../../scenarios/networking.scenarios.json', import.meta.url));

export function parseCatalogue(raw: unknown, where = 'catalogue'): Catalogue {
  const result = catalogue.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new Error(`${where}: ${first.path.join('.') || '(root)'}: ${first.message}`);
  }
  return { policy: result.data.policy, scenarios: result.data.scenarios };
}

export function loadCatalogue(path: string = CATALOGUE_PATH): Catalogue {
  return parseCatalogue(JSON.parse(readFileSync(path, 'utf8')), path);
}

export function loadScenarios(path: string = CATALOGUE_PATH): Scenario[] {
  return loadCatalogue(path).scenarios;
}

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { stepSchema } from '../contract/scenarios.js';

// A small HTTP server that plays back a script of responses, one per request,
// and remembers exactly what it received. The last step repeats if the client
// keeps asking.
//
// Each scenario gets its own id (and so its own counter), which is what lets
// the tests run in parallel without stepping on each other.

export type Step =
  | {
      status: number;
      headers?: Record<string, string>;
      json?: unknown;
      raw?: string; // sent as-is, for malformed bodies
      delayMs?: number;
    }
  | { drop: true; delayMs?: number }; // kill the socket without answering

// What a native runner sends back. Kept structural on purpose; the typed
// version of the same shape is OutcomeFile in contract/outcomeFile.ts.
interface StoredOutcome {
  scenarioId: string;
  scriptId: string;
  outcome: unknown;
}

// Input from a native runner is checked before it is stored, so a broken
// runner gets a 400 with the reason instead of producing a confusing file later.
const scriptsBody = z.object({ steps: z.array(stepSchema).min(1) }).strict();
const outcomeBody = z
  .object({
    platform: z.string().regex(/^[a-z]+$/),
    sdkVersion: z.string().min(1),
    scenarioId: z.string().min(1),
    scriptId: z.string().uuid(),
    outcome: z.object({ ok: z.boolean() }).passthrough(),
  })
  .strict();

export interface Received {
  index: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export class FaultServer {
  private server = http.createServer((req, res) => this.handle(req, res));
  private scripts = new Map<string, Step[]>();
  private logs = new Map<string, Received[]>();
  private timers = new Set<NodeJS.Timeout>();
  private outcomes = new Map<string, { sdkVersion: string; results: StoredOutcome[] }>();
  baseUrl = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Register a script and get back the base URL the SDK under test should use. */
  script(steps: Step[]): { id: string; baseUrl: string } {
    if (steps.length === 0) throw new Error('a scenario needs at least one server step');
    const id = randomUUID();
    this.scripts.set(id, steps);
    this.logs.set(id, []);
    return { id, baseUrl: `${this.baseUrl}/s/${id}` };
  }

  received(id: string): Received[] {
    return this.logs.get(id) ?? [];
  }

  /** Resolve once the server has logged at least `count` requests for this scenario (or after `maxMs`). */
  async waitForRequests(id: string, count: number, maxMs = 2_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while ((this.logs.get(id)?.length ?? 0) < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  // Control plane, so a native runner needs no host script per scenario: it
  // registers each scenario's server script, runs the SDK against the returned
  // base URL, and posts its outcome. One instrumentation / xcodebuild run per
  // platform covers the whole catalogue. The host script then fetches the merged
  // file (outcomes joined with what the server actually received).
  //
  //   POST /__control/scripts              { steps }                                   -> { id, baseUrl }
  //   POST /__control/outcomes             { platform, sdkVersion, scenarioId, scriptId, outcome }
  //   GET  /__control/outcome-file/:platform                                           -> OutcomeFile
  //   POST /__control/reset                forget all posted outcomes (start of a run)
  private control(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      try {
        const url = req.url ?? '';
        const text = Buffer.concat(chunks).toString('utf8');
        if (req.method === 'POST' && url === '/__control/scripts') {
          const { steps } = scriptsBody.parse(JSON.parse(text));
          return send(200, this.script(steps as Step[]));
        }
        if (req.method === 'POST' && url === '/__control/reset') {
          this.outcomes.clear();
          return send(204, {});
        }
        if (req.method === 'POST' && url === '/__control/outcomes') {
          const o = outcomeBody.parse(JSON.parse(text));
          if (!this.scripts.has(o.scriptId)) return send(400, { error: `unknown scriptId ${o.scriptId}` });
          const entry = this.outcomes.get(o.platform) ?? { sdkVersion: o.sdkVersion, results: [] };
          if (entry.sdkVersion !== o.sdkVersion) {
            return send(400, { error: `${o.platform} already posted results for ${entry.sdkVersion}, got ${o.sdkVersion}; reset first` });
          }
          entry.results.push({ scenarioId: o.scenarioId, scriptId: o.scriptId, outcome: o.outcome });
          this.outcomes.set(o.platform, entry);
          return send(204, {});
        }
        const file = /^\/__control\/outcome-file\/([a-z]+)$/.exec(url);
        if (req.method === 'GET' && file) {
          const platform = file[1]!;
          const entry = this.outcomes.get(platform);
          if (!entry) return send(404, { error: `no outcomes posted for ${platform}` });
          return send(200, {
            schemaVersion: 1,
            platform,
            sdkVersion: entry.sdkVersion,
            results: entry.results.map((r) => ({ id: r.scenarioId, outcome: r.outcome, received: this.received(r.scriptId) })),
          });
        }
        return send(404, { error: 'unknown control endpoint' });
      } catch (e) {
        const reason = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') : e instanceof Error ? e.message : String(e);
        return send(400, { error: reason });
      }
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url?.startsWith('/__control/')) return this.control(req, res);
    const match = /^\/s\/([0-9a-f-]{36})(\/.*)?$/.exec(req.url ?? '');
    const id = match?.[1];
    const steps = id ? this.scripts.get(id) : undefined;
    if (!id || !steps) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown scenario' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const log = this.logs.get(id)!;
      const index = log.length;
      log.push({
        index,
        method: req.method ?? '',
        path: match?.[2] ?? '/',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')]),
        ),
        body: Buffer.concat(chunks).toString('utf8'),
      });

      const step = steps[Math.min(index, steps.length - 1)]!;
      const respond = () => {
        if (res.destroyed || req.socket.destroyed) return;
        if ('drop' in step) {
          req.socket.destroy();
          return;
        }
        const body = step.raw ?? (step.json === undefined ? '' : JSON.stringify(step.json));
        res.writeHead(step.status, {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...step.headers,
        });
        res.end(body);
      };

      if (step.delayMs) {
        const t = setTimeout(respond, step.delayMs);
        this.timers.add(t);
        t.unref();
      } else {
        respond();
      }
    });
  }
}

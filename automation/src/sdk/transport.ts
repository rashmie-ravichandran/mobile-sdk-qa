import http from 'node:http';

// One HTTP attempt, no policy. In the real SDKs this is OkHttp on Android and
// URLSession on iOS, so it is fine that both simulated SDKs share it. All the
// behaviour the contract cares about (retries, mapping, headers) sits above it.

export type AttemptResult =
  | { kind: 'response'; status: number; headers: Record<string, string>; text: string }
  // `sent` is false when the failure happened before the whole request was
  // handed to the network (connection refused, connect timeout). The server
  // cannot have acted on it, so it is safe to repeat and its outcome is known.
  | { kind: 'timeout'; sent: boolean }
  | { kind: 'network'; reason: string; sent: boolean };

const CONNECT_TIMEOUT_MS = 5_000;

export function singleAttempt(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<AttemptResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: AttemptResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        done({
          kind: 'response',
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')]),
          ),
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (e) => done({ kind: 'network', reason: e.message, sent: true }));
    });

    // Two clocks, a simplification of what real stacks do (OkHttp has separate
    // connect / read / write / call timeouts; URLSession's request timeout is an
    // idle timeout, see native-runners/README.md):
    //   - connecting and sending the request get a fixed, generous limit, so a
    //     server that never accepts the connection can't hang a test forever;
    //   - the configured timeout starts once the request has been sent, so a
    //     busy machine can't "time out" a request that never left.
    let sent = false;
    const connectTimer = setTimeout(() => {
      done({ kind: 'timeout', sent: false });
      req.destroy();
    }, CONNECT_TIMEOUT_MS);
    let timer: NodeJS.Timeout | undefined;
    req.on('finish', () => {
      sent = true;
      clearTimeout(connectTimer);
      if (settled) return;
      timer = setTimeout(() => {
        done({ kind: 'timeout', sent: true });
        req.destroy();
      }, timeoutMs);
    });

    req.on('error', (e) => done({ kind: 'network', reason: e.message, sent }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

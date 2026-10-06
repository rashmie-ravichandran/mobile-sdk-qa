import { fault } from '../sdk/faults.js';
import { singleAttempt } from '../sdk/transport.js';

// A tiny model of the situation in the brief: several SDK modules that share
// one resource. Here the shared resource is the default header set of the
// HTTP session, the way two real modules might share a URLSession configuration
// or an OkHttp client. Each module adds what it needs when it is initialised.
//
// Nothing here is a real SDK. It exists so there is something concrete to
// show an order-dependent interaction bug with, and how to reproduce it on
// purpose instead of waiting for it.

export class SharedSession {
  defaultHeaders: Record<string, string> = {};

  async get(baseUrl: string, path: string) {
    return singleAttempt(baseUrl + path, 'GET', this.defaultHeaders, undefined, 2_000);
  }
}

export type ModuleName = 'payments' | 'telemetry' | 'config';

export const MODULES: Record<ModuleName, { header: string; init(session: SharedSession): void }> = {
  payments: {
    header: 'authorization',
    init(session) {
      session.defaultHeaders = { ...session.defaultHeaders, authorization: 'Bearer test-token' };
    },
  },
  telemetry: {
    header: 'x-telemetry-session',
    init(session) {
      // The planted 3.5 mistake: assigning instead of merging. It wipes whatever
      // modules that were initialised earlier put there. Nothing breaks if
      // telemetry happens to be initialised first.
      session.defaultHeaders = fault('telemetry:replace-shared-headers')
        ? { 'x-telemetry-session': 's-1' }
        : { ...session.defaultHeaders, 'x-telemetry-session': 's-1' };
    },
  },
  config: {
    header: 'x-config-version',
    init(session) {
      session.defaultHeaders = { ...session.defaultHeaders, 'x-config-version': '12' };
    },
  },
};

export function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

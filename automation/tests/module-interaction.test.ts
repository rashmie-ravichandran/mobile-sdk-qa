import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FaultServer } from '../src/mock/faultServer.js';
import { MODULES, SharedSession, permutations, type ModuleName } from '../src/modules/sharedSession.js';

// An init-order interaction between modules that share a resource.
//
// In a real app the order depends on things nobody controls directly: which
// screen loads first, lazy initialisation, test order. So the failure looks
// random. Here we don't wait for it: we try every order, and the name of the
// failing test is the reproduction recipe.

const server = new FaultServer();
beforeAll(() => server.start());
afterAll(() => server.stop());

const names = Object.keys(MODULES) as ModuleName[];

describe.concurrent.each(permutations(names).map((order) => ({ order, label: order.join(' -> ') })))(
  'modules initialised in order: $label',
  ({ order }) => {
    it('every module\'s headers are still on the wire', async () => {
      const session = new SharedSession();
      for (const name of order) MODULES[name].init(session);

      const { id, baseUrl } = server.script([{ status: 200, json: {} }]);
      await session.get(baseUrl, '/ping');
      await server.waitForRequests(id, 1);

      const headers = server.received(id)[0]!.headers;
      const missing = names.filter((n) => headers[MODULES[n].header] === undefined).map((n) => `${n} (${MODULES[n].header})`);
      expect(missing, 'headers lost to another module overwriting the shared session').toEqual([]);
    });
  },
);

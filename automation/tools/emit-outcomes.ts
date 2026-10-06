import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FaultServer } from '../src/mock/faultServer.js';
import { loadScenarios } from '../src/contract/scenarios.js';
import { buildOutcomeFile } from '../src/contract/outcomeFile.js';
import { drivers } from '../src/sdk/drivers.js';

// usage: tsx tools/emit-outcomes.ts <android|ios> <out.json>
// Plays the host-side role for one platform, with the stand-in SDK in place of
// the native runner. See src/contract/outcomeFile.ts for the real-world flow.

const [platform, out] = process.argv.slice(2);
const driver = drivers.find((d) => d.platform === platform);
if (!driver || !out) {
  console.error('usage: tsx tools/emit-outcomes.ts <android|ios> <out.json>');
  process.exit(2);
}

const server = new FaultServer();
await server.start();
try {
  const file = await buildOutcomeFile(driver, loadScenarios(), server);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(file, null, 1));
  console.log(`wrote ${file.results.length} results for ${file.platform} ${file.sdkVersion} to ${out}`);
} finally {
  await server.stop();
}

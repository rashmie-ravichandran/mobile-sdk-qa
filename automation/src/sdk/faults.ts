// Test seams for the stand-in SDKs. Each fault is a small, realistic mistake a
// refactor could introduce. They are all off by default. The mutation check
// (tools/mutation-check.ts) switches them on one at a time and requires the
// contract suite to go red for every one.
//
//   SDK_FAULTS=ios:retry-post-on-timeout npm test
//
// The seams are only here because the SDKs are stand-ins. A real SDK would get
// the same effect from mutation testing tools on the native code.

export const FAULTS = [
  'ios:retry-post-on-timeout',
  'ios:retry-401',
  'ios:drop-idempotency-key-on-retry',
  'ios:wrong-code-after-last-429',
  'ios:retry-408',
  'ios:no-jitter',
  'ios:lenient-retry-after',
  'ios:5xx-outcome-known',
  'ios:wrong-content-type',
  'android:new-request-id-per-attempt',
  'android:ignore-retry-after',
  'android:retry-404',
  'android:leak-query-in-message',
  'android:four-attempts',
  'android:no-delay-cap',
  'android:retry-after-too-long-waited',
  'android:retry-body-changes',
  'android:retry-unkeyed-post-on-429-503',
  'android:not-sent-treated-as-sent',
  'telemetry:replace-shared-headers',
] as const;

export type Fault = (typeof FAULTS)[number];

function load(): Set<string> {
  const active = new Set((process.env.SDK_FAULTS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  // "iOS 3.5.0" is the story: that release started retrying POSTs after a timeout.
  if (/^3\.5(\.|$)/.test(process.env.IOS_SDK_VERSION ?? '')) active.add('ios:retry-post-on-timeout');
  for (const f of active) {
    if (!(FAULTS as readonly string[]).includes(f)) throw new Error(`unknown fault "${f}". Known: ${FAULTS.join(', ')}`);
  }
  return active;
}

export const faultsOn = load();
export const fault = (name: Fault): boolean => faultsOn.has(name);

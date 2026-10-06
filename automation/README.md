# Networking contract example

The runnable part of the submission. It shows how I would check one SDK capability, networking and error handling, so that iOS and Android are held to the same written behaviour.

**What is real and what isn't.** The scenario catalogue, the fault-injecting mock server (with its control plane), the checking and comparison logic, the mutation check and the triage tool are real, and are what I would build on. The two SDKs (`src/sdk/androidSdk.ts`, `src/sdk/iosSdk.ts`) are small stand-ins written so the suite has something to run against. They are not the real SDKs, and nothing here says anything about real iOS or Android behaviour. I did not compile any Kotlin or Swift; the files in [`native-runners/`](native-runners/README.md) are sketches.

## Run it

Needs Node 22.12 or newer.

```bash
npm ci
npm test              # 129 tests, about 10 seconds on a two-core machine
npm run typecheck
npm run mutation      # plants 20 mistakes one at a time; the suite must catch all 20 (about a minute)
npm run triage        # flaky-test triage on made-up data
```

### See it catch a regression

```bash
npm run test:ios35
```

Switches on a planted change in the iOS stand-in: "3.5.0 retries POSTs after a timeout". Seven tests go red: the four that cover the two affected scenarios (contract and parity), and three that run both platforms through the whole file hand-over and expect a clean result, so they fail too. The first kind reads like this:

```
why this scenario exists: the server may have processed the first request; a retry could create a duplicate payment:
  attempts: expected 1, got 3
```

The same check as files, the way separate CI jobs would run it:

```bash
npm run native:emit -- android out/android.json
npm run native:emit -- ios out/ios.json
npm run native:compare -- out/android.json out/ios.json
```

## How it fits together

```
scenarios/networking.scenarios.json   the spec: the policy numbers and 30 scenarios (request, scripted server behaviour, expected result, why)
src/mock/faultServer.ts               plays a scenario's script, records what it received, has a control plane for native runners
src/contract/runner.ts                runs a scenario against a driver; check() returns plain sentences
src/contract/outcomeFile.ts           the file hand-over between platform jobs and the parity step
src/sdk/                              the two stand-in SDKs, shared single-attempt transport, planted faults (faults.ts)
src/modules/sharedSession.ts          three modules sharing one HTTP session (for the init-order demo)
tests/                                contract and parity tests, policy numbers, init order, control plane, file hand-over, checker, triage
tools/                                mutation check, emit/compare, flake triage, synthetic data generator
native-runners/                       Kotlin and Swift sketches and what the real setup has to solve
```

**Scenarios are data.** Each says what the server will do, what the SDK is asked to do and what must happen. The catalogue is validated on load: unknown fields, a failing scenario without an error code, duplicate ids are rejected with the location. Native runners read the same JSON.

**Every scenario also gets the wire checks.** The number of requests the server saw must equal the attempts the SDK reports. The request ID is a UUID and stays the same across retries, `x-attempt` counts up, the user agent follows `PlatformSDK/x.y.z (platform)`, an idempotency key and the request body are the same on every attempt, `Authorization` arrives untouched, and there is exactly one backoff wait between consecutive attempts, inside the policy window.

**What must match between platforms, and what may differ**, is written down in `normalise()` and `wireShape()` in `runner.ts`. Same: success or error, error code, status, attempts, number of waits, `outcomeUnknown`, which SDK headers are sent, the values of `authorization`, `content-type` (media type only, since one stack may add `; charset=utf-8`), the idempotency key and `x-attempt`, and the body as parsed JSON. When they don't match, the message says which field and both values, for example `parity: get-404: attempts: android 1, ios 2`. May differ: message text, the request ID value, the exact jittered delays, and anything the platform's HTTP stack adds on its own (`accept-encoding`, `connection`, key order in the JSON). The two stand-ins use different random seeds, so their jitter really does differ.

**Timing.** Waits are recorded, not lived through: the SDK is given a `sleep` that returns immediately, and the checks look at the delays it asked for. Connecting and sending get a fixed 5-second limit, and the configured timeout starts once the request has been sent. Only scenarios that are about timeouts use a short one (150ms), and the server answers 2.5 seconds later, so a slow machine can't turn them into the wrong result. Everything else gets 2 seconds. The full suite ran 20 times in a row on a two-core machine held at three busy processes per core (a run takes about 24 seconds there instead of 10) with no failures. An earlier version with one 150ms timeout everywhere failed 3 of 6 runs under similar load; that is the reason for this design.

**The tests are tested.**

- `checker.test.ts` feeds `check()` wrong results and expects the right complaints.
- `policy.test.ts` pins the backoff numbers with literals and pushes the random source to its extremes, because the scenarios only look at windows. It also checks the SDK constants against the policy written in the catalogue (two separate copies of the numbers, so changing one alone fails).
- `npm run mutation` first requires an unmodified green baseline, then switches on 20 planted mistakes one at a time (retrying a 401 or a 408, retrying a POST without a key after a 503, reporting a 5xx as a known outcome, treating a refused connection like a sent request, a wrong content type, a new request ID on every attempt, ignoring `Retry-After`, accepting `Retry-After: 1e3`, no jitter, no delay cap, a body that changes on retry, a module overwriting shared headers, and so on). A mistake only counts as caught if tests ran and at least one failed, so a crashing harness can't pass as success. This is a hand-made version of mutation testing; on native code I'd use a tool for it.

## The retry policy the scenarios pin down

| Situation | Behaviour |
|---|---|
| 2xx with JSON | Success. An empty body (204) is a success with no body. A 2xx with a body that is not JSON is `DECODE_ERROR` and is not retried |
| 401 | `UNAUTHENTICATED`, never retried. Refreshing the token is the auth module's job |
| Other 4xx, including 408 | `CLIENT_ERROR`, never retried. Treating 408 this way is a simplification and one of the questions for the team |
| 429 and 503 | Retried for GET/PUT/DELETE and for POSTs with an idempotency key, waiting at least `Retry-After` if given. A plain POST is not retried. A `Retry-After` over 10 seconds is handed back (`RATE_LIMITED` / `SERVER_ERROR` with `retryAfterMs`), exactly 10 is waited out. `Retry-After` is plain seconds only: anything else (`1e3`, `0x10`, an HTTP date) is ignored |
| Other 5xx | Same rule: retried if repeating is safe. A plain POST fails straight away |
| Timeout or dropped connection after sending | Same rule: retried if repeating is safe. Otherwise the error carries `outcomeUnknown: true` |
| Connection refused, or no connection within 5 seconds | Nothing reached the server, so it is retried for any method, including a plain POST, and `outcomeUnknown` is `false` |
| `outcomeUnknown` | `true` when the server may have acted and the result doesn't say: sent with no answer, or a 5xx or 429. `false` when nothing was sent or the answer settles it (2xx, other 4xx). It tells the caller to check the status before trying again |
| Always | At most 3 attempts, exponential backoff from 200ms with 50–100% jitter, capped at 300ms. Error messages never include the query string or credentials |

These numbers are chosen for the example. The 300ms cap is lower than I'd choose for a real SDK; it is there so the cap actually binds within three attempts and can be tested. A POST without an idempotency key is never repeated, not even after a 429 or 503. Many rate limiters and load balancers reject before any work is done, but a 503 can also come from a gateway after the backend acted, and HTTP itself doesn't promise either way. Relaxing this would need the backend teams to guarantee it and, for payments, a risk owner to agree. It is in the questions list.

## The init-order demo

The brief's failure is an interaction, which the retry regression is not. `tests/module-interaction.test.ts` has three modules (payments, telemetry, config) that each add headers to one shared HTTP session when initialised. With the planted mistake (`SDK_FAULTS=telemetry:replace-shared-headers`) telemetry assigns instead of merging, so it wipes whatever was added before it. Four of the six initialisation orders then fail and two pass, which is what "intermittent" looks like when the order depends on what loads first. The test tries every order, so the failing test's name is the reproduction. This one is deterministic; a real race would also need a stress loop and injected delays (see section 4 of the main document).

## Flaky-test triage

`tools/flake-triage.ts` supports the 3.4 → 3.5 investigation in the main document. Given run history (one record per execution: platform, OS, runner, module versions, position in the run, result) it ranks the combinations of conditions that best explain a test's failures, with precision, recall and lift for each, and works out how many runs are needed to reproduce.

```bash
npm run triage                               # made-up data
npm run triage:file -- your-runs.json [test] # your own data, same record shape (see RunRecord)
```

The data is **made up**: `tools/make-synthetic-runs.ts` generates it from a fixed seed (nothing is committed). It plants failures on iOS when both modules are at 3.5.0 and the test runs from position 3 onwards, plus a noisy simulator pool and some random failures. The tool isn't told where the cut-off is: it is offered several and the data picks. It also searches up to four conditions at once, which happens to be the number planted, so what this shows is that the method works on data built to be solvable. Real data is messier.

## Limits

- Stand-ins, not SDKs. Only one capability. No cancellation, streaming, redirects, TLS failure, `Retry-After` as an HTTP date, or a real offline state. "Not sent" versus "sent, no answer" is covered (`tests/not-sent.test.ts`), but only for connection refused, because the mock server can't refuse a connection for one scenario. Several are questions for the team.
- The scenario format covers request/response behaviour and counts. Lifecycle events (backgrounding mid-request) can't be expressed and would stay native tests.
- `mustNotLeak` only inspects the result. It does not look at logs or crash reports, which is where a leak would do the damage.
- The 20 planted mistakes were chosen by the same author as the scenarios, so they share its blind spots. A real mutation tool would find holes they miss.
- The triage tool searches many combinations, so some of what it finds is chance. It has a minimum group size and a minimum lift, not a significance test.
- Test seams (`fault()` calls) live inside the stand-in SDKs. A real SDK would not carry them.
- Both stand-ins share one HTTP layer (`src/sdk/transport.ts`), so parity on what was sent is easier to pass here than it will be with OkHttp and URLSession.

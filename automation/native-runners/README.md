# Native runners: what they would look like

> **Sketches, not working code.** I did not compile or run anything in this folder.
> The SDK API names (`PlatformSdk`, `NetworkingConfig`, and so on) are invented
> to show the shape. The point is how small the native part can be.

The TypeScript suite in the parent folder plays both platforms with stand-ins.
For the real SDKs, each platform gets a thin runner and the TypeScript side
becomes the host script and the comparison step. Nothing about the scenarios is
re-implemented in Kotlin or Swift.

## The flow

One native run per platform covers the whole catalogue. The mock server has a small control plane (`src/mock/faultServer.ts`) so the runner can drive it over HTTP, without a host script per scenario:

1. **Host script** starts the mock server, calls `POST /__control/reset`, and launches the native run once, passing the control URL (`adb shell am instrument -e controlUrl …` on Android, an environment variable with `xcodebuild test` on iOS).
2. **Native runner** (a parameterised instrumented test on Android, Swift Testing with `arguments:` on iOS, which needs Xcode 16) reads the same `networking.scenarios.json` and creates one test per scenario, so the report names the scenario that broke. Each test `POST`s the scenario's server script to `/__control/scripts` and gets back a `baseUrl`, runs the real SDK against it, and `POST`s the **outcome** to `/__control/outcomes`.
3. **Host script** fetches `GET /__control/outcome-file/<platform>`: the outcomes joined with what the server actually received, in the `OutcomeFile` shape (`src/contract/outcomeFile.ts`).
4. **Parity job** reads the two files: `npm run native:compare -- out/android.json out/ios.json`.

The native test only fails if the SDK call crashes; whether the result is right is decided in step 4, where the spec and the server's log are. The control plane checks what it is sent and answers 400 with the reason for a malformed script or outcome, or for results from two SDK versions in one file. `tests/control-plane.test.ts` plays steps 2–3 over HTTP with the stand-in SDKs, so the flow itself is tested. `npm run native:emit` produces the same files directly.

The outcome the native runner must return, per scenario:

```json
{ "ok": false, "code": "TIMEOUT", "status": null, "attempts": 1, "requestId": "…", "waitsMs": [], "outcomeUnknown": true, "retryAfterMs": null, "message": "…" }
```

`ok: true` results carry `status` and `body` instead of `code`. The error codes are the seven in `src/contract/types.ts`; mapping the platform's own errors onto them is the job of the runner, and is where most of the drift between iOS and Android shows up.

## Things that have to be solved on the real platforms

- **Reaching the mock server.** Android emulator: the host is `10.0.2.2`. Android device: `adb reverse tcp:PORT tcp:PORT`, then use `127.0.0.1`. iOS simulator: it shares the host's network, so `127.0.0.1`. iOS device: the machine's LAN address plus the local-network permission, or a tunnel. Plain HTTP needs a test-only exception on both: a network security config (Android) and `NSAllowsLocalNetworking` under `NSAppTransportSecurity` (iOS). Neither belongs in a release build.
- **Short timeouts.** The SDK config must let a test set the request timeout. That is normally already there. Check it rather than assume it.
- **No real waiting for backoff.** The SDK needs a way to inject a scheduler (the thing that sleeps between attempts) and the random source for jitter, so the runner can record the waits and return immediately. Ask the SDK team for it as an `internal` / `@testable` hook or a small testing module, not as public API.
- **Timeout semantics differ per stack.** OkHttp has separate connect, read, write and call timeouts; URLSession's `timeoutIntervalForRequest` is an idle timeout, and `waitsForConnectivity` can make it wait instead of failing. The stand-ins model a simple version: a fixed 5-second limit for connecting and sending, then the configured timeout from the moment the request is sent. The first thing the real runners will show is which of these a given scenario actually exercises, and the SDK team will have to decide what "timeout" means in the contract.
- **Silent retries in the HTTP stack.** OkHttp's `retryOnConnectionFailure` is on by default and can repeat a request after some connection failures without the SDK knowing; URLSession can also retry on its own in some cases. The check that the server saw exactly as many requests as the SDK reports is there to catch this, and on the real platforms it is likely to be the first thing it finds.
- **One crash shouldn't end the run.** With one test per scenario, a thrown exception only fails that scenario. A real process crash still ends the whole instrumentation run on Android unless it runs under Android Test Orchestrator, which starts each test in its own process. On iOS a crash ends the test run too; the host script should report which scenarios have no result.
- **HTTP stack defaults.** URLSession and OkHttp add their own headers (`accept-language`, `accept-encoding`, `connection`). The parity check only compares the headers the SDK itself sets, and compares bodies as parsed JSON, because byte-identical requests across two HTTP stacks aren't realistic.

Files here: [`ScenarioRunner.kt`](ScenarioRunner.kt) and [`ScenarioRunner.swift`](ScenarioRunner.swift).

# Questions for the team

These are the questions whose answers would change my plan the most, roughly in order. Each has a short note on why I'm asking. In a first conversation I'd start with the first five.

## How the SDK ships and who uses it

1. **How are the modules packaged and versioned?** (Swift packages or XCFrameworks, Maven artifacts; one version for the whole SDK or one per module.)
   *Per-module versions need a compatibility matrix. A single version number makes this much simpler.*
2. **Which versions must keep working, for how long, and who decides?**
   *Without a support window, "compatible" can't be tested, and it sets the size of the matrix.*
3. **How many apps use the SDK, which matter most, and how far behind do they usually run?**
   *This decides which apps get built against every release candidate and which only nightly.*

## What exists today

4. **What automation runs today, where, and who looks at the failures?**
   *I'd want to see the CI history before forming an opinion about the tests.*
5. **Is there a list of integration incidents from the last year, with causes?**
   *It's the best data for choosing the first capability for contract tests and which module pairs go in the matrix.*
6. **Is there a stubbed or recorded backend for tests, and who owns it?**
   *Hermetic tests need one. If it doesn't exist, building it comes first.*

## The code

7. **Which resources do modules share, and are any of them singletons?** (HTTP session, keychain or keystore, database, push, analytics.)
   *Shared global state is the usual cause of "only breaks when two modules are together", as in the 3.4 to 3.5 case.*
8. **Is the retry and timeout logic written separately on iOS and Android, and what HTTP stack does each use?**
   *If it's written twice, that's where a shared contract pays off first.*
9. **Can the SDK accept a test-only clock and random source?**
   *Without them, retry and backoff tests either wait for real or can't check the delays.*

## Behaviour I had to guess in the example

10. **Do the backends guarantee that a 429 or 503 means the request was not processed?** In the example a POST without an idempotency key is never retried, even then.
    *If the gateways do guarantee it, retrying would be safe and better for users. For payments I'd want a risk owner to agree before changing it.*
11. **Should a 408 be retried, and do the backends ever send `Retry-After` as an HTTP date?**
    *The example treats 408 as a plain client error and only reads `Retry-After` in seconds. Both are guesses.*
12. **Does the request timeout cover the whole call or each attempt, and when does it start?**
    *OkHttp and URLSession have different defaults here, so without a written answer the two platforms will disagree.*

## Ownership

13. **Who owns a failure that only appears when two modules are combined?**
    *That is the situation in the brief. I'd want to agree on an owner and how such failures get reported.*
14. **Who can stop a release, and what evidence do they need, including for change management and DORA?**
    *A quality gate is only worth building if someone acts on it, and the evidence format is easier to get right from the start.*

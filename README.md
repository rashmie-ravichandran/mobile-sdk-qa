# Mobile SDK quality engineering: assignment submission

My submission for the Senior Mobile QA Engineer (Platform / SDK) assignment. I treated it as a design exercise first, with one small runnable example to back up the central idea: put confidence in contract tests that run identically on iOS and Android, and keep end-to-end tests few.

## Where to find what the brief asked for

| The brief asks for | Where it is |
|---|---|
| Test strategy and compatibility approach | [`docs/quality-approach.md`](docs/quality-approach.md), sections 1 and 3 |
| Automation example on both platforms | [`automation/`](automation/README.md); summary in section 2 of the document; Kotlin/Swift runner sketches in [`automation/native-runners/`](automation/native-runners/README.md) |
| CI/CD and release validation | Section 3 of the document; a working PR pipeline, [`.github/workflows/pr-checks.yml`](.github/workflows/pr-checks.yml); an illustrative release pipeline, [`ci/release-validation.yml`](ci/release-validation.yml) |
| The 3.4 → 3.5 investigation | Section 4 of the document, plus the [init-order demo](automation/README.md#the-init-order-demo) and the [triage tool](automation/README.md#flaky-test-triage) |
| First three priorities | Section 5 of the document |
| A diagram, assumptions, risks, trade-offs | Three Mermaid diagrams in the document (they render on GitHub); assumptions, risks and trade-offs in section 6 |
| Questions for the team | [`docs/questions-for-the-team.md`](docs/questions-for-the-team.md) |
| AI-assistance statement | Last section of this file |

If you read one thing, read the first section of the document ("The short version"). It is about 4,000 words plus three diagrams; a PDF copy ([`docs/quality-approach.pdf`](docs/quality-approach.pdf), 7 pages) is next to it.

## Run it

Needs Node 22.12 or newer.

```bash
cd automation
npm ci
npm test              # 129 tests, about 10 seconds
npm run test:ios35    # a planted regression; 7 tests go red on purpose
npm run mutation      # 20 planted mistakes; the suite must catch all of them
npm run triage        # flaky-test triage on made-up data
```

## Design choices

- **The document comes first; the code backs up one idea in it.** The brief values reasoning over volume. Because most of the code was drafted with AI help (see the last section), the example is bigger than four hours of hand-written work would be. The parts that matter are the scenario file, the checker in `runner.ts` and the parity step; the mutation check and the triage tool are extras.
- **Scenarios as data.** One source of truth for both platforms. The cost: lifecycle and UI checks don't fit as data and stay native.
- **TypeScript for the example.** Quickest to make runnable and easy to review. Not a recommendation for real SDK test code, which should be Kotlin and Swift.
- **Plain failure messages.** A red test says what was expected, what happened and why the scenario exists.
- **The tests are tested.** A checker with its own tests, a mutation check, and the full suite run 20 times under CPU load (20 of 20 clean).

## Assumptions

Listed in section 6 of the document. The big ones: versioned packages from an internal registry, native Swift and Kotlin code, separate module and app teams, and no agreed definition of a "supported version" yet.

## Known limitations

- **The two SDKs in the example are stand-ins written for it, not real iOS or Android code.** I did not compile any Kotlin or Swift. The example shows the method, not real platform behaviour, and the files in `native-runners/` are unverified sketches.
- The data behind the triage tool is made up. It demonstrates the method; real run history is messier.
- One capability only, and the release pipeline in `ci/` has stub stages for everything that needs mobile tooling.
- GitHub Actions in the workflows use version tags. In a real pipeline I'd pin commit hashes.
- Other limits are listed in [`automation/README.md`](automation/README.md#limits).

## What I would do with more time

1. Write the two native runners for one real capability and run the shared scenarios against the real SDK.
2. Generate the compatibility matrix from real manifests and lockfiles, with pairwise selection.
3. Add the API-diff gate in report-only mode to see how noisy it is before it blocks anyone.
4. Add lifecycle scenarios (backgrounding mid-request, connectivity changes) as native tests.
5. Build the nightly flake dashboard from real run metadata.

## AI assistance

The brief asks for where AI tools were used, how the output was validated, and what I did myself.

**Tool:** Claude (Anthropic), through the Claude desktop app.

**Where it was used:** first drafts of the strategy document, the questions list, this README, all of the TypeScript example (mock server, stand-in SDKs, scenario runner, mutation check, triage tool), the Kotlin/Swift sketches and the CI files. A second, separate AI pass reviewed the result as a sceptical reviewer would. It listed concrete defects in the first versions (a suite that failed under CPU load, a quality gate that could never fail, weak parity and sensitivity evidence, no native runner sketches, documents too long and repetitive). A later pass found that the CI mutation step could never fail (a pipe into `tee` without `pipefail`) and that two scenarios stated as fact that a 429 or 503 means the server did nothing, which led to a change in the retry policy. A final independent review found that `outcomeUnknown` told a caller the result of a failed POST was known when it wasn't (and the opposite for a refused connection), that parity didn't compare header values, and that the docs said "I wrote" about code I didn't write by hand. Those were fixed as well, and the test runner was upgraded so `npm audit` is clean.

**How the output was validated:**

- The code was run. All 129 tests pass, type checking is clean, and the planted regression turns exactly the expected tests red. The mutation check catches all 20 planted faults. The full suite was run 20 times under heavy CPU load with no failures, after a first version failed 3 of 6.
- The triage tool was run on its synthetic data. A test asserts that the planted cause ranks first.
- Both workflow files pass `actionlint`, and the steps of the PR workflow were run by hand to confirm they do what the comments say.
- The three Mermaid diagrams were rendered to check the syntax.
- The tool names and commands in the document (API diff tooling, sanitizers, `xcodebuild` options, dependency locking) were reviewed against what I know of them. I did not run any native tooling, because there is no native code in this submission. The Kotlin and Swift files are sketches.

**Time spent:** about 3 hours, mostly reading the document and the code, running the suite and the planted regression, and going through the review findings.

**What I changed or implemented myself:**

I used Claude heavily, and I'd rather be clear about the split. Claude drafted the document, the code and the pipelines. I set the scope. I chose networking and error handling as the capability, and a runnable TypeScript example over native code I couldn't compile and verify in the time. I also chose Markdown with diagrams for the document. I then asked for three critical reviews, written from a chapter lead's or senior reviewer's point of view, and decided to act on what they found. They found real problems:

- the suite failed under CPU load;
- the release gate could never fail;
- the CI mutation step couldn't fail because of a missing `pipefail`;
- two scenarios stated as fact that a 503 or 429 means the server did nothing;
- the `outcomeUnknown` flag told a caller the result of a failed payment was known when it wasn't.

The last one led me to change the retry policy, so a POST without an idempotency key is never retried. I also had the wording rewritten to be plainer. I read all of it and ran the suite, the planted regression and the mutation check myself. I didn't write the TypeScript by hand. I'm happy to walk through any part and explain why it is the way it is.

// SKETCH, not compiled. One instrumented test run covers the whole catalogue,
// with one test per scenario, so a report says "post-timeout-no-key failed"
// rather than "1 test failed", and an exception in one scenario doesn't stop
// the others. A native crash still ends the run unless it uses Android Test
// Orchestrator (one process per test).
//
// The native test only fails if the SDK call itself blows up. Whether the
// outcome is *right* is decided afterwards by the compare step, which has the
// spec and what the server received.
//
// PlatformSdk / NetworkingConfig / RetryScheduler / ControlPlane are invented names.

@RunWith(Parameterized::class)
class NetworkingScenarioTest(private val scenario: Scenario) {

    companion object {
        private val args = InstrumentationRegistry.getArguments()
        // Emulator: the host machine is 10.0.2.2. On a device: `adb reverse tcp:5050 tcp:5050`, then 127.0.0.1.
        private val control = ControlPlane(args.getString("controlUrl")!!)   // e.g. http://10.0.2.2:5050

        @JvmStatic
        @Parameterized.Parameters(name = "{0}")   // Scenario.toString() returns its id
        fun scenarios(): List<Scenario> =
            Json.decodeFromString<Catalogue>(
                InstrumentationRegistry.getInstrumentation().context.assets
                    .open("networking.scenarios.json").bufferedReader().readText()
            ).scenarios
    }

    @Test
    fun runScenario() = runBlocking {
        val script = control.registerScript(scenario.server)          // POST /__control/scripts -> { id, baseUrl }
        val waits = mutableListOf<Long>()

        // Test-only seams: short timeout, a scheduler that records instead of sleeping.
        val client = PlatformSdk.networking(
            NetworkingConfig(
                baseUrl = script.baseUrl,
                requestTimeoutMs = scenario.config?.requestTimeoutMs ?: 2_000,
                scheduler = RetryScheduler { delayMs -> waits += delayMs },
                random = SeededRandom(42),
            )
        )

        val outcome = when (val result = client.execute(scenario.request.toSdkRequest())) {
            is SdkResult.Success -> Outcome.success(result, waits)
            is SdkResult.Failure -> Outcome.failure(result.toContractCode(), result, waits)   // mapping to the 7 codes lives here
        }
        control.postOutcome("android", BuildConfig.SDK_VERSION, scenario.id, script.id, outcome)   // POST /__control/outcomes
    }
    // Before the run the host script calls POST /__control/reset; afterwards
    // GET /__control/outcome-file/android > out/android.json
}

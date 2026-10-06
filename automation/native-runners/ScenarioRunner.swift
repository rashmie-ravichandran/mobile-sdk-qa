// SKETCH, not compiled. One test run covers the whole catalogue, with one test
// per scenario (Swift Testing arguments), so the report names the scenario that
// failed and an error in one scenario doesn't stop the others. A crash still ends
// the run; the host script reports which scenarios have no result.
//
// The native test only fails if the SDK call itself throws something that isn't
// an SdkError. Whether the outcome is *right* is decided afterwards by the
// compare step, which has the spec and what the server received.
//
// PlatformSDK / NetworkingConfig / RetryScheduler / ControlPlane are invented names.

import Foundation
import Testing
@testable import PlatformSDK   // for the test seams (needs -enable-testing in Debug)

// Simulator: shares the host's network, so 127.0.0.1 works. Plain HTTP needs
// NSAllowsLocalNetworking under NSAppTransportSecurity in the test app only.
private let control = ControlPlane(url: URL(string: ProcessInfo.processInfo.environment["CONTROL_URL"]!)!)

private let catalogue: Catalogue = {
    let url = Bundle.module.url(forResource: "networking.scenarios", withExtension: "json")!
    return try! JSONDecoder().decode(Catalogue.self, from: Data(contentsOf: url))
}()

@Suite("networking scenarios")
struct NetworkingScenarioTests {

    // Scenario conforms to CustomTestStringConvertible and shows its id.
    @Test(arguments: catalogue.scenarios)
    func scenario(_ scenario: Scenario) async throws {
        let script = try await control.registerScript(scenario.server)   // POST /__control/scripts -> { id, baseUrl }

        // Test-only seams: short timeout, a scheduler that records instead of sleeping.
        let waits = WaitRecorder()
        let client = PlatformSDK.networking(NetworkingConfig(
            baseURL: script.baseURL,
            requestTimeout: .milliseconds(scenario.config?.requestTimeoutMs ?? 2_000),
            scheduler: RetryScheduler { delay in await waits.record(delay) },
            random: SeededRandom(seed: 7)
        ))

        let outcome: Outcome
        do {
            let response = try await client.execute(scenario.request.asSdkRequest())
            outcome = .success(response, waits: await waits.values)
        } catch let error as SdkError {
            outcome = .failure(error.contractCode, error, waits: await waits.values)   // mapping to the 7 codes lives here
        }
        try await control.postOutcome(platform: "ios", sdkVersion: PlatformSDK.version, scenarioId: scenario.id, scriptId: script.id, outcome: outcome)
    }
    // Before the run the host script calls POST /__control/reset; afterwards
    // GET /__control/outcome-file/ios > out/ios.json
}

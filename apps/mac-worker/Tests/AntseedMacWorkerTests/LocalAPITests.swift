import XCTest
@testable import AntseedMacWorker

final class LocalAPITests: XCTestCase {
    private let key = "sk-colony-abc"

    private func request(_ method: String, _ path: String, headers: [String: String] = [:], body: String = "") -> HTTPRequest {
        var all = ["host": "127.0.0.1:11435", "authorization": "Bearer \(key)"]
        all.merge(headers) { _, new in new }
        return HTTPRequest(method: method, path: path, headers: all.filter { !$0.value.isEmpty }, body: Data(body.utf8))
    }

    private func route(_ request: HTTPRequest) -> LocalAPIServer.Route {
        LocalAPIServer.route(request, port: 11435, key: key)
    }

    func testForwardsChatWithTheServedModelName() throws {
        guard case .forward(let path, let body) = route(request("POST", "/v1/chat/completions", body: #"{"model":"gpt-4o","messages":[],"stream":true}"#)) else {
            return XCTFail("expected a forward")
        }
        XCTAssertEqual(path, "/v1/chat/completions")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["model"] as? String, LocalModel.servedName)
        XCTAssertEqual(json["stream"] as? Bool, true)
    }

    func testAcceptsAnAnthropicKeyHeader() {
        let anthropic = request("POST", "/v1/messages", headers: ["authorization": "", "x-api-key": key], body: #"{"messages":[]}"#)
        guard case .forward(let path, _) = route(anthropic) else { return XCTFail("expected a forward") }
        XCTAssertEqual(path, "/v1/messages")
    }

    func testListsTheModelUnderItsService() {
        XCTAssertEqual(route(request("GET", "/v1/models")), .models)
        XCTAssertEqual(route(request("POST", "/v1/models")), .reject(status: 405, message: "Method not allowed"))
    }

    func testRefusesAWrongOrMissingKey() {
        XCTAssertEqual(route(request("GET", "/v1/models", headers: ["authorization": "Bearer nope"])), .reject(status: 401, message: "Use the key shown in Antseed Colony"))
        XCTAssertEqual(route(request("GET", "/v1/models", headers: ["authorization": ""])), .reject(status: 401, message: "Use the key shown in Antseed Colony"))
    }

    func testRefusesAnotherHost() {
        XCTAssertEqual(route(request("GET", "/v1/models", headers: ["host": "attacker.example:11435"])), .reject(status: 403, message: "Forbidden"))
        XCTAssertEqual(route(request("GET", "/v1/models", headers: ["host": "127.0.0.1:9999"])), .reject(status: 403, message: "Forbidden"))
        guard case .models = route(request("GET", "/v1/models", headers: ["host": "localhost:11435"])) else { return XCTFail("localhost is this Mac") }
    }

    func testKeepsTheEnginesOtherRoutesClosed() {
        for path in ["/v1/load", "/v1/memory", "/v1/slide/learn", "/v1/imprint/load", "/stats", "/dashboard", "/v1/recall"] {
            XCTAssertEqual(route(request("POST", path, body: "{}")), .reject(status: 404, message: "Not found"), path)
        }
    }

    func testRefusesABodyThatIsNotAJSONObject() {
        XCTAssertEqual(route(request("POST", "/v1/chat/completions", body: "[1]")), .reject(status: 400, message: "The body must be a JSON object"))
    }

    func testSettingsStartOffWithAFreshKeyAndPersistOwnerOnly() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var settings = LocalAPISettings.load(in: directory)
        XCTAssertFalse(settings.enabled)
        XCTAssertEqual(settings.port, LocalAPISettings.defaultPort)
        XCTAssertTrue(settings.key.hasPrefix("sk-colony-"))
        XCTAssertNotEqual(settings.key, LocalAPISettings.load(in: directory).key, "nothing saved yet: each load makes a new key")
        settings.enabled = true
        try settings.save(in: directory)
        XCTAssertEqual(LocalAPISettings.load(in: directory), settings)
        let mode = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(LocalAPISettings.fileName).path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
    }

    func testEngineStatsReadTheEnginesNumbers() throws {
        let json = #"{"running": 1, "waiting": 2, "decode_tokens_per_second": 184.6, "prefill_tokens_per_second": 861.0, "prompt_tokens_total": 18, "generation_tokens_total": 4, "memory": {"active": 2889828920, "cache": 0, "peak": 2900000000}}"#
        let stats = try XCTUnwrap(EngineStats(json: Data(json.utf8)))
        XCTAssertEqual(stats.running, 1)
        XCTAssertEqual(stats.waiting, 2)
        XCTAssertEqual(stats.decodeTokensPerSecond, 184.6, accuracy: 0.01)
        XCTAssertEqual(stats.promptTokensTotal, 18)
        XCTAssertEqual(stats.generationTokensTotal, 4)
        XCTAssertEqual(stats.memoryActive, 2_889_828_920)
        XCTAssertEqual(stats.memoryPeak, 2_900_000_000)
        XCTAssertNil(EngineStats(json: Data("not json".utf8)))
    }

    func testGPUSampleReadsIOKitStatistics() {
        let sample = GPUSample(statistics: ["Device Utilization %": 63, "In use system memory": 2_950_397_952])
        XCTAssertEqual(sample, GPUSample(utilization: 63, memoryInUse: 2_950_397_952))
        XCTAssertEqual(GPUSample(statistics: ["Device Utilization %": 140])?.utilization, 100)
        XCTAssertNil(GPUSample(statistics: [:]))
    }

    func testShortLabels() {
        XCTAssertEqual(tokensShort(950), "950")
        XCTAssertEqual(tokensShort(12_345), "12.3K")
        XCTAssertEqual(tokensShort(4_500_000), "4.5M")
        XCTAssertEqual(bytesShort(2_889_828_920), "2.9 GB")
        XCTAssertEqual(bytesShort(512_000_000), "512 MB")
    }

    /// A loopback port nothing listens on.
    private func freePort() throws -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, length) == 0 && getsockname(fd, $0, &length) == 0 }
        }
        guard bound else { throw XCTSkip("no loopback port to bind") }
        return UInt16(bigEndian: address.sin_port)
    }

    /// The status `GET /v1/models` gets with the key, or nil when nothing answers.
    private func modelsStatus(_ port: UInt16) async -> Int? {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/v1/models")!)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 5
        return ((try? await URLSession.shared.data(for: request))?.1 as? HTTPURLResponse)?.statusCode
    }

    @MainActor private final class Switch { var on = true }

    @MainActor
    private func server(_ port: UInt16, _ enabled: Switch) -> LocalAPIServer {
        let key = key
        return LocalAPIServer(settings: { LocalAPISettings(enabled: enabled.on, port: port, key: key) }, target: { nil }, onStart: {}, onEnd: {})
    }

    @MainActor
    func testAStartStoppedBeforeItIsReadyNeverServes() async throws {
        let port = try freePort()
        let server = server(port, Switch())
        let starting = Task { @MainActor in try await server.start(port: port) }
        while !server.isStarting { await Task.yield() }
        server.stop()
        do {
            try await starting.value
            XCTFail("a stopped start must not succeed")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertNil(server.port)
        XCTAssertFalse(server.isStarting)
        let status = await modelsStatus(port)
        XCTAssertNil(status, "nothing listens")
    }

    @MainActor
    func testRefusesAKeyHolderOnceSwitchedOff() async throws {
        let port = try freePort()
        let enabled = Switch()
        let server = server(port, enabled)
        try await server.start(port: port)
        defer { server.stop() }
        let on = await modelsStatus(port)
        XCTAssertEqual(on, 503, "on, with no model loaded")
        enabled.on = false
        let off = await modelsStatus(port)
        XCTAssertEqual(off, 403)
    }
}

import XCTest
@testable import AntseedMacWorker

/// Answers per host: `down.test` fails to connect, `limited.test` answers 429,
/// `erroring.test` answers a JSON-RPC error, `healthy.test` answers an active
/// channel of the test buyer with the test pool. Records the hosts asked.
private final class StubRPC: URLProtocol {
    nonisolated(unsafe) static var asked: [String] = []
    nonisolated(unsafe) static var channelResult = ""

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host ?? ""
        Self.asked.append(host)
        switch host {
        case "down.test":
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        case "limited.test":
            respond(status: 429, body: "rate limited")
        case "erroring.test":
            respond(status: 200, body: #"{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"limit exceeded"}}"#)
        default:
            respond(status: 200, body: #"{"jsonrpc":"2.0","id":1,"result":"\#(Self.channelResult)"}"#)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private func respond(status: Int, body: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
    }
}

final class ChainFailoverTests: XCTestCase {
    private let buyer = "0x1000000000000000000000000000000000000001"
    private let pool = "0x2000000000000000000000000000000000000002"
    private let channel = "0x" + String(repeating: "ab", count: 32)

    private var session: URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubRPC.self]
        return URLSession(configuration: configuration)
    }

    override func setUp() {
        StubRPC.asked = []
        // channels(bytes32): buyer, seller, then 6 zero words and status Active (1).
        let word = { (hex: String) in String(repeating: "0", count: 64 - hex.count) + hex }
        StubRPC.channelResult = "0x" + word(String(buyer.dropFirst(2))) + word(String(pool.dropFirst(2)))
            + String(repeating: word(""), count: 6) + word("1")
    }

    private func chain(_ hosts: [String]) -> Chain {
        Chain(rpcURLs: hosts.map { URL(string: "https://\($0)/")! }, timeout: 2, session: session)
    }

    func testAFailedPrimaryStillAdmitsAValidChannelThroughAHealthyFallback() async throws {
        let verdict = try await chain(["down.test", "limited.test", "erroring.test", "healthy.test"])
            .channelBelongs(channel: channel, buyer: buyer, pool: pool, channels: "0x3000000000000000000000000000000000000003")
        XCTAssertEqual(verdict, true)
        XCTAssertEqual(StubRPC.asked, ["down.test", "limited.test", "erroring.test", "healthy.test"])
    }

    func testAHealthyPrimaryIsTheOnlyEndpointAsked() async throws {
        _ = try await chain(["healthy.test", "down.test"]).channelBelongs(channel: channel, buyer: buyer, pool: pool, channels: "0x3000000000000000000000000000000000000003")
        XCTAssertEqual(StubRPC.asked, ["healthy.test"])
    }

    func testFailsWhenEveryEndpointFails() async {
        do {
            _ = try await chain(["down.test", "limited.test"]).chainId()
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error.localizedDescription, "RPC answered HTTP 429")
        }
    }
}

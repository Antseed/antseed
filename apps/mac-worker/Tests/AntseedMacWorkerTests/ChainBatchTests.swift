import XCTest
@testable import AntseedMacWorker

/// `batch.test` answers a JSON-RPC batch out of order, each read's answer its calldata echoed;
/// `unbatched.test` answers a batch with one error object (batches unsupported) and single
/// calls normally; `partial.test` answers a batch with one read failing.
private final class StubBatchRPC: URLProtocol {
    nonisolated(unsafe) static var bodies: [String: Int] = [:]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host ?? ""
        let json = try? JSONSerialization.jsonObject(with: Self.body(of: request))
        var answer: Any = ["jsonrpc": "2.0", "id": 1, "error": ["code": -32600, "message": "bad request"]]
        if let batch = json as? [[String: Any]] {
            Self.bodies["\(host) batch", default: 0] += 1
            if host == "unbatched.test" {
                answer = ["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32600, "message": "batches not supported"]]
            } else {
                answer = batch.reversed().map { call -> [String: Any] in
                    let id = call["id"] as? Int ?? -1
                    if host == "partial.test", id == 1 { return ["jsonrpc": "2.0", "id": id, "error": ["code": 3, "message": "reverted"]] }
                    return ["jsonrpc": "2.0", "id": id, "result": Self.calldata(call)]
                }
            }
        } else if let call = json as? [String: Any], host == "epochs.test" {
            // An emissions contract claiming an absurd epoch count; every other read answers an address.
            let currentEpoch = Chain.selector("currentEpoch()").prefixedHex
            let result = Self.calldata(call).hasPrefix(currentEpoch)
                ? "0x" + String(repeating: "f", count: 64)
                : "0x" + String(repeating: "0", count: 24) + String(repeating: "1", count: 40)
            answer = ["jsonrpc": "2.0", "id": call["id"] ?? 1, "result": result]
        } else if let call = json as? [String: Any] {
            Self.bodies["\(host) single", default: 0] += 1
            answer = ["jsonrpc": "2.0", "id": call["id"] ?? 1, "result": Self.calldata(call)]
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: answer)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func calldata(_ call: [String: Any]) -> String {
        ((call["params"] as? [Any])?.first as? [String: Any])?["data"] as? String ?? "0x"
    }

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

final class ChainBatchTests: XCTestCase {
    private let pool = "0x2000000000000000000000000000000000000002"

    private func chain(_ hosts: [String]) -> Chain {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubBatchRPC.self]
        return Chain(rpcURLs: hosts.map { URL(string: "https://\($0)/")! }, timeout: 2, session: URLSession(configuration: configuration))
    }

    private func reads(_ count: Int) -> [Chain.Read] {
        (0..<count).map { Chain.Read(to: pool, data: Data([0xab, UInt8($0)])) }
    }

    override func setUp() {
        StubBatchRPC.bodies = [:]
    }

    func testBatchesReadsAndMatchesAnswersByID() async throws {
        let answers = try await chain(["batch.test"]).batchEthCall(reads(120), batchSize: 50)
        XCTAssertEqual(answers, reads(120).map(\.data))
        XCTAssertEqual(StubBatchRPC.bodies, ["batch.test batch": 3], "120 reads in batches of 50: three requests")
    }

    func testReadsOneByOneFromAnEndpointWithoutBatches() async throws {
        let answers = try await chain(["unbatched.test"]).batchEthCall(reads(10))
        XCTAssertEqual(answers, reads(10).map(\.data))
        XCTAssertEqual(StubBatchRPC.bodies, ["unbatched.test batch": 1, "unbatched.test single": 10])
    }

    func testRefusesAnEpochCountNoRealScheduleReachesBeforeAllocatingForIt() async throws {
        do {
            _ = try await chain(["epochs.test"]).colonyRewards(pool: pool, account: pool)
            XCTFail("an absurd epoch count must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("more than any real schedule"), error.localizedDescription)
        }
    }

    func testOneFailedReadFailsTheWholeCallRatherThanReadingAsZero() async throws {
        do {
            _ = try await chain(["partial.test"]).batchEthCall(reads(3))
            XCTFail("a failed read must fail the call")
        } catch {}
        // The next endpoint gets the batch.
        let answers = try await chain(["partial.test", "batch.test"]).batchEthCall(reads(3))
        XCTAssertEqual(answers, reads(3).map(\.data))
    }
}

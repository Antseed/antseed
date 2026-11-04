import CryptoKit
import XCTest
@testable import AntseedMacWorker

/// Vectors produced by the TypeScript implementation (ethers + @antseed/node/worker-e2e).
final class InteropTests: XCTestCase {
    func testEthereumAddressAndPersonalSignMatchEthers() throws {
        let key = try EthereumKey(privateKey: try Data(hexString: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"))
        XCTAssertEqual(key.address, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")
        // RFC 6979 signing is deterministic, so the signature matches ethers byte for byte.
        XCTAssertEqual(
            try key.personalSign("antseed-colony-pool/v1\npool:demo\nnonce:abc"),
            "0xf205a95a5e2a200ed183a7fe28b968a3b6d851c8837ac4d0ea26a2553dbbf39e62acd609041876574ccc5eb4cb62dcba072509a79cde86304da7243a57abf1211b"
        )
    }

    func testPayoutLinkSignatureMatchesTheContractDigest() throws {
        let key = try EthereumKey(privateKey: try Data(hexString: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"))
        let digest = PayoutAuthorization.digest(chainId: 31337, pool: "0xa85233c63b9ee964add6f2cffe00fd84eb32338f", worker: key.address,
                                                payout: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", nonce: 2, deadline: 2_000_000_000)
        // AntseedColonyPool.payoutDigest for the same arguments.
        XCTAssertEqual(Data(digest), try Data(hexString: "0xdb41b3b2acdc64eee8c7887ce758e6bd8c9f976f6f634b243c4966d31675c577"))
        XCTAssertEqual(
            try key.sign(digest: personalMessageDigest(digest)).prefixedHex,
            "0xa7ecd142fa0fddf28b82fb040fc8dac58e1bca88b0a2a6f1157ae651d483775100b623e798ba7d98cf075379d1b69b2463b863ac3b7a465877bd62b5ef5363c91c"
        )
    }

    func testOpensARequestSealedByTheBuyerAndVerifiesItsBinding() throws {
        let body = #"{"model":"qwen2.5-0.5b","stream":true,"antseed_e2e":{"v":2,"recipients":[{"worker":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","epk":"BEJ6FfiCTUbQ1tNZayY9qLI2oOypahN5p+gbWn3PY0FwLL5lvc6IMJP8DIDY8cFVr4h4tCLwpNsBnI4QWXVzx/4=","wk":"LC4x1AdUvXAwLWeM1QMcZ6iu6TBZrlTKRY2XaHg8THDijg0ogMcp8/xMLkek8c+t"}],"ct":"YGHsula2cpuACCaWH6diX6OgUw+VNntKc8GiJZOqfoB5t2oMWXUiVPmzBKwMMiP/6RYfcVWx8M2dDncr9MWX4N6qshrRvETvpWOd9NpNHl12yonRpjH4vaWSc5icQnFcs3EW8lT77CsKNdg/","buyer":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","channel":"0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","sig":"0xa20cc8774678595dd1ef6e9253cf08347fd43236cccc173796a4e02964c3e52d01c8e27aa0a476b81c5f11912ee6e3de66400911c43940dd41f9b6a8c1737a151b"}}"#
        let worker = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: try Data(hexString: "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721"))
        let opened = try WorkerE2E.openRequest(Data(body.utf8), workerAddress: worker, key: key)
        XCTAssertEqual(opened.model, "qwen2.5-0.5b")
        XCTAssertTrue(String(decoding: opened.body, as: UTF8.self).contains("hi from node"))
        XCTAssertEqual(opened.buyer?.lowercased(), "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc")
        XCTAssertThrowsError(try WorkerE2E.openRequest(Data(body.utf8), workerAddress: "0x0000000000000000000000000000000000000001", key: key))
        XCTAssertThrowsError(try WorkerE2E.openRequest(Data(body.utf8), workerAddress: worker, key: P256.KeyAgreement.PrivateKey()))
    }

    func testEachRecipientOpensARequestSealedForTwoWorkers() throws {
        // sealRequest({ recipients: [w1, w2], buyer }) in @antseed/node/worker-e2e.
        let body = Data(#"{"model":"qwen2.5-0.5b","stream":true,"antseed_e2e":{"v":2,"recipients":[{"worker":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","epk":"BBHw6KisVYhQZr+Rcvfj2WOz6RQUZTxLIROfhsngn0KUCWkDlGIGb1YZqZhePkDJ0p1DQMR0x+Ac7gJLaXWWbQY=","wk":"Ltx3DttS1XStQIvtw7JJSIc2EImCifVV19epdD/OycesFHKcaoKpIkLhyFMai1fk"},{"worker":"0x90F79bf6EB2c4f870365E785982E1f101E93b906","epk":"BDk4pUTVcbiTY/QT1z0pNuHH2HTC5OPdJNwTtwZFvgyeYBZ8CwBwfUcLNIZ5zLlC1vx6QU0lPYlZr/m2XZsdJWY=","wk":"H7znnVjHwxSPpxqSyiOyBF/J0NwkRL368HLztubBVh3ydl+BUYyN+2zj4sm3Byzo"}],"ct":"gzhs4+nkyaG7DyM/ROpptc8859wJqQPAkbwwhGMzEmNe0z2V55rCvC6BEfKfL4lYobF4FlJoEDUMaeiJwLNe/J2mmSJVDCee2v1Itsfz0ZLv1Fmwhwn4NrtN3L8dWPN6uOnNNyYZ3PzyLLmM","buyer":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","channel":"0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","sig":"0xb59c375127adbcf05018e1aad5f606128cba11f0947594bf70f4b5a7cccb81595c0ba5b8d5a23ec2b18fc1e73391ca3dbeb18ed36c28449ddf032a1f7e5257821b"}}"#.utf8)
        let w1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
        let w2 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"
        let k1 = try P256.KeyAgreement.PrivateKey(rawRepresentation: try Data(hexString: "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721"))
        let k2 = try P256.KeyAgreement.PrivateKey(rawRepresentation: try Data(hexString: "519b423d715f8b581f4fa8ee59f4771a5b44c8130b4e3eacca54a56dda72b464"))
        for (worker, key) in [(w1, k1), (w2, k2)] {
            let opened = try WorkerE2E.openRequest(body, workerAddress: worker, key: key)
            XCTAssertTrue(String(decoding: opened.body, as: UTF8.self).contains("hi from node"))
            XCTAssertEqual(opened.recipients, [w1, w2])
            // The buyer's signature covers both recipients, in order.
            XCTAssertEqual(opened.buyer?.lowercased(), "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc")
        }
        // A worker the envelope does not name, or a recipient's address with another key, can't open it.
        XCTAssertThrowsError(try WorkerE2E.openRequest(body, workerAddress: "0x0000000000000000000000000000000000000001", key: k1)) {
            XCTAssertEqual($0 as? WorkerE2E.Failure, .wrongWorker)
        }
        XCTAssertThrowsError(try WorkerE2E.openRequest(body, workerAddress: w2, key: k1))
        // Reordering the recipients breaks the binding: the request no longer opens.
        var outer = try JSONSerialization.jsonObject(with: body) as! [String: Any]
        var envelope = outer["antseed_e2e"] as! [String: Any]
        envelope["recipients"] = Array((envelope["recipients"] as! [[String: Any]]).reversed())
        outer["antseed_e2e"] = envelope
        XCTAssertThrowsError(try WorkerE2E.openRequest(try JSONSerialization.data(withJSONObject: outer), workerAddress: w1, key: k1))
    }

    func testAnswerNamesTheWorkerAndOpensWithItsResponseKey() throws {
        let sealer = ResponseSealer(key: SymmetricKey(data: Data(repeating: 0x11, count: 32)), worker: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", salt: Data(repeating: 0x22, count: 16))
        let body = try JSONSerialization.jsonObject(with: try sealer.sealBody(Data(#"{"answer":1}"#.utf8), usage: nil)) as! [String: Any]
        let envelope = body["antseed_e2e"] as! [String: Any]
        XCTAssertEqual(envelope["worker"] as? String, "0x90F79bf6EB2c4f870365E785982E1f101E93b906")
        let key = ResponseSealer.responseKey(base: SymmetricKey(data: Data(repeating: 0x11, count: 32)), salt: Data(repeating: 0x22, count: 16))
        let plain = try WorkerE2E.open(key, seq: 0, aad: WorkerE2E.responseAAD(0, end: true), Data(base64Encoded: envelope["ct"] as! String)!)
        XCTAssertEqual(String(decoding: plain, as: UTF8.self), #"{"answer":1}"#)
        // A stream names it on its first event only.
        let stream = ResponseSealer(key: SymmetricKey(data: Data(repeating: 0x11, count: 32)), worker: "0xabc")
        let first = String(decoding: try stream.sealEvent("data: {}"), as: UTF8.self)
        let second = String(decoding: try stream.sealEvent("data: {}"), as: UTF8.self)
        XCTAssertTrue(first.contains(#""worker":"0xabc""#))
        XCTAssertFalse(second.contains("worker"))
    }

    func testResponseKeyFromSaltMatchesNode() {
        // responseKey(base, salt) in @antseed/node/worker-e2e: HKDF-SHA256(base, salt, "antseed-worker-e2e/v2|resp-key").
        let key = ResponseSealer.responseKey(base: SymmetricKey(data: Data(repeating: 0x11, count: 32)), salt: Data(repeating: 0x22, count: 16))
        XCTAssertEqual(key.withUnsafeBytes { Data($0) }.hex, "2d11af63a7112054fe4acaeb5d08f935522baff5d227392ccf160ac7f08c0986")
    }

    func testAttestationMessageAndSignatureMatchNode() throws {
        let keyHex = "0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299"
        let statement: [String: Any] = [
            "v": 1, "teamId": "H3M5BXXQR2", "signingId": "com.antseed.macworker", "cdhash": String(repeating: "ab", count: 20),
            "sip": true, "hardenedRuntime": true, "debuggerDenied": false, "keyAppBound": true, "os": "macOS 26.2",
            "serial": "C02TEST0MD6T", "udid": "00000000-0000-1000-8000-0123456789AB", "issued": 1767225600, "nonce": "n0",
        ]
        let message = Protection.attestationMessage(worker: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", keyHex: keyHex, statement: statement)
        // workerAttestationMessage in @antseed/node/worker-e2e for the same statement.
        XCTAssertEqual(message, "antseed-worker-attestation/v1\nworker:0x70997970c51812dc3a010c7d01b50e0d17dc79c8\nkey:\(keyHex)\nteam:H3M5BXXQR2\nsigning-id:com.antseed.macworker\ncdhash:abababababababababababababababababababab\nsip:1\nhardened-runtime:1\ndebugger-denied:0\nkey-app-bound:1\nos:macOS 26.2\nserial:C02TEST0MD6T\nudid:00000000-0000-1000-8000-0123456789AB\nissued:1767225600\nnonce:n0")
        // Node's DER signature (crypto.sign sha256) verifies with CryptoKit, so the reverse direction uses the same encoding.
        let publicKey = try P256.Signing.PublicKey(x963Representation: try Data(hexString: keyHex))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: Data(base64Encoded: "MEUCIQCiJy66wEGNJOwI6UpEzshogWUjJxcZKm5fIlzEM7Q2DQIgNnI1XLKIrBEgzq/yVvAittamdxynKykA1dGMDjKivQU=")!)
        XCTAssertTrue(publicKey.isValidSignature(signature, for: Data(message.utf8)))
        XCTAssertFalse(publicKey.isValidSignature(signature, for: Data(message.replacingOccurrences(of: "sip:1", with: "sip:0").utf8)))
    }

    func testThisMacReportsItsProtectionsAndSignsWithTheSecureEnclave() throws {
        let identity = Protection.codeIdentity()
        // `swift test` runs unsigned: never reported as hardened.
        XCTAssertNil(identity.teamId)
        let report = Protection.Report(identity: identity, sip: Protection.sipEnabled(), debuggerDenied: false, keyAppBound: false)
        XCTAssertFalse(report.hardened)
        XCTAssertNotNil(Protection.device.serial)
        XCTAssertEqual(Protection.device.udid?.count, 36)
        try XCTSkipUnless(SecureEnclave.isAvailable, "no Secure Enclave")
        let signer = AttestationKey(try SecureEnclave.P256.Signing.PrivateKey())
        let attestation = try Protection.attest(report, nonce: "n1", worker: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", keyHex: "04ab", signer: signer)
        let message = Protection.attestationMessage(worker: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", keyHex: "04ab", statement: attestation)
        let signature = try P256.Signing.ECDSASignature(derRepresentation: Data(base64Encoded: attestation["signature"] as! String)!)
        XCTAssertTrue(signer.publicKey.isValidSignature(signature, for: Data(message.utf8)))
    }
}

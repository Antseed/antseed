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
        let body = #"{"model":"qwen2.5-0.5b","stream":true,"antseed_e2e":{"v":3,"recipients":[{"worker":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","epk":"BPQkh7pyUxv3QVK83Q4KAyvKRpaUtRgn6fP/okQNz6sAW2h9oosHvoLZuhZHgpgJpp+VosytNOGDvc1dm7qnFsA=","wk":"eUKFGQo95l9JWaVPgBwgiK1887YmlUv6tuGWbRTpTG7qpDbiw+FWiF5f0HAqI87Y"}],"ct":"sjt09i7KQOxQPEhQU1Koj2zYsABtsCafzKWK9YfCnK5x3Jg/u/qLnUAZklY7dHrT+CW16CQ76zgJS8TgAkTbudKxIdkY32OkvGXhjLQBGDPPchK+tnCvy3UKTEGQjomhmcX9P7NPayzUq+Ha","buyer":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","channel":"0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","exp":2000000000,"sig":"0xac8e502271d1970675990d0fd234d63105fb29671038b4688468197a48f052102b214bb3a0bd8c7fc7fab05e9701207171d2a5967efae07c3d056a56374a035d1b"}}"#
        let worker = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: try Data(hexString: "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721"))
        let opened = try WorkerE2E.openRequest(Data(body.utf8), workerAddress: worker, key: key)
        XCTAssertEqual(opened.model, "qwen2.5-0.5b")
        XCTAssertTrue(String(decoding: opened.body, as: UTF8.self).contains("hi from node"))
        XCTAssertEqual(opened.buyer?.lowercased(), "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc")
        XCTAssertEqual(opened.expires, 2_000_000_000)
        // The signature covers the expiry: a changed one leaves the request unbound.
        let extended = body.replacingOccurrences(of: #""exp":2000000000"#, with: #""exp":2000000001"#)
        XCTAssertNil(try WorkerE2E.openRequest(Data(extended.utf8), workerAddress: worker, key: key).buyer)
        XCTAssertThrowsError(try WorkerE2E.openRequest(Data(body.utf8), workerAddress: "0x0000000000000000000000000000000000000001", key: key))
        XCTAssertThrowsError(try WorkerE2E.openRequest(Data(body.utf8), workerAddress: worker, key: P256.KeyAgreement.PrivateKey()))
        // The binding is read and verified before anything is decrypted: no key needed.
        let sealed = try WorkerE2E.inspectRequest(Data(body.utf8), workerAddress: worker)
        XCTAssertEqual(sealed.buyer?.lowercased(), "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc")
        XCTAssertEqual(sealed.channel?.lowercased(), "0x" + String(repeating: "cd", count: 32))
        XCTAssertEqual(sealed.expires, 2_000_000_000)
        XCTAssertEqual(sealed.binding, opened.binding)
        XCTAssertEqual(sealed.bodyBytes, opened.body.count)
        XCTAssertEqual(try WorkerE2E.decrypt(sealed, key: key).body, opened.body)
    }

    func testEachRecipientOpensARequestSealedForTwoWorkers() throws {
        // sealRequest({ recipients: [w1, w2], buyer }) in @antseed/node/worker-e2e.
        let body = Data(#"{"model":"qwen2.5-0.5b","stream":true,"antseed_e2e":{"v":3,"recipients":[{"worker":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","epk":"BICh5Jgr/pAgDPGInQXnxRc0F0L/dWuurJA53yaN5NmXHEdkn/UtWpcvLbU9MCHwQxXn/Qkryjk5Npwq2+QrDDs=","wk":"qjeMp0Pqos3encqibzGS8JKG+jAR93znG100N85/VOH15X4vWSRrszKsWb61P5oK"},{"worker":"0x90F79bf6EB2c4f870365E785982E1f101E93b906","epk":"BP1peFokuN9LgpGgg9Ejw2ovI4XIGnDkOhIcsF3OuOhNDcwibfBUFMp5cIaFOUpT8dAJYd878rDWfsCG3XW8JTQ=","wk":"MqWFcmPczitoXlFOL3unk2+HJxBwmBGypPNqpxdOv0Vl83lIfh0ZAq6oVjRlsTee"}],"ct":"1dWaylsSxIMKPhn6MSwGO8r+a+BFqU1h8iWVhJcmylzo815cdIIJBWv8tEjoj4Ire5LS1Ou9Tx5bVTl/WhiIo5Ru55KyAniisSyEKrzlS/IimZgXTpXhSLnivGUFryhT0l5+Kqn06XByFUhg","buyer":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","channel":"0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","exp":2000000000,"sig":"0x19940421401d79a2842711c90277ce01906ca966ff4f3d28c5967e322244786243cf11260c2b60379391b59645dc9f2cf7cd034a5bd16a4983dcce10f775f2a81c"}}"#.utf8)
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
        // responseKey(base, salt) in @antseed/node/worker-e2e: HKDF-SHA256(base, salt, "antseed-worker-e2e/v3|resp-key").
        let key = ResponseSealer.responseKey(base: SymmetricKey(data: Data(repeating: 0x11, count: 32)), salt: Data(repeating: 0x22, count: 16))
        XCTAssertEqual(key.withUnsafeBytes { Data($0) }.hex, "b7da4356e6d473751b91b59ac1f256a2f1bf9fb943d3c429463a5ac538d7c386")
    }

    func testAttestedWitnessSignsAsInNode() {
        let statement: [String: Any] = [
            "v": 1, "teamId": "H3M5BXXQR2", "signingId": "com.antseed.macworker", "cdhash": String(repeating: "ab", count: 20),
            "sip": true, "hardenedRuntime": true, "debuggerDenied": false, "keyAppBound": true, "os": "macOS 26.2",
            "serial": "C02TEST0MD6T", "udid": "00000000-0000-1000-8000-0123456789AB", "issued": 1767225600, "nonce": "n0",
            "models": [
                "qwen3.5-2b": [
                    "model": "mlx-community/Qwen3.5-2B-MLX-4bit@93760be4f1f69842a46bc13dbdc0f19e291392a3", "sha256": String(repeating: "12", count: 32),
                    "witness": ["path": "qwen3_5-2b/metal/tp1/mlx-q4g64/text", "engine": String(repeating: "56", count: 32),
                                "binary": String(repeating: "78", count: 32), "text": String(repeating: "9a", count: 32)],
                ],
                "a-svc": ["model": "org/a@" + String(repeating: "0", count: 40), "sha256": String(repeating: "34", count: 32)],
            ],
        ]
        // workerAttestationMessage in @antseed/node/worker-e2e for the same statement.
        XCTAssertEqual(
            Protection.attestationMessage(worker: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", keyHex: "04ab", statement: statement),
            "antseed-worker-attestation/v1\nworker:0x70997970c51812dc3a010c7d01b50e0d17dc79c8\nkey:04ab\nteam:H3M5BXXQR2\nsigning-id:com.antseed.macworker\ncdhash:abababababababababababababababababababab\nsip:1\nhardened-runtime:1\ndebugger-denied:0\nkey-app-bound:1\nos:macOS 26.2\nserial:C02TEST0MD6T\nudid:00000000-0000-1000-8000-0123456789AB\nmodels:a-svc=org/a@0000000000000000000000000000000000000000#3434343434343434343434343434343434343434343434343434343434343434,qwen3.5-2b=mlx-community/Qwen3.5-2B-MLX-4bit@93760be4f1f69842a46bc13dbdc0f19e291392a3#1212121212121212121212121212121212121212121212121212121212121212\nwitness:qwen3.5-2b=qwen3_5-2b/metal/tp1/mlx-q4g64/text#5656565656565656565656565656565656565656565656565656565656565656#7878787878787878787878787878787878787878787878787878787878787878#9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a\nissued:1767225600\nnonce:n0"
        )
    }

    func testAttestationCarriesOnlyAKnownWitness() throws {
        let report = Protection.Report(identity: .init(teamId: nil, signingId: nil, cdhash: nil, hardenedRuntime: false), sip: true, debuggerDenied: false, keyAppBound: false)
        let known = EngineWitness.Known(witness: String(repeating: "01", count: 32), path: "qwen3_5-2b/metal/tp1/mlx-q4g64/text",
                                        engine: String(repeating: "02", count: 32), binary: String(repeating: "03", count: 32), text: String(repeating: "04", count: 32))
        let models = [
            "a": LocalModel.Checkpoint(model: "org/a@1", sha256: String(repeating: "aa", count: 32), witness: .known(known)),
            "b": LocalModel.Checkpoint(model: "org/b@1", sha256: String(repeating: "bb", count: 32), witness: .unknown(reason: "unsupported_path", feature: nil)),
        ]
        let attestation = try Protection.attest(report, nonce: "n1", worker: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", keyHex: "04ab",
                                                signer: AttestationKey(P256.Signing.PrivateKey()), models: models)
        let attested = try XCTUnwrap(attestation["models"] as? [String: [String: Any]])
        XCTAssertEqual(attested["a"]?["witness"] as? [String: String], ["path": known.path, "engine": known.engine, "binary": known.binary, "text": known.text])
        XCTAssertNil(attested["b"]?["witness"])
        let message = Protection.attestationMessage(worker: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", keyHex: "04ab", statement: attestation)
        XCTAssertTrue(message.contains("\nwitness:a=\(known.path)#\(known.engine)#\(known.binary)#\(known.text)\nissued:"))
    }

    func testAttestedModelsSignAsInNode() {
        let statement: [String: Any] = [
            "v": 1, "teamId": "H3M5BXXQR2", "signingId": "com.antseed.macworker", "cdhash": String(repeating: "ab", count: 20),
            "sip": true, "hardenedRuntime": true, "debuggerDenied": false, "keyAppBound": true, "os": "macOS 26.2",
            "serial": "C02TEST0MD6T", "udid": "00000000-0000-1000-8000-0123456789AB", "issued": 1767225600, "nonce": "n0",
            "models": [
                "qwen3.5-2b": ["model": "mlx-community/Qwen3.5-2B-MLX-4bit@93760be4f1f69842a46bc13dbdc0f19e291392a3", "sha256": String(repeating: "12", count: 32)],
                "a-svc": ["model": "org/a@" + String(repeating: "0", count: 40), "sha256": String(repeating: "34", count: 32)],
            ],
        ]
        // workerAttestationMessage in @antseed/node/worker-e2e for the same statement.
        XCTAssertEqual(
            Protection.attestationMessage(worker: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", keyHex: "04ab", statement: statement),
            "antseed-worker-attestation/v1\nworker:0x70997970c51812dc3a010c7d01b50e0d17dc79c8\nkey:04ab\nteam:H3M5BXXQR2\nsigning-id:com.antseed.macworker\ncdhash:abababababababababababababababababababab\nsip:1\nhardened-runtime:1\ndebugger-denied:0\nkey-app-bound:1\nos:macOS 26.2\nserial:C02TEST0MD6T\nudid:00000000-0000-1000-8000-0123456789AB\nmodels:a-svc=org/a@0000000000000000000000000000000000000000#3434343434343434343434343434343434343434343434343434343434343434,qwen3.5-2b=mlx-community/Qwen3.5-2B-MLX-4bit@93760be4f1f69842a46bc13dbdc0f19e291392a3#1212121212121212121212121212121212121212121212121212121212121212\nissued:1767225600\nnonce:n0"
        )
    }

    func testFilesDigestMatchesShasumAndNode() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let snapshot = root.appendingPathComponent("snapshots/abc")
        try FileManager.default.createDirectory(at: snapshot.appendingPathComponent("sub"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("blobs"), withIntermediateDirectories: true)
        try Data("a\n".utf8).write(to: root.appendingPathComponent("blobs/x"))
        try FileManager.default.createSymbolicLink(atPath: snapshot.appendingPathComponent("model.safetensors").path, withDestinationPath: "../../blobs/x")
        for (path, text) in [("config.json", "{}\n"), ("sub/tok.json", "t\n"), ("sub-a.json", "z\n"), (".gitattributes", "g\n")] {
            try Data(text.utf8).write(to: snapshot.appendingPathComponent(path))
        }
        // cd snapshot && find -L . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256
        XCTAssertEqual(try LocalModel.filesDigest(of: snapshot), "8abebad2c580890a7a7cb2319ac8416f6b03f2346e008911323cd50a3eb56991")
    }

    func testServesThePinnedSnapshotFromTheEnginesCache() {
        let model = "mlx-community/Qwen3.5-2B-MLX-4bit@93760BE4F1F69842A46BC13DBDC0F19E291392A3"
        XCTAssertEqual(
            LocalModel.snapshotDirectory(model, hub: LocalModel.hubCache(["HF_HOME": "/h", "HF_HUB_CACHE": "/c"])).path,
            "/c/models--mlx-community--Qwen3.5-2B-MLX-4bit/snapshots/93760be4f1f69842a46bc13dbdc0f19e291392a3"
        )
        XCTAssertEqual(LocalModel.hubCache(["HF_HOME": "/h"]).path, "/h/hub")
        XCTAssertTrue(LocalModel.hubCache([:]).path.hasSuffix("/.cache/huggingface/hub"))
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

    func testAFullySignedBuildIsNotHardenedWhilePromptsReachTheEngine() throws {
        let identity = Protection.CodeIdentity(teamId: "H3M5BXXQR2", signingId: "com.antseed.macworker", cdhash: "ab", hardenedRuntime: true)
        let report = Protection.Report(identity: identity, sip: true, debuggerDenied: true, keyAppBound: true)
        XCTAssertFalse(report.hardened)
        XCTAssertTrue(report.summary.contains("TensorFold"))
        let attestation = try Protection.attest(report, nonce: "n1", worker: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", keyHex: "04ab", signer: AttestationKey(P256.Signing.PrivateKey()))
        XCTAssertEqual(attestation["debuggerDenied"] as? Bool, false)
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

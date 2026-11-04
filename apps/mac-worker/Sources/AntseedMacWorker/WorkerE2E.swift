import CryptoKit
import Foundation

/// Worker side of the buyer ↔ worker end-to-end encryption
/// (docs/protocol/worker-pool.md). Byte-compatible with @antseed/node/worker-e2e.
enum WorkerE2E {
    static let info = "antseed-worker-e2e/v2"
    static let version = 2

    enum Failure: Error, LocalizedError {
        case notEncrypted
        case wrongWorker
        case modelMismatch
        case malformed

        var errorDescription: String? {
            switch self {
            case .notEncrypted: "Refusing an unencrypted request"
            case .wrongWorker: "Envelope is addressed to another worker"
            case .modelMismatch: "Inner and outer model differ"
            case .malformed: "Request could not be decrypted for this worker"
            }
        }
    }

    /// Message the worker signs to certify its encryption key (and attestation key) for a pool seller.
    static func keyCertificateMessage(pool: String, keyHex: String, expires: Int, attestationKeyHex: String = "") -> String {
        "antseed-worker-key/v2\npool:\(pool.lowercased())\nkey:\(keyHex.lowercased())\nexpires:\(expires)\nattestation-key:\(attestationKeyHex.lowercased())"
    }

    static func nonce(_ seq: Int) -> ChaChaPoly.Nonce {
        var bytes = [UInt8](repeating: 0, count: 12)
        var value = UInt64(seq).bigEndian
        withUnsafeBytes(of: &value) { raw in
            for i in 0..<8 { bytes[4 + i] = raw[i] }
        }
        return try! ChaChaPoly.Nonce(data: bytes)
    }

    static func seal(_ key: SymmetricKey, seq: Int, aad: String, _ plaintext: Data) throws -> Data {
        let box = try ChaChaPoly.seal(plaintext, using: key, nonce: nonce(seq), authenticating: Data(aad.utf8))
        return box.ciphertext + box.tag
    }

    static func open(_ key: SymmetricKey, seq: Int, aad: String, _ sealed: Data) throws -> Data {
        guard sealed.count >= 16 else { throw Failure.malformed }
        let box = try ChaChaPoly.SealedBox(nonce: nonce(seq), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
        return try ChaChaPoly.open(box, using: key, authenticating: Data(aad.utf8))
    }

    static func responseAAD(_ seq: Int, end: Bool) -> String {
        "\(info)|resp|\(seq)\(end ? "|end" : "")"
    }

    struct OpenedRequest {
        /// The buyer's original JSON body.
        let body: Data
        let model: String
        /// Set when the buyer signed the binding and it verifies.
        let buyer: String?
        let channel: String?
        let sealer: ResponseSealer
    }

    static func isSealed(_ body: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return false }
        return object["antseed_e2e"] is [String: Any]
    }

    static func openRequest(_ body: Data, workerAddress: String, key: DecryptionKey) throws -> OpenedRequest {
        guard let outer = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              let envelope = outer["antseed_e2e"] as? [String: Any] else { throw Failure.notEncrypted }
        guard let model = outer["model"] as? String,
              let worker = envelope["worker"] as? String,
              let epkB64 = envelope["epk"] as? String, let epkData = Data(base64Encoded: epkB64),
              let ctB64 = envelope["ct"] as? String, let ct = Data(base64Encoded: ctB64),
              (envelope["v"] as? Int) == version else { throw Failure.malformed }
        guard worker.lowercased() == workerAddress.lowercased() else { throw Failure.wrongWorker }

        let epk: P256.KeyAgreement.PublicKey
        do {
            epk = try P256.KeyAgreement.PublicKey(x963Representation: epkData)
        } catch {
            throw Failure.malformed
        }
        let shared = try key.sharedSecretFromKeyAgreement(with: epk)
        let okm = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: epkData + key.publicKey.x963Representation,
            sharedInfo: Data(info.utf8),
            outputByteCount: 64
        )
        let bytes = okm.withUnsafeBytes { Data($0) }
        let requestKey = SymmetricKey(data: bytes.prefix(32))
        let responseKey = SymmetricKey(data: bytes.suffix(32))

        let plaintext: Data
        do {
            plaintext = try open(requestKey, seq: 0, aad: "\(info)|req|\(worker.lowercased())|\(model)", ct)
        } catch {
            throw Failure.malformed
        }
        guard let inner = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              inner["model"] as? String == model else { throw Failure.modelMismatch }

        var buyer: String?
        var channel: String?
        if let claimed = envelope["buyer"] as? String, let channelHex = envelope["channel"] as? String,
           let sigHex = envelope["sig"] as? String, let sig = try? Data(hexString: sigHex),
           let workerBytes = try? Data(hexString: worker), let channelBytes = try? Data(hexString: channelHex) {
            let binding = keccak256(Array(info.utf8) + Array(workerBytes) + Array(channelBytes) + keccak256(ct))
            if let recovered = try? recoverAddress(digest: personalMessageDigest(binding), signature: sig),
               recovered.lowercased() == claimed.lowercased() {
                buyer = claimed
                channel = channelHex
            }
        }
        return OpenedRequest(body: plaintext, model: model, buyer: buyer, channel: channel, sealer: ResponseSealer(key: responseKey))
    }
}

/// Encrypts a response for the buyer; the usage stays in the clear for metering.
final class ResponseSealer {
    private let key: SymmetricKey
    private var seq = 0

    init(key: SymmetricKey) { self.key = key }

    /// A complete (non-streamed) body.
    func sealBody(_ body: Data, usage: [String: Any]?) throws -> Data {
        let ct = try WorkerE2E.seal(key, seq: 0, aad: WorkerE2E.responseAAD(0, end: true), body)
        var envelope: [String: Any] = ["antseed_e2e": ["v": WorkerE2E.version, "ct": ct.base64EncodedString()]]
        if let usage { envelope["usage"] = usage }
        return Data(try jsonString(envelope).utf8)
    }

    /// One SSE event (`data: …`, without the blank-line separator).
    func sealEvent(_ event: String, usage: [String: Any]? = nil) throws -> Data {
        let current = seq
        seq += 1
        let ct = try WorkerE2E.seal(key, seq: current, aad: WorkerE2E.responseAAD(current, end: false), Data(event.utf8))
        var out = try "data: " + jsonString(["antseed_e2e": ["seq": current, "ct": ct.base64EncodedString()]]) + "\n\n"
        if let usage { out += try "data: " + jsonString(["choices": [Any](), "usage": usage]) + "\n\n" }
        return Data(out.utf8)
    }

    /// The authenticated end marker; a stream without it fails to verify.
    func finish() throws -> Data {
        let current = seq
        seq += 1
        let ct = try WorkerE2E.seal(key, seq: current, aad: WorkerE2E.responseAAD(current, end: true), Data())
        return try Data(("data: " + jsonString(["antseed_e2e": ["seq": current, "end": true, "ct": ct.base64EncodedString()]]) + "\n\n").utf8)
    }
}

func jsonString(_ object: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes, .sortedKeys]), as: UTF8.self)
}

import CryptoKit
import Foundation

/// Worker side of the buyer ↔ worker end-to-end encryption
/// (docs/protocol/colony-pool.md). Byte-compatible with @antseed/node/worker-e2e.
enum WorkerE2E {
    static let info = "antseed-worker-e2e/v2"
    static let version = 2
    /// Most workers one request is encrypted for.
    static let maxRecipients = 3

    enum Failure: Error, LocalizedError {
        case notEncrypted
        case wrongWorker
        case modelMismatch
        case malformed

        var errorDescription: String? {
            switch self {
            case .notEncrypted: "Refusing an unencrypted request"
            case .wrongWorker: "Envelope is addressed to other workers"
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
        /// Every worker the request is encrypted for, in order.
        let recipients: [String]
        /// Set when the buyer signed the binding and it verifies.
        let buyer: String?
        let channel: String?
        /// The signed expiry (unix seconds) and binding hash, set with `buyer`.
        let expires: UInt64?
        let binding: Data?
        let sealer: ResponseSealer
    }

    static func isSealed(_ body: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return false }
        return object["antseed_e2e"] is [String: Any]
    }

    /// A request as it arrived, before decryption: everything in the clear
    /// (the model, the recipients, the buyer's signed binding), so a worker can
    /// refuse it without ever reading the prompt.
    struct SealedRequest {
        let model: String
        /// Every worker the request is encrypted for, in order.
        let recipients: [String]
        /// Set when the buyer signed the binding and the signature recovers to it.
        let buyer: String?
        let channel: String?
        /// The signed expiry (unix seconds) and binding hash, set with `buyer`.
        let expires: UInt64?
        let binding: Data?
        /// The buyer's latest SpendingAuth the request carries (well-formed, not yet verified), with a binding only.
        let payment: WorkerPayment.Proof?
        /// The decrypted body's size (the ciphertext less its tag).
        let bodyBytes: Int
        fileprivate let worker: String
        fileprivate let epk: Data
        fileprivate let wrapped: Data
        fileprivate let ct: Data
    }

    /// Reads a request one of whose recipients is this worker, and verifies the
    /// buyer's binding, without decrypting anything. The binding covers
    /// keccak256(ct), so it holds for the ciphertext that is later opened.
    static func inspectRequest(_ body: Data, workerAddress: String) throws -> SealedRequest {
        guard let outer = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              let envelope = outer["antseed_e2e"] as? [String: Any] else { throw Failure.notEncrypted }
        guard let model = outer["model"] as? String,
              let entries = envelope["recipients"] as? [[String: Any]], (1...maxRecipients).contains(entries.count),
              let ctB64 = envelope["ct"] as? String, let ct = Data(base64Encoded: ctB64), ct.count >= 16,
              (envelope["v"] as? Int) == version else { throw Failure.malformed }
        let workers = try entries.map { entry -> String in
            guard let worker = entry["worker"] as? String else { throw Failure.malformed }
            return worker
        }
        guard Set(workers.map { $0.lowercased() }).count == workers.count else { throw Failure.malformed }
        guard let mine = entries.first(where: { ($0["worker"] as? String)?.lowercased() == workerAddress.lowercased() }) else {
            throw Failure.wrongWorker
        }
        guard let epkB64 = mine["epk"] as? String, let epk = Data(base64Encoded: epkB64),
              let wkB64 = mine["wk"] as? String, let wrapped = Data(base64Encoded: wkB64) else { throw Failure.malformed }

        var buyer: String?
        var channel: String?
        var expires: UInt64?
        var signedBinding: Data?
        if let claimed = envelope["buyer"] as? String, let channelHex = envelope["channel"] as? String,
           let sigHex = envelope["sig"] as? String, let sig = try? Data(hexString: sigHex),
           let channelBytes = try? Data(hexString: channelHex),
           let exp = envelope["exp"] as? Int, exp >= 0 {
            // keccak256(info ‖ worker₁ ‖ … ‖ workerₙ ‖ channel ‖ uint64 exp ‖ keccak256(ct))
            var preimage = Array(info.utf8)
            var addressesOK = true
            for worker in workers {
                guard let bytes = try? Data(hexString: worker), bytes.count == 20 else { addressesOK = false; break }
                preimage += Array(bytes)
            }
            if addressesOK {
                let expBytes = (0..<8).reversed().map { UInt8(truncatingIfNeeded: UInt64(exp) >> ($0 * 8)) }
                let binding = keccak256(preimage + Array(channelBytes) + expBytes + keccak256(ct))
                if let recovered = try? recoverAddress(digest: personalMessageDigest(binding), signature: sig),
                   recovered.lowercased() == claimed.lowercased() {
                    buyer = claimed
                    channel = channelHex
                    expires = UInt64(exp)
                    signedBinding = Data(binding)
                }
            }
        }
        return SealedRequest(model: model, recipients: workers, buyer: buyer, channel: channel, expires: expires,
                             binding: signedBinding, payment: signedBinding == nil ? nil : WorkerPayment.parse(envelope["pay"]),
                             bodyBytes: ct.count - 16, worker: workerAddress, epk: epk, wrapped: wrapped, ct: ct)
    }

    /// Decrypts an inspected request: unwraps the content key with this
    /// worker's own ECDH secret, then the body. The AADs bind the ordered
    /// recipient list and the model.
    static func decrypt(_ request: SealedRequest, key: DecryptionKey) throws -> OpenedRequest {
        let epk: P256.KeyAgreement.PublicKey
        do {
            epk = try P256.KeyAgreement.PublicKey(x963Representation: request.epk)
        } catch {
            throw Failure.malformed
        }
        let shared = try key.sharedSecretFromKeyAgreement(with: epk)
        let okm = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: request.epk + key.publicKey.x963Representation,
            sharedInfo: Data(info.utf8),
            outputByteCount: 64
        )
        let bytes = okm.withUnsafeBytes { Data($0) }
        let wrapKey = SymmetricKey(data: bytes.prefix(32))
        let responseKey = SymmetricKey(data: bytes.suffix(32))
        let list = request.recipients.map { $0.lowercased() }.joined(separator: ",")
        let model = request.model

        let plaintext: Data
        do {
            let contentKey = SymmetricKey(data: try open(wrapKey, seq: 0, aad: "\(info)|wrap|\(list)|\(model)", request.wrapped))
            plaintext = try open(contentKey, seq: 0, aad: "\(info)|req|\(list)|\(model)", request.ct)
        } catch {
            throw Failure.malformed
        }
        guard let inner = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              inner["model"] as? String == model else { throw Failure.modelMismatch }
        return OpenedRequest(body: plaintext, model: model, recipients: request.recipients, buyer: request.buyer, channel: request.channel,
                             expires: request.expires, binding: request.binding, sealer: ResponseSealer(key: responseKey, worker: request.worker))
    }

    /// `inspectRequest`, then `decrypt`.
    static func openRequest(_ body: Data, workerAddress: String, key: DecryptionKey) throws -> OpenedRequest {
        try decrypt(try inspectRequest(body, workerAddress: workerAddress), key: key)
    }
}

/// Encrypts a response for the buyer; the usage stays in the clear for metering.
/// Each response gets its own key from a random salt, so a replayed request
/// never seals two answers under the same key and nonce, and names this
/// worker so the buyer picks its response key (no other recipient has it).
final class ResponseSealer {
    private let key: SymmetricKey
    private let salt: Data
    private let worker: String
    private var seq = 0

    init(key base: SymmetricKey, worker: String, salt: Data = Data((0..<16).map { _ in UInt8.random(in: .min ... .max) })) {
        self.salt = salt
        self.worker = worker
        self.key = Self.responseKey(base: base, salt: salt)
    }

    static func responseKey(base: SymmetricKey, salt: Data) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: base, salt: salt, info: Data("\(WorkerE2E.info)|resp-key".utf8), outputByteCount: 32)
    }

    /// The first event of a stream names the worker and carries the salt.
    private func envelope(_ fields: [String: Any], seq: Int) -> [String: Any] {
        var fields = fields
        if seq == 0 {
            fields["salt"] = salt.base64EncodedString()
            fields["worker"] = worker
        }
        return ["antseed_e2e": fields]
    }

    /// A complete (non-streamed) body.
    func sealBody(_ body: Data, usage: [String: Any]?) throws -> Data {
        let ct = try WorkerE2E.seal(key, seq: 0, aad: WorkerE2E.responseAAD(0, end: true), body)
        var envelope = envelope(["v": WorkerE2E.version, "ct": ct.base64EncodedString()], seq: 0)
        if let usage { envelope["usage"] = usage }
        return Data(try jsonString(envelope).utf8)
    }

    /// One SSE event (`data: …`, without the blank-line separator).
    func sealEvent(_ event: String, usage: [String: Any]? = nil) throws -> Data {
        let current = seq
        seq += 1
        let ct = try WorkerE2E.seal(key, seq: current, aad: WorkerE2E.responseAAD(current, end: false), Data(event.utf8))
        var out = try "data: " + jsonString(envelope(["seq": current, "ct": ct.base64EncodedString()], seq: current)) + "\n\n"
        if let usage { out += try "data: " + jsonString(["choices": [Any](), "usage": usage]) + "\n\n" }
        return Data(out.utf8)
    }

    /// The authenticated end marker; a stream without it fails to verify.
    func finish() throws -> Data {
        let current = seq
        seq += 1
        let ct = try WorkerE2E.seal(key, seq: current, aad: WorkerE2E.responseAAD(current, end: true), Data())
        return try Data(("data: " + jsonString(envelope(["seq": current, "end": true, "ct": ct.base64EncodedString()], seq: current)) + "\n\n").utf8)
    }
}

func jsonString(_ object: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes, .sortedKeys]), as: UTF8.self)
}

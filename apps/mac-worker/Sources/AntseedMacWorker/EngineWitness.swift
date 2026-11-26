import Foundation

/// The engine's execution witness (`serve --execution-witness`, "Execution witness" in TensorFold's
/// docs/api.md): the engine's own digest of the checkpoint it loaded, every weight byte read once it
/// serves, beside the digests of its executable and the text files it loaded, and each reply's
/// binding to it. Reported by the engine, not signed by it: the app attests what its engine reports.
enum EngineWitness {
    /// A known snapshot, as the worker attests it.
    struct Known: Equatable, Sendable {
        /// New with every engine start: SHA-256 over the content, the process and the engine generation.
        let witness: String
        /// The supported path it attests, e.g. `qwen3_5-2b/metal/tp1/mlx-q4g64/text`.
        let path: String
        /// `components.engine`: the weights, the checkpoint's structure, the Metal kernels and the OS and chip that build them.
        let engine: String
        /// `components.binary`: the engine executable's SHA-256.
        let binary: String
        /// `components.text`: the tokenizer, template and special-token files.
        let text: String
    }

    /// What `GET /v1/execution/witness` reads.
    enum Snapshot: Equatable, Sendable {
        case known(Known)
        /// `pending`, `unsupported_path`, `feature_excluded` (naming `feature`), `files_changed`, `hash_failed`, …
        case unknown(reason: String, feature: String?)

        var known: Known? {
            if case .known(let known) = self { return known }
            return nil
        }

        /// Still hashing, or the engine reloading: it will read something else.
        var settling: Bool {
            if case .unknown(let reason, _) = self { return ["pending", "parked", "reloading"].contains(reason) }
            return false
        }

        /// The files changed under the engine after it stamped them: what it serves is not what it hashed.
        var filesChanged: Bool {
            if case .unknown("files_changed", _) = self { return true }
            return false
        }

        /// For the activity log.
        var summary: String {
            switch self {
            case .known(let known): "execution witness known · \(known.path) · engine \(known.engine.prefix(12))"
            case .unknown(let reason, let feature): "no execution witness (\(reason)\(feature.map { " \($0)" } ?? ""))"
            }
        }
    }

    static func snapshot(_ object: [String: Any]) -> Snapshot? {
        guard object["schema"] as? Int == 1, let state = object["state"] as? String else { return nil }
        if state == "known" {
            let components = object["components"] as? [String: Any]
            guard let witness = object["witness"] as? String, let path = object["path"] as? String, isPath(path),
                  let engine = components?["engine"] as? String, let binary = components?["binary"] as? String,
                  let text = components?["text"] as? String, [witness, engine, binary, text].allSatisfy(isDigest) else { return nil }
            return .known(Known(witness: witness, path: path, engine: engine, binary: binary, text: text))
        }
        guard state == "unknown", let reason = object["reason"] as? String else { return nil }
        return .unknown(reason: reason, feature: object["feature"] as? String)
    }

    /// A reply's `execution_witness`: known when the engine read the same known witness when it took
    /// the request and when the reply ended.
    struct Binding: Equatable, Sendable {
        let known: Bool
        /// Known only: the witness the reply is bound to.
        let witness: String?
        /// Known only: SHA-256 over the witness, the prompt's and the reply's tokens, the resolved request and the finish reason.
        let binding: String?
        /// Unknown only: the snapshot's reason, or `epoch_changed`, `witness_changed` or `unbound`.
        let reason: String?
    }

    static func binding(_ object: [String: Any]) -> Binding? {
        guard let state = object["state"] as? String else { return nil }
        if state == "known" {
            guard let witness = object["witness"] as? String, let binding = object["binding"] as? String,
                  isDigest(witness), isDigest(binding) else { return nil }
            return Binding(known: true, witness: witness, binding: binding, reason: nil)
        }
        return Binding(known: false, witness: nil, binding: nil, reason: object["reason"] as? String ?? "unknown")
    }

    static func isDigest(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// Printable, without the separators the attestation's line uses.
    static func isPath(_ text: String) -> Bool {
        (1...128).contains(text.utf8.count) && text.utf8.allSatisfy { (33...126).contains($0) && !",=#".utf8.contains($0) }
    }
}

import CryptoKit
import Foundation
import Security

/// Settings from the command line (or defaults), e.g.
/// `AntseedMacWorker --pool wss://pool.example:8790 --rpc https://… --channels 0x…`.
struct WorkerConfig {
    var poolURL = URL(string: "ws://127.0.0.1:8790")!
    /// Service name the pool sells.
    var service = "qwen3.5-2b"
    /// Hugging Face checkpoint that serves it, pinned to a revision the engine was checked with.
    var modelId = "mlx-community/Qwen3.5-2B-MLX-4bit@93760be4f1f69842a46bc13dbdc0f19e291392a3"
    /// The TensorFold engine; `scripts/build-app.sh` bundles it.
    var engineURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/tensorfold/bin/tensorfold-native")
    /// RPCs that request channels (and the payout wallet) are read on, in the
    /// order tried: Base mainnet's default RPC and its fallbacks, unless `--rpc`
    /// names one (which replaces them all). Buyer requests are refused without
    /// one, so the pool can't buy work with made-up channels.
    var rpcURLs: [URL] = ([GeneratedContractAddresses.defaultRPC] + GeneratedContractAddresses.fallbackRPCs).compactMap(URL.init(string:))
    /// The AntseedChannels contract to check request channels on (default: the
    /// deployment for the RPC's chain; required on other chains, such as a local one).
    var channelsAddress: String?
    var dataDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("AntseedMacWorker", isDirectory: true)
    /// Write PNG renderings of the dashboard here every few seconds.
    var snapshotDirectory: URL?
    var name = Host.current().localizedName ?? "Mac"
    /// Append activity lines here.
    var logFile: URL?
    /// Sign a payout link for this wallet once joined (a Mac with no one at the
    /// screen); the code is also written to the log.
    var linkPayoutTo: String?

    /// Whether `modelId` is `repo@revision` with a full commit hash: an
    /// unpinned model could change under the service name the pool sells.
    static func isPinned(_ modelId: String) -> Bool {
        let parts = modelId.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].split(separator: "/").count == 2 else { return false }
        return parts[1].count == 40 && parts[1].allSatisfy(\.isHexDigit)
    }

    /// The model's short name, for display.
    var modelName: String {
        let repository = modelId.split(separator: "@", maxSplits: 1).first.map(String.init) ?? modelId
        return repository.split(separator: "/").last.map(String.init) ?? repository
    }

    static func fromCommandLine(_ arguments: [String] = CommandLine.arguments) -> WorkerConfig {
        var config = WorkerConfig()
        var iterator = arguments.dropFirst().makeIterator()
        while let flag = iterator.next() {
            guard let value = iterator.next() else { break }
            switch flag {
            case "--pool": config.poolURL = URL(string: value) ?? config.poolURL
            case "--service": config.service = value
            case "--model": config.modelId = value
            case "--engine": config.engineURL = URL(fileURLWithPath: value)
            case "--rpc": config.rpcURLs = URL(string: value).map { [$0] } ?? []
            case "--channels": config.channelsAddress = value
            case "--data-dir": config.dataDirectory = URL(fileURLWithPath: value, isDirectory: true)
            case "--snapshot": config.snapshotDirectory = URL(fileURLWithPath: value, isDirectory: true)
            case "--name": config.name = value
            case "--log": config.logFile = URL(fileURLWithPath: value)
            case "--link-payout": config.linkPayoutTo = value
            default: break
            }
        }
        return config
    }
}

/// The worker's keys. The address key (identity and payout signer) is kept in
/// a 0600 file. The decryption and attestation keys live in the Secure Enclave:
/// they never leave it, and their handles are kept in the data-protection
/// keychain under this app's access group, so only this signed app can use
/// them. Builds without that entitlement (development) keep the handles in the
/// file instead and attest `keyAppBound: false`.
struct WorkerKeys {
    let ethereum: EthereumKey
    let encryption: DecryptionKey
    let attestation: AttestationKey
    /// Only this signed app can use the decryption key.
    let appBound: Bool

    var encryptionKeyHex: String { encryption.publicKey.x963Representation.hex }
    var attestationKeyHex: String { attestation.publicKey.x963Representation.hex }

    enum LoadError: Error, LocalizedError {
        case damaged(URL, String)
        var errorDescription: String? {
            guard case .damaged(let url, let reason) = self else { return nil }
            return "\(url.path) \(reason). It holds this Mac's worker identity (the address its earnings are credited to), so it was left untouched. Restore it from a backup, or move it aside to start over as a new worker."
        }
    }

    static func loadOrCreate(in directory: URL) throws -> WorkerKeys {
        let url = directory.appendingPathComponent("keys.json")
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // New keys only on a first launch: a file that exists but can't be read
        // or decoded is never replaced, since that would lose the worker identity.
        let firstLaunch = !fm.fileExists(atPath: url.path)
        var stored: [String: String] = [:]
        if !firstLaunch {
            let data: Data
            do { data = try Data(contentsOf: url) } catch { throw LoadError.damaged(url, "can't be read (\(error.localizedDescription))") }
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
                throw LoadError.damaged(url, "is not a valid key file")
            }
            stored = object
        }
        var changed = false

        let ethereum: EthereumKey
        if let hex = stored["ethereum"] {
            do { ethereum = try EthereumKey(privateKey: try Data(hexString: hex)) } catch { throw LoadError.damaged(url, "holds an invalid address key") }
        } else if !firstLaunch {
            throw LoadError.damaged(url, "has no address key")
        } else {
            let (key, raw) = try EthereumKey.generate()
            ethereum = key
            stored["ethereum"] = raw.hex
            changed = true
        }

        let appBound = Keychain.available
        func handle(_ name: String, create: () throws -> Data) throws -> Data {
            if appBound {
                if let data = try Keychain.load(name) { return data }
                let data = try create()
                try Keychain.save(name, data)
                return data
            }
            if let b64 = stored[name], let data = Data(base64Encoded: b64) { return data }
            let data = try create()
            stored[name] = data.base64EncodedString()
            changed = true
            return data
        }

        let encryption: DecryptionKey
        let attestation: AttestationKey
        if SecureEnclave.isAvailable {
            let agreement = try handle("se-encryption") { try SecureEnclave.P256.KeyAgreement.PrivateKey().dataRepresentation }
            let signing = try handle("se-attestation") { try SecureEnclave.P256.Signing.PrivateKey().dataRepresentation }
            encryption = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: agreement)
            attestation = AttestationKey(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: signing))
        } else {
            // No Secure Enclave (a VM): software keys, never reported as app-bound.
            let agreement = try handle("p256-encryption") { P256.KeyAgreement.PrivateKey().rawRepresentation }
            let signing = try handle("p256-attestation") { P256.Signing.PrivateKey().rawRepresentation }
            encryption = try P256.KeyAgreement.PrivateKey(rawRepresentation: agreement)
            attestation = AttestationKey(try P256.Signing.PrivateKey(rawRepresentation: signing))
        }

        if changed {
            stored.removeValue(forKey: "encryption") // the v1 X25519 key
            try JSONSerialization.data(withJSONObject: stored).write(to: url, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
        return WorkerKeys(ethereum: ethereum, encryption: encryption, attestation: attestation, appBound: appBound && SecureEnclave.isAvailable)
    }
}

/// Generic-password items in the data-protection keychain, under the app's
/// default access group (`keychain-access-groups` entitlement).
enum Keychain {
    private static let service = "com.antseed.macworker.keys"

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    /// False when the app lacks the entitlement (development builds). Lookups
    /// succeed without it, so this probes with a write.
    static let available: Bool = {
        var probe = query("probe")
        probe[kSecValueData as String] = Data()
        let status = SecItemAdd(probe as CFDictionary, nil)
        SecItemDelete(query("probe") as CFDictionary)
        return status == errSecSuccess || status == errSecDuplicateItem
    }()

    static func load(_ account: String) throws -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return result as? Data
    }

    static func save(_ account: String, _ data: Data) throws {
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    struct KeychainError: Error, LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "Keychain error \(status)" }
    }
}

import CryptoKit
import Foundation
import Security

/// Settings from the command line (or defaults), e.g.
/// `AntseedMacWorker --pool ws://pool.example:8790 --rpc http://… --pool-contract 0x…`.
struct WorkerConfig {
    var poolURL = URL(string: "ws://127.0.0.1:8790")!
    /// Service name the pool sells.
    var service = "qwen2.5-0.5b"
    /// Hugging Face MLX model that serves it.
    var modelId = "mlx-community/Qwen2.5-0.5B-Instruct-4bit"
    var rpcURL: URL?
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

    static func fromCommandLine(_ arguments: [String] = CommandLine.arguments) -> WorkerConfig {
        var config = WorkerConfig()
        var iterator = arguments.dropFirst().makeIterator()
        while let flag = iterator.next() {
            guard let value = iterator.next() else { break }
            switch flag {
            case "--pool": config.poolURL = URL(string: value) ?? config.poolURL
            case "--service": config.service = value
            case "--model": config.modelId = value
            case "--rpc": config.rpcURL = URL(string: value)
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

    static func loadOrCreate(in directory: URL) throws -> WorkerKeys {
        let url = directory.appendingPathComponent("keys.json")
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var stored = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
        var changed = false

        let ethereum: EthereumKey
        if let hex = stored["ethereum"] {
            ethereum = try EthereumKey(privateKey: try Data(hexString: hex))
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

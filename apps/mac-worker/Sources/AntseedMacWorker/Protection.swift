import CryptoKit
import Darwin
import Foundation
import IOKit
import Security

/// What keeps the Mac's owner out of the prompts this app decrypts, and the
/// attestation that reports it (docs/protocol/colony-pool.md, "Hardened Macs").
/// macOS enforces these for a Developer ID build with the hardened runtime
/// while SIP is on; memory itself is not encrypted, so this is a hardened Mac,
/// not a TEE.
enum Protection {
    /// The running app's code signature.
    struct CodeIdentity {
        let teamId: String?
        let signingId: String?
        let cdhash: String?
        /// Hardened runtime on and get-task-allow off: macOS refuses debuggers and injection.
        let hardenedRuntime: Bool
    }

    static func codeIdentity() -> CodeIdentity {
        var code: SecCode?
        var staticCode: SecStaticCode?
        var info: CFDictionary?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, [], nil) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let info = info as? [String: Any] else {
            return CodeIdentity(teamId: nil, signingId: nil, cdhash: nil, hardenedRuntime: false)
        }
        let flags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
        let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
        let debuggable = entitlements["com.apple.security.get-task-allow"] as? Bool ?? false
        let adhoc = flags & SecCodeSignatureFlags.adhoc.rawValue != 0
        return CodeIdentity(
            teamId: adhoc ? nil : info[kSecCodeInfoTeamIdentifier as String] as? String,
            signingId: info[kSecCodeInfoIdentifier as String] as? String,
            cdhash: (info[kSecCodeInfoUnique as String] as? Data)?.hex,
            hardenedRuntime: !adhoc && flags & SecCodeSignatureFlags.runtime.rawValue != 0 && !debuggable
        )
    }

    /// System Integrity Protection fully on. Without it, root could debug or
    /// patch the app despite the hardened runtime. Turning it off needs a
    /// reboot into Recovery, and this app then stops serving.
    static func sipEnabled() -> Bool {
        typealias GetConfig = @convention(c) (UnsafeMutablePointer<UInt32>) -> Int32
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "csr_get_active_config") else { return false }
        var config: UInt32 = 0
        guard unsafeBitCast(symbol, to: GetConfig.self)(&config) == 0 else { return false }
        // Untrusted kexts, unrestricted filesystem, task_for_pid, kernel
        // debugger, unrestricted dtrace, unapproved kexts, unauthenticated root.
        let weakening: UInt32 = 0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x200 | 0x800
        return config & weakening == 0
    }

    /// Refuse debugger attachment for the life of the process (PT_DENY_ATTACH).
    static func denyDebuggers() -> Bool {
        typealias Ptrace = @convention(c) (Int32, pid_t, UnsafeMutableRawPointer?, Int32) -> Int32
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "ptrace") else { return false }
        return unsafeBitCast(symbol, to: Ptrace.self)(31, 0, nil, 0) == 0
    }

    static func debuggerAttached() -> Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0 else { return true }
        return info.kp_proc.p_flag & P_TRACED != 0
    }

    /// The Mac's serial number and hardware UUID (the UDID an MDM addresses it by).
    static let device: (serial: String?, udid: String?) = {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        defer { IOObjectRelease(service) }
        func property(_ key: String) -> String? {
            IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String
        }
        return (property(kIOPlatformSerialNumberKey), property(kIOPlatformUUIDKey))
    }()

    static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macOS \(v.majorVersion).\(v.minorVersion)\(v.patchVersion > 0 ? ".\(v.patchVersion)" : "")"
    }

    /// The protections in force right now.
    struct Report {
        let identity: CodeIdentity
        let sip: Bool
        let debuggerDenied: Bool
        let keyAppBound: Bool

        /// False while decrypted prompts leave this app for the TensorFold engine:
        /// the app's protections don't cover that process, and the Mac's owner can
        /// read its loopback traffic. Set true only once inference runs in the app.
        static let promptsStayInApp = false

        /// What pools and buyers that require attestation accept.
        var hardened: Bool { Self.promptsStayInApp && identity.teamId != nil && identity.hardenedRuntime && sip && debuggerDenied && keyAppBound }

        /// One line for the menubar panel.
        var summary: String {
            if hardened { return "Prompts protected: signed app, SIP on, key in the Secure Enclave" }
            if identity.teamId != nil && !sip { return "System Integrity Protection is off: not serving" }
            if identity.teamId == nil { return "Development build: prompts are not protected from this Mac's owner" }
            if !Self.promptsStayInApp { return "Prompts pass through the TensorFold engine: not protected from this Mac's owner" }
            if !keyAppBound { return "Key not bound to this app: prompts are not protected" }
            return "Debugger protection is off: prompts are not protected"
        }
    }

    static func attestationMessage(worker: String, keyHex: String, statement: [String: Any]) -> String {
        func flag(_ key: String) -> String { (statement[key] as? Bool ?? false) ? "1" : "0" }
        func text(_ key: String) -> String { statement[key] as? String ?? "" }
        return [
            "antseed-worker-attestation/v1",
            "worker:\(worker.lowercased())",
            "key:\(keyHex.lowercased())",
            "team:\(text("teamId"))",
            "signing-id:\(text("signingId"))",
            "cdhash:\(text("cdhash"))",
            "sip:\(flag("sip"))",
            "hardened-runtime:\(flag("hardenedRuntime"))",
            "debugger-denied:\(flag("debuggerDenied"))",
            "key-app-bound:\(flag("keyAppBound"))",
            "os:\(text("os"))",
            "serial:\(text("serial"))",
            "udid:\(text("udid"))",
            "issued:\(statement["issued"] as? Int ?? 0)",
            "nonce:\(text("nonce"))",
        ].joined(separator: "\n")
    }

    /// A signed attestation answering the pool's `nonce` (WorkerAttestation in @antseed/node/worker-e2e).
    static func attest(_ report: Report, nonce: String, worker: String, keyHex: String, signer: AttestationKey, issued: Int = Int(Date().timeIntervalSince1970)) throws -> [String: Any] {
        var statement: [String: Any] = [
            "v": 1,
            "teamId": report.identity.teamId ?? NSNull(),
            "signingId": report.identity.signingId ?? NSNull(),
            "cdhash": report.identity.cdhash ?? NSNull(),
            "sip": report.sip,
            "hardenedRuntime": report.identity.hardenedRuntime,
            // Pools and buyers derive "hardened" from these flags, so a worker whose
            // prompts reach a process that doesn't deny debuggers can't report this.
            "debuggerDenied": report.debuggerDenied && Report.promptsStayInApp,
            "keyAppBound": report.keyAppBound,
            "os": osVersion,
            "serial": device.serial ?? NSNull(),
            "udid": device.udid ?? NSNull(),
            "issued": issued,
            "nonce": nonce,
        ]
        let message = attestationMessage(worker: worker, keyHex: keyHex, statement: statement)
        statement["signature"] = try signer.sign(Data(message.utf8)).derRepresentation.base64EncodedString()
        return statement
    }
}

/// The worker's decryption key: in the Secure Enclave on a real Mac, in memory in tests.
protocol DecryptionKey {
    var publicKey: P256.KeyAgreement.PublicKey { get }
    func sharedSecretFromKeyAgreement(with publicKeyShare: P256.KeyAgreement.PublicKey) throws -> SharedSecret
}

extension P256.KeyAgreement.PrivateKey: DecryptionKey {}
extension SecureEnclave.P256.KeyAgreement.PrivateKey: DecryptionKey {}

/// The key that signs attestations: in the Secure Enclave on a real Mac.
struct AttestationKey {
    let publicKey: P256.Signing.PublicKey
    let sign: (Data) throws -> P256.Signing.ECDSASignature

    init(_ key: SecureEnclave.P256.Signing.PrivateKey) {
        publicKey = key.publicKey
        sign = { try key.signature(for: $0) }
    }

    init(_ key: P256.Signing.PrivateKey) {
        publicKey = key.publicKey
        sign = { try key.signature(for: $0) }
    }
}

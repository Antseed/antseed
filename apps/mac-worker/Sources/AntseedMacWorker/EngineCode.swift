import Darwin
import Foundation
import Security

/// What may run as the engine and what it starts with. Decrypted prompts reach the engine, so on a
/// signed build only code signed by this app's own team, with the engine's identifier, may be it:
/// checked on the file before it runs and on the process at the other end of every connection.
/// A development (ad hoc) build has no team to name, checks neither, and attests not hardened.
enum EngineCode {
    /// The signing identifier `scripts/build-app.sh` gives the bundled engine.
    static let identifier = "com.antseed.colony.tensorfold"

    /// The code requirement the engine must meet, or nil when this build has no team ID.
    static func requirement(teamId: String?) -> String? {
        guard let teamId, teamId.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return nil }
        return "anchor apple generic and certificate leaf[subject.OU] = \"\(teamId)\" and identifier \"\(identifier)\""
    }

    enum CodeError: Error, LocalizedError {
        case notEngine(String)
        var errorDescription: String? { if case .notEngine(let reason) = self { reason } else { nil } }
    }

    /// Refuse to run an engine file that isn't validly signed to `requirement`.
    static func verifyFile(_ url: URL, requirement text: String?) throws {
        guard let text else { return }
        var code: SecStaticCode?
        guard let requirement = compile(text),
              SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else {
            throw CodeError.notEngine("Could not read the engine's code signature at \(url.path)")
        }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate)
        let status = SecStaticCodeCheckValidity(code, flags, requirement)
        guard status == errSecSuccess else {
            throw CodeError.notEngine("The engine at \(url.path) is not the one this app ships (code signature check \(status))")
        }
    }

    /// Whether the running process named by `token` is validly signed to `requirement`.
    static func verifyProcess(_ token: audit_token_t, requirement text: String) -> Bool {
        guard let requirement = compile(text) else { return false }
        var token = token
        let data = withUnsafeBytes(of: &token) { Data($0) }
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: data] as CFDictionary, [], &code) == errSecSuccess,
              let code else { return false }
        return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
    }

    /// The engine's whole environment. Nothing the app was started with reaches it: the engine reads
    /// hundreds of settings from its environment, some of which write requests to disk
    /// (`TENSORFOLD_REQUEST_LOG`) or load a library (`TENSORFOLD_LIBTURBOJPEG`).
    static func environment(hubCache: URL, offline: Bool) -> [String: String] {
        var environment = [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": accountHome(),
            "TMPDIR": NSTemporaryDirectory(),
            "HF_HUB_CACHE": hubCache.path,
        ]
        // Serving reads only the snapshot it was given; only a pull downloads.
        if offline { environment["HF_HUB_OFFLINE"] = "1" }
        return environment
    }

    /// This user's home from the account database, not from a `HOME` the app may have been started with.
    static func accountHome() -> String {
        if let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir { return String(cString: dir) }
        return NSHomeDirectory()
    }

    /// No core files for this process or the engine it starts: one would hold decrypted prompts.
    /// Lowering the hard limit too means neither can raise it again.
    static func disableCoreDumps() {
        var none = rlimit(rlim_cur: 0, rlim_max: 0)
        setrlimit(RLIMIT_CORE, &none)
    }

    private static func compile(_ text: String) -> SecRequirement? {
        var requirement: SecRequirement?
        return SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess ? requirement : nil
    }
}

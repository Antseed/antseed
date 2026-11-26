import Darwin
import Security
import XCTest
@testable import AntseedMacWorker

final class EngineCodeTests: XCTestCase {
    func testASignedBuildRequiresItsOwnTeamAndTheEngineIdentifier() throws {
        XCTAssertNil(EngineCode.requirement(teamId: nil), "a development build names no team")
        XCTAssertNil(EngineCode.requirement(teamId: "not a team\" or anchor apple"), "a team ID is ten letters or digits")
        let text = try XCTUnwrap(EngineCode.requirement(teamId: "ABCDE12345"))
        XCTAssertEqual(text, #"anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345" and identifier "com.antseed.colony.tensorfold""#)
        var requirement: SecRequirement?
        XCTAssertEqual(SecRequirementCreateWithString(text as CFString, [], &requirement), errSecSuccess)
    }

    func testRefusesAnEngineFileFromAnyoneElse() throws {
        let requirement = try XCTUnwrap(EngineCode.requirement(teamId: "ABCDE12345"))
        // Signed, but by Apple rather than this team.
        XCTAssertThrowsError(try EngineCode.verifyFile(URL(fileURLWithPath: "/bin/ls"), requirement: requirement))
        let script = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try "#!/bin/sh\n".write(to: script, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: script) }
        XCTAssertThrowsError(try EngineCode.verifyFile(script, requirement: requirement), "unsigned")
        XCTAssertNoThrow(try EngineCode.verifyFile(script, requirement: nil), "a development build checks nothing")
    }

    func testChecksARunningProcessByItsAuditToken() throws {
        var token = audit_token_t()
        var count = mach_msg_type_number_t(MemoryLayout<audit_token_t>.size / MemoryLayout<natural_t>.size)
        let status = withUnsafeMutablePointer(to: &token) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_AUDIT_TOKEN), $0, &count) }
        }
        XCTAssertEqual(status, KERN_SUCCESS)
        XCTAssertFalse(EngineCode.verifyProcess(token, requirement: try XCTUnwrap(EngineCode.requirement(teamId: "ABCDE12345"))))
        XCTAssertTrue(EngineCode.verifyProcess(token, requirement: try Self.ownRequirement()), "a process meeting the requirement passes")
    }

    func testTheEngineEnvironmentIsFixed() {
        setenv("TENSORFOLD_REQUEST_LOG", "/tmp/prompts.log", 1)
        setenv("HOME", "/tmp/elsewhere", 1)
        defer { unsetenv("TENSORFOLD_REQUEST_LOG"); setenv("HOME", EngineCode.accountHome(), 1) }
        let cache = URL(fileURLWithPath: "/tmp/hub")
        let serving = EngineCode.environment(hubCache: cache, offline: true)
        XCTAssertEqual(Set(serving.keys), ["PATH", "HOME", "TMPDIR", "HF_HUB_CACHE", "HF_HUB_OFFLINE"])
        XCTAssertEqual(serving["HOME"], EngineCode.accountHome())
        XCTAssertNotEqual(serving["HOME"], "/tmp/elsewhere", "HOME comes from the account, not the app's environment")
        XCTAssertEqual(serving["HF_HUB_CACHE"], "/tmp/hub")
        XCTAssertNil(EngineCode.environment(hubCache: cache, offline: false)["HF_HUB_OFFLINE"], "a pull downloads")
    }

    /// A requirement this test process meets: its own identifier and code directory hash.
    static func ownRequirement() throws -> String {
        var code: SecCode?
        var staticCode: SecStaticCode?
        var info: CFDictionary?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let info = info as? [String: Any], let cdhash = info[kSecCodeInfoUnique as String] as? Data
        else { throw XCTSkip("this test process has no code signature") }
        return "cdhash H\"\(cdhash.map { String(format: "%02x", $0) }.joined())\""
    }
}

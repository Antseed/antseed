import Foundation
import IOKit.ps
import ServiceManagement

/// What keeps this Mac earning without anyone at it: starting at login, and
/// staying awake while it shares (by default only on power, so it never drains
/// a laptop's battery). Kept in the app's preferences.
@MainActor
final class MacSettings: ObservableObject {
    @Published private(set) var openAtLogin = false
    @Published var keepAwake: Bool {
        didSet { defaults.set(keepAwake, forKey: Keys.keepAwake); refreshAwake() }
    }
    @Published var onlyOnPower: Bool {
        didSet { defaults.set(onlyOnPower, forKey: Keys.onlyOnPower); refreshAwake() }
    }
    /// Why the login item could not change, if it couldn't (e.g. the app isn't in Applications).
    @Published private(set) var loginError: String?
    /// Whether the Mac is held awake right now.
    @Published private(set) var holdingAwake = false

    private enum Keys {
        static let keepAwake = "keepAwake"
        static let onlyOnPower = "keepAwakeOnlyOnPower"
        static let loginOffered = "openAtLoginOffered"
    }

    private let defaults = UserDefaults.standard
    /// Whether the worker is sharing now (serving or able to): only then is staying awake worth it.
    private let isSharing: () -> Bool
    private var activity: NSObjectProtocol?

    init(isSharing: @escaping () -> Bool) {
        self.isSharing = isSharing
        defaults.register(defaults: [Keys.keepAwake: true, Keys.onlyOnPower: true])
        keepAwake = defaults.bool(forKey: Keys.keepAwake)
        onlyOnPower = defaults.bool(forKey: Keys.onlyOnPower)
        openAtLogin = SMAppService.mainApp.status == .enabled
    }

    /// Turn starting at login on the first time the app runs (it's what keeps a Mac earning after a
    /// restart), then follow the panel's switch. Re-checks power every minute.
    func start() {
        if !defaults.bool(forKey: Keys.loginOffered) {
            defaults.set(true, forKey: Keys.loginOffered)
            setOpenAtLogin(true)
        }
        refreshAwake()
        Task {
            while true {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                refreshAwake()
            }
        }
    }

    func setOpenAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            loginError = nil
        } catch {
            loginError = on ? "Couldn't open at login: \(error.localizedDescription). Move the app to Applications and try again." : nil
        }
        openAtLogin = SMAppService.mainApp.status == .enabled
    }

    /// Hold off idle sleep while sharing, as the settings allow; release it otherwise.
    func refreshAwake() {
        let hold = keepAwake && isSharing() && (!onlyOnPower || Self.onPower())
        if hold, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled], reason: "Antseed Colony is sharing this Mac with its pool")
        } else if !hold, let current = activity {
            ProcessInfo.processInfo.endActivity(current)
            activity = nil
        }
        holdingAwake = activity != nil
    }

    /// Whether the Mac runs on AC power (a desktop always does).
    static func onPower() -> Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let source = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String? else { return true }
        return source == kIOPSACPowerValue
    }
}

import AppKit
import Sparkle

/// Automatic updates (Sparkle): a release build checks the appcast its release
/// publishes once a day, and installs a new version signed with the release's
/// update key. Development builds carry no feed or key and never update.
@MainActor
final class Updates: ObservableObject {
    private let controller: SPUStandardUpdaterController?

    /// Whether this build updates itself.
    var available: Bool { controller != nil }

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let configured = info["SUFeedURL"] is String && info["SUPublicEDKey"] is String
        controller = configured
            ? SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
            : nil
    }

    func check() {
        // A menu bar app has no window in front: bring Sparkle's to it.
        NSApp.activate(ignoringOtherApps: true)
        controller?.checkForUpdates(nil)
    }
}

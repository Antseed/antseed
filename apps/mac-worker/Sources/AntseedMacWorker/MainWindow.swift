import AppKit
import SwiftUI

/// The app's one window, centered on the screen. The app lives in the menu bar; while the window
/// is open it also shows in the Dock and the app switcher, and closing it leaves the app running.
@MainActor
final class MainWindow: NSObject, NSWindowDelegate {
    static let shared = MainWindow()
    private var window: NSWindow?

    /// Bring the window up (creating it the first time) in front of other apps.
    func show(_ worker: WorkerController) {
        let window = self.window ?? make(worker)
        self.window = window
        NSApp.setActivationPolicy(.regular)
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func make(_ worker: WorkerController) -> NSWindow {
        // The content runs under a transparent title bar, clear of its buttons.
        let hosting = NSHostingController(rootView: MainView(worker: worker, topInset: 22))
        // The window follows the content's height as cards appear and collapse.
        hosting.sizingOptions = [.preferredContentSize]
        let window = NSWindow(contentViewController: hosting)
        window.title = "Antseed Colony"
        window.styleMask = [.titled, .closable, .miniaturizable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(Theme.background)
        window.setContentSize(hosting.view.fittingSize)
        window.isReleasedWhenClosed = false
        window.delegate = self
        return window
    }

    func windowWillClose(_ notification: Notification) {
        // Back to the menu bar only.
        NSApp.setActivationPolicy(.accessory)
    }
}

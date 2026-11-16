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
        let hosting = NSHostingController(rootView: MainView(worker: worker, topInset: 22) { [weak self] height in
            self?.fit(height)
        })
        // The window follows the content's height (fit), not SwiftUI's constraints: sized by those,
        // a fractional content height on a 1x display never settled, and the window re-laid itself
        // out until AppKit aborted. The view leaves room for the title bar itself (topInset).
        hosting.sizingOptions = []
        hosting.safeAreaRegions = []
        let window = NSWindow(contentViewController: hosting)
        window.title = "Antseed Colony"
        window.styleMask = [.titled, .closable, .miniaturizable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(Theme.background)
        window.setContentSize(NSSize(width: MainView.width, height: hosting.view.fittingSize.height.rounded(.up)))
        window.isReleasedWhenClosed = false
        window.delegate = self
        return window
    }

    /// Resize the window to the content's height in whole points, keeping its top edge in place,
    /// after the layout pass that reported the height.
    private func fit(_ height: CGFloat) {
        let height = height.rounded(.up)
        guard height > 0 else { return }
        DispatchQueue.main.async { [weak self] in
            guard let window = self?.window else { return }
            let current = window.contentRect(forFrameRect: window.frame)
            guard current.height != height else { return }
            var frame = window.frameRect(forContentRect: NSRect(x: current.minX, y: current.maxY - height, width: current.width, height: height))
            frame.origin.y = window.frame.maxY - frame.height
            window.setFrame(frame, display: true)
        }
    }

    func windowWillClose(_ notification: Notification) {
        // Back to the menu bar only.
        NSApp.setActivationPolicy(.accessory)
    }
}

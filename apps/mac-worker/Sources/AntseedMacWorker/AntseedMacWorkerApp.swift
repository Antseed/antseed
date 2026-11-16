import AppKit
import SwiftUI

@main
struct AntseedMacWorkerApp: App {
    @StateObject private var worker: WorkerController

    init() {
        let config = WorkerConfig.fromCommandLine()
        do {
            let controller = try WorkerController(config: config)
            _worker = StateObject(wrappedValue: controller)
            controller.start()
            // A first launch has nothing set up yet: open the window to join a pool. Later launches
            // (at login) start quietly in the menu bar.
            if controller.poolURL == nil {
                DispatchQueue.main.async { MainWindow.shared.show(controller) }
            }
            if let directory = config.snapshotDirectory {
                Snapshots.start(worker: controller, into: directory)
            }
        } catch {
            // e.g. a damaged key file: say what to do instead of crashing.
            _ = NSApplication.shared
            let alert = NSAlert()
            alert.messageText = "Antseed Colony could not start"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            exit(1)
        }
    }

    var body: some Scene {
        // The menu bar's ant: open the window, or quit. Everything else is in the window.
        MenuBarExtra {
            Button("Open Antseed Colony") { MainWindow.shared.show(worker) }
                .keyboardShortcut("o")
            Divider()
            Button("Quit Antseed Colony") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        } label: {
            if let mark = menuBarMark {
                Image(nsImage: mark)
            } else {
                Image(systemName: worker.status == .serving ? "ant.fill" : "ant")
            }
        }
        .menuBarExtraStyle(.menu)
    }
}

/// Renders the window to PNG every few seconds (for docs and demos; no
/// screen-recording permission needed).
@MainActor
enum Snapshots {
    static func start(worker: WorkerController, into directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        worker.watchActivity(true)
        Task { @MainActor in
            while true {
                write(MainView(worker: worker, snapshot: true), to: directory.appendingPathComponent("window.png"))
                write(SettingsView(worker: worker, snapshot: true, done: {}), to: directory.appendingPathComponent("settings.png"))
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private static func write(_ view: some View, to url: URL) {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .dark))
        renderer.scale = 2
        // The window's colours follow the appearance they are drawn in: render in dark, like the menubar.
        var rendered: NSImage?
        (NSAppearance(named: .darkAqua) ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance { rendered = renderer.nsImage }
        guard let image = rendered, let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: url, options: .atomic)
    }
}

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
            if let directory = config.snapshotDirectory {
                Snapshots.start(worker: controller, into: directory)
            }
        } catch {
            fatalError("Antseed worker could not start: \(error)")
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuPanel(worker: worker)
        } label: {
            Image(systemName: worker.status == .serving ? "ant.fill" : "ant")
        }
        .menuBarExtraStyle(.window)
    }
}

/// Renders the panel to PNG every few seconds (for docs and demos; no
/// screen-recording permission needed).
@MainActor
enum Snapshots {
    static func start(worker: WorkerController, into directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        Task { @MainActor in
            while true {
                write(MenuPanel(worker: worker, snapshot: true).background(Color(nsColor: .windowBackgroundColor)), to: directory.appendingPathComponent("menu.png"))
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private static func write(_ view: some View, to url: URL) {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .dark))
        renderer.scale = 2
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: url, options: .atomic)
    }
}

import Foundation

/// The service this Mac sells and the pinned checkpoint that serves it: chosen
/// by its owner from the pool's pins (`--model`/`--service` override), and
/// kept in the data directory.
struct ModelChoice: Codable, Equatable, Hashable {
    let service: String
    /// `repo@<40-character commit>` (`WorkerConfig.isPinned`).
    let model: String

    /// What the app runs on a pool that pins no models.
    static let fallback = ModelChoice(service: "qwen3.5-2b", model: "mlx-community/Qwen3.5-2B-MLX-4bit@93760be4f1f69842a46bc13dbdc0f19e291392a3")
    static let fileName = "model.json"

    var repository: String { model.split(separator: "@", maxSplits: 1).first.map(String.init) ?? model }

    /// The model's short name, for display.
    var displayName: String { repository.split(separator: "/").last.map(String.init) ?? repository }

    static func saved(in directory: URL) -> ModelChoice? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(fileName)),
              let choice = try? JSONDecoder().decode(ModelChoice.self, from: data),
              WorkerConfig.isPinned(choice.model) else { return nil }
        return choice
    }

    func save(in directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(self).write(to: directory.appendingPathComponent(Self.fileName), options: .atomic)
    }

    /// What a pool's welcome pins (service → `repo@revision`, maybe `#sha256`) that this app can run:
    /// pinned to a full commit, so the files can't change under the service name. Sorted by service.
    static func offers(from pins: [String: String]) -> [ModelChoice] {
        pins.compactMap { service, pin in
            let model = pin.split(separator: "#", maxSplits: 1).first.map(String.init) ?? pin
            return WorkerConfig.isPinned(model) ? ModelChoice(service: service, model: model) : nil
        }
        .sorted { $0.service < $1.service }
    }
}

/// How much a pinned checkpoint downloads, and whether this Mac has the memory to run it.
enum ModelSize {
    /// The checkpoint's total file size from the Hugging Face API; nil when it can't be read.
    static func bytes(of model: String) async -> UInt64? {
        let parts = model.split(separator: "@", maxSplits: 1).map(String.init)
        guard parts.count == 2,
              let url = URL(string: "https://huggingface.co/api/models/\(parts[0])/revision/\(parts[1])?blobs=true") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let siblings = json["siblings"] as? [[String: Any]] else { return nil }
        return siblings.reduce(UInt64(0)) { $0 + UInt64(($1["size"] as? NSNumber)?.uint64Value ?? 0) }
    }

    /// Weights take at most half the Mac's memory, leaving room for the context cache and everything else.
    static func fits(_ bytes: UInt64, memory: UInt64 = ProcessInfo.processInfo.physicalMemory) -> Bool {
        bytes <= memory / 2
    }

    static func label(_ bytes: UInt64) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

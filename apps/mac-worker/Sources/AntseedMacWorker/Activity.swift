import Foundation
import IOKit

/// The engine's live numbers, from its `/stats`: counts and rates only, never a prompt.
struct EngineStats: Equatable {
    /// Requests generating now, and waiting for a free lane.
    var running = 0
    var waiting = 0
    /// Generation speed of the latest decode (tokens/s); stale once nothing runs.
    var decodeTokensPerSecond = 0.0
    var prefillTokensPerSecond = 0.0
    /// Tokens of finished requests since the engine started.
    var promptTokensTotal = 0
    var generationTokensTotal = 0
    /// Memory the engine holds on the GPU now, and its peak (bytes).
    var memoryActive: UInt64 = 0
    var memoryPeak: UInt64 = 0

    init() {}

    init?(json: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return nil }
        func int(_ key: String) -> Int { (object[key] as? NSNumber)?.intValue ?? 0 }
        func double(_ key: String) -> Double { (object[key] as? NSNumber)?.doubleValue ?? 0 }
        running = int("running")
        waiting = int("waiting")
        decodeTokensPerSecond = double("decode_tokens_per_second")
        prefillTokensPerSecond = double("prefill_tokens_per_second")
        promptTokensTotal = int("prompt_tokens_total")
        generationTokensTotal = int("generation_tokens_total")
        let memory = object["memory"] as? [String: Any] ?? [:]
        memoryActive = (memory["active"] as? NSNumber)?.uint64Value ?? 0
        memoryPeak = (memory["peak"] as? NSNumber)?.uint64Value ?? 0
    }
}

/// What the Mac's GPU is doing, as IOKit reports it to any user (no admin rights needed).
struct GPUSample: Equatable {
    /// Share of the time the GPU was busy, 0–100.
    var utilization: Int
    /// GPU memory in use across all apps (bytes).
    var memoryInUse: UInt64

    /// The first GPU's numbers, or nil when IOKit has none (a virtual machine).
    static func read() -> GPUSample? {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iterator) == KERN_SUCCESS else { return nil }
        defer { IOObjectRelease(iterator) }
        while case let service = IOIteratorNext(iterator), service != 0 {
            defer { IOObjectRelease(service) }
            let property = IORegistryEntryCreateCFProperty(service, "PerformanceStatistics" as CFString, kCFAllocatorDefault, 0)
            if let statistics = property?.takeRetainedValue() as? [String: Any], let sample = GPUSample(statistics: statistics) {
                return sample
            }
        }
        return nil
    }

    init(utilization: Int, memoryInUse: UInt64) {
        self.utilization = utilization
        self.memoryInUse = memoryInUse
    }

    /// From an IOAccelerator's `PerformanceStatistics`.
    init?(statistics: [String: Any]) {
        guard let utilization = (statistics["Device Utilization %"] as? NSNumber)?.intValue else { return nil }
        self.utilization = max(0, min(100, utilization))
        memoryInUse = (statistics["In use system memory"] as? NSNumber)?.uint64Value ?? 0
    }
}

/// What the panel's Activity card shows: the engine, the GPU, and the owner's own use.
struct Activity: Equatable {
    var engine: EngineStats?
    var gpu: GPUSample?
    /// The owner's own requests through the local endpoint since launch, and those running now.
    var localRequests = 0
    var localRunning = 0

    /// Generating now (for the pool or the owner).
    var busy: Bool { (engine?.running ?? 0) > 0 }
}

/// Byte counts for the panel: one decimal in GB, whole MB below.
func bytesShort(_ bytes: UInt64) -> String {
    let gigabytes = Double(bytes) / 1_000_000_000
    return gigabytes >= 1 ? String(format: "%.1f GB", gigabytes) : "\(bytes / 1_000_000) MB"
}

/// Token counts for the panel: 950, 12.3K, 4.5M.
func tokensShort(_ count: Int) -> String {
    switch count {
    case ..<1_000: "\(count)"
    case ..<1_000_000: String(format: "%.1fK", Double(count) / 1_000)
    default: String(format: "%.1fM", Double(count) / 1_000_000)
    }
}

import CryptoKit
import Foundation

/// Uses model files the owner already has (an LM Studio folder, another cache) for a model the pool
/// pins, instead of downloading them again. A file is taken only when its hash is the one Hugging Face
/// lists for the pinned commit (SHA-256 for large files, the Git blob ID for the others), and is copied (cloned, on APFS) into the model cache, so
/// the engine's download finds it there and fetches only what is missing. The owner's folder is only read.
enum ModelFolder {
    /// A file of a pinned checkpoint, and the name of its blob in the model cache: its SHA-256
    /// when it is large (Git LFS), else its Git blob ID.
    struct PinnedFile: Equatable, Sendable {
        let path: String
        let size: UInt64
        let blob: String

        func matches(_ url: URL) throws -> Bool {
            if blob.count == 64 { return try LocalModel.fileSHA256(url) == blob }
            let data = try Data(contentsOf: url)
            var hasher = Insecure.SHA1()
            hasher.update(data: Data("blob \(data.count)\0".utf8))
            hasher.update(data: data)
            return Data(hasher.finalize()).hex == blob
        }
    }

    /// Files outside Git LFS are small; a listing that says otherwise is not read into memory.
    private static let maxSmallFile: UInt64 = 64 << 20

    enum FolderError: Error, LocalizedError, Equatable {
        case unreachable
        case noMatch

        var errorDescription: String? {
            switch self {
            case .unreachable: "Could not read the pool's model versions from Hugging Face. Check your connection and try again"
            case .noMatch: "This folder doesn't hold the exact version of a model this pool runs. Pick one above to download it"
            }
        }
    }

    /// Whether the pinned snapshot is complete in the model cache, so running it downloads nothing.
    static func isCached(_ model: String, hub: URL = LocalModel.hubCache()) -> Bool {
        let snapshot = LocalModel.snapshotDirectory(model, hub: hub)
        let fm = FileManager.default
        // fileExists follows symlinks: one to a blob that is gone counts as missing.
        func has(_ name: String) -> Bool { fm.fileExists(atPath: snapshot.appendingPathComponent(name).path) }
        guard has("config.json"), let names = try? fm.contentsOfDirectory(atPath: snapshot.path) else { return false }
        var weights = names.filter { $0.hasSuffix(".safetensors") }
        if let data = try? Data(contentsOf: snapshot.appendingPathComponent("model.safetensors.index.json")),
           let index = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let map = index["weight_map"] as? [String: String] {
            weights = Array(Set(map.values))
        }
        return !weights.isEmpty && weights.allSatisfy(has)
    }

    /// The files of `repo@commit`, from the Hugging Face API; nil when they can't be read.
    static func files(of model: String) async -> [PinnedFile]? {
        guard let json = await ModelSize.revision(of: model) else { return nil }
        return files(in: json)
    }

    static func files(in revision: [String: Any]) -> [PinnedFile] {
        (revision["siblings"] as? [[String: Any]] ?? []).compactMap { file in
            guard let path = file["rfilename"] as? String, isRelative(path) else { return nil }
            let lfs = file["lfs"] as? [String: Any]
            guard let blob = (lfs?["sha256"] ?? file["blobId"]) as? String, blob.count == (lfs == nil ? 40 : 64), blob.allSatisfy(\.isHexDigit),
                  let size = ((lfs?["size"] ?? file["size"]) as? NSNumber)?.uint64Value, lfs != nil || size <= maxSmallFile else { return nil }
            return PinnedFile(path: path, size: size, blob: blob.lowercased())
        }
    }

    /// A path that stays inside the folder it is joined to.
    private static func isRelative(_ path: String) -> Bool {
        !path.isEmpty && !path.hasPrefix("/") && !path.split(separator: "/", omittingEmptySubsequences: false).contains { $0 == ".." || $0.isEmpty }
    }

    /// The first of `offers` whose weights `folder` holds, with the files that match it.
    /// Sizes are compared first, so only a likely match is hashed.
    static func match(_ folder: URL, offers: [(offer: ModelChoice, files: [PinnedFile])]) throws -> (offer: ModelChoice, files: [PinnedFile])? {
        for (offer, files) in offers {
            let weights = files.filter { $0.path.hasSuffix(".safetensors") }
            let present = files.filter { fileSize(folder.appendingPathComponent($0.path)) == $0.size }
            guard !weights.isEmpty, weights.allSatisfy(present.contains) else { continue }
            var matching: [PinnedFile] = []
            for file in present {
                try Task.checkCancellation()
                if try file.matches(folder.appendingPathComponent(file.path)) { matching.append(file) }
            }
            if weights.allSatisfy(matching.contains) { return (offer, matching) }
        }
        return nil
    }

    /// Put `files` of `folder` into the model cache as `model`'s blobs. Each copy is hashed again
    /// before it gets its name, so a file changed meanwhile never enters the cache.
    static func add(_ files: [PinnedFile], from folder: URL, as model: String, hub: URL = LocalModel.hubCache()) throws {
        let fm = FileManager.default
        let repository = LocalModel.snapshotDirectory(model, hub: hub).deletingLastPathComponent().deletingLastPathComponent()
        let blobs = repository.appendingPathComponent("blobs", isDirectory: true)
        try fm.createDirectory(at: blobs, withIntermediateDirectories: true)
        for file in files {
            try Task.checkCancellation()
            let blob = blobs.appendingPathComponent(file.blob)
            if fileSize(blob) == file.size { continue }
            let copy = blobs.appendingPathComponent(".colony-\(UUID().uuidString)")
            defer { try? fm.removeItem(at: copy) }
            // Through symlinks (a Hugging Face snapshot): the file itself, not a link to it.
            try fm.copyItem(at: folder.appendingPathComponent(file.path).resolvingSymlinksInPath(), to: copy)
            guard try file.matches(copy) else { throw FolderError.noMatch }
            try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: copy.path)
            if fm.fileExists(atPath: blob.path) { try fm.removeItem(at: blob) }
            try fm.moveItem(at: copy, to: blob)
        }
    }

    /// Where a folder picker opens: LM Studio's models, when there are any.
    static var suggestedDirectory: URL? {
        [".lmstudio/models", ".cache/lm-studio/models", ".cache/huggingface/hub"]
            .map { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent($0, isDirectory: true) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func fileSize(_ url: URL) -> UInt64? {
        let file = url.resolvingSymlinksInPath()
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              attributes[.type] as? FileAttributeType == .typeRegular else { return nil }
        return (attributes[.size] as? NSNumber)?.uint64Value
    }
}

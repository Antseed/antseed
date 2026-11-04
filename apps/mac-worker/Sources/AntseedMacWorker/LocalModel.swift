import Foundation
import HuggingFace
import MLXHuggingFace
import MLXLLM
import MLXLMCommon
import Tokenizers

/// The model this Mac serves, running on MLX.
actor LocalModel {
    let modelId: String
    private var container: ModelContainer?

    struct Result {
        let text: String
        let promptTokens: Int
        let completionTokens: Int
        let tokensPerSecond: Double
    }

    init(modelId: String) {
        self.modelId = modelId
    }

    var isLoaded: Bool { container != nil }

    /// Download (first run) and load the weights.
    func load(progress: @escaping @Sendable (Double) -> Void) async throws {
        if container != nil { return }
        let configuration = ModelConfiguration(id: modelId, extraEOSTokens: ["<|im_end|>"])
        container = try await #huggingFaceLoadModelContainer(configuration: configuration, progressHandler: { value in
            progress(value.fractionCompleted)
        })
    }

    /// Run a chat completion, calling `onChunk` for each piece of generated text.
    func generate(
        messages: [[String: Any]],
        maxTokens: Int,
        maxPromptTokens: Int? = nil,
        temperature: Float,
        onChunk: @escaping @Sendable (String) async -> Void
    ) async throws -> Result {
        guard let container else { throw NSError(domain: "LocalModel", code: 1, userInfo: [NSLocalizedDescriptionKey: "Model not loaded"]) }
        let chat: [Chat.Message] = messages.compactMap { message in
            let content = Self.text(of: message["content"])
            switch message["role"] as? String {
            case "system", "developer": return .system(content)
            case "assistant": return .assistant(content)
            case "user": return .user(content)
            default: return nil
            }
        }
        let input = try await container.prepare(input: UserInput(chat: chat))
        // Checked after tokenizing and before prefill, the costly part.
        if let maxPromptTokens, input.text.tokens.size > maxPromptTokens {
            throw NSError(domain: "LocalModel", code: 2, userInfo: [NSLocalizedDescriptionKey: "Prompt too long (\(input.text.tokens.size) tokens, at most \(maxPromptTokens))"])
        }
        try Task.checkCancellation()
        let parameters = GenerateParameters(maxTokens: maxTokens, temperature: temperature)
        var text = ""
        var promptTokens = 0
        var completionTokens = 0
        var tokensPerSecond = 0.0
        for await event in try await container.generate(input: input, parameters: parameters) {
            try Task.checkCancellation()
            switch event {
            case .chunk(let piece):
                text += piece
                await onChunk(piece)
            case .info(let info):
                promptTokens = info.promptTokenCount
                completionTokens = info.generationTokenCount
                tokensPerSecond = info.tokensPerSecond
            default:
                break
            }
        }
        return Result(text: text, promptTokens: promptTokens, completionTokens: completionTokens, tokensPerSecond: tokensPerSecond)
    }

    /// OpenAI message content: a string, or an array of `{type: "text", text}` parts.
    private static func text(of content: Any?) -> String {
        if let string = content as? String { return string }
        if let parts = content as? [[String: Any]] {
            return parts.compactMap { $0["text"] as? String }.joined(separator: "\n")
        }
        return ""
    }
}

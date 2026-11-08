import Foundation

/// A buyer's chat request in the engine's terms, and the engine's stream back
/// (OpenAI chat completions, tools included). Nothing the buyer sent is
/// dropped: a role, content part or tool the engine can't take refuses the
/// request before inference, so a buyer never pays for an answer to a
/// different prompt than the one they sent.
enum EngineChat {
    struct Unsupported: Error, LocalizedError, Equatable {
        let reason: String
        var errorDescription: String? { reason }
    }

    /// The request fields that shape the prompt (`messages`, `tools`,
    /// `tool_choice`, `parallel_tool_calls`), checked and in the engine's form.
    static func fields(of request: [String: Any]) throws -> [String: Any] {
        guard let list = request["messages"] as? [[String: Any]], !list.isEmpty else {
            throw Unsupported(reason: "The request has no messages")
        }
        var fields: [String: Any] = ["messages": try list.map(message)]
        if let raw = request["tools"], !(raw is NSNull) {
            guard let tools = raw as? [[String: Any]] else { throw Unsupported(reason: "`tools` must be a list of function tools") }
            if !tools.isEmpty { fields["tools"] = try tools.map(tool) }
        }
        if let choice = request["tool_choice"], !(choice is NSNull) {
            if let name = choice as? String {
                guard ["none", "auto", "required"].contains(name) else { throw Unsupported(reason: "Unsupported tool_choice \"\(name)\"") }
            } else {
                guard let object = choice as? [String: Any], object["type"] as? String == "function",
                      let function = object["function"] as? [String: Any], function["name"] is String else {
                    throw Unsupported(reason: "Unsupported tool_choice")
                }
            }
            fields["tool_choice"] = choice
        }
        if let raw = request["parallel_tool_calls"], !(raw is NSNull) {
            guard let parallel = raw as? Bool else { throw Unsupported(reason: "`parallel_tool_calls` must be true or false") }
            fields["parallel_tool_calls"] = parallel
        }
        return fields
    }

    private static func message(_ message: [String: Any]) throws -> [String: Any] {
        guard let role = message["role"] as? String else { throw Unsupported(reason: "A message has no role") }
        var out: [String: Any]
        switch role {
        // The engine gives developer messages system semantics.
        case "system", "developer": out = ["role": "system"]
        case "user", "assistant", "tool": out = ["role": role]
        default: throw Unsupported(reason: "Unsupported message role \"\(role)\"")
        }
        let content = message["content"]
        if content == nil || content is NSNull {
            // Only an assistant turn that called tools may have no content.
            guard role == "assistant", message["tool_calls"] != nil else { throw Unsupported(reason: "A \(role) message has no content") }
            out["content"] = NSNull()
        } else {
            out["content"] = try text(of: content)
        }
        if let name = message["name"] as? String { out["name"] = name }
        if role == "assistant", let raw = message["tool_calls"], !(raw is NSNull) {
            guard let calls = raw as? [[String: Any]] else { throw Unsupported(reason: "`tool_calls` must be a list") }
            if !calls.isEmpty { out["tool_calls"] = try calls.map(toolCall) }
        }
        if role == "tool" {
            guard let id = message["tool_call_id"] as? String else { throw Unsupported(reason: "A tool message has no tool_call_id") }
            out["tool_call_id"] = id
        }
        return out
    }

    private static func toolCall(_ call: [String: Any]) throws -> [String: Any] {
        guard (call["type"] as? String ?? "function") == "function", let id = call["id"] as? String,
              let function = call["function"] as? [String: Any], let name = function["name"] as? String else {
            throw Unsupported(reason: "Unsupported tool call in an assistant message")
        }
        return ["id": id, "type": "function", "function": ["name": name, "arguments": function["arguments"] as? String ?? ""]]
    }

    private static func tool(_ tool: [String: Any]) throws -> [String: Any] {
        guard tool["type"] as? String == "function", let function = tool["function"] as? [String: Any], function["name"] is String else {
            throw Unsupported(reason: "Only function tools are supported")
        }
        return ["type": "function", "function": function]
    }

    /// OpenAI message content: a string, or `{type: "text", text}` parts. Any
    /// other part (an image, audio, a file) is refused: this model reads text only.
    static func text(of content: Any?) throws -> String {
        if let string = content as? String { return string }
        guard let parts = content as? [[String: Any]] else { throw Unsupported(reason: "Unsupported message content") }
        return try parts.map { part -> String in
            let type = part["type"] as? String ?? ""
            guard type == "text", let text = part["text"] as? String else {
                throw Unsupported(reason: "Content of type \"\(type)\" is not supported by this worker (text only)")
            }
            return text
        }.joined()
    }

    /// One server-sent event of the engine's chat stream.
    struct Event {
        var content: String?
        /// `delta.tool_calls`, as the engine streamed them (index, id and name first, then arguments in pieces).
        var toolCalls: [[String: Any]]?
        var finishReason: String?
        var tokensPerSecond: Double?
        var usage: (prompt: Int, completion: Int)?
    }

    static func parseEvent(_ line: String) -> Event? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard payload != "[DONE]", let object = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] else { return nil }
        let choice = (object["choices"] as? [[String: Any]])?.first
        let delta = choice?["delta"] as? [String: Any]
        var event = Event()
        event.content = delta?["content"] as? String
        if let calls = delta?["tool_calls"] as? [[String: Any]], !calls.isEmpty { event.toolCalls = calls }
        event.finishReason = choice?["finish_reason"] as? String
        event.tokensPerSecond = (object["tensorfold"] as? [String: Any])?["tokens_per_second"] as? Double
        if let reported = object["usage"] as? [String: Any],
           let prompt = reported["prompt_tokens"] as? Int, let completion = reported["completion_tokens"] as? Int {
            event.usage = (prompt, completion)
        }
        return event
    }

    /// Joins streamed tool-call deltas into whole calls, for an answer that isn't streamed.
    struct ToolCalls {
        private var calls: [Int: (id: String, name: String, arguments: String)] = [:]

        mutating func add(_ deltas: [[String: Any]]) {
            for delta in deltas {
                let index = delta["index"] as? Int ?? calls.count
                var call = calls[index] ?? (id: "", name: "", arguments: "")
                if let id = delta["id"] as? String { call.id = id }
                let function = delta["function"] as? [String: Any]
                if let name = function?["name"] as? String { call.name += name }
                if let arguments = function?["arguments"] as? String { call.arguments += arguments }
                calls[index] = call
            }
        }

        /// The calls in index order, as `message.tool_calls`.
        var message: [[String: Any]] {
            calls.keys.sorted().compactMap { index in
                guard let call = calls[index] else { return nil }
                return ["id": call.id, "type": "function", "function": ["name": call.name, "arguments": call.arguments]]
            }
        }
    }
}

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

    /// Sampling fields the engine applies as sent, once each is a number.
    static let samplingFields = ["seed", "top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty"]

    /// Fields that would change the answer and that this worker can't honor.
    static let refusedFields = [
        "logit_bias", "top_logprobs", "audio", "modalities", "prediction", "web_search_options",
        "guided_json", "guided_regex", "guided_choice", "guided_grammar", "structured_outputs",
    ]

    /// The request fields that shape the answer, checked and in the engine's
    /// form: the prompt (`messages`, `tools`, `tool_choice`,
    /// `parallel_tool_calls`), `stop`, `response_format` and the sampling
    /// fields. The token budget, temperature and streaming are `generation(of:)`.
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
        if let stop = present(request["stop"]) {
            let stops = (stop as? String).map { [$0] } ?? stop as? [String]
            guard let stops, !stops.contains(where: \.isEmpty) else {
                throw Unsupported(reason: "`stop` must be a nonempty string or a list of nonempty strings")
            }
            if !stops.isEmpty { fields["stop"] = stops }
        }
        if let format = present(request["response_format"]) {
            fields["response_format"] = try responseFormat(format)
        }
        for name in samplingFields {
            guard let value = present(request[name]) else { continue }
            guard isNumber(value) else { throw Unsupported(reason: "`\(name)` must be a number") }
            fields[name] = value
        }
        for name in refusedFields where present(request[name]) != nil {
            throw Unsupported(reason: "`\(name)` is not supported by this worker")
        }
        if let logprobs = present(request["logprobs"]), logprobs as? Bool != false || !isBool(logprobs) {
            throw Unsupported(reason: "`logprobs` is not supported by this worker")
        }
        if let n = present(request["n"]), !isNumber(n) || (n as? Int) != 1 {
            throw Unsupported(reason: "`n` must be 1; this worker returns one choice")
        }
        return fields
    }

    /// How much to generate and how: `max_tokens` (or `max_completion_tokens`,
    /// default 512) as a whole number of at least 1, `temperature` (default
    /// 0.7) from 0 to 2, and `stream`. A value of the wrong kind refuses the
    /// request rather than falling back to the default.
    static func generation(of request: [String: Any]) throws -> (maxTokens: Int, temperature: Float, stream: Bool) {
        var maxTokens = 512
        for name in ["max_completion_tokens", "max_tokens"] {
            guard let value = present(request[name]) else { continue }
            guard isNumber(value), let number = value as? NSNumber, let tokens = Int(exactly: number.doubleValue), tokens >= 1 else {
                throw Unsupported(reason: "`\(name)` must be a whole number of at least 1")
            }
            maxTokens = tokens
        }
        var temperature = 0.7
        if let value = present(request["temperature"]) {
            guard isNumber(value), let number = value as? NSNumber, number.doubleValue.isFinite, (0...2).contains(number.doubleValue) else {
                throw Unsupported(reason: "`temperature` must be a number from 0 to 2")
            }
            temperature = number.doubleValue
        }
        var stream = false
        if let value = present(request["stream"]) {
            guard isBool(value), let flag = value as? Bool else { throw Unsupported(reason: "`stream` must be true or false") }
            stream = flag
        }
        return (maxTokens, Float(temperature), stream)
    }

    /// `{type: "text"}`, `{type: "json_object"}` or `{type: "json_schema", json_schema: {schema, ...}}`.
    private static func responseFormat(_ format: Any) throws -> [String: Any] {
        guard let object = format as? [String: Any], let type = object["type"] as? String else {
            throw Unsupported(reason: "`response_format` must be an object such as {\"type\": \"json_object\"}")
        }
        switch type {
        case "text", "json_object": return ["type": type]
        case "json_schema":
            guard let spec = object["json_schema"] as? [String: Any], spec["schema"] is [String: Any] else {
                throw Unsupported(reason: "`response_format` json_schema needs json_schema.schema (a JSON schema object)")
            }
            return ["type": type, "json_schema": spec]
        default:
            throw Unsupported(reason: "`response_format` type must be text, json_object or json_schema")
        }
    }

    /// A field the request set, `null` counting as unset.
    private static func present(_ value: Any?) -> Any? {
        guard let value, !(value is NSNull) else { return nil }
        return value
    }

    /// JSON booleans decode as `NSNumber` too; these tell them apart.
    private static func isBool(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func isNumber(_ value: Any) -> Bool {
        value is NSNumber && !isBool(value)
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

    /// The OpenAI chat answer a worker sends: stream chunks, then a finish
    /// chunk and a usage event, or one buffered completion.
    struct Response {
        let id: String
        let created: Int
        let model: String

        /// One streamed piece of output: text, or tool-call deltas.
        func chunk(_ output: LocalModel.Output) -> [String: Any] {
            let delta: [String: Any]
            switch output {
            case .text(let piece): delta = ["content": piece]
            case .toolCalls(let calls): delta = ["tool_calls": calls]
            }
            return event(["index": 0, "delta": delta])
        }

        /// The stream's last chunk: an empty delta with the engine's finish reason.
        func finish(_ result: LocalModel.Result) -> [String: Any] {
            event(["index": 0, "delta": [String: Any](), "finish_reason": result.finishReason])
        }

        /// The whole answer, not streamed. A reply that only calls tools has null content.
        func completion(_ result: LocalModel.Result) -> [String: Any] {
            var message: [String: Any] = ["role": "assistant", "content": result.text]
            if !result.toolCalls.isEmpty {
                message["tool_calls"] = result.toolCalls
                if result.text.isEmpty { message["content"] = NSNull() }
            }
            return [
                "id": id, "object": "chat.completion", "created": created, "model": model,
                "choices": [["index": 0, "message": message, "finish_reason": result.finishReason]],
                "usage": Self.usage(result),
            ]
        }

        static func usage(_ result: LocalModel.Result) -> [String: Any] {
            [
                "prompt_tokens": result.promptTokens,
                "completion_tokens": result.completionTokens,
                "total_tokens": result.promptTokens + result.completionTokens,
            ]
        }

        /// The stream's usage event, which the buyer is charged on.
        static func usageEvent(_ usage: [String: Any]) -> [String: Any] {
            ["choices": [Any](), "usage": usage]
        }

        private func event(_ choice: [String: Any]) -> [String: Any] {
            ["id": id, "object": "chat.completion.chunk", "created": created, "model": model, "choices": [choice]]
        }
    }
}

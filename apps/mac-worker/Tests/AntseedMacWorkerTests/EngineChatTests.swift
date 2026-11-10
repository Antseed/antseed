import XCTest
@testable import AntseedMacWorker

final class EngineChatTests: XCTestCase {
    private let weather: [String: Any] = [
        "type": "function",
        "function": ["name": "weather", "description": "Weather for a city", "parameters": ["type": "object", "properties": ["city": ["type": "string"]]]],
    ]

    func testForwardsToolsAndEveryRoleOfAToolConversation() throws {
        let fields = try EngineChat.fields(of: [
            "model": "qwen3.5-2b",
            "messages": [
                ["role": "developer", "content": "Be brief."],
                ["role": "user", "content": [["type": "text", "text": "Weather in "], ["type": "text", "text": "Paris?"]]],
                ["role": "assistant", "content": NSNull(), "tool_calls": [
                    ["id": "call_1", "type": "function", "function": ["name": "weather", "arguments": #"{"city":"Paris"}"#]],
                ]],
                ["role": "tool", "tool_call_id": "call_1", "content": "18°C, sunny"],
            ],
            "tools": [weather],
            "tool_choice": "auto",
            "parallel_tool_calls": false,
        ])
        let messages = try XCTUnwrap(fields["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.map { $0["role"] as? String }, ["system", "user", "assistant", "tool"])
        XCTAssertEqual(messages[1]["content"] as? String, "Weather in Paris?")
        XCTAssertTrue(messages[2]["content"] is NSNull)
        let call = try XCTUnwrap((messages[2]["tool_calls"] as? [[String: Any]])?.first)
        XCTAssertEqual(call["id"] as? String, "call_1")
        XCTAssertEqual((call["function"] as? [String: Any])?["arguments"] as? String, #"{"city":"Paris"}"#)
        XCTAssertEqual(messages[3]["tool_call_id"] as? String, "call_1")
        XCTAssertEqual(messages[3]["content"] as? String, "18°C, sunny")
        let tools = try XCTUnwrap(fields["tools"] as? [[String: Any]])
        XCTAssertEqual(((tools.first?["function"]) as? [String: Any])?["name"] as? String, "weather")
        XCTAssertEqual(fields["tool_choice"] as? String, "auto")
        XCTAssertEqual(fields["parallel_tool_calls"] as? Bool, false)
        XCTAssertNil(fields["model"], "only the fields that shape the prompt")
    }

    func testNamedToolChoiceIsKept() throws {
        let choice: [String: Any] = ["type": "function", "function": ["name": "weather"]]
        let fields = try EngineChat.fields(of: ["messages": [["role": "user", "content": "hi"]], "tools": [weather], "tool_choice": choice])
        XCTAssertEqual(((fields["tool_choice"] as? [String: Any])?["function"] as? [String: Any])?["name"] as? String, "weather")
    }

    func testForwardsStopResponseFormatAndSampling() throws {
        let schema: [String: Any] = ["name": "city", "schema": ["type": "object", "properties": ["city": ["type": "string"]]]]
        let fields = try EngineChat.fields(of: [
            "messages": [["role": "user", "content": "hi"]],
            "stop": "\n\n",
            "response_format": ["type": "json_schema", "json_schema": schema],
            "seed": 7, "top_p": 0.9, "top_k": 20, "min_p": 0.05, "presence_penalty": 0.5, "frequency_penalty": NSNull(),
            "logprobs": false, "n": 1, "user": "buyer-1",
        ])
        XCTAssertEqual(fields["stop"] as? [String], ["\n\n"])
        let format = try XCTUnwrap(fields["response_format"] as? [String: Any])
        XCTAssertEqual(format["type"] as? String, "json_schema")
        XCTAssertEqual((format["json_schema"] as? [String: Any])?["name"] as? String, "city")
        XCTAssertEqual(fields["seed"] as? Int, 7)
        XCTAssertEqual(fields["top_p"] as? Double, 0.9)
        XCTAssertEqual(fields["top_k"] as? Int, 20)
        XCTAssertEqual(fields["presence_penalty"] as? Double, 0.5)
        XCTAssertNil(fields["frequency_penalty"], "null is unset")
        XCTAssertNil(fields["logprobs"])
        XCTAssertNil(fields["n"])

        let stops = try EngineChat.fields(of: ["messages": [["role": "user", "content": "hi"]], "stop": ["END", "###"], "response_format": ["type": "json_object"]])
        XCTAssertEqual(stops["stop"] as? [String], ["END", "###"])
        XCTAssertEqual((stops["response_format"] as? [String: Any])?["type"] as? String, "json_object")
    }

    func testRefusesOutputOptionsItCannotHonor() {
        func refused(_ extra: [String: Any]) -> String? {
            var request: [String: Any] = ["messages": [["role": "user", "content": "hi"]]]
            request.merge(extra) { $1 }
            do {
                _ = try EngineChat.fields(of: request)
                return nil
            } catch {
                return error.localizedDescription
            }
        }
        XCTAssertEqual(refused(["stop": ""]), "`stop` must be a nonempty string or a list of nonempty strings")
        XCTAssertEqual(refused(["stop": ["a", 1] as [Any]]), "`stop` must be a nonempty string or a list of nonempty strings")
        XCTAssertEqual(refused(["response_format": ["type": "xml"]]), "`response_format` type must be text, json_object or json_schema")
        XCTAssertEqual(refused(["response_format": ["type": "json_schema"]]), "`response_format` json_schema needs json_schema.schema (a JSON schema object)")
        XCTAssertEqual(refused(["response_format": "json"]), #"`response_format` must be an object such as {"type": "json_object"}"#)
        XCTAssertEqual(refused(["top_p": "0.9"]), "`top_p` must be a number")
        XCTAssertEqual(refused(["seed": true]), "`seed` must be a number")
        XCTAssertEqual(refused(["logit_bias": ["50256": -100]]), "`logit_bias` is not supported by this worker")
        XCTAssertEqual(refused(["logprobs": true]), "`logprobs` is not supported by this worker")
        XCTAssertEqual(refused(["n": 2]), "`n` must be 1; this worker returns one choice")
        XCTAssertNil(refused(["stop": NSNull(), "logprobs": NSNull(), "n": NSNull()]))
    }

    func testReadsTheGenerationBudgetAndRefusesMalformedValues() throws {
        let defaults = try EngineChat.generation(of: ["max_tokens": NSNull(), "temperature": NSNull()])
        XCTAssertEqual(defaults.maxTokens, 512)
        XCTAssertEqual(defaults.temperature, 0.7)
        XCTAssertFalse(defaults.stream)
        let set = try EngineChat.generation(of: ["max_completion_tokens": 64, "temperature": 0, "stream": true])
        XCTAssertEqual(set.maxTokens, 64)
        XCTAssertEqual(set.temperature, 0)
        XCTAssertTrue(set.stream)
        XCTAssertEqual(try EngineChat.generation(of: ["max_tokens": 2048.0]).maxTokens, 2048)

        func refused(_ request: [String: Any]) -> String? {
            do {
                _ = try EngineChat.generation(of: request)
                return nil
            } catch {
                return error.localizedDescription
            }
        }
        XCTAssertEqual(refused(["max_tokens": "1000000"]), "`max_tokens` must be a whole number of at least 1")
        XCTAssertEqual(refused(["max_tokens": 0]), "`max_tokens` must be a whole number of at least 1")
        XCTAssertEqual(refused(["max_tokens": 1.5]), "`max_tokens` must be a whole number of at least 1")
        XCTAssertEqual(refused(["max_tokens": true]), "`max_tokens` must be a whole number of at least 1")
        XCTAssertEqual(refused(["max_completion_tokens": -1]), "`max_completion_tokens` must be a whole number of at least 1")
        XCTAssertEqual(refused(["temperature": "invalid"]), "`temperature` must be a number from 0 to 2")
        XCTAssertEqual(refused(["temperature": 3]), "`temperature` must be a number from 0 to 2")
        XCTAssertEqual(refused(["temperature": Double.nan]), "`temperature` must be a number from 0 to 2")
        XCTAssertEqual(refused(["stream": "yes"]), "`stream` must be true or false")
        XCTAssertEqual(refused(["stream": 1]), "`stream` must be true or false")
    }

    func testRefusesInputItCannotRead() {
        func refused(_ request: [String: Any]) -> String? {
            do {
                _ = try EngineChat.fields(of: request)
                return nil
            } catch {
                return error.localizedDescription
            }
        }
        let image: [String: Any] = ["role": "user", "content": [
            ["type": "text", "text": "What is this?"],
            ["type": "image_url", "image_url": ["url": "data:image/png;base64,AAAA"]],
        ]]
        XCTAssertEqual(refused(["messages": [image]]), #"Content of type "image_url" is not supported by this worker (text only)"#)
        XCTAssertNotNil(refused(["messages": [["role": "user", "content": [["type": "input_audio", "input_audio": [String: Any]()]]]]]))
        XCTAssertEqual(refused(["messages": [["role": "function", "content": "x"]]]), #"Unsupported message role "function""#)
        XCTAssertNotNil(refused(["messages": [["role": "tool", "content": "18°C"]]]), "a tool result names its call")
        XCTAssertNotNil(refused(["messages": [["role": "user"]]]), "only an assistant tool call may have no content")
        XCTAssertNotNil(refused(["messages": [["role": "user", "content": "hi"]], "tools": [["type": "web_search"]]]))
        XCTAssertNotNil(refused(["messages": [["role": "user", "content": "hi"]], "tool_choice": "sometimes"]))
        XCTAssertNotNil(refused(["messages": [[String: Any]]()]))
        XCTAssertNil(refused(["messages": [["role": "user", "content": "hi"]]]))
    }

    func testParsesStreamedToolCallsAndTheirFinishReason() throws {
        let first = try XCTUnwrap(EngineChat.parseEvent(#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":""}}]}}]}"#))
        let second = try XCTUnwrap(EngineChat.parseEvent(#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}}]}"#))
        let third = try XCTUnwrap(EngineChat.parseEvent(#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Paris\"}"}}]}}]}"#))
        let end = try XCTUnwrap(EngineChat.parseEvent(#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#))
        XCTAssertNil(first.content)
        XCTAssertEqual(end.finishReason, "tool_calls")
        XCTAssertNil(end.toolCalls)

        var calls = EngineChat.ToolCalls()
        for event in [first, second, third] { calls.add(try XCTUnwrap(event.toolCalls)) }
        let call = try XCTUnwrap(calls.message.first)
        XCTAssertEqual(calls.message.count, 1)
        XCTAssertEqual(call["id"] as? String, "call_1")
        XCTAssertEqual((call["function"] as? [String: Any])?["name"] as? String, "weather")
        XCTAssertEqual((call["function"] as? [String: Any])?["arguments"] as? String, #"{"city":"Paris"}"#)
    }

    func testModelMustPinAFullRevision() {
        XCTAssertTrue(WorkerConfig.isPinned(WorkerConfig().modelId), "the default is pinned")
        XCTAssertTrue(WorkerConfig.isPinned("mlx-community/Qwen3.5-2B-MLX-4bit@93760be4f1f69842a46bc13dbdc0f19e291392a3"))
        XCTAssertFalse(WorkerConfig.isPinned("mlx-community/Qwen3.5-2B-MLX-4bit"))
        XCTAssertFalse(WorkerConfig.isPinned("mlx-community/Qwen3.5-2B-MLX-4bit@main"))
        XCTAssertFalse(WorkerConfig.isPinned("mlx-community/Qwen3.5-2B-MLX-4bit@93760be"))
        XCTAssertFalse(WorkerConfig.isPinned("Qwen3.5-2B@93760be4f1f69842a46bc13dbdc0f19e291392a3"))
    }

    func testFormatsStreamedChunksAndTheBufferedCompletion() throws {
        let response = EngineChat.Response(id: "chatcmpl-1", created: 7, model: "qwen3.5-2b")
        let text = response.chunk(.text("Hi"))
        XCTAssertEqual(text["object"] as? String, "chat.completion.chunk")
        XCTAssertEqual(((text["choices"] as? [[String: Any]])?.first?["delta"] as? [String: Any])?["content"] as? String, "Hi")
        let result = LocalModel.Result(text: "", toolCalls: [["id": "call_1", "type": "function"]], finishReason: "tool_calls",
                                       promptTokens: 10, completionTokens: 4, tokensPerSecond: 0)
        let finish = try XCTUnwrap((response.finish(result)["choices"] as? [[String: Any]])?.first)
        XCTAssertEqual(finish["finish_reason"] as? String, "tool_calls")
        XCTAssertEqual((finish["delta"] as? [String: Any])?.count, 0)
        let completion = response.completion(result)
        let message = try XCTUnwrap(((completion["choices"] as? [[String: Any]])?.first)?["message"] as? [String: Any])
        // A reply that only calls tools has null content.
        XCTAssertTrue(message["content"] is NSNull)
        XCTAssertEqual((message["tool_calls"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual((completion["usage"] as? [String: Any])?["total_tokens"] as? Int, 14)
        XCTAssertEqual(completion["model"] as? String, "qwen3.5-2b")
        XCTAssertEqual((EngineChat.Response.usageEvent(EngineChat.Response.usage(result))["choices"] as? [Any])?.count, 0)
    }
}

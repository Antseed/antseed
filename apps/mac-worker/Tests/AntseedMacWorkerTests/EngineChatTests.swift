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
}

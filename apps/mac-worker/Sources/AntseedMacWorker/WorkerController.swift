import AppKit
import CryptoKit
import Foundation
import SwiftUI

struct PoolStats: Equatable {
    var earnedToday: UInt64 = 0
    var earnedLast7Days: UInt64 = 0
    var earnedTotal: UInt64 = 0
    var paidTotal: UInt64 = 0
    var pending: UInt64 = 0
    var requestsTotal = 0
    var outputTokensTotal = 0
    var connectedSecondsLast7Days = 0
}

enum WorkerStatus: Equatable {
    case starting
    case loadingModel(Double)
    case connecting
    case serving
    case paused
    case failed(String)

    var label: String {
        switch self {
        case .starting: "Starting"
        case .loadingModel(let p): p > 0 && p < 1 ? "Downloading model \(Int(p * 100))%" : "Loading model"
        case .connecting: "Connecting to pool"
        case .serving: "Sharing this Mac"
        case .paused: "Paused"
        case .failed(let message): message
        }
    }

    var color: Color {
        switch self {
        case .serving: .green
        case .paused: .orange
        case .failed: .red
        default: .secondary
        }
    }
}

/// Runs the worker: keeps a connection to the pool, serves its encrypted
/// requests with the local model, and tracks what this Mac earned.
@MainActor
final class WorkerController: ObservableObject {
    @Published private(set) var status: WorkerStatus = .starting
    @Published private(set) var stats = PoolStats()
    @Published private(set) var poolShareBps = 0
    @Published private(set) var poolSeller: String?
    /// The owner's wallet this Mac's earnings are paid to, as the pool contract records it.
    @Published private(set) var payout: String?
    /// A signed link the owner has not submitted yet. Kept until the contract
    /// records it or it expires, so its code can be copied again after a restart.
    @Published private(set) var pendingLink: PayoutAuthorization?
    @Published private(set) var linkError: String?
    /// The payout authorization was just copied for the owner to paste.
    @Published private(set) var linkCopied = false
    /// What keeps this Mac's owner out of the prompts it serves, re-checked on every attestation.
    @Published private(set) var protection: Protection.Report
    @Published var sharing = true {
        didSet { if oldValue != sharing { announceServices() } }
    }

    let config: WorkerConfig
    let keys: WorkerKeys
    private let identity: Protection.CodeIdentity
    private let debuggerDenied: Bool
    private let model: LocalModel
    private var socket: URLSessionWebSocketTask?
    private var backoff: UInt64 = 1
    private var active: [String: Task<Void, Never>] = [:]
    private let gate = RequestGate()
    /// The Channels contract channels are checked on, once the RPC's chain id is known.
    private var trustedChannels: String?
    /// On-chain channel checks (when an RPC is set), each read bounded so a slow RPC can't hold a request.
    private lazy var channels: ChannelVerdicts = {
        let verdicts = ChannelVerdicts { [weak self] channel, buyer in
            guard let self, let rpc = self.config.rpcURL, let pool = self.poolSeller, let trusted = self.trustedChannels else { return nil }
            return try await Chain(rpcURL: rpc, timeout: 2).channelBelongs(channel: channel, buyer: buyer, pool: pool, channels: trusted)
        }
        verdicts.onVerdict = { [weak self] channel, buyer, verified in
            self?.log(verified
                ? "on-chain check: channel \(channel.prefix(12))… belongs to buyer \(buyer.prefix(10))… and this pool"
                : "on-chain check FAILED: channel \(channel.prefix(12))… is not this buyer's; refusing it")
        }
        return verdicts
    }()

    var address: String { keys.ethereum.address }

    private func log(_ line: String) {
        guard let url = config.logFile else { return }
        let stamp = Date().formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits))
        let data = Data("\(stamp) \(line)\n".utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }

    init(config: WorkerConfig) throws {
        self.config = config
        let keys = try WorkerKeys.loadOrCreate(in: config.dataDirectory)
        self.keys = keys
        self.model = LocalModel(modelId: config.modelId)
        let identity = Protection.codeIdentity()
        self.identity = identity
        // Signed builds refuse debuggers for the life of the process; development builds stay debuggable.
        let denied = identity.teamId != nil && Protection.denyDebuggers()
        self.debuggerDenied = denied
        self.protection = Protection.Report(identity: identity, sip: Protection.sipEnabled(), debuggerDenied: denied && !Protection.debuggerAttached(), keyAppBound: keys.appBound)
        self.pendingLink = (try? Data(contentsOf: config.dataDirectory.appendingPathComponent(Self.pendingLinkFile)))
            .flatMap { try? JSONDecoder().decode(PayoutAuthorization.self, from: $0) }
    }

    /// Re-read SIP and debugger state. A signed build with SIP off stops serving.
    @discardableResult
    private func refreshProtection() -> Bool {
        protection = Protection.Report(identity: identity, sip: Protection.sipEnabled(), debuggerDenied: debuggerDenied && !Protection.debuggerAttached(), keyAppBound: keys.appBound)
        if identity.teamId != nil && !protection.sip {
            status = .failed(protection.summary)
            return false
        }
        return true
    }

    func start() {
        log(protection.summary)
        guard refreshProtection() else { return }
        Task {
            do {
                status = .loadingModel(0)
                log("Antseed Mac app \(config.name) · payout address \(address)")
                log("loading \(config.modelId) with MLX…")
                try await model.load { progress in
                    Task { @MainActor in self.status = .loadingModel(progress) }
                }
                log("model ready on MLX (Apple GPU)")
                connect()
                startPolling()
            } catch {
                status = .failed("Model failed to load: \(error.localizedDescription)")
            }
        }
    }

    // MARK: pool connection

    private func connect() {
        status = .connecting
        let task = URLSession.shared.webSocketTask(with: config.poolURL)
        task.maximumMessageSize = 16 * 1024 * 1024
        socket = task
        task.resume()
        receive(on: task)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                switch result {
                case .success(.string(let text)):
                    self.handle(text)
                    self.receive(on: task)
                case .success:
                    self.receive(on: task)
                case .failure(let error):
                    self.log("pool connection lost: \(error.localizedDescription)")
                    self.reconnect()
                }
            }
        }
    }

    private func reconnect() {
        for task in active.values { task.cancel() }
        active.removeAll()
        socket = nil
        status = .connecting
        let delay = backoff
        backoff = min(backoff * 2, 60)
        Task {
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            connect()
        }
    }

    private func send(_ frame: [String: Any]) {
        guard let socket, let text = try? jsonString(frame) else { return }
        socket.send(.string(text)) { _ in }
    }

    private func announceServices() {
        send(["t": "services", "services": sharing ? [config.service] : []])
        if case .serving = status, !sharing { status = .paused }
        if case .paused = status, sharing { status = .serving }
    }

    private func handle(_ text: String) {
        guard let frame = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let type = frame["t"] as? String else { return }
        switch type {
        case "challenge":
            guard let pool = frame["pool"] as? String, let nonce = frame["nonce"] as? String,
                  let seller = frame["seller"] as? String else { return }
            poolSeller = seller
            guard refreshProtection() else { socket?.cancel(with: .goingAway, reason: nil); return }
            do {
                let keyHex = keys.encryptionKeyHex
                let expires = Int(Date().timeIntervalSince1970) + 24 * 3600
                send([
                    "t": "hello",
                    "address": address,
                    "signature": try keys.ethereum.personalSign("antseed-colony-pool/v1\npool:\(pool)\nnonce:\(nonce)"),
                    "services": sharing ? [config.service] : [],
                    "maxConcurrency": RequestGate.maxConcurrency,
                    "encryption": [
                        "key": keyHex,
                        "expires": expires,
                        "certificate": try keys.ethereum.personalSign(WorkerE2E.keyCertificateMessage(pool: seller, keyHex: keyHex, expires: expires, attestationKeyHex: keys.attestationKeyHex)),
                        "attestationKey": keys.attestationKeyHex,
                    ],
                    "attestation": try Protection.attest(protection, nonce: nonce, worker: address, keyHex: keyHex, signer: keys.attestation),
                    "agent": "antseed-mac/0.1.0 (\(config.name))",
                ])
            } catch {
                status = .failed("Could not sign: \(error.localizedDescription)")
            }
        case "welcome":
            backoff = 1
            poolShareBps = frame["workerShareBps"] as? Int ?? 0
            status = sharing ? .serving : .paused
            log("joined pool \(config.poolURL.host ?? "") · encryption key certified for \(poolSeller ?? "") · attested \(protection.hardened ? "hardened" : "not hardened")")
            requestStats()
            refreshPayout()
            if let wallet = config.linkPayoutTo, !linkRequested {
                linkRequested = true
                Task { await linkPayout(to: wallet) }
            }
        case "request":
            guard let id = frame["id"] as? String else { return }
            // The slot is taken before any asynchronous work, so the pool can't run more at once than announced.
            if let refusal = gate.reserve(id) { return fail(id, refusal) }
            active[id] = Task {
                await self.serve(frame, id: id)
                self.gate.release(id)
                if self.active[id] != nil { self.active.removeValue(forKey: id) }
            }
        case "attest":
            guard let nonce = frame["nonce"] as? String else { return }
            guard refreshProtection() else { socket?.cancel(with: .goingAway, reason: nil); return }
            if let attestation = try? Protection.attest(protection, nonce: nonce, worker: address, keyHex: keys.encryptionKeyHex, signer: keys.attestation) {
                send(["t": "attestation", "attestation": attestation])
            }
        case "cancel":
            if let id = frame["id"] as? String { active.removeValue(forKey: id)?.cancel() }
        case "stats":
            if let stats = frame["stats"] as? [String: Any] { apply(stats) }
        case "error":
            status = .failed(frame["message"] as? String ?? "Pool error")
        default:
            break
        }
    }

    // MARK: serving

    private func fail(_ id: String, _ message: String) {
        send(["t": "response-error", "id": id, "message": message])
    }

    /// How this request's channel binding can be checked: on the trusted
    /// Channels contract for the RPC's chain (`--channels`, or the known
    /// deployment). With an RPC but none for its chain, full requests are refused.
    private func channelCheck(channel: String, buyer: String) async -> ChannelCheck {
        guard let rpc = config.rpcURL, poolSeller != nil else { return .signatureOnly }
        if trustedChannels == nil {
            guard let chainId = try? await Chain(rpcURL: rpc, timeout: 2).chainId() else {
                return .unavailable("Could not read the chain id to check the request channel; retry shortly")
            }
            guard let address = TrustedChannels.address(chainId: chainId, override: config.channelsAddress) else {
                return .unavailable("No trusted Channels contract for chain \(chainId); start the worker with --channels")
            }
            trustedChannels = address
        }
        return .verify { [weak self] in
            guard let self else { return nil }
            return await self.channels.verdict(channel: channel, buyer: buyer)
        }
    }

    private func serve(_ frame: [String: Any], id: String) async {
        let connection = socket
        guard frame["method"] as? String == "POST", frame["path"] as? String == "/v1/chat/completions",
              let bodyB64 = frame["body"] as? String, let body = Data(base64Encoded: bodyB64) else {
            return fail(id, "Unsupported route")
        }
        guard WorkerE2E.isSealed(body) else { return fail(id, WorkerE2E.Failure.notEncrypted.localizedDescription) }
        let opened: WorkerE2E.OpenedRequest
        do {
            opened = try WorkerE2E.openRequest(body, workerAddress: address, key: keys.encryption)
        } catch {
            return fail(id, error.localizedDescription)
        }
        guard opened.model == config.service, sharing else { return fail(id, "Not serving \(opened.model)") }
        log(opened.buyer.map { "decrypted request from buyer \($0.prefix(10))… (pool saw only ciphertext)" } ?? "pool check request")

        let check: ChannelCheck
        if let buyer = opened.buyer, let channel = opened.channel, !channel.allSatisfy({ $0 == "0" || $0 == "x" }) {
            check = await channelCheck(channel: channel, buyer: buyer)
        } else {
            check = .signatureOnly
        }
        // Pool checks are bounded by size here, before the body is even parsed.
        let size = opened.body.count
        var maxTokens = 512
        var promptLimit: Int?
        let requested: [String: Any]? = size <= RequestGate.checkBodyBytes || opened.buyer != nil
            ? (try? JSONSerialization.jsonObject(with: opened.body) as? [String: Any]) : nil
        let requestedMax = requested?["max_tokens"] as? Int ?? requested?["max_completion_tokens"] as? Int ?? 512
        switch await gate.admit(buyer: opened.buyer, channel: opened.channel, bodyBytes: size, requestedMaxTokens: requestedMax, check: check) {
        case .full:
            maxTokens = max(1, requestedMax)
        case .check(let limit):
            maxTokens = limit
            promptLimit = RequestGate.checkPromptTokens
        case .refused(let reason):
            return fail(id, reason)
        case .cancelled:
            return
        }
        // Cancelled, or the pool connection changed, while the channel was checked: don't start.
        guard !Task.isCancelled, socket === connection else { return }
        guard let request = requested else { return fail(id, "Request body is not JSON") }

        let stream = request["stream"] as? Bool ?? false
        let messages = request["messages"] as? [[String: Any]] ?? []
        let temperature = Float(request["temperature"] as? Double ?? 0.7)
        let created = Int(Date().timeIntervalSince1970)
        let completionId = "chatcmpl-\(UUID().uuidString.prefix(12).lowercased())"
        let service = config.service
        let sealer = opened.sealer

        do {
            if stream {
                send(["t": "response-start", "id": id, "status": 200, "headers": ["content-type": "text/event-stream"]])
            }
            let result = try await model.generate(messages: messages, maxTokens: maxTokens, maxPromptTokens: promptLimit, temperature: temperature) { [weak self] piece in
                guard stream else { return }
                let chunk: [String: Any] = [
                    "id": completionId, "object": "chat.completion.chunk", "created": created, "model": service,
                    "choices": [["index": 0, "delta": ["content": piece]]],
                ]
                guard let event = try? "data: " + jsonString(chunk), let sealed = try? sealer.sealEvent(event) else { return }
                await self?.send(["t": "response-chunk", "id": id, "data": sealed.base64EncodedString()])
            }
            let usage: [String: Any] = [
                "prompt_tokens": result.promptTokens,
                "completion_tokens": result.completionTokens,
                "total_tokens": result.promptTokens + result.completionTokens,
            ]
            if stream {
                var tail = try sealer.sealEvent("data: " + jsonString([
                    "id": completionId, "object": "chat.completion.chunk", "created": created, "model": service,
                    "choices": [["index": 0, "delta": [String: Any](), "finish_reason": "stop"]],
                ]))
                tail += try sealer.sealEvent("data: " + jsonString(["choices": [Any](), "usage": usage]), usage: usage)
                tail += try sealer.sealEvent("data: [DONE]")
                tail += try sealer.finish()
                send(["t": "response-chunk", "id": id, "data": tail.base64EncodedString()])
            } else {
                let completion: [String: Any] = [
                    "id": completionId, "object": "chat.completion", "created": created, "model": service,
                    "choices": [["index": 0, "message": ["role": "assistant", "content": result.text], "finish_reason": "stop"]],
                    "usage": usage,
                ]
                let sealed = try sealer.sealBody(Data(try jsonString(completion).utf8), usage: usage)
                send(["t": "response-start", "id": id, "status": 200, "headers": ["content-type": "application/json"]])
                send(["t": "response-chunk", "id": id, "data": sealed.base64EncodedString()])
            }
            send(["t": "response-end", "id": id])
            log("answered with MLX: \(result.promptTokens) in / \(result.completionTokens) out · \(Int(result.tokensPerSecond)) tok/s · sealed for the buyer")
            requestStats()
        } catch {
            fail(id, Task.isCancelled ? "cancelled" : error.localizedDescription)
        }
    }

    // MARK: earnings

    private func requestStats() {
        send(["t": "stats-request", "id": UUID().uuidString])
    }

    private func apply(_ raw: [String: Any]) {
        func amount(_ key: String) -> UInt64 { UInt64(raw[key] as? String ?? "0") ?? 0 }
        stats = PoolStats(
            earnedToday: amount("earnedToday"), earnedLast7Days: amount("earnedLast7Days"), earnedTotal: amount("earnedTotal"),
            paidTotal: amount("paidTotal"), pending: amount("pending"), requestsTotal: raw["requestsTotal"] as? Int ?? 0,
            outputTokensTotal: raw["outputTokensTotal"] as? Int ?? 0, connectedSecondsLast7Days: raw["connectedSecondsLast7Days"] as? Int ?? 0
        )
    }

    private func startPolling() {
        Task {
            while true {
                requestStats()
                if pendingLink != nil { refreshPayout() }
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
    }


    // MARK: payout wallet

    /// Sign the instruction for the pool contract to pay this Mac's earnings to
    /// `wallet`, and copy it: the owner submits it from that wallet in the ANTS
    /// dashboard (Rewards → Link a Mac), where rewards are also claimed.
    /// `--link-payout` signs once per launch, not on every reconnect.
    private var linkRequested = false
    private static let pendingLinkFile = "payout-link.json"

    /// Read the payout wallet from the pool contract, and drop a pending link
    /// once the contract records it or its deadline passes.
    func refreshPayout() {
        guard let rpc = config.rpcURL, let pool = poolSeller else { return }
        Task {
            guard let word = try? await Chain(rpcURL: rpc, timeout: 10).ethCall(to: pool, data: Chain.selector("payoutOf(address)") + Data(repeating: 0, count: 12) + (try Data(hexString: address))),
                  word.count == 32 else { return }
            let recorded = word.suffix(20)
            payout = recorded.allSatisfy({ $0 == 0 }) ? nil : Data(recorded).prefixedHex
            if let link = pendingLink,
               link.payout.lowercased() == payout?.lowercased() || link.deadline <= UInt64(Date().timeIntervalSince1970) {
                setPendingLink(nil)
            }
        }
    }

    private func setPendingLink(_ link: PayoutAuthorization?) {
        pendingLink = link
        let file = config.dataDirectory.appendingPathComponent(Self.pendingLinkFile)
        if let link, let json = try? JSONEncoder().encode(link) {
            try? json.write(to: file, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// Copy the pending link's code again.
    func copyLinkCode() {
        guard let link = pendingLink else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(link.code, forType: .string)
        linkCopied = true
    }

    /// Returns whether a new link was signed; on failure `linkError` says why.
    @discardableResult
    func linkPayout(to wallet: String) async -> Bool {
        let wallet = wallet.trimmingCharacters(in: .whitespacesAndNewlines)
        guard wallet.count == 42, wallet.hasPrefix("0x"), (try? Data(hexString: wallet)) != nil else {
            linkError = "Enter a wallet address (0x…)"
            return false
        }
        guard let rpc = config.rpcURL, let pool = poolSeller else {
            linkError = "Join a pool first"
            return false
        }
        linkError = nil
        do {
            let chain = Chain(rpcURL: rpc, timeout: 10)
            let chainId = try await chain.chainId()
            let nonceWord = try await chain.ethCall(to: pool, data: Chain.selector("payoutNonce(address)") + Data(repeating: 0, count: 12) + (try Data(hexString: address)))
            let nonce = nonceWord.suffix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            let deadline = UInt64(Date().timeIntervalSince1970) + 7 * 24 * 3600
            let digest = PayoutAuthorization.digest(chainId: chainId, pool: pool, worker: address, payout: wallet, nonce: nonce, deadline: deadline)
            let signature = try keys.ethereum.sign(digest: personalMessageDigest(digest))
            let link = PayoutAuthorization(chainId: chainId, pool: pool, worker: address, payout: wallet, deadline: deadline, signature: signature.prefixedHex)
            setPendingLink(link)
            copyLinkCode()
            log("payout authorization for \(wallet) copied; paste it in the ANTS dashboard (Rewards → Link a Mac)")
            if config.linkPayoutTo != nil { log("link code \(link.code)") }
            return true
        } catch {
            linkError = error.localizedDescription
            return false
        }
    }
}

func usd(_ units: UInt64) -> String {
    String(format: "$%.6f", Double(units) / 1_000_000)
}

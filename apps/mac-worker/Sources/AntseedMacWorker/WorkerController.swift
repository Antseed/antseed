import AppKit
import CryptoKit
import Foundation
import SwiftUI

struct PoolStats: Equatable {
    var earnedToday: UInt64 = 0
    var earnedLast7Days: UInt64 = 0
    var earnedTotal: UInt64 = 0
    var requestsTotal = 0
    var outputTokensTotal = 0
    var connectedSecondsLast7Days = 0
}

enum WorkerStatus: Equatable {
    case starting
    case loadingModel(Double)
    case needsPool
    case choosingModel
    case connecting
    case serving
    case paused
    case failed(String)

    var label: String {
        switch self {
        case .starting: "Starting"
        case .loadingModel(let p): p > 0 && p < 1 ? "Downloading model \(Int(p * 100))%" : "Loading model"
        case .needsPool: "Enter a pool to join"
        case .choosingModel: "Choose a model to run"
        case .connecting: "Connecting to pool"
        case .serving: "Sharing this Mac"
        case .paused: "Paused"
        case .failed(let message): message
        }
    }

    /// The status once the pool's welcome lists what it took: a pool that refused
    /// the service this Mac offers routes it nothing, however sharing is set.
    static func joined(sharing: Bool, service: String, rejected: [String]) -> WorkerStatus {
        if rejected.contains(service) { return .failed("The pool doesn't accept \(service) with this model") }
        return sharing ? .serving : .paused
    }

    /// The status once the pool's welcome arrives (it lists the models the owner can pick):
    /// picking one when none is chosen, serving once the chosen one loaded, still saying why it
    /// failed to load when it did (the picker and Retry are offered beside it), and otherwise
    /// the load's own progress (`current`).
    static func welcomed(choice: ModelChoice?, loaded: Bool, loadError: String?, sharing: Bool, rejected: [String], current: WorkerStatus) -> WorkerStatus {
        guard let choice else { return .choosingModel }
        if loaded { return joined(sharing: sharing, service: choice.service, rejected: rejected) }
        if let loadError { return .failed(loadError) }
        return current
    }
}

/// Runs the worker: keeps a connection to the pool, serves its encrypted
/// requests with the local model, and tracks what this Mac earned.
@MainActor
final class WorkerController: ObservableObject {
    @Published private(set) var status: WorkerStatus = .starting {
        didSet { if oldValue != status { mac.refreshAwake() } }
    }
    /// Automatic updates (release builds only).
    let updates = Updates()
    /// Start at login and staying awake while sharing.
    lazy var mac = MacSettings { [weak self] in
        guard let self, self.sharing else { return false }
        switch self.status {
        case .starting, .loadingModel, .connecting, .serving: return true
        case .paused, .needsPool, .choosingModel, .failed: return false
        }
    }
    @Published private(set) var stats = PoolStats()
    @Published private(set) var poolShareBps = 0
    @Published private(set) var poolSeller: String?
    /// The pool this Mac joins; nil until the owner enters one.
    @Published private(set) var poolURL: URL?
    /// The service this Mac sells and its checkpoint; nil until the owner picks one.
    @Published private(set) var choice: ModelChoice?
    /// Why the chosen model failed to load (download or engine start), shown again once the pool's
    /// welcome arrives; nil while it loads or once it loaded.
    @Published private(set) var modelLoadError: String?
    /// The chosen model failed to load: the owner may try it again, or pick another.
    var modelLoadFailed: Bool { modelLoadError != nil }
    /// The models the pool pins that this app can run, for the owner to pick from.
    @Published private(set) var poolModels: [ModelChoice] = []
    /// Download size of each offered checkpoint (`ModelChoice.model`), once read.
    @Published private(set) var modelSizes: [String: UInt64] = [:]
    /// When the pool connection last showed signs of life.
    private var liveness = PoolLiveness()
    /// The owner's payout wallet and the link that sets it.
    let payouts: WorkerPayoutController
    /// What keeps this Mac's owner out of the prompts it serves, re-checked on every attestation.
    @Published private(set) var protection: Protection.Report
    @Published var sharing = true {
        didSet { if oldValue != sharing { announceServices(); mac.refreshAwake() } }
    }

    let config: WorkerConfig
    let keys: WorkerKeys
    private let identity: Protection.CodeIdentity
    private let debuggerDenied: Bool
    private var model: LocalModel?
    /// The checkpoint behind `choice` and the digest of its files, attested to the pool once loaded.
    private var checkpoint: LocalModel.Checkpoint?
    private let terminationSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    private var socket: URLSessionWebSocketTask?
    private var backoff: UInt64 = 1
    /// The pending reconnect, if one is waiting out its backoff; any new connection cancels it.
    private var reconnectTask: Task<Void, Never>?
    private var active: [String: Task<Void, Never>] = [:]
    /// Streamed answers that have sent response-start.
    private var startedStreams = Set<String>()
    /// Requests some of whose answer was sent to the pool.
    private var sentOutput = Set<String>()
    private let gate = RequestGate()
    /// The Channels contract channels are checked on, once the RPC's chain id is known.
    private var trustedChannels: String?
    /// The chain `trustedChannels` is on: buyers sign SpendingAuths for that contract on it.
    private var trustedChainId: UInt64?
    /// Each checked channel's on-chain reserve, from its latest read.
    private var channelDeposits: [String: UInt64] = [:]
    /// What buyers pay for each service, as the pool's welcome declares it.
    private var prices: [String: WorkerPayment.Price] = [:]
    /// What each channel's buyer owes this Mac for its answers, and has paid; kept across restarts.
    private lazy var payments = WorkerPaymentLedger(file: config.dataDirectory.appendingPathComponent("payments.json"))
    /// On-chain channel checks (when an RPC is set), each read bounded so a slow RPC can't hold a request.
    /// Its verdicts are for `verdictsSeller` only: a challenge naming another pool seller starts a fresh one,
    /// whatever happened to the connection in between.
    private lazy var channels = makeChannelVerdicts(for: nil)
    private var verdictsSeller: String?

    /// Verdicts on channels with `seller`'s pool; every lookup checks that seller, even one still running after a switch.
    private func makeChannelVerdicts(for seller: String?) -> ChannelVerdicts {
        let verdicts = ChannelVerdicts { [weak self] channel, buyer in
            guard let self, !self.config.rpcURLs.isEmpty, let pool = seller, let trusted = self.trustedChannels else { return nil }
            let state = try await Chain(rpcURLs: self.config.rpcURLs, timeout: 2).channelState(channel: channel, buyer: buyer, pool: pool, channels: trusted)
            if state.belongs == true {
                if self.channelDeposits.count >= 10_000 { self.channelDeposits.removeAll() }
                self.channelDeposits[channel.lowercased()] = state.deposit
            }
            // It never serves again, so its account can go: no old payment can be replayed on it.
            if state.closed { self.payments.forget(channel: channel) }
            return state.belongs
        }
        verdicts.onVerdict = { [weak self] channel, buyer, verified in
            self?.log(verified
                ? "on-chain check: channel \(channel.prefix(12))… belongs to buyer \(buyer.prefix(10))… and this pool"
                : "on-chain check FAILED: channel \(channel.prefix(12))… is not this buyer's; refusing it")
        }
        return verdicts
    }

    var address: String { keys.ethereum.address }

    private func log(_ line: String) {
        Self.append(line, to: config.logFile)
    }

    /// Append a timestamped line to `url`, when one is set.
    nonisolated static func append(_ line: String, to url: URL?) {
        guard let url else { return }
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
        self.poolURL = config.poolURL
        self.choice = config.choice
        let keys = try WorkerKeys.loadOrCreate(in: config.dataDirectory)
        self.keys = keys
        let identity = Protection.codeIdentity()
        self.identity = identity
        // Signed builds refuse debuggers for the life of the process; development builds stay debuggable.
        let denied = identity.teamId != nil && Protection.denyDebuggers()
        self.debuggerDenied = denied
        self.protection = Protection.Report(identity: identity, sip: Protection.sipEnabled(), debuggerDenied: denied && !Protection.debuggerAttached(), keyAppBound: keys.appBound)
        self.payouts = WorkerPayoutController(config: config, keys: keys, log: { line in WorkerController.append(line, to: config.logFile) })
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
        if let choice, !WorkerConfig.isPinned(choice.model) {
            status = .failed("--model must pin a revision: repo@<40-character commit>")
            return
        }
        guard refreshProtection() else { return }
        let config = self.config
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in
            LocalModel.stopEngine(in: config.dataDirectory, engine: config.engineURL)
        }
        // `kill` skips that notification unless it becomes a normal quit.
        signal(SIGTERM, SIG_IGN)
        terminationSignal.setEventHandler { NSApplication.shared.terminate(nil) }
        terminationSignal.resume()
        log("Antseed Colony \(config.name) · payout address \(address)")
        mac.start()
        startPolling()
        Task {
            // Without a model yet, it joins to learn which models the pool runs, and serves once one is picked.
            // A saved model that fails to load joins too, offering nothing: the pool's welcome lists the
            // models the owner can switch to, beside Retry.
            if let choice { _ = await load(choice) }
            rejoin()
        }
    }

    /// The model load in progress, if any: a newer pick cancels it and waits for it to stop.
    private var loadTask: Task<Bool, Never>?

    /// Download (first time), hash and start the chosen checkpoint. False when it failed to load,
    /// or a newer pick replaced it. Loads run one at a time: a newer one cancels the one before and
    /// waits until its download or engine stopped, so the superseded load can't stop the new engine.
    private func load(_ choice: ModelChoice) async -> Bool {
        let previous = loadTask
        previous?.cancel()
        let task = Task { [weak self] () -> Bool in
            _ = await previous?.value
            guard let self, !Task.isCancelled else { return false }
            return await self.loadNow(choice)
        }
        loadTask = task
        return await task.value
    }

    private func loadNow(_ choice: ModelChoice) async -> Bool {
        let local = LocalModel(modelId: choice.model, engine: config.engineURL, directory: config.dataDirectory)
        model = local
        checkpoint = nil
        modelLoadError = nil
        status = .loadingModel(0)
        log("loading \(choice.model) with TensorFold…")
        do {
            let loaded = try await local.load { progress in
                Task { @MainActor in self.status = .loadingModel(progress) }
            }
            guard model === local, !Task.isCancelled else {
                // Another pick replaced it meanwhile: stop the engine this load started.
                await local.stop()
                return false
            }
            checkpoint = loaded
            log("model ready on TensorFold (Apple GPU) · files sha256 \(loaded.sha256)")
            return true
        } catch {
            if model === local, !Task.isCancelled {
                let message = "Model failed to load: \(error.localizedDescription)"
                modelLoadError = message
                status = .failed(message)
            }
            return false
        }
    }

    /// Run `offer` from now on (saved for later launches): load it, then rejoin the pool with it.
    func choose(_ offer: ModelChoice) {
        guard offer != choice || checkpoint == nil else { return }
        do {
            try offer.save(in: config.dataDirectory)
        } catch {
            status = .failed("Could not save the model choice: \(error.localizedDescription)")
            return
        }
        log("owner chose \(offer.service) on \(offer.model)")
        choice = offer
        // Stop serving the old model while the new one loads.
        disconnect()
        Task { if await load(offer) { rejoin() } }
    }

    /// Load the chosen model again after it failed to (a download or engine start that broke off).
    func retryModel() {
        guard modelLoadFailed, let choice else { return }
        choose(choice)
    }

    /// The services this Mac offers the pool now: its chosen one, once loaded, while sharing.
    private var offeredServices: [String] {
        guard sharing, checkpoint != nil, let choice else { return [] }
        return [choice.service]
    }

    /// The checkpoint each service runs, for the attestation: a pool that pins its files' digest routes only on it.
    private var attestedModels: [String: LocalModel.Checkpoint] {
        guard let checkpoint, let choice else { return [:] }
        return [choice.service: checkpoint]
    }

    /// The pins the pool's welcome lists, kept for the owner to pick from, with each one's download size.
    private func notePoolModels(_ pins: [String: String]) {
        let offers = ModelChoice.offers(from: pins)
        guard offers != poolModels else { return }
        poolModels = offers
        for offer in offers where modelSizes[offer.model] == nil {
            Task {
                if let bytes = await ModelSize.bytes(of: offer.model) { modelSizes[offer.model] = bytes }
            }
        }
    }

    // MARK: rewards page

    /// The Antseed payments page, served by this app, for the steps that need the owner's wallet.
    private lazy var payAPI = ColonyPayAPI(
        config: config, payouts: payouts, workerAddress: address,
        pool: { [weak self] in self?.poolSeller },
        chainId: { [weak self] in self?.trustedChainId },
        channels: { [weak self] in self?.trustedChannels }
    )
    private lazy var payServer = PayServer { [weak self] request in
        guard let self else { return .error(503, "Antseed Colony is quitting") }
        return await self.payAPI.handle(request)
    }
    /// Why the rewards page could not open, if it couldn't.
    @Published private(set) var payPageError: String?

    /// Open the payments page in the owner's browser: `colony-link` (link a wallet) or `colony-claim`.
    func openPayPage(_ action: String) {
        Task {
            do {
                NSWorkspace.shared.open(try await payServer.url(for: action))
                payPageError = nil
            } catch {
                payPageError = error.localizedDescription
            }
        }
    }

    // MARK: pool connection

    /// Join the pool the owner entered (saved for later launches), leaving the current one.
    /// Returns why it can't, or nil once it is joining.
    func join(pool text: String) -> String? {
        guard let url = PoolAddress.parse(text) else {
            return "Enter the pool's wss:// address from its operator"
        }
        do {
            try PoolAddress.save(url, in: config.dataDirectory)
        } catch {
            return "Could not save the pool: \(error.localizedDescription)"
        }
        log("joining pool \(url.host ?? "")")
        poolURL = url
        rejoin()
        return nil
    }

    /// (Re)connect to the pool, fresh: the hello names the model this Mac runs now.
    private func rejoin() {
        disconnect()
        backoff = 1
        connect()
    }

    /// Leave the current pool connection, cancelling its requests and any pending reconnect.
    private func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        for task in active.values { task.cancel() }
        active.removeAll()
        let previous = socket
        socket = nil
        previous?.cancel(with: .goingAway, reason: nil)
        poolSeller = nil
    }

    private func connect() {
        // This connection supersedes a reconnect still waiting: it must not replace this socket later.
        reconnectTask?.cancel()
        reconnectTask = nil
        guard let poolURL else {
            status = .needsPool
            return
        }
        status = .connecting
        let task = URLSession.shared.webSocketTask(with: poolURL)
        task.maximumMessageSize = 16 * 1024 * 1024
        socket = task
        liveness = PoolLiveness()
        task.resume()
        receive(on: task)
        watch(task)
    }

    /// URLSession answers the pool's pings without telling us, so the app pings
    /// the pool itself and reconnects when neither a message nor a pong arrives
    /// for `PoolLiveness.silenceLimit` (a sleeping Mac, a dropped network path).
    private func watch(_ task: URLSessionWebSocketTask) {
        Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: UInt64(PoolLiveness.pingInterval * 1_000_000_000))
                guard let self, self.socket === task else { return }
                if self.liveness.isSilent() {
                    self.log("pool connection silent for \(Int(PoolLiveness.silenceLimit)) s; reconnecting")
                    self.reconnect()
                    task.cancel(with: .goingAway, reason: nil)
                    return
                }
                task.sendPing { [weak self] error in
                    guard error == nil else { return }
                    Task { @MainActor in
                        guard let self, self.socket === task else { return }
                        self.liveness.heard()
                    }
                }
            }
        }
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                if case .success = result { self.liveness.heard() }
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
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            // Cancelled by a join, rejoin or disconnect while waiting: that connection stands.
            guard !Task.isCancelled, let self else { return }
            self.reconnectTask = nil
            self.connect()
        }
    }

    private func send(_ frame: [String: Any]) {
        guard let socket, let text = try? jsonString(frame) else { return }
        socket.send(.string(text)) { _ in }
    }

    /// Sends a request's `frame` on the pool connection the request came in on, only while it is still
    /// the current one: a request's frames never reach another pool joined meanwhile.
    private func send(_ frame: [String: Any], on connection: URLSessionWebSocketTask?) {
        guard let connection, connection === socket, let text = try? jsonString(frame) else { return }
        connection.send(.string(text)) { _ in }
    }

    /// Sends a request's `frame` on its pool connection, as `send(_:on:)`, and waits for it to take it:
    /// false once that connection is no longer the current one, or when the send failed.
    private func sendConfirmed(_ frame: [String: Any], on connection: URLSessionWebSocketTask?) async -> Bool {
        guard !Task.isCancelled, let connection, connection === socket, let text = try? jsonString(frame) else { return false }
        do {
            try await connection.send(.string(text))
            return true
        } catch {
            return false
        }
    }

    private func announceServices() {
        send(["t": "services", "services": offeredServices])
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
            // Verdicts say "this buyer's channel with that pool": none carry over to another pool seller.
            if seller.lowercased() != verdictsSeller {
                channels = makeChannelVerdicts(for: seller)
                verdictsSeller = seller.lowercased()
            }
            poolSeller = seller
            guard refreshProtection() else { socket?.cancel(with: .goingAway, reason: nil); return }
            do {
                let keyHex = keys.encryptionKeyHex
                let expires = Int(Date().timeIntervalSince1970) + 24 * 3600
                send([
                    "t": "hello",
                    "address": address,
                    "signature": try keys.ethereum.personalSign("antseed-colony-pool/v1\npool:\(pool)\nnonce:\(nonce)"),
                    "services": offeredServices,
                    "maxConcurrency": RequestGate.maxConcurrency,
                    // The pinned checkpoint behind each service, so a pool can refuse one it didn't expect.
                    "models": checkpoint == nil ? [:] : choice.map { [$0.service: $0.model] } ?? [:],
                    "encryption": [
                        "key": keyHex,
                        "expires": expires,
                        "certificate": try keys.ethereum.personalSign(WorkerE2E.keyCertificateMessage(pool: seller, keyHex: keyHex, expires: expires, attestationKeyHex: keys.attestationKeyHex)),
                        "attestationKey": keys.attestationKeyHex,
                    ],
                    "attestation": try Protection.attest(protection, nonce: nonce, worker: address, keyHex: keyHex, signer: keys.attestation, models: attestedModels),
                    "agent": "antseed-mac/0.1.0 (\(config.name))",
                ])
            } catch {
                status = .failed("Could not sign: \(error.localizedDescription)")
            }
        case "welcome":
            backoff = 1
            poolShareBps = frame["workerShareBps"] as? Int ?? 0
            prices = ((frame["prices"] as? [String: Any]) ?? [:]).compactMapValues { WorkerPayment.Price($0) }
            notePoolModels(frame["models"] as? [String: String] ?? [:])
            if choice == nil && poolModels.isEmpty {
                // The pool pins nothing to pick from: run the built-in model, then join again with it.
                log("pool \(poolURL?.host ?? "") pins no models; running \(ModelChoice.fallback.model)")
                choose(.fallback)
                return
            }
            // Still loading, the progress stays and the app rejoins with the model once it is ready.
            status = .welcomed(choice: choice, loaded: checkpoint != nil, loadError: modelLoadError,
                               sharing: sharing, rejected: frame["rejected"] as? [String] ?? [], current: status)
            log("joined pool \(poolURL?.host ?? "") · encryption key certified for \(poolSeller ?? "") · attested \(protection.hardened ? "hardened" : "not hardened")")
            requestStats()
            payouts.joined(pool: poolSeller)
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
            if let attestation = try? Protection.attest(protection, nonce: nonce, worker: address, keyHex: keys.encryptionKeyHex, signer: keys.attestation, models: attestedModels) {
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
    /// deployment). Without an RPC, or with none for its chain, full requests
    /// are refused.
    private func channelCheck(channel: String, buyer: String) async -> ChannelCheck {
        guard !config.rpcURLs.isEmpty else { return .unavailable("This worker has no RPC to check request channels on, so it refuses buyer requests; start it with --rpc") }
        guard poolSeller != nil else { return .unavailable("Not joined to a pool yet; retry shortly") }
        if trustedChannels == nil {
            guard let chainId = try? await Chain(rpcURLs: config.rpcURLs, timeout: 2).chainId() else {
                return .unavailable("Could not read the chain id to check the request channel; retry shortly")
            }
            guard let address = TrustedChannels.address(chainId: chainId, override: config.channelsAddress) else {
                return .unavailable("No trusted Channels contract for chain \(chainId); start the worker with --channels")
            }
            trustedChannels = address
            trustedChainId = chainId
        }
        return .verify { [weak self] in
            guard let self else { return nil }
            return await self.channels.verdict(channel: channel, buyer: buyer)
        }
    }

    /// What the request's payment attributes to this Mac: 0 when it carries
    /// none, or one that does not verify (unsigned by the buyer, for another
    /// Channels contract, or beyond the channel's reserve).
    private func attributed(_ sealed: WorkerE2E.SealedRequest, channel: String, buyer: String) -> (attributed: UInt64, cumulative: UInt64) {
        guard let payment = sealed.payment, let chainId = trustedChainId, let channels = trustedChannels else { return (0, 0) }
        do {
            let amount = try WorkerPayment.attributed(payment, channel: channel, buyer: buyer, worker: address,
                                                      deposit: channelDeposits[channel.lowercased()] ?? WorkerPayment.saturating(payment.cumulativeAmount),
                                                      chainId: chainId, channels: channels)
            return (amount, WorkerPayment.saturating(payment.cumulativeAmount))
        } catch {
            log("ignoring the payment on channel \(channel.prefix(18))…: \(error.localizedDescription)")
            return (0, 0)
        }
    }

    /// What of `paid` the pool can still pay this Mac, and a settlement check. The
    /// pool contract pays a worker from what later settlements add to the channel,
    /// so attribution beyond what it already paid this Mac plus what the payment
    /// adds since the last settlement is credit nothing funds. Read with the
    /// settlement (one call): once the channel settled past a payment the buyer
    /// showed this Mac yet credited it less, the answers that payment covered are
    /// owed again (WorkerPaymentLedger.reconcile). When
    /// the read fails it returns nil and the request is refused (retryable):
    /// attribution the pool may never pay must not clear this Mac's unpaid
    /// answers. A pool that is no contract (a seller paying workers from its own
    /// address) has nothing on-chain to check, so the signed attribution stands.
    private func redeemable(channel: String, paid: (attributed: UInt64, cumulative: UInt64)) async -> (attributed: UInt64, cumulative: UInt64)? {
        let rpcURLs = config.rpcURLs
        guard !rpcURLs.isEmpty, let pool = poolSeller else { return paid }
        let read: (settled: UInt64, credited: UInt64)?
        do {
            read = try await Chain(rpcURLs: rpcURLs, timeout: 2).poolCredit(channel: channel, worker: address, pool: pool)
        } catch {
            log("could not read the pool's credit on channel \(channel.prefix(18))…: \(error.localizedDescription)")
            return nil
        }
        guard let credit = read else { return paid }
        if payments.reconcile(channel: channel, settled: credit.settled, credited: credit.credited) {
            log("a settlement on channel \(channel.prefix(18))… credited this Mac less than the buyer signed; those answers are owed again")
        }
        let unsettled = paid.cumulative > credit.settled ? paid.cumulative - credit.settled : 0
        let (cap, overflow) = credit.credited.addingReportingOverflow(unsettled)
        return (overflow ? paid.attributed : min(paid.attributed, cap), paid.cumulative)
    }

    private func serve(_ frame: [String: Any], id: String) async {
        let connection = socket
        guard frame["method"] as? String == "POST", frame["path"] as? String == "/v1/chat/completions",
              let bodyB64 = frame["body"] as? String, let body = Data(base64Encoded: bodyB64) else {
            return fail(id, "Unsupported route")
        }
        guard WorkerE2E.isSealed(body) else { return fail(id, WorkerE2E.Failure.notEncrypted.localizedDescription) }
        // Everything up to admission reads only what is in the clear: a request this
        // worker refuses (its channel, its binding, a replay) is never decrypted.
        let sealed: WorkerE2E.SealedRequest
        do {
            sealed = try WorkerE2E.inspectRequest(body, workerAddress: address)
        } catch {
            return fail(id, error.localizedDescription)
        }
        guard let model, checkpoint != nil, let service = choice?.service, sealed.model == service, sharing else {
            return fail(id, "Not serving \(sealed.model)")
        }

        let check: ChannelCheck
        if let buyer = sealed.buyer, let channel = sealed.channel, !channel.allSatisfy({ $0 == "0" || $0 == "x" }) {
            check = await channelCheck(channel: channel, buyer: buyer)
        } else {
            check = .unavailable("No buyer binding") // never consulted: an unbound request is a pool check
        }
        // The channel and price this request's answer is owed on, once admitted: settled when it ends.
        var owed: (channel: String, price: WorkerPayment.Price)?
        var answered: (promptTokens: Int, completionTokens: Int)?
        defer {
            let cutOff = sentOutput.remove(id) != nil
            if let owed {
                if let answered {
                    payments.served(channel: owed.channel, cost: WorkerPayment.cost(promptTokens: answered.promptTokens, completionTokens: answered.completionTokens, price: owed.price))
                } else if cutOff {
                    // Output sent and then cut off (cancelled, failed, or the pool connection
                    // dropped): not owed, since the buyer never pays for an answer without its end,
                    // but counted, so cancelling each answer before it completes gets only a few.
                    payments.interrupted(channel: owed.channel)
                } else {
                    // Nothing reached the pool: nothing to pay for.
                    payments.released(channel: owed.channel)
                }
            }
        }
        // Pool checks are bounded by size here, before the body is even decrypted.
        var full = false
        var checkLimit = RequestGate.checkMaxTokens
        var promptLimit: Int?
        switch await gate.admit(buyer: sealed.buyer, channel: sealed.channel, bodyBytes: sealed.bodyBytes, requestedMaxTokens: RequestGate.checkMaxTokens, check: check) {
        case .full:
            guard let channel = sealed.channel, let buyer = sealed.buyer, let price = prices[sealed.model], price.isChargeable else {
                return fail(id, "The pool declared no price for \(sealed.model), so this worker can't check it is paid")
            }
            // Paid before served: the buyer's signed payments must cover this Mac's earlier answers on the channel.
            guard let paid = await redeemable(channel: channel, paid: attributed(sealed, channel: channel, buyer: buyer)) else {
                return fail(id, "Could not read the pool's settlement for this channel; retry shortly")
            }
            if let refused = payments.admit(channel: channel, attributed: paid.attributed, cumulative: paid.cumulative) {
                return fail(id, refused)
            }
            if let binding = sealed.binding, let expires = sealed.expires,
               let refused = gate.claimOnce(binding: binding, expires: Date(timeIntervalSince1970: TimeInterval(expires))) {
                payments.released(channel: channel)
                return fail(id, refused)
            }
            owed = (channel, price)
            full = true
        case .check(let limit):
            checkLimit = limit
            promptLimit = RequestGate.checkPromptTokens
        case .refused(let reason):
            return fail(id, reason)
        case .cancelled:
            return
        }
        // Cancelled, or the pool connection changed, while the channel was checked: don't start.
        guard !Task.isCancelled, socket === connection else { return }

        let opened: WorkerE2E.OpenedRequest
        do {
            opened = try WorkerE2E.decrypt(sealed, key: keys.encryption)
        } catch {
            return fail(id, error.localizedDescription)
        }
        log(opened.buyer.map { "decrypted request from buyer \($0.prefix(10))… (pool saw only ciphertext)" } ?? "pool check request")
        guard let request = try? JSONSerialization.jsonObject(with: opened.body) as? [String: Any] else {
            return fail(id, "Request body is not JSON")
        }
        let chat: [String: Any]
        let generation: (maxTokens: Int, temperature: Float, stream: Bool)
        do {
            chat = try EngineChat.fields(of: request)
            generation = try EngineChat.generation(of: request)
        } catch {
            // The buyer's request, not this worker, is at fault: answered, never billed, never failed over.
            return await refuse(id, status: 400, error.localizedDescription, sealer: opened.sealer, connection: connection)
        }
        // Taken: the pool now gives it the full first-byte deadline instead of failing over.
        send(["t": "accepted", "id": id], on: connection)

        let maxTokens = full ? generation.maxTokens : min(generation.maxTokens, checkLimit)
        do {
            guard let result = try await generateAndSend(id: id, model: model, service: service, chat: chat, maxTokens: maxTokens, promptLimit: promptLimit,
                                                         temperature: generation.temperature, stream: generation.stream,
                                                         sealer: opened.sealer, connection: connection) else {
                log(sentOutput.contains(id)
                    ? "the answer was cut off on its way to the pool; it counts as cut off, not owed"
                    : "the answer could not be sent to the pool; it is not owed")
                return
            }
            answered = (result.promptTokens, result.completionTokens)
            let calls = result.toolCalls.isEmpty ? "" : " · \(result.toolCalls.count) tool call(s)"
            log("answered with TensorFold: \(result.promptTokens) in / \(result.completionTokens) out\(calls) · \(Int(result.tokensPerSecond)) tok/s · sealed for the buyer")
            requestStats()
        } catch {
            fail(id, Task.isCancelled ? "cancelled" : error.localizedDescription)
        }
    }

    /// Runs the model and sends its answer, sealed for the buyer, streamed or whole. Returns the result
    /// only when the pool took the answer whole on the connection the request came in on. Any of the
    /// answer sent before that is recorded in `sentOutput`, so a cut-off answer counts against the channel (WorkerPaymentLedger.interrupted).
    private func generateAndSend(
        id: String,
        model: LocalModel,
        service: String,
        chat: [String: Any],
        maxTokens: Int,
        promptLimit: Int?,
        temperature: Float,
        stream: Bool,
        sealer: ResponseSealer,
        connection: URLSessionWebSocketTask?
    ) async throws -> LocalModel.Result? {
        let response = EngineChat.Response(id: "chatcmpl-\(UUID().uuidString.prefix(12).lowercased())",
                                           created: Int(Date().timeIntervalSince1970), model: service)
        defer { startedStreams.remove(id) }
        let result = try await model.generate(chat: chat, maxTokens: maxTokens, maxPromptTokens: promptLimit, temperature: temperature) { [weak self] output in
            guard stream else { return }
            await self?.startStream(id, connection: connection)
            guard let event = try? "data: " + jsonString(response.chunk(output)), let sealed = try? sealer.sealEvent(event) else { return }
            await self?.sendOutput(id, sealed, connection: connection)
        }
        let usage = EngineChat.Response.usage(result)
        let sent: Bool
        if stream {
            startStream(id, connection: connection)
            var tail = try sealer.sealEvent("data: " + jsonString(response.finish(result)))
            tail += try sealer.sealEvent("data: " + jsonString(EngineChat.Response.usageEvent(usage)), usage: usage)
            tail += try sealer.sealEvent("data: [DONE]")
            tail += try sealer.finish()
            sent = await sendConfirmed(["t": "response-chunk", "id": id, "data": tail.base64EncodedString()], on: connection)
            if sent { sentOutput.insert(id) }
        } else {
            let sealed = try sealer.sealBody(Data(try jsonString(response.completion(result)).utf8), usage: usage)
            sent = await sendBufferedBody(sealed, id: id, status: 200, connection: connection)
            if sent { sentOutput.insert(id) }
        }
        guard sent, await sendConfirmed(["t": "response-end", "id": id], on: connection) else { return nil }
        return socket === connection ? result : nil
    }

    /// Answers a request the worker can't serve as asked (a part or role the model
    /// can't read) with a sealed OpenAI error, before any inference.
    private func refuse(_ id: String, status: Int, _ message: String, sealer: ResponseSealer, connection: URLSessionWebSocketTask?) async {
        let error: [String: Any] = ["error": ["message": message, "type": "invalid_request_error"]]
        guard let body = try? jsonString(error), let sealed = try? sealer.sealBody(Data(body.utf8), usage: nil) else {
            return fail(id, message)
        }
        log("refused a request: \(message)")
        if await sendBufferedBody(sealed, id: id, status: status, connection: connection) {
            send(["t": "response-end", "id": id], on: connection)
        }
    }

    /// A whole (not streamed) sealed JSON answer: its response-start and its one chunk, on `connection`.
    /// False when the connection didn't take all of it; nothing more is sent after a send that failed.
    @discardableResult
    private func sendBufferedBody(_ sealed: Data, id: String, status: Int, connection: URLSessionWebSocketTask?) async -> Bool {
        guard await sendConfirmed(["t": "response-start", "id": id, "status": status, "headers": ["content-type": "application/json"]], on: connection) else { return false }
        return await sendConfirmed(["t": "response-chunk", "id": id, "data": sealed.base64EncodedString()], on: connection)
    }

    /// Sends one streamed output of `id`'s answer, recording that the buyer may now hold it.
    private func sendOutput(_ id: String, _ sealed: Data, connection: URLSessionWebSocketTask?) {
        guard connection === socket else { return }
        sentOutput.insert(id)
        send(["t": "response-chunk", "id": id, "data": sealed.base64EncodedString()], on: connection)
    }

    /// Starts a streamed answer once, at its first generated output: the pool keeps its first-byte deadline
    /// until response-start, so model startup and prefill get that allowance rather than the idle one.
    private func startStream(_ id: String, connection: URLSessionWebSocketTask?) {
        guard startedStreams.insert(id).inserted else { return }
        send(["t": "response-start", "id": id, "status": 200, "headers": ["content-type": "text/event-stream"]], on: connection)
    }

    // MARK: earnings

    private func requestStats() {
        send(["t": "stats-request", "id": UUID().uuidString])
    }

    private func apply(_ raw: [String: Any]) {
        func amount(_ key: String) -> UInt64 { UInt64(raw[key] as? String ?? "0") ?? 0 }
        stats = PoolStats(
            earnedToday: amount("earnedToday"), earnedLast7Days: amount("earnedLast7Days"), earnedTotal: amount("earnedTotal"),
            requestsTotal: raw["requestsTotal"] as? Int ?? 0,
            outputTokensTotal: raw["outputTokensTotal"] as? Int ?? 0, connectedSecondsLast7Days: raw["connectedSecondsLast7Days"] as? Int ?? 0
        )
    }

    private func startPolling() {
        Task {
            var tick = 0
            while true {
                requestStats()
                // A pending link waits on the owner's transaction; otherwise rewards change only as the pool settles.
                if payouts.pendingLink != nil || tick % 6 == 0 { payouts.refresh(pool: poolSeller) }
                tick += 1
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
    }
}


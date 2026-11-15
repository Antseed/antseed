import Foundation

/// What the pool owes a wallet: its USDC, the ANTS of finished epochs, and the
/// epochs to claim them for. Read the way the ANTS dashboard's claim reads them
/// (apps/ants colony-pools.ts), so a claim from this Mac's rewards page sends
/// the same transactions.
struct ColonyRewards: Equatable, Sendable {
    /// USDC base units (6 decimals).
    var usdc: Decimal
    /// ANTS base units (18 decimals) the pool can pay now: those of epochs whose emissions it already
    /// holds, plus `outrightAnts`.
    var ants: Decimal
    /// Finished epochs with ANTS owed to the wallet.
    var antsEpochs: [Int]
    /// Finished epochs whose emissions the pool hasn't pulled yet and whose pull brings the wallet ANTS
    /// (it has weight in them, or the pull credits it outright): claiming first pulls them
    /// (claimEpochEmissions), so more ANTS may come than `ants` shows.
    var unpulledEpochs: [Int]
    /// Epochs whose ANTS are still the worker key's own after it linked a payout wallet (older than
    /// setPayout moves): counted in `ants`, and paid to the payout wallet with claimAntsFor.
    var workerAntsEpochs: [Int] = []
    /// Whether the pool can send ANTS yet (`antsTransferable()`): until ANTS transfers open, what it
    /// owes stays recorded there and only USDC can be claimed.
    var antsTransferable = true
    /// ANTS the pool owes the wallet outright rather than by epoch (`antsOwed`: its operator fee, or the
    /// emissions of an epoch nobody earned in): counted in `ants`, and claimed with claimOwedAnts.
    var outrightAnts: Decimal = 0

    /// The payout wallet's rewards plus what the linked worker key still holds itself.
    func adding(worker: ColonyRewards) -> ColonyRewards {
        // Its USDC always moves with the link (and later credit goes to the payout), so only ANTS stay behind.
        var merged = self
        // What the pool owes the key outright only the key itself can claim: it is not this wallet's.
        merged.ants += worker.ants - worker.outrightAnts
        merged.workerAntsEpochs = worker.antsEpochs
        merged.unpulledEpochs = Array(Set(unpulledEpochs + worker.unpulledEpochs)).sorted()
        return merged
    }

    var isEmpty: Bool { usdc == 0 && ants == 0 && unpulledEpochs.isEmpty }

    var usdcLabel: String { Self.format(usdc, decimals: 6, prefix: "$", small: 0.0001) }
    var antsLabel: String { Self.format(ants, decimals: 18, prefix: "", small: 0.01) + " ANTS" }

    /// The amount in whole units, two decimals (four below a cent for USDC); "<x" below the smallest shown.
    static func format(_ units: Decimal, decimals: Int, prefix: String, small: Double) -> String {
        let value = NSDecimalNumber(decimal: units / pow(Decimal(10), decimals)).doubleValue
        if value == 0 { return prefix + "0" }
        if value < small { return "<" + prefix + String(small) }
        return prefix + String(format: value < 0.01 ? "%.4f" : "%.2f", value)
    }

    /// An integer amount as a decimal string, for the rewards page (exact for any USDC or ANTS amount).
    static func integerString(_ units: Decimal) -> String { NSDecimalNumber(decimal: units).stringValue }
}

/// An unsigned big-endian ABI word as a Decimal: exact up to 38 digits, beyond any USDC or ANTS amount.
func abiDecimal(_ word: some Sequence<UInt8>) -> Decimal {
    word.reduce(Decimal(0)) { $0 * 256 + Decimal($1) }
}

extension Chain {
    /// What every rewards read of a pool shares: its emissions contract and the finished epochs. Read
    /// once per refresh (never cached across refreshes, so new epochs and registry changes show).
    struct RewardsContext: Sendable {
        let emissions: String
        let epochs: [Int]
        /// The pool's `antsTransferable()`; true when the pool predates it.
        var antsTransferable = true
        /// The account every pull credits the pool's operator fee to outright; nil while the fee is zero.
        var operatorFeeRecipient: String?
        /// The account a pull credits outright for an epoch nobody earned in.
        var remainderRecipient: String?
    }

    func rewardsContext(pool: String) async throws -> RewardsContext {
        let registry = try await address(of: pool, "registry()")
        let emissions = try await address(of: registry, "emissions()")
        let current = WorkerPayment.saturating([UInt8](try await ethCall(to: emissions, data: Self.selector("currentEpoch()"))))
        // The emissions contract is the pool's to choose: a count no real schedule reaches is refused
        // before anything is allocated for it.
        guard current <= UInt64(Self.maxRewardEpochs) else {
            throw Failure.rpc("The pool's emissions contract reports \(current) epochs, more than any real schedule")
        }
        // A pool without the view (or a read that fails) is taken as able to send: its claims say otherwise.
        let transferable = (try? await ethCall(to: pool, data: Self.selector("antsTransferable()"))).map { abiDecimal($0.prefix(32)) != 0 } ?? true
        let feeBps = abiDecimal(try await ethCall(to: pool, data: Self.selector("operatorFeeBps()")).prefix(32))
        var feeRecipient: String?
        if feeBps > 0 { feeRecipient = try await address(of: pool, "operatorFeeRecipient()") }
        let remainder = try await address(of: pool, "remainderRecipient()")
        return RewardsContext(
            emissions: emissions, epochs: Array(0..<Int(current)), antsTransferable: transferable,
            operatorFeeRecipient: feeRecipient, remainderRecipient: remainder
        )
    }

    /// What `pool` owes `account`, over every finished epoch (pool ANTS never expire).
    func colonyRewards(pool: String, account: String, context: RewardsContext? = nil) async throws -> ColonyRewards {
        let resolved: RewardsContext
        if let context { resolved = context } else { resolved = try await rewardsContext(pool: pool) }
        let emissions = resolved.emissions
        let epochs = resolved.epochs
        let account = try Self.addressWord(account)

        let usdc = abiDecimal(try await ethCall(to: pool, data: Self.selector("usdcBalance(address)") + account))
        let outright = abiDecimal(try await ethCall(to: pool, data: Self.selector("antsOwed(address)") + account))
        let weights = try await reads(epochs) { epoch in
            Read(to: pool, data: Self.selector("epochWeight(uint256,address)") + Data(abiWord(UInt64(epoch))) + account)
        }
        let weighted = epochs.filter { abiDecimal(weights[$0] ?? Data()) > 0 }
        // A one-epoch uint256[]: its offset, length and element after the address.
        func oneEpoch(_ epoch: Int) -> Data { Data(abiWord(0x40) + abiWord(1) + abiWord(UInt64(epoch))) }
        async let owedRead = reads(weighted) { epoch in
            Read(to: pool, data: Self.selector("pendingAnts(address,uint256[])") + account + oneEpoch(epoch))
        }
        async let fundedRead = reads(weighted) { epoch in
            Read(to: pool, data: Self.selector("epochAnts(uint256)") + Data(abiWord(UInt64(epoch))))
        }
        let (owed, funded) = try await (owedRead, fundedRead)
        let unfunded = weighted.filter { abiDecimal(funded[$0] ?? Data()) == 0 }
        // Only an epoch the emissions contract would pay the pool for is worth a pull.
        let poolWord = try Self.addressWord(pool)
        let pullable = try await reads(unfunded) { epoch in
            Read(to: emissions, data: Self.selector("pendingEmissions(address,uint256[])") + poolWord + oneEpoch(epoch))
        }
        let earned = unfunded.filter { abiDecimal((pullable[$0] ?? Data()).prefix(32)) > 0 }
        // A pull also credits the wallet outright, whatever its weight: every rewarded epoch when it takes
        // the pool's operator fee, and a rewarded epoch nobody earned in when it is the remainder recipient.
        let takesFee = try resolved.operatorFeeRecipient.map { try Self.addressWord($0) } == account
        let takesRemainder = try resolved.remainderRecipient.map { try Self.addressWord($0) } == account
        var credited: [Int] = []
        if takesFee || takesRemainder {
            let rewards = try await reads(epochs) { epoch in
                Read(to: emissions, data: Self.selector("pendingEmissions(address,uint256[])") + poolWord + oneEpoch(epoch))
            }
            credited = epochs.filter { abiDecimal((rewards[$0] ?? Data()).prefix(32)) > 0 }
            if !takesFee {
                let totals = try await reads(credited) { epoch in
                    Read(to: pool, data: Self.selector("epochTotalWeight(uint256)") + Data(abiWord(UInt64(epoch))))
                }
                credited = credited.filter { abiDecimal(totals[$0] ?? Data()) == 0 }
            }
        }
        let antsEpochs = weighted.filter { abiDecimal(owed[$0] ?? Data()) > 0 }
        return ColonyRewards(
            usdc: usdc,
            ants: antsEpochs.reduce(outright) { $0 + abiDecimal(owed[$1] ?? Data()) },
            antsEpochs: antsEpochs,
            unpulledEpochs: Array(Set(earned + credited)).sorted(),
            antsTransferable: resolved.antsTransferable,
            outrightAnts: outright
        )
    }

    /// Epochs a rewards read covers at most: weekly epochs would take a century to reach it.
    static let maxRewardEpochs = 5_000

    private func address(of contract: String, _ getter: String) async throws -> String {
        let word = try await ethCall(to: contract, data: Self.selector(getter))
        guard word.count >= 32 else { throw Failure.rpc("Malformed \(getter) answer") }
        return Data(word.prefix(32).suffix(20)).prefixedHex
    }

    /// One read per epoch, batched (batchEthCall); any failure fails the whole read (a missing value must never show as nothing owed).
    private func reads(_ epochs: [Int], _ read: @Sendable (Int) -> Read) async throws -> [Int: Data] {
        let answers = try await batchEthCall(epochs.map(read))
        return Dictionary(uniqueKeysWithValues: zip(epochs, answers))
    }
}

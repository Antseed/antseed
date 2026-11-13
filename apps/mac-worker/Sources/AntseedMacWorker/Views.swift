import SwiftUI

private func short(_ address: String) -> String {
    address.count > 12 ? "\(address.prefix(6))…\(address.suffix(4))" : address
}

/// Drawn in SwiftUI (not an AppKit switch) so it also shows in rendered snapshots.
struct ShareSwitch: View {
    @Binding var isOn: Bool

    var body: some View {
        Capsule()
            .fill(isOn ? Color.green : Color.gray.opacity(0.4))
            .frame(width: 34, height: 20)
            .overlay(alignment: isOn ? .trailing : .leading) {
                Circle().fill(.white).frame(width: 16, height: 16).padding(2).shadow(radius: 1)
            }
            .animation(.easeOut(duration: 0.15), value: isOn)
            .onTapGesture { isOn.toggle() }
            .accessibilityLabel("Share this Mac")
            .accessibilityAddTraits(.isButton)
    }
}

/// The whole app: a menubar panel. Earnings history and claims live in the
/// ANTS dashboard; this only shows whether the Mac is working and links there.
struct MenuPanel: View {
    @ObservedObject var worker: WorkerController
    /// ImageRenderer cannot draw AppKit controls; snapshots get drawn stand-ins.
    var snapshot = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Circle().fill(worker.status.color).frame(width: 8, height: 8)
                Text(worker.status.label).font(.system(size: 13, weight: .medium))
                Spacer()
                ShareSwitch(isOn: $worker.sharing)
            }
            HStack {
                Text("Earned today (est.)").foregroundStyle(.secondary)
                Spacer()
                Text(usd(worker.stats.earnedToday)).monospacedDigit()
            }
            .font(.system(size: 12))
            HStack {
                Text("Model").foregroundStyle(.secondary)
                Spacer()
                Text(worker.config.modelName).lineLimit(1)
            }
            .font(.system(size: 12))
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: worker.protection.hardened ? "lock.fill" : "lock.open")
                    .foregroundStyle(worker.protection.hardened ? Color.green : Color.orange)
                Text(worker.protection.summary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .font(.system(size: 11))
            Divider()
            PoolView(worker: worker, snapshot: snapshot)
            Divider()
            PayoutLinkView(payouts: worker.payouts, pool: worker.poolSeller, snapshot: snapshot)
            HStack {
                Spacer()
                if snapshot {
                    Text("Quit").font(.system(size: 12)).foregroundStyle(Color.accentColor)
                } else {
                    Button("Quit") { NSApp.terminate(nil) }.buttonStyle(.link).font(.system(size: 12))
                }
            }
        }
        .padding(14)
        .frame(width: 280)
    }
}

/// The pool this Mac joins, and a form to enter or change it.
struct PoolView: View {
    @ObservedObject var worker: WorkerController
    var snapshot = false
    @State private var address = ""
    @State private var editing = false
    @State private var error: String?

    var body: some View {
        if let pool = worker.poolURL, !editing {
            HStack {
                Text("Pool").foregroundStyle(.secondary)
                Spacer()
                Text(pool.host ?? pool.absoluteString).lineLimit(1).truncationMode(.middle)
            }
            .font(.system(size: 12))
            if snapshot {
                Text("Change pool").font(.system(size: 11)).foregroundStyle(Color.accentColor)
            } else {
                Button("Change pool") { address = pool.absoluteString; editing = true }.buttonStyle(.link).font(.system(size: 11))
            }
        } else {
            Text("Pool address, from its operator").font(.system(size: 12)).foregroundStyle(.secondary)
            HStack {
                if snapshot {
                    Text("wss://…").font(.system(size: 12, design: .monospaced)).foregroundStyle(.tertiary)
                        .padding(.horizontal, 6).frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.4)))
                    Text("Join").font(.system(size: 11)).padding(.horizontal, 8).padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Color.secondary.opacity(0.25)))
                } else {
                    TextField("wss://…", text: $address).textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
                        .onSubmit(join)
                    Button("Join", action: join).controlSize(.small)
                }
            }
            if let error {
                Text(error).font(.system(size: 11)).foregroundStyle(.red)
            }
            if editing && !snapshot {
                Button("Cancel") { editing = false; error = nil }.buttonStyle(.link).font(.system(size: 11))
            }
        }
    }

    private func join() {
        error = worker.join(pool: address)
        if error == nil { editing = false }
    }
}

/// The payout wallet: the one the pool pays, a link waiting to be submitted, or a form to link one.
struct PayoutLinkView: View {
    @ObservedObject var payouts: WorkerPayoutController
    let pool: String?
    var snapshot = false
    @State private var wallet = ""
    /// The owner chose to link another wallet.
    @State private var changingPayout = false

    var body: some View {
        if let link = payouts.pendingLink, !changingPayout {
            Text("Linking \(short(link.payout))").font(.system(size: 12)).foregroundStyle(.secondary)
            Text(payouts.linkCopied
                 ? "Link code copied. In the Antseed app's Rewards (or `antseed ants`), choose Link a Mac and paste it."
                 : "Not linked yet: paste the link code in Rewards in the Antseed app or `antseed ants`.")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            payoutActions(primary: "Copy code") { payouts.copyLinkCode() }
        } else if let payout = payouts.payout, !changingPayout {
            Text("Pays to \(short(payout))").font(.system(size: 12)).foregroundStyle(.secondary)
            Text("Earnings and claims: Rewards in the Antseed app or `antseed ants`.")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            payoutActions(primary: nil) {}
        } else {
            Text("Link the wallet your earnings go to").font(.system(size: 12)).foregroundStyle(.secondary)
            HStack {
                if snapshot {
                    Text("0x…").font(.system(size: 12, design: .monospaced)).foregroundStyle(.tertiary)
                        .padding(.horizontal, 6).frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.4)))
                    Text("Link").font(.system(size: 11)).padding(.horizontal, 8).padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Color.secondary.opacity(0.25)))
                } else {
                    TextField("0x…", text: $wallet).textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
                    Button("Link") {
                        // The editor stays open, with the error, until a new link is signed.
                        Task { if await payouts.link(to: wallet, pool: pool) { changingPayout = false } }
                    }.controlSize(.small)
                }
            }
            if let error = payouts.linkError {
                Text(error).font(.system(size: 11)).foregroundStyle(.red)
            }
            if changingPayout && !snapshot {
                Button("Cancel") { changingPayout = false }.buttonStyle(.link).font(.system(size: 11))
            }
        }
    }

    /// Text links under the payout line: an optional primary action, then Change.
    @ViewBuilder
    private func payoutActions(primary: String?, action: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            if snapshot {
                if let primary { Text(primary).foregroundStyle(Color.accentColor) }
                Text("Change wallet").foregroundStyle(Color.accentColor)
            } else {
                if let primary { Button(primary, action: action).buttonStyle(.link) }
                Button("Change wallet") { changingPayout = true }.buttonStyle(.link)
            }
        }
        .font(.system(size: 11))
    }
}

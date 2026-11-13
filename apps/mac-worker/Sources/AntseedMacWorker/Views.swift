import AppKit
import SwiftUI

// The menubar panel, in the Antseed desktop app's look: warm paper and an olive
// accent in light mode, deep navy and lime in dark, rounded cards, calm notices,
// and the desktop's ant showing how the Mac is doing. Everything is drawn in
// SwiftUI (no AppKit controls except text fields), so rendered snapshots match.

private func short(_ address: String) -> String {
    address.count > 12 ? "\(address.prefix(6))…\(address.suffix(4))" : address
}

/// Earnings in USDC (6 decimals): cents once there are some, four decimals below a cent.
func usdShort(_ units: UInt64) -> String {
    if units == 0 { return "$0.00" }
    let value = Double(units) / 1_000_000
    return value < 0.01 ? String(format: "$%.4f", value) : String(format: "$%.2f", value)
}

// MARK: theme

/// The desktop app's tokens (apps/desktop global.scss), light and dark.
enum Theme {
    static let background = dynamic(light: 0xFBFAF6, dark: 0x0A0F22)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x121A36)
    static let surface = dynamic(light: 0xF1EFE8, dark: 0x1A2140)
    static let text = dynamic(light: 0x16181D, dark: 0xEEF0F7)
    static let textSecondary = dynamic(light: 0x4B5058, dark: 0xB7BDD3)
    static let textMuted = dynamic(light: 0x62676F, dark: 0x9AA1BA)
    static let accent = dynamic(light: 0x5C8A12, dark: 0xC6F06A)
    /// Text on the accent: white on olive, ink on lime.
    static let onAccent = dynamic(light: 0xFFFFFF, dark: 0x0A0F22)
    static let amber = dynamic(light: 0xB47A14, dark: 0xE0A93B)
    static let danger = dynamic(light: 0xDC3545, dark: 0xF07178)
    static let border = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.isDark ? NSColor(white: 1, alpha: 0.11) : NSColor(red: 22 / 255, green: 24 / 255, blue: 29 / 255, alpha: 0.1)
    })

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in rgb(appearance.isDark ? dark : light) })
    }

    private static func rgb(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

private extension NSAppearance {
    var isDark: Bool { bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }
}

// MARK: building blocks

/// The desktop's ant, in the mood that matches the worker's status.
struct Mascot: View {
    let status: WorkerStatus
    var size: CGFloat = 52

    var body: some View {
        if let image = resourceImage("mascot/\(Self.mood(status)).png") {
            Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                .frame(width: size, height: size * 1.2)
        } else {
            Image(systemName: "ant.fill").font(.system(size: size * 0.5)).foregroundStyle(Theme.accent)
                .frame(width: size, height: size * 1.2)
        }
    }

    static func mood(_ status: WorkerStatus) -> String {
        switch status {
        case .serving: "happy"
        case .failed: "oops"
        case .starting, .loadingModel, .connecting: "think"
        case .paused, .needsPool, .choosingModel: "idle"
        }
    }
}

/// An image from apps/mac-worker/Resources: bundled in Contents/Resources by scripts/build-app.sh,
/// read from the source tree in development.
func resourceImage(_ path: String) -> NSImage? {
    let bundled = Bundle.main.resourceURL?.appendingPathComponent(path)
    let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Resources/\(path)")
    return [bundled, source].compactMap { $0 }.lazy.compactMap { NSImage(contentsOf: $0) }.first
}

/// The desktop app's menu bar mark: 18 pt, a template image so it follows the menu bar's colour.
let menuBarMark: NSImage? = {
    guard let image = resourceImage("menubar.png") else { return nil }
    image.size = NSSize(width: 18, height: 18)
    image.isTemplate = true
    return image
}()

/// The desktop's toggle: accent when on.
struct ShareSwitch: View {
    @Binding var isOn: Bool
    var label = "Share this Mac"

    var body: some View {
        Capsule()
            .fill(isOn ? Theme.accent : Theme.border)
            .frame(width: 36, height: 21)
            .overlay(alignment: isOn ? .trailing : .leading) {
                Circle().fill(isOn ? Theme.onAccent : Color.white).frame(width: 17, height: 17).padding(2)
                    .shadow(color: .black.opacity(0.15), radius: 1, y: 0.5)
            }
            .animation(.easeOut(duration: 0.15), value: isOn)
            .contentShape(Capsule())
            .clickable(label) { isOn.toggle() }
            .accessibilityValue(isOn ? "On" : "Off")
    }
}

extension View {
    /// A drawn control that acts like a button: the pointing hand on hover, and a named button for
    /// VoiceOver and automation (a tap gesture alone is neither).
    func clickable(_ label: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        self
            .onTapGesture { if enabled { action() } }
            .onHover { inside in
                (inside && enabled ? NSCursor.pointingHand : NSCursor.arrow).set()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if enabled { action() } }
    }
}

/// A pill button: the accent for the main action, an outline otherwise.
struct PillButton: View {
    let title: String
    var primary = true
    let action: () -> Void

    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(primary ? Theme.onAccent : Theme.text)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Capsule().fill(primary ? Theme.accent : Color.clear))
            .overlay(Capsule().stroke(primary ? Color.clear : Theme.border))
            .contentShape(Capsule())
            .clickable(title, action: action)
    }
}

/// A text link in the accent colour.
struct TextLink: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Text(title).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.accent)
            .contentShape(Rectangle())
            .clickable(title, action: action)
    }
}

/// A rounded card on the panel's background.
struct Card<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border))
    }
}

/// One row of a settings card: a label, its value, and an optional action on the right.
struct SettingRow<Detail: View>: View {
    let icon: String
    let title: String
    let value: String
    var actionTitle: String?
    var action: () -> Void = {}
    @ViewBuilder var detail: Detail

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textMuted).frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                    Text(value).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if let actionTitle { TextLink(title: actionTitle, action: action) }
            }
            detail
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }
}

extension SettingRow where Detail == EmptyView {
    init(icon: String, title: String, value: String, actionTitle: String? = nil, action: @escaping () -> Void = {}) {
        self.init(icon: icon, title: title, value: value, actionTitle: actionTitle, action: action) { EmptyView() }
    }
}

/// A text field drawn in the panel's style; snapshots get a drawn stand-in (ImageRenderer can't draw AppKit fields).
struct InputField: View {
    let placeholder: String
    @Binding var text: String
    var snapshot = false
    var onSubmit: () -> Void = {}

    var body: some View {
        Group {
            if snapshot {
                Text(text.isEmpty ? placeholder : text).foregroundStyle(text.isEmpty ? Theme.textMuted : Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                TextField(placeholder, text: $text).textFieldStyle(.plain).onSubmit(onSubmit)
            }
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border))
    }
}

// MARK: the panel

/// The whole app: a menubar panel. Earnings history and claims live in the
/// ANTS dashboard; this shows whether the Mac is working and what it earns.
struct MenuPanel: View {
    @ObservedObject var worker: WorkerController
    /// ImageRenderer cannot draw AppKit controls; snapshots get drawn stand-ins.
    var snapshot = false
    /// The panel's laid-out height, which its window follows.
    @State private var height: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            EarningsCard(worker: worker)
            // A payout link names the pool contract, so rewards show once the app has joined one.
            if worker.poolSeller != nil {
                RewardsCard(worker: worker, payouts: worker.payouts, snapshot: snapshot)
            }
            Card {
                ModelRow(worker: worker, snapshot: snapshot)
                Divider().overlay(Theme.border)
                PoolRow(worker: worker, snapshot: snapshot)
            }
            ThisMacCard(mac: worker.mac, updates: worker.updates)
            ProtectionNotice(protection: worker.protection)
            footer
        }
        .padding(14)
        .frame(width: 320)
        .background(Theme.background)
        .fixedSize(horizontal: false, vertical: true)
        .background(GeometryReader { geometry in
            Color.clear.preference(key: PanelHeightKey.self, value: geometry.size.height)
        })
        .onPreferenceChange(PanelHeightKey.self) { height = $0 }
        .background(FitWindowToContent(height: height))
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Mascot(status: worker.status, size: 46)
            VStack(alignment: .leading, spacing: 3) {
                Text("Antseed Colony").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                HStack(spacing: 6) {
                    Circle().fill(statusColor).frame(width: 7, height: 7)
                    Text(worker.status.label).font(.system(size: 12)).foregroundStyle(Theme.textSecondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            ShareSwitch(isOn: $worker.sharing)
        }
    }

    private var statusColor: Color {
        switch worker.status {
        case .serving: Theme.accent
        case .failed: Theme.danger
        case .paused, .needsPool, .choosingModel: Theme.amber
        default: Theme.textMuted
        }
    }

    private var footer: some View {
        HStack {
            Text("Version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")")
                .font(.system(size: 11)).foregroundStyle(Theme.textMuted)
            Spacer()
            TextLink(title: "Help") { if !snapshot { NSWorkspace.shared.open(URL(string: "https://antseed.com/docs/local-ai/mac")!) } }
            TextLink(title: "Quit") { if !snapshot { NSApp.terminate(nil) } }
                .padding(.leading, 10)
        }
    }
}

/// Starting at login, staying awake while sharing, and updates.
struct ThisMacCard: View {
    @ObservedObject var mac: MacSettings
    @ObservedObject var updates: Updates

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                toggleRow("Open at login", detail: "Keeps earning after a restart",
                          isOn: Binding(get: { mac.openAtLogin }, set: { mac.setOpenAtLogin($0) }))
                if let error = mac.loginError {
                    Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
                }
                toggleRow("Keep awake while sharing", detail: mac.holdingAwake ? "Holding this Mac awake now" : "The display can still sleep",
                          isOn: $mac.keepAwake)
                if mac.keepAwake {
                    toggleRow("Only when plugged in", detail: "Never drains the battery", isOn: $mac.onlyOnPower)
                }
                if updates.available {
                    Divider().overlay(Theme.border)
                    HStack {
                        Text("Updates").font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.text)
                        Spacer()
                        TextLink(title: "Check for updates") { updates.check() }
                    }
                }
            }
            .padding(14)
        }
    }

    private func toggleRow(_ title: String, detail: String, isOn: Binding<Bool>) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.text)
                Text(detail).font(.system(size: 11)).foregroundStyle(Theme.textMuted)
            }
            Spacer(minLength: 8)
            ShareSwitch(isOn: isOn, label: title).scaleEffect(0.85)
        }
    }
}

/// Today's estimate, large, with the week and the requests served under it.
struct EarningsCard: View {
    @ObservedObject var worker: WorkerController

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 4) {
                Text("Earned today").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                Text(usdShort(worker.stats.earnedToday))
                    .font(.system(size: 28, weight: .semibold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(Theme.text)
                HStack(spacing: 14) {
                    stat("7 days", usdShort(worker.stats.earnedLast7Days))
                    stat("All time", usdShort(worker.stats.earnedTotal))
                    stat("Requests", "\(worker.stats.requestsTotal)")
                }
                .padding(.top, 4)
            }
            .padding(14)
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 10.5)).foregroundStyle(Theme.textMuted)
            Text(value).font(.system(size: 12, weight: .medium)).monospacedDigit().foregroundStyle(Theme.textSecondary)
        }
    }
}

/// What protects prompts on this Mac, as one calm line: a coloured dot, the summary and a link.
struct ProtectionNotice: View {
    let protection: Protection.Report

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(protection.hardened ? Theme.accent : Theme.amber).frame(width: 7, height: 7)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 3 }
            Text(protection.summary).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4)
    }
}

// MARK: rows

/// The model this Mac runs, and the pool's models to pick from.
struct ModelRow: View {
    @ObservedObject var worker: WorkerController
    var snapshot = false
    @State private var picking = false

    var body: some View {
        let choice = worker.choice
        let canChange = worker.poolModels.contains { $0 != choice }
        // After a failed load the list stays open: pick the same model to retry it, or another.
        let showList = !worker.poolModels.isEmpty && (choice == nil || picking || worker.modelLoadFailed)
        SettingRow(icon: "cpu", title: choice.map { "Model · \($0.service)" } ?? "Model",
                   value: choice?.displayName ?? (worker.poolModels.isEmpty ? "Chosen from the pool you join" : "Choose one below"),
                   actionTitle: picking ? "Cancel" : (worker.modelLoadFailed ? "Retry" : (choice != nil && canChange ? "Change" : nil)),
                   action: {
                       guard !picking, worker.modelLoadFailed else { return picking.toggle() }
                       guard !snapshot else { return }
                       worker.retryModel()
                   }) {
            if showList {
                VStack(spacing: 6) {
                    ForEach(worker.poolModels, id: \.self) { offer in option(offer) }
                }
            }
        }
    }

    private func option(_ offer: ModelChoice) -> some View {
        let size = worker.modelSizes[offer.model]
        let fits = size.map { ModelSize.fits($0) } ?? true
        let current = offer == worker.choice
        return HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(offer.displayName).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
                Text(fits ? offer.service : "\(offer.service) · needs more memory")
                    .font(.system(size: 10.5)).foregroundStyle(fits ? Theme.textMuted : Theme.amber)
            }
            Spacer(minLength: 6)
            if let size { Text(ModelSize.label(size)).font(.system(size: 11)).monospacedDigit().foregroundStyle(Theme.textMuted) }
            Image(systemName: current ? "checkmark.circle.fill" : "arrow.down.circle")
                .foregroundStyle(current ? Theme.accent : Theme.textMuted)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(current ? Theme.accent.opacity(0.1) : Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(current ? Theme.accent.opacity(0.5) : Color.clear))
        .opacity(fits ? 1 : 0.55)
        .contentShape(Rectangle())
        .clickable("Run \(offer.displayName) for \(offer.service)", enabled: fits && (!current || worker.modelLoadFailed)) {
            guard !snapshot else { return }
            picking = false
            worker.choose(offer)
        }
    }
}

/// The pool this Mac joins, and a form to enter or change it.
struct PoolRow: View {
    @ObservedObject var worker: WorkerController
    var snapshot = false
    @State private var address = ""
    @State private var editing = false
    @State private var error: String?

    var body: some View {
        let pool = worker.poolURL
        let showForm = pool == nil || editing
        SettingRow(icon: "point.3.connected.trianglepath.dotted", title: "Pool",
                   value: pool.map { $0.host ?? $0.absoluteString } ?? "Not joined",
                   actionTitle: pool == nil ? nil : (editing ? "Cancel" : "Change"),
                   action: {
                       if editing { editing = false; error = nil } else { address = pool?.absoluteString ?? ""; editing = true }
                   }) {
            if showForm {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        InputField(placeholder: "wss://… from the pool's operator", text: $address, snapshot: snapshot, onSubmit: join)
                        PillButton(title: "Join", action: join)
                    }
                    if let error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger) }
                }
            }
        }
    }

    private func join() {
        guard !snapshot else { return }
        error = worker.join(pool: address)
        if error == nil { editing = false }
    }
}

/// What the pool owes this Mac's owner, the wallet it pays, and the two steps that need that wallet
/// (link, claim), which open the Antseed payments page in the browser.
struct RewardsCard: View {
    @ObservedObject var worker: WorkerController
    @ObservedObject var payouts: WorkerPayoutController
    var snapshot = false

    var body: some View {
        let rewards = payouts.rewards
        let linked = payouts.payout != nil
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(linked ? "Claimable" : "Earned, waiting for a wallet").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                        Text(rewards.map { "\($0.usdcLabel) · \($0.antsLabel)" } ?? "Reading…")
                            .font(.system(size: 14, weight: .semibold)).monospacedDigit().foregroundStyle(Theme.text)
                    }
                    Spacer(minLength: 8)
                    if linked {
                        PillButton(title: "Claim", primary: !(rewards?.isEmpty ?? true)) { open("colony-claim") }
                    }
                }
                if let unpulled = rewards?.unpulledEpochs.count, unpulled > 0 {
                    Text("Plus ANTS from \(unpulled) finished epoch\(unpulled == 1 ? "" : "s"), pulled into the pool when you claim.")
                        .font(.system(size: 11)).foregroundStyle(Theme.textMuted).fixedSize(horizontal: false, vertical: true)
                }
                Divider().overlay(Theme.border)
                HStack(spacing: 10) {
                    Image(systemName: "wallet.pass").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textMuted).frame(width: 16)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Payout wallet").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                        Text(payouts.payout.map(short) ?? "Not linked").font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.text)
                    }
                    Spacer(minLength: 8)
                    if linked {
                        TextLink(title: "Change") { open("colony-link") }
                    } else {
                        PillButton(title: "Link wallet") { open("colony-link") }
                    }
                }
                if let error = worker.payPageError ?? payouts.rewardsError {
                    Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
        }
    }

    private func open(_ action: String) {
        if !snapshot { worker.openPayPage(action) }
    }
}

// MARK: window sizing

private struct PanelHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// A MenuBarExtra window keeps the height it opened with, so content that shrinks (the model list
/// collapsing once one is picked) left a gap. This resizes the window to the panel, keeping its top
/// edge under the menu bar.
private struct FitWindowToContent: NSViewRepresentable {
    let height: CGFloat

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ view: NSView, context: Context) {
        let height = height
        DispatchQueue.main.async {
            guard let window = view.window, height > 0 else { return }
            var frame = window.frame
            let target = window.frameRect(forContentRect: NSRect(x: 0, y: 0, width: frame.width, height: height)).height
            guard abs(frame.height - target) > 0.5 else { return }
            frame.origin.y += frame.height - target
            frame.size.height = target
            window.setFrame(frame, display: true, animate: false)
        }
    }
}

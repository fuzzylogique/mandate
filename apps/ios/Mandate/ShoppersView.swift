// Everyone who shops from the account, what they're doing, and the owner's controls.
import SwiftUI

struct ShoppersView: View {
    @Environment(AppStore.self) private var store
    @State private var adding = false
    @State private var openShopper: Shopper?

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Shoppers")
                        .font(.system(size: 30, weight: .semibold))
                        .tracking(-0.8)
                    Spacer()
                    Button { adding = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 18, weight: .medium))
                            .frame(width: 44, height: 44)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("New shopper")
                    .disabled(!store.hasAccount)
                }
                .padding(.top, 8)

                if !store.hasAccount {
                    Text("Open your account first, then add shoppers to it.")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.soft)
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassPanel()
                } else if store.shoppers.isEmpty {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Nobody is shopping for you right now. Add a shopper and hand over a limit.")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.soft)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("New shopper") { adding = true }
                            .buttonStyle(LensButtonStyle(height: 52))
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassPanel()
                }

                ForEach(store.shoppers) { shopper in
                    ShopperCard(shopper: shopper) { openShopper = shopper }
                }

                if !store.stopped.isEmpty {
                    Text("Stopped")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                        .padding(.top, 14)
                    VStack(spacing: 0) {
                        ForEach(Array(store.stopped.enumerated()), id: \.element.id) { index, shopper in
                            Button { openShopper = shopper } label: {
                                HStack {
                                    Image(systemName: shopper.kindIcon)
                                        .font(.system(size: 14))
                                        .foregroundStyle(Color.soft)
                                        .frame(width: 22)
                                    Text(shopper.name)
                                        .font(.system(size: 15))
                                    Spacer()
                                    Text(shopper.status == "expired" ? "Ended" : "Can't spend")
                                        .font(.system(size: 13))
                                        .foregroundStyle(Color.soft)
                                }
                                .frame(height: 48)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            if index < store.stopped.count - 1 {
                                Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
                            }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 2)
                    .glassPanel(24)
                }
            }
        }
        // Before the sheets, so pull-to-refresh does not leak into them.
        .refreshable { await store.refresh() }
        .fullScreenCover(isPresented: $adding) { NewShopperView() }
        .sheet(item: $openShopper) { ShopperDetail(shopperID: $0.id) }
    }
}

/// One shopper as a glass card: who it is, its job, what it spent, and what you can do.
struct ShopperCard: View {
    @Environment(AppStore.self) private var store
    let shopper: Shopper
    var open: (() -> Void)?

    @State private var confirmingStop = false

    private var color: Color { .shopper(shopper.colorIndex) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let open {
                Button(action: open) { header }
                    .buttonStyle(.plain)
            } else {
                header
            }

            if shopper.isWaiting {
                PairingPanel(shopper: shopper)
                    .padding(.top, 16)
            } else {
                spend.padding(.top, 16)
                if let job = shopper.job { jobLines(job).padding(.top, 12) }
            }

            if let working = store.working[shopper.id] {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(working)
                        .font(.system(size: 14, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 46)
                .padding(.top, 14)
            } else {
                if let outcome = store.outcomes[shopper.id] {
                    OutcomeLine(outcome: outcome).padding(.top, 12)
                }
                actions.padding(.top, 14)
            }
        }
        .padding(18)
        .glassPanel()
        .confirmationDialog("Stop \(shopper.name)?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop this shopper", role: .destructive) {
                Task { await store.stop(shopper) }
            }
        } message: {
            Text("It won't be able to spend from your account again. What it already bought stays in your activity.")
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: shopper.kindIcon)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Color.ink)
                .frame(width: 44, height: 44)
                .background(color, in: .circle)
            VStack(alignment: .leading, spacing: 2) {
                Text(shopper.name)
                    .font(.system(size: 17, weight: .semibold))
                Text(shopper.kindLabel)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
            }
            Spacer(minLength: 8)
            Chip(text: shopper.statusLabel, color: shopper.isActive ? .trusted : shopper.isWaiting ? .glow : .soft)
        }
        .lineLimit(1)
        .contentShape(.rect)
    }

    private var spend: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(shopper.spentMoney.text) spent")
                    .font(.system(size: 15, weight: .medium))
                Spacer()
                Text("of \(shopper.limitMoney.short) \(Period.current(shopper.period))")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
            }
            SpendBar(share: shopper.spentShare, color: color)
            Text("Trusted stores only · until \(Dates.day(Dates.parse(shopper.expiresAt)))")
                .font(.system(size: 12))
                .foregroundStyle(Color.soft)
        }
    }

    private func jobLines(_ job: ShopperJob) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(shopper.jobLine ?? "", systemImage: "arrow.triangle.2.circlepath")
                .font(.system(size: 14, weight: .medium))
            if let last = job.lastResult, store.outcomes[shopper.id] == nil {
                Text("Last: \(last)")
                    .font(.system(size: 13))
                    .foregroundStyle(last.hasPrefix("Blocked") ? Color.blocked : Color.soft)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if shopper.isActive {
                Text("Next shop \(Dates.relative(Dates.parse(job.nextRunAt)))")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        if shopper.isLive {
            HStack(spacing: 8) {
                if shopper.isHosted && shopper.isActive {
                    Button("Shop now") { Task { await store.run(shopper) } }
                        .buttonStyle(LensButtonStyle(height: 44))
                }
                if !shopper.isAssistant && shopper.isActive {
                    Menu {
                        Button("At a look-alike store", systemImage: "exclamationmark.shield") {
                            Task { await store.run(shopper, test: "lookalike") }
                        }
                        Button("Over the limit", systemImage: "gauge.with.dots.needle.100percent") {
                            Task { await store.run(shopper, test: "over-limit") }
                        }
                    } label: {
                        Text("Test the rules")
                            .font(.system(size: 15, weight: .semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .frame(maxWidth: .infinity)
                            .frame(height: 44)
                    }
                    .glassEffect(.regular.interactive(), in: .capsule)
                }
                Button("Stop") { confirmingStop = true }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.blocked)
                    .frame(maxWidth: shopper.isActive && !shopper.isAssistant ? 76 : .infinity)
                    .frame(height: 44)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .disabled(shopper.stopPending == true)
            }
        }
    }
}

/// What came back from Shop now or a rules test.
struct OutcomeLine: View {
    let outcome: PurchaseOutcome
    /// Whose account checked it, when it isn't yours.
    var owner: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: outcome.status == "paid" ? "checkmark.circle.fill" : outcome.status == "blocked" ? "hand.raised.fill" : "info.circle")
                .foregroundStyle(outcome.status == "paid" ? Color.trusted : outcome.status == "blocked" ? Color.blocked : Color.soft)
            VStack(alignment: .leading, spacing: 2) {
                Text(outcome.summary)
                    .font(.system(size: 14, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                if outcome.status == "blocked" {
                    Text("\(owner.map { "\($0)'s account" } ?? "Your account") refused it, so no money moved.")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.soft)
                } else if let note = outcome.note {
                    Text(note)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.soft)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(.white.opacity(0.08), in: .rect(cornerRadius: 16))
    }
}

/// An assistant that hasn't connected yet: the one-time code to give it.
struct PairingPanel: View {
    @Environment(AppStore.self) private var store
    let shopper: Shopper

    var body: some View {
        VStack(spacing: 12) {
            if let pairing = shopper.pairing {
                Text("Connect \(shopper.name) with this code")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
                Text(pairing.code)
                    .font(.system(size: 38, weight: .semibold, design: .monospaced))
                    .tracking(2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .textSelection(.enabled)
                Text("Open \(shopper.name) and say: connect to Mandate with code \(pairing.code)")
                    .font(.system(size: 14))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button {
                        UIPasteboard.general.string = "Connect to Mandate with code \(pairing.code)"
                        store.show(Banner(blocked: false, title: "Copied", detail: "Paste it into \(shopper.name)"))
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                            .font(.system(size: 14, weight: .medium))
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                    }
                    .glassEffect(.regular.interactive(), in: .capsule)
                    Text("Works for \(Dates.relative(Dates.parse(pairing.expiresAt)).replacingOccurrences(of: "in ", with: ""))")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.soft)
                        .frame(maxWidth: .infinity)
                }
            } else {
                Text("The code expired before \(shopper.name) connected.")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
                    .multilineTextAlignment(.center)
                Button("Get a new code") { Task { await store.newPairingCode(shopper) } }
                    .buttonStyle(LensButtonStyle(height: 46))
                    .disabled(store.working[shopper.id] != nil)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .background(.white.opacity(0.08), in: .rect(cornerRadius: 22))
    }
}

/// One shopper: its limit, the proof of its rule, and what it has bought.
struct ShopperDetail: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let shopperID: String
    @State private var openReceipt: Activity?

    var body: some View {
        ZStack {
            LightField()
            if let shopper = store.shopper(shopperID) {
                ScrollView {
                    VStack(spacing: 22) {
                        header(shopper)
                        if shopper.isLive {
                            ShopperCard(shopper: shopper)
                        }
                        proof(shopper)
                        history(shopper)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 36)
                    .padding(.bottom, 32)
                }
                .scrollIndicators(.hidden)
            }
        }
        .showsBanner()
        .presentationDragIndicator(.visible)
        .sheet(item: $openReceipt) { ReceiptView(item: $0) }
    }

    private func header(_ shopper: Shopper) -> some View {
        VStack(spacing: 10) {
            Text(shopper.name)
                .font(.system(size: 17, weight: .medium))
            ZStack {
                Ring(share: shopper.isLive ? shopper.leftShare : 0, color: .shopper(shopper.colorIndex), width: 10)
                VStack(spacing: 0) {
                    Text(shopper.isLive ? shopper.leftMoney.short : shopper.statusLabel)
                        .font(.system(size: shopper.isLive ? 40 : 22, weight: .medium))
                        .tracking(-1)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                    if shopper.isLive {
                        Text("left \(Period.current(shopper.period))")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.soft)
                    }
                }
                .padding(.horizontal, 24)
            }
            .frame(width: 180, height: 180)
            .padding(.vertical, 6)
            Text(shopper.rule)
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func proof(_ shopper: Shopper) -> some View {
        if let ruleId = shopper.ruleId {
            VStack(alignment: .leading, spacing: 0) {
                Text("Proof")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
                    .padding(.bottom, 4)
                ProofRow(label: "Rule on your account", value: "#\(ruleId)")
                if let key = shopper.agentKey { ProofRow(label: "Shopper's own key", value: shortened(key)) }
                if let address = store.account?.address { ProofRow(label: "Account", value: shortened(address)) }
                if let link = store.account?.explorerUrl.flatMap(URL.init(string:)) {
                    Link(destination: link) {
                        Label("View on Stellar", systemImage: "arrow.up.right")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.glow)
                            .frame(minHeight: 40)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel(24)
        }
    }

    @ViewBuilder
    private func history(_ shopper: Shopper) -> some View {
        let items = Array(store.activity(for: shopper).prefix(8))
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("What it's done")
                    .font(.system(size: 18, weight: .semibold))
                ActivityPanel(items: items) { openReceipt = $0 }
            }
        }
    }
}

/// A label and a monospaced value, for the proof sections.
struct ProofRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label).foregroundStyle(Color.soft)
            Spacer(minLength: 12)
            Text(value).font(.system(size: 13, design: .monospaced))
        }
        .font(.system(size: 14))
        .lineLimit(1)
        .frame(height: 36)
    }
}

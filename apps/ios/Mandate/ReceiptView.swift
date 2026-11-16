// The receipt for one purchase, drawn as a pass, or the record of one that was
// blocked, or of money added. The proof section is where the account's own
// record lives: the rule, the shopper's key, and a link to look it up.
import SwiftUI

struct ReceiptView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Activity
    @State private var topHeight: CGFloat = 250
    @State private var showingProof = false

    private var link: URL? { item.explorerUrl.flatMap(URL.init(string:)) }

    private var title: String {
        if item.added { return "Money added" }
        return item.blocked ? "Blocked payment" : "Receipt"
    }

    private var ruleLine: String? {
        guard let id = item.shopper?.id, let shopper = store.shopper(id) else { return nil }
        guard shopper.isActive else { return "Since stopped" }
        return "\(shopper.limitMoney.short) a \(shopper.period), \(shopper.leftMoney.short) left"
    }

    var body: some View {
        ZStack {
            LightField()
            ScrollViewReader { reader in
            ScrollView {
                VStack(spacing: 22) {
                    ZStack {
                        Text(title)
                            .font(.system(size: 16, weight: .medium))
                        HStack {
                            Button { dismiss() } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 16, weight: .medium))
                                    .frame(width: 44, height: 44)
                            }
                            .glassEffect(.regular.interactive(), in: .circle)
                            .accessibilityLabel("Close")
                            Spacer()
                            if !item.blocked, let link {
                                ShareLink(item: link) {
                                    Image(systemName: "square.and.arrow.up")
                                        .font(.system(size: 16, weight: .medium))
                                        .frame(width: 44, height: 44)
                                }
                                .glassEffect(.regular.interactive(), in: .circle)
                                .accessibilityLabel("Share")
                            }
                        }
                    }
                    .frame(height: 44)

                    pass

                    if showingProof { proof.id("proof") }
                }
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 32)
                .animation(.smooth(duration: 0.3), value: showingProof)
            }
            .scrollIndicators(.hidden)
            .onChange(of: showingProof) { _, showing in
                guard showing else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(150))
                    withAnimation(.smooth(duration: 0.4)) { reader.scrollTo("proof", anchor: .bottom) }
                }
            }
            }
        }
    }

    private var pass: some View {
        VStack(spacing: 0) {
            top
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { topHeight = $0 }

            Line()
                .stroke(.white.opacity(0.35), style: StrokeStyle(lineWidth: 2, dash: [6, 6]))
                .frame(height: 2)
                .padding(.horizontal, 28)

            VStack(spacing: 0) {
                if item.added {
                    row("From", "Your bank (demo transfer)")
                    row("To", "Your account")
                } else {
                    row("For", item.item)
                    if item.blocked {
                        row("Tried by", item.shopper?.name ?? "A shopper")
                        row("On behalf of", store.customer?.name ?? "You")
                    } else if item.byYou {
                        row("Paid by", "You")
                        row("Asked by", item.shopper?.name ?? "A shopper")
                    } else {
                        row("Paid by", item.shopper?.name ?? "A shopper")
                        row("Allowed by", store.customer?.name ?? "You")
                    }
                    if !item.blocked, let ruleLine { row("Rule now", ruleLine) }
                }
                if let note = item.note {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "text.quote")
                            .foregroundStyle(Color.glow)
                        Text(note)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .font(.system(size: 14))
                    .padding(12)
                    .background(.white.opacity(0.08), in: .rect(cornerRadius: 14))
                    .padding(.vertical, 8)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 14)
            .padding(.bottom, 8)

            if item.blocked {
                stopped
            } else {
                seal
            }
        }
        .glassEffect(.regular, in: PassShape(notchY: topHeight))
    }

    private var top: some View {
        VStack(spacing: 0) {
            Group {
                if item.added {
                    Image(systemName: "arrow.down.to.line")
                        .font(.system(size: 22, weight: .semibold))
                } else {
                    Text(String(item.storeName.prefix(1)))
                        .font(.system(size: 22, weight: .semibold))
                }
            }
            .foregroundStyle(Color.ink)
            .frame(width: 52, height: 52)
            .background(.white.opacity(0.92), in: .circle)

            Text(item.added ? "Added to your account" : item.storeName)
                .font(.system(size: 17, weight: .medium))
                .padding(.top, 10)
            if let store = item.store {
                Label(store.trusted ? "Trusted store" : "Not a trusted store",
                      systemImage: store.trusted ? "checkmark.shield" : "exclamationmark.shield")
                    .font(.system(size: 13))
                    .foregroundStyle(store.trusted ? Color.trusted : Color.blocked)
                    .padding(.top, 2)
                if !store.trusted, let real = store.looksLike {
                    Text("Looks like \(real), but isn't")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.soft)
                }
            }
            AmountText(money: item.money, size: 58, struck: item.blocked)
                .foregroundStyle(item.blocked ? Color.blocked : .white)
                .padding(.top, 8)
            Text(Dates.long(item.date))
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.top, 24)
        .padding(.bottom, 22)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Color.soft)
            Spacer(minLength: 12)
            Text(value)
        }
        .font(.system(size: 14))
        .lineLimit(1)
        .frame(height: 40)
    }

    private var seal: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle().fill(
                    AngularGradient(
                        colors: [.glow, .shopper(1), .shopper(2), .shopper(4), .trusted, .glow],
                        center: .center,
                        angle: .degrees(40)
                    )
                )
                Circle().fill(Color(red: 18 / 255, green: 20 / 255, blue: 58 / 255)).padding(9)
                Image(systemName: "checkmark")
                    .font(.system(size: 20, weight: .bold))
            }
            .frame(width: 68, height: 68)
            .shadow(color: Color.shopper(1).opacity(0.6), radius: 11)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text("Sealed")
                    .font(.system(size: 15, weight: .medium))
                Text("Nobody can edit or fake this receipt, not even us.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
                    .fixedSize(horizontal: false, vertical: true)
                if item.proof != nil || link != nil {
                    Button(showingProof ? "Hide the proof" : "See the proof") { showingProof.toggle() }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.glow)
                        .frame(minHeight: 30)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.top, 10)
        .padding(.bottom, 20)
    }

    private var stopped: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 24))
                .foregroundStyle(Color.blocked)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.reason ?? "Blocked")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.blocked)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Your account's rules stopped this before anything was sent. Your money didn't move.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 24)
    }

    /// What the account itself checked, and where anyone can look it up.
    private var proof: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Checked by your account")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .padding(.bottom, 8)
            if let checks = item.proof?.checks, !checks.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(checks, id: \.self) { check in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(Color.trusted)
                            Text(check)
                                .font(.system(size: 14))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.bottom, 10)
            } else if item.added {
                Text("A transfer into your account, recorded on the Stellar test network.")
                    .font(.system(size: 14))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 10)
            }
            Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
            if let ruleId = item.proof?.ruleId { ProofRow(label: "Rule", value: "#\(ruleId)") }
            if let key = item.proof?.agentKey { ProofRow(label: "Shopper's key", value: shortened(key)) }
            if let account = item.proof?.smartAccount ?? store.account?.address {
                ProofRow(label: "Account", value: shortened(account))
            }
            if let hash = item.txHash { ProofRow(label: "Transaction", value: shortened(hash)) }
            if let link {
                Link(destination: link) {
                    Label("View on Stellar", systemImage: "arrow.up.right")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Color.glow)
                        .frame(minHeight: 44)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel(24)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}

/// A rounded card with a half-circle bitten out of each side, like a ticket.
struct PassShape: Shape {
    var notchY: CGFloat
    var corner: CGFloat = 32
    var notch: CGFloat = 14

    func path(in rect: CGRect) -> Path {
        let y = rect.minY + min(max(notchY, corner + notch), rect.height - corner - notch)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + corner, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - corner, y: rect.minY))
        path.addArc(center: CGPoint(x: rect.maxX - corner, y: rect.minY + corner), radius: corner,
                    startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        path.addLine(to: CGPoint(x: rect.maxX, y: y - notch))
        path.addArc(center: CGPoint(x: rect.maxX, y: y), radius: notch,
                    startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: true)
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - corner))
        path.addArc(center: CGPoint(x: rect.maxX - corner, y: rect.maxY - corner), radius: corner,
                    startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        path.addLine(to: CGPoint(x: rect.minX + corner, y: rect.maxY))
        path.addArc(center: CGPoint(x: rect.minX + corner, y: rect.maxY - corner), radius: corner,
                    startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        path.addLine(to: CGPoint(x: rect.minX, y: y + notch))
        path.addArc(center: CGPoint(x: rect.minX, y: y), radius: notch,
                    startAngle: .degrees(90), endAngle: .degrees(-90), clockwise: true)
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + corner))
        path.addArc(center: CGPoint(x: rect.minX + corner, y: rect.minY + corner), radius: corner,
                    startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        path.closeSubpath()
        return path
    }
}

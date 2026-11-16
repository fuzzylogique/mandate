// The receipt for one purchase, drawn as a pass, or the record of one that was blocked.
import SwiftUI

struct ReceiptView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Activity
    @State private var topHeight: CGFloat = 250

    private var proof: URL? {
        item.txHash.flatMap { URL(string: "https://stellar.expert/explorer/testnet/tx/\($0)") }
    }

    private var ruleLine: String {
        guard let shopper = store.shopper(item.agent.ruleId), shopper.isActive,
              let limit = shopper.limitMoney, let left = shopper.leftMoney
        else { return "Since stopped" }
        return "\(limit.short) a \(shopper.period ?? "day"), \(left.short) left"
    }

    var body: some View {
        ZStack {
            LightField()
            ScrollView {
                VStack(spacing: 22) {
                    ZStack {
                        Text(item.blocked ? "Blocked payment" : "Receipt")
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
                            if !item.blocked, let proof {
                                ShareLink(item: proof) {
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
                }
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
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
                row("For", item.item)
                row(item.blocked ? "Tried by" : "Paid by", item.agent.name)
                row(item.blocked ? "On behalf of" : "Allowed by", store.overview?.owner.name ?? "You")
                row("Under the rule", ruleLine)
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
            Text(String(item.seller.name.prefix(1)))
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Color.ink)
                .frame(width: 52, height: 52)
                .background(.white.opacity(0.92), in: .circle)
            Text(item.seller.name)
                .font(.system(size: 17, weight: .medium))
                .padding(.top, 10)
            Label(item.seller.verified ? "Trusted store" : "Not a trusted store",
                  systemImage: item.seller.verified ? "checkmark.shield" : "exclamationmark.shield")
                .font(.system(size: 13))
                .foregroundStyle(item.seller.verified ? Color.trusted : Color.blocked)
                .padding(.top, 2)
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
                if let proof {
                    Link("See the proof", destination: proof)
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

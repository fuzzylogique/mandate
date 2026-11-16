// The look: coloured light behind glass, and the few pieces every screen shares.
import SwiftUI

extension Color {
    static let night = Color(red: 7 / 255, green: 8 / 255, blue: 24 / 255)
    static let ink = Color(red: 11 / 255, green: 12 / 255, blue: 34 / 255)
    static let glow = Color(red: 125 / 255, green: 249 / 255, blue: 1)
    static let blocked = Color(red: 1, green: 179 / 255, blue: 166 / 255)
    static let trusted = Color(red: 141 / 255, green: 252 / 255, blue: 192 / 255)
    static let soft = Color.white.opacity(0.74)

    /// Each mandate keeps its own colour.
    static func mandate(_ id: Int) -> Color {
        let colors: [Color] = [
            .glow,
            Color(red: 185 / 255, green: 166 / 255, blue: 1),
            Color(red: 1, green: 159 / 255, blue: 208 / 255),
            .trusted,
            Color(red: 1, green: 224 / 255, blue: 138 / 255),
        ]
        return colors[abs(id) % colors.count]
    }
}

/// The background of every screen: three fields of coloured light on near-black.
struct LightField: View {
    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            ZStack {
                Color.night
                light(Color(red: 98 / 255, green: 76 / 255, blue: 1), 0.82, x: 0.06, y: 0.04, radius: 270, in: size)
                light(Color(red: 0, green: 150 / 255, blue: 230 / 255), 0.6, x: 1.04, y: 0.36, radius: 240, in: size)
                light(Color(red: 230 / 255, green: 40 / 255, blue: 130 / 255), 0.6, x: 0.26, y: 1.04, radius: 290, in: size)
            }
        }
        .ignoresSafeArea()
    }

    private func light(_ color: Color, _ strength: Double, x: Double, y: Double, radius: CGFloat, in size: CGSize) -> some View {
        RadialGradient(
            colors: [color.opacity(strength), color.opacity(0)],
            center: UnitPoint(x: x, y: y),
            startRadius: 0,
            endRadius: radius
        )
    }
}

/// A scrolling screen on the light field.
struct Screen<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ZStack {
            LightField()
            ScrollView {
                content
                    .padding(.horizontal, 20)
                    .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
        }
    }
}

extension View {
    /// A frosted glass panel with rounded corners.
    func glassPanel(_ radius: CGFloat = 28) -> some View {
        glassEffect(.regular, in: .rect(cornerRadius: radius))
    }
}

/// The main action on a screen: a near-white lens with dark text.
struct LensButtonStyle: ButtonStyle {
    var height: CGFloat = 58

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(Color.ink)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(.white.opacity(0.92), in: .capsule)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}

/// How much of a limit is left, as a ring.
struct Ring: View {
    let share: Double
    let color: Color
    var width: CGFloat = 6

    var body: some View {
        ZStack {
            Circle().stroke(.white.opacity(0.18), lineWidth: width)
            Circle()
                .trim(from: 0, to: max(0.001, min(1, share)))
                .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.smooth(duration: 0.6), value: share)
        }
    }
}

/// A large amount with smaller, quieter cents.
struct AmountText: View {
    let money: Money
    var size: CGFloat = 62
    var struck = false

    var body: some View {
        let parts = money.parts
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(parts.whole)
                .font(.system(size: size, weight: .medium))
                .tracking(-size * 0.04)
            Text(parts.cents)
                .font(.system(size: size * 0.58, weight: .medium))
                .foregroundStyle(Color.soft)
            if !parts.suffix.isEmpty {
                Text(" \(parts.suffix)")
                    .font(.system(size: size * 0.3, weight: .medium))
                    .foregroundStyle(Color.soft)
            }
        }
        .strikethrough(struck)
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(money.text)
    }
}

/// The wordmark: a ring and the name.
struct Wordmark: View {
    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .strokeBorder(.white, lineWidth: 3)
                .frame(width: 18, height: 18)
            Text("mandate")
                .font(.system(size: 18, weight: .semibold))
                .tracking(-0.3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Mandate")
    }
}

/// One line in a list of activity.
struct ActivityRow: View {
    let item: Activity

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.blocked ? "Blocked: \(item.seller.name)" : item.seller.name)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(item.blocked ? Color.blocked : .white)
                Text(item.blocked ? "\(item.reason ?? "Nothing was paid"), \(Dates.short(item.date))" : "\(item.agent.name), \(Dates.short(item.date))")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.soft)
            }
            Spacer(minLength: 8)
            Text(item.money.text)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(item.blocked ? Color.blocked : .white)
                .strikethrough(item.blocked)
        }
        .lineLimit(1)
        .frame(minHeight: 60)
        .contentShape(.rect)
    }
}

/// A glass panel listing activity, each line opening its receipt.
struct ActivityPanel: View {
    let items: [Activity]
    let open: (Activity) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                Button { open(item) } label: { ActivityRow(item: item) }
                    .buttonStyle(.plain)
                if index < items.count - 1 {
                    Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 4)
        .glassPanel()
    }
}

/// Lays words out left to right, wrapping like text.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: proposal.width ?? result.width, height: result.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, point) in result.points.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                proposal: .unspecified
            )
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (points: [CGPoint], width: CGFloat, height: CGFloat) {
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        var points: [CGPoint] = []
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + lineSpacing
                rowHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (points, widest, y + rowHeight)
    }
}

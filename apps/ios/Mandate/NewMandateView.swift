// Adding a mandate: write the rule as one sentence, then slide and confirm it's you.
import LocalAuthentication
import SwiftUI

struct NewMandateView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    enum Field: Hashable { case name, amount, period, stores, agent }
    enum Stage: Equatable { case editing, confirming, saving, done }

    @State private var requestId = UUID().uuidString
    @State private var expiresAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(30 * 86400))
    @State private var active: Field = .name
    @State private var name = ""
    @State private var amount = "50"
    @State private var typingAmount = false
    @State private var period = "week"
    /// nil lets any agent registered to the account use it.
    @State private var agentId: String?
    @State private var created: Mandate?
    @State private var stage: Stage = .editing
    @State private var slid = false
    @State private var problem: String?
    @FocusState private var focus: Field?

    private let quickAmounts = ["25", "50", "100", "200"]
    private let quickNames = ["Produce", "Packaging", "Deliveries", "Supplies"]

    private var token: TokenInfo { store.token ?? TokenInfo(id: "", symbol: "USDC") }

    private var chosenAgent: AccountAgent? { store.eligibleAgents.first { $0.id == agentId } }

    private var agentLabel: String {
        guard let chosenAgent else { return "any agent" }
        return chosenAgent.name.count > 18 ? "\(chosenAgent.name.prefix(17))…" : chosenAgent.name
    }

    private func ownKeyLine(_ agent: AccountAgent) -> String {
        "Only \(agent.name)'s own key will be able to sign for this mandate. There is no secret ID, and the seller list is enforced on chain."
    }

    private var amountLabel: String {
        guard let value = Decimal(string: amount), value > 0 else { return "an amount" }
        return Money(value: value, token: token).short
    }

    var body: some View {
        if stage == .done, let created {
            CreatedForAgentView(mandate: created, agentName: store.agent(created.agentId)?.name ?? chosenAgent?.name ?? "the agent") { dismiss() }
        } else {
            editing
        }
    }

    private var editing: some View {
        ZStack {
            LightField()
                .onTapGesture { focus = nil }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    topBar

                    Text("Tap any word to change it")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                        .padding(.top, 24)

                    sentence
                        .padding(.top, 12)

                    editor
                        .padding(.top, 16)
                        .animation(.snappy(duration: 0.2), value: active)

                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "checkmark.shield")
                            .font(.system(size: 20))
                            .foregroundStyle(Color.glow)
                        Text("Anything over the limit, or at a store that isn't trusted, is stopped before any money moves.")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.soft)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 24)

                    if let chosenAgent, chosenAgent.isConnected {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: "key")
                                .font(.system(size: 20))
                                .foregroundStyle(Color.glow)
                            Text(ownKeyLine(chosenAgent))
                                .font(.system(size: 14))
                                .foregroundStyle(Color.soft)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 14)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .safeAreaInset(edge: .bottom) { footer }
        .interactiveDismissDisabled(stage != .editing)
        .onChange(of: name) { _, _ in requestId = UUID().uuidString }
        .onChange(of: amount) { _, _ in requestId = UUID().uuidString }
        .onChange(of: period) { _, _ in requestId = UUID().uuidString }
        .onChange(of: agentId) { _, _ in requestId = UUID().uuidString }
    }

    private var topBar: some View {
        ZStack {
            Text("New mandate")
                .font(.system(size: 16, weight: .medium))
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("Close")
                .disabled(stage != .editing)
                Spacer()
            }
        }
        .frame(height: 44)
        .padding(.top, 8)
    }

    // MARK: The sentence

    private var sentence: some View {
        FlowLayout(spacing: 8, lineSpacing: 8) {
            word("Let")
            blank(.name, name.isEmpty ? "a mandate" : name, empty: name.isEmpty)
            word("spend")
            word("up")
            word("to")
            blank(.amount, amountLabel, empty: amountLabel == "an amount")
            word("every")
            blank(.period, period)
            word("at")
            blank(.stores, "trusted stores")
            word("only.")
            word("Used")
            word("by")
            blank(.agent, agentLabel, empty: chosenAgent == nil)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel(32)
    }

    private func word(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 27, weight: .regular))
            .frame(height: 44)
    }

    private func blank(_ field: Field, _ text: String, empty: Bool = false) -> some View {
        let isActive = active == field
        return Button {
            active = field
            focus = field == .name ? .name : nil
            problem = nil
        } label: {
            Text(text)
                .font(.system(size: 27, weight: .medium))
                .foregroundStyle(empty ? Color.soft : .white)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .frame(height: 44)
                .background(isActive ? Color.glow.opacity(0.22) : .white.opacity(0.16), in: .rect(cornerRadius: 14))
                .overlay {
                    RoundedRectangle(cornerRadius: 14)
                        .strokeBorder(isActive ? Color.glow : .white.opacity(0.3), lineWidth: isActive ? 1.5 : 1)
                }
                .shadow(color: isActive ? Color.glow.opacity(0.45) : .clear, radius: 9)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Changes this part of the rule")
    }

    // MARK: Editing the active word

    @ViewBuilder
    private var editor: some View {
        switch active {
        case .name:
            VStack(spacing: 10) {
                TextField("Name it, like Produce", text: $name)
                    .focused($focus, equals: .name)
                    .submitLabel(.done)
                    .autocorrectionDisabled()
                    .font(.system(size: 17, weight: .medium))
                    .padding(.horizontal, 22)
                    .frame(height: 56)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .onChange(of: name) { _, next in
                        if next.utf8.count > 20 { name = String(next.prefix(20)) }
                    }
                    .onSubmit { active = .amount }
                chips(quickNames, selected: name) { name = $0 }
            }
        case .amount:
            VStack(spacing: 10) {
                chips(quickAmounts.map { Money(value: Decimal(string: $0) ?? 0, token: token).short } + ["Other"],
                      selected: typingAmount ? "Other" : amountLabel) { label in
                    if label == "Other" {
                        typingAmount = true
                        focus = .amount
                    } else if let index = quickAmounts.firstIndex(where: { Money(value: Decimal(string: $0) ?? 0, token: token).short == label }) {
                        typingAmount = false
                        focus = nil
                        amount = quickAmounts[index]
                    }
                }
                if typingAmount {
                    TextField("Amount", text: $amount)
                        .focused($focus, equals: .amount)
                        .keyboardType(.decimalPad)
                        .font(.system(size: 17, weight: .medium))
                        .padding(.horizontal, 22)
                        .frame(height: 56)
                        .glassEffect(.regular.interactive(), in: .capsule)
                }
            }
        case .period:
            chips(["day", "week", "month"], selected: period) { period = $0 }
        case .stores:
            Text("Mandates can only pay stores that have been checked. A look-alike store is refused, even if the name is one letter off.")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel(24)
        case .agent:
            agentPicker
        }
    }

    private var agentPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(spacing: 0) {
                agentRow(nil, "Any registered agent", detail: "Uses its identification and a secret mandate ID")
                ForEach(store.eligibleAgents) { agent in
                    Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
                    agentRow(agent.id, agent.isConnected ? "\(agent.name) · own key" : agent.name,
                             detail: agent.isConnected ? agent.shortKey.map { "Signs with \($0)" } : "Uses its identification and a secret mandate ID")
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 2)
            .glassPanel(24)

            Text(chosenAgent?.isConnected == true
                 ? "The agent can only pay verified sellers, within this limit, until the mandate expires."
                 : "Without an agent that holds its own key, any agent registered to your account can use the mandate with its identification value and the secret mandate ID.")
                .font(.system(size: 13))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)
            if store.agents.contains(where: \.isWaiting) {
                Text("Agents still waiting to connect can't be chosen yet.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
            }
        }
    }

    private func agentRow(_ id: String?, _ title: String, detail: String?) -> some View {
        let selected = agentId == id
        return Button {
            agentId = id
            problem = nil
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 16, weight: .medium))
                        .lineLimit(1)
                    if let detail {
                        Text(detail)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.soft)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.glow)
                }
            }
            .frame(minHeight: 60)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func chips(_ options: [String], selected: String, pick: @escaping (String) -> Void) -> some View {
        HStack(spacing: 8) {
            ForEach(options, id: \.self) { option in
                let isSelected = option == selected
                Button { pick(option) } label: {
                    Text(option)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(isSelected ? Color.ink : .white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .padding(.horizontal, 4)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                }
                .buttonStyle(.plain)
                .background {
                    if isSelected { Capsule().fill(.white.opacity(0.92)) }
                }
                .glassEffect(isSelected ? .identity : .regular.interactive(), in: .capsule)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
    }

    // MARK: Handing it over

    private var footer: some View {
        VStack(spacing: 12) {
            if let problem {
                Text(problem)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.blocked)
                    .multilineTextAlignment(.center)
            }
            if stage == .saving {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Setting up… about ten seconds")
                        .font(.system(size: 16, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 64)
                .glassEffect(.regular, in: .capsule)
            } else {
                SlideToConfirm(label: "Slide to hand it over", done: $slid) {
                    Task { await handOver() }
                }
            }
            Text("You can stop a mandate at any time.")
                .font(.system(size: 13))
                .foregroundStyle(Color.soft)
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    private func refuse(_ message: String, _ field: Field?) {
        problem = message
        if let field { active = field }
        stage = .editing
        slid = false
    }

    private func handOver() async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return refuse("Give your mandate a name", .name) }
        guard amount.range(of: #"^\d+(\.\d{1,7})?$"#, options: .regularExpression) != nil,
              let value = Decimal(string: amount), value > 0
        else { return refuse("Enter a limit greater than zero", .amount) }
        if agentId != nil, chosenAgent == nil {
            return refuse("That agent can't be given a mandate any more. Choose another.", .agent)
        }
        let ownKey = chosenAgent?.isConnected == true

        focus = nil
        problem = nil
        stage = .confirming
        guard await Owner.confirm("Confirm it's you to let \(trimmed) spend from your account.") else {
            return refuse("That wasn't confirmed, so nothing was set up.", nil)
        }

        stage = .saving
        do {
            let mandate = try await store.create(name: trimmed, limit: amount, period: period, agentId: agentId, expiresAt: expiresAt, requestId: requestId)
            if ownKey || mandate.signedByAgentKey {
                created = mandate
                stage = .done
            } else {
                dismiss()
            }
        } catch {
            refuse(error.localizedDescription, nil)
        }
    }
}

/// After giving a mandate to an agent that holds its own key: there is nothing secret to pass on.
private struct CreatedForAgentView: View {
    let mandate: Mandate
    let agentName: String
    let done: () -> Void

    var body: some View {
        ZStack {
            LightField()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Image(systemName: "checkmark.shield.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(Color.trusted)
                        .padding(.top, 60)
                    Text("\(mandate.name) is ready")
                        .font(.system(size: 30, weight: .semibold))
                        .tracking(-0.8)
                    Text(mandate.rule)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.soft)
                    VStack(alignment: .leading, spacing: 14) {
                        point("key", "Signed only by \(agentName)'s own key. No secret ID.")
                        point("person.badge.shield.checkmark", "There's no mandate ID to share. \(agentName) can already use it.")
                        point("checkmark.shield", "Its seller list is enforced on chain, and it can't raise the limit.")
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassPanel()
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge: .bottom) {
            Button("Done", action: done)
                .buttonStyle(LensButtonStyle())
                .padding(.horizontal, 20)
                .padding(.bottom, 10)
        }
    }

    private func point(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(Color.glow)
                .frame(width: 24)
            Text(text)
                .font(.system(size: 14))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Checks that the person holding the phone is its owner: Face ID, or the passcode.
enum Owner {
    static func confirm(_ reason: String) async -> Bool {
        let context = LAContext()
        var unavailable: NSError?
        // A phone with no passcode has nothing to check against (the simulator, by default).
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unavailable) else { return true }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}

/// A track with a knob to drag across. Releasing early springs it back.
struct SlideToConfirm: View {
    let label: String
    @Binding var done: Bool
    let action: () -> Void

    @State private var drag: CGFloat = 0
    private let knob: CGFloat = 56
    private let inset: CGFloat = 4

    var body: some View {
        GeometryReader { proxy in
            let travel = max(1, proxy.size.width - knob - inset * 2)
            let offset = done ? travel : drag
            ZStack(alignment: .leading) {
                Text(label)
                    .font(.system(size: 16, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.leading, knob)
                    .opacity(1 - min(1, Double(offset / travel) * 1.6))

                Circle()
                    .fill(.white.opacity(0.92))
                    .frame(width: knob, height: knob)
                    .overlay {
                        Image(systemName: done ? "checkmark" : "arrow.right")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(Color.ink)
                    }
                    .offset(x: inset + offset)
                    .gesture(
                        DragGesture()
                            .onChanged { value in
                                guard !done else { return }
                                drag = min(max(0, value.translation.width), travel)
                            }
                            .onEnded { _ in
                                guard !done else { return }
                                if drag > travel * 0.85 {
                                    complete()
                                } else {
                                    withAnimation(.spring(duration: 0.35)) { drag = 0 }
                                }
                            }
                    )
            }
            .frame(height: proxy.size.height)
        }
        .frame(height: 64)
        .glassEffect(.regular, in: .capsule)
        .onChange(of: done) { _, isDone in
            if !isDone { withAnimation(.spring(duration: 0.4)) { drag = 0 } }
        }
        .sensoryFeedback(.impact, trigger: done)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { complete() }
    }

    private func complete() {
        guard !done else { return }
        withAnimation(.snappy(duration: 0.2)) { done = true }
        action()
    }
}

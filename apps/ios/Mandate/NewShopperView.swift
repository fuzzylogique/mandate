// Adding a shopper: choose who shops, write the rule as one sentence, then slide and confirm it's you.
import LocalAuthentication
import SwiftUI

struct NewShopperView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    enum Kind: String { case hosted, assistant, person }
    enum Field: Hashable { case who, amount, period, ends, stores }
    enum Stage: Equatable { case choosing, editing, confirming, saving, connecting }

    @State private var kind: Kind = .hosted
    @State private var stage: Stage = .choosing
    @State private var active: Field = .who
    @State private var item = "herbs"
    @State private var assistant = "Claude"
    @State private var email = ""
    @State private var amount = "10"
    @State private var typingAmount = false
    @State private var period = "week"
    @State private var months = 3
    @State private var slid = false
    @State private var problem: String?
    @State private var created: Shopper?
    @FocusState private var focus: Field?

    private let quickAmounts = ["10", "20", "25", "50"]
    private let quickItems = ["herbs", "basil", "olive oil", "napkins"]
    private let quickAssistants = ["Claude", "ChatGPT", "Gemini"]
    private let quickEnds = [1, 3, 12]

    private var amountLabel: String {
        guard let value = Decimal(string: amount), value > 0 else { return "an amount" }
        return Money(value: value).short
    }

    private var endDate: Date {
        Calendar.current.date(byAdding: .month, value: months, to: .now) ?? .now
    }

    private func endsLabel(_ months: Int) -> String {
        switch months {
        case 1: "1 month"
        case 12: "1 year"
        default: "\(months) months"
        }
    }

    var body: some View {
        ZStack {
            LightField()
                .onTapGesture { focus = nil }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    topBar
                    switch stage {
                    case .choosing: chooser
                    case .connecting: connecting
                    default: rule
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .safeAreaInset(edge: .bottom) {
            if stage != .choosing && stage != .connecting && focus == nil { footer }
        }
        .interactiveDismissDisabled(stage == .confirming || stage == .saving)
        .animation(.smooth(duration: 0.3), value: stage)
    }

    private var topBar: some View {
        ZStack {
            Text(stage == .connecting ? "Connect \(assistant)" : "New shopper")
                .font(.system(size: 16, weight: .medium))
            HStack {
                Button {
                    if stage == .editing { stage = .choosing; problem = nil } else { dismiss() }
                } label: {
                    Image(systemName: stage == .editing ? "chevron.left" : "xmark")
                        .font(.system(size: 16, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel(stage == .editing ? "Back" : "Close")
                .disabled(stage == .confirming || stage == .saving)
                Spacer()
            }
        }
        .frame(height: 44)
        .padding(.top, 8)
    }

    // MARK: Who shops

    private var chooser: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Who does the shopping?")
                .font(.system(size: 30, weight: .semibold))
                .tracking(-0.8)
                .padding(.top, 24)
                .padding(.bottom, 8)
            option(.hosted, icon: "cart", title: "Mandate shops for you",
                   detail: "Give it a standing job, like keeping herbs stocked. It compares trusted stores and buys from the cheapest.")
            option(.assistant, icon: "text.bubble", title: "Your AI assistant",
                   detail: "An assistant you already use, like Claude, connects with a one-time code and shops within your rules.")
            option(.person, icon: "person.2", title: "Someone you trust",
                   detail: "Share spending with someone by email. They sign in to Mandate and buy, never more than you allow.")
        }
    }

    private func option(_ choice: Kind, icon: String, title: String, detail: String) -> some View {
        Button {
            kind = choice
            switch choice {
            case .hosted: amount = "10"
            case .assistant: amount = "20"
            case .person: amount = "25"
            }
            typingAmount = false
            active = .who
            problem = nil
            stage = .editing
            if choice == .person { focus = .who }
        } label: {
            HStack(alignment: .top, spacing: 16) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color.ink)
                    .frame(width: 48, height: 48)
                    .background(.white.opacity(0.92), in: .circle)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 18, weight: .semibold))
                    Text(detail)
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.soft)
                    .padding(.top, 16)
            }
            .padding(18)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 28))
    }

    // MARK: The sentence

    private var rule: some View {
        VStack(alignment: .leading, spacing: 0) {
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
                Text(promise)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 24)
        }
    }

    private var promise: String {
        switch kind {
        case .hosted: "It shops on its own and buys from the cheapest trusted store. Anything over the limit, or at a store that isn't trusted, is stopped before any money moves, and you're asked."
        case .assistant: "You'll get a one-time code to give \(assistant). Your account checks every payment it makes, so it can't go over the limit or pay a look-alike store."
        case .person: "They sign in with this email to buy. Your account checks every payment, so they can't go over the limit or pay a look-alike store."
        }
    }

    private var whoLabel: String {
        switch kind {
        case .hosted: item.isEmpty ? "something" : item
        case .assistant: assistant.isEmpty ? "Your assistant" : assistant
        case .person: email.isEmpty ? "Their email" : email
        }
    }

    private var sentence: some View {
        FlowLayout(spacing: 8, lineSpacing: 8) {
            switch kind {
            case .hosted:
                word("Keep")
                blank(.who, whoLabel, empty: item.isEmpty)
                word("stocked,")
                word("up")
                word("to")
            case .assistant, .person:
                blank(.who, whoLabel, empty: kind == .person ? email.isEmpty : assistant.isEmpty)
                word("can")
                word("spend")
                word("up")
                word("to")
            }
            blank(.amount, amountLabel, empty: amountLabel == "an amount")
            word("a")
            blank(.period, period)
            word("at")
            blank(.stores, "trusted stores,")
            word("for")
            blank(.ends, endsLabel(months))
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
            focus = field == .who && kind != .assistant ? .who : nil
            problem = nil
        } label: {
            Text(text)
                .font(.system(size: 27, weight: .medium))
                .foregroundStyle(empty ? Color.soft : .white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
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
        case .who:
            switch kind {
            case .hosted:
                VStack(spacing: 10) {
                    input("What to keep stocked, like herbs", text: $item, limit: 40)
                    chips(quickItems, selected: item) { item = $0 }
                }
            case .assistant:
                VStack(spacing: 10) {
                    chips(quickAssistants, selected: assistant) { assistant = $0 }
                    input("Or type its name", text: $assistant, limit: 30)
                }
            case .person:
                input("Their email", text: $email, limit: 254)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .textContentType(.emailAddress)
            }
        case .amount:
            VStack(spacing: 10) {
                chips(quickAmounts.map { Money($0).short } + ["Other"],
                      selected: typingAmount ? "Other" : amountLabel) { label in
                    if label == "Other" {
                        typingAmount = true
                        focus = .amount
                    } else if let index = quickAmounts.firstIndex(where: { Money($0).short == label }) {
                        typingAmount = false
                        focus = nil
                        amount = quickAmounts[index]
                    }
                }
                if typingAmount {
                    TextField("Amount in dollars", text: $amount)
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
        case .ends:
            VStack(spacing: 10) {
                chips(quickEnds.map(endsLabel), selected: endsLabel(months)) { label in
                    months = quickEnds.first { endsLabel($0) == label } ?? 3
                }
                Text("Ends on \(endDate.formatted(.dateTime.month(.wide).day().year())). After that it can't spend.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
            }
        case .stores:
            Text("Shoppers can only pay stores that have been checked. A look-alike store is refused, even if the name is one letter off.")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel(24)
        }
    }

    private func input(_ prompt: String, text: Binding<String>, limit: Int) -> some View {
        TextField(prompt, text: text)
            .focused($focus, equals: .who)
            .submitLabel(.done)
            .autocorrectionDisabled()
            .font(.system(size: 17, weight: .medium))
            .padding(.horizontal, 22)
            .frame(height: 56)
            .glassEffect(.regular.interactive(), in: .capsule)
            .onChange(of: text.wrappedValue) { _, next in
                if next.count > limit { text.wrappedValue = String(next.prefix(limit)) }
            }
            .onSubmit { active = .amount }
    }

    private func chips(_ options: [String], selected: String, pick: @escaping (String) -> Void) -> some View {
        HStack(spacing: 8) {
            ForEach(options, id: \.self) { option in
                let isSelected = option.lowercased() == selected.lowercased()
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
                    Text(kind == .assistant ? "Making a code…" : "Setting up… about ten seconds")
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
            Text("You can stop a shopper at any time.")
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
        let trimmedItem = item.trimmingCharacters(in: .whitespaces)
        let trimmedAssistant = assistant.trimmingCharacters(in: .whitespaces)
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces).lowercased()
        let name: String
        switch kind {
        case .hosted:
            guard !trimmedItem.isEmpty else { return refuse("Say what to keep stocked", .who) }
            name = trimmedItem.prefix(1).uppercased() + trimmedItem.dropFirst()
        case .assistant:
            guard !trimmedAssistant.isEmpty else { return refuse("Name the assistant", .who) }
            name = trimmedAssistant
        case .person:
            guard trimmedEmail.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
            else { return refuse("Enter their email address", .who) }
            let local = trimmedEmail.split(separator: "@").first.map(String.init) ?? trimmedEmail
            name = String((local.prefix(1).uppercased() + local.dropFirst()).prefix(40))
        }
        guard amount.range(of: #"^\d+(\.\d{1,2})?$"#, options: .regularExpression) != nil,
              let value = Decimal(string: amount), value > 0
        else { return refuse("Enter a limit greater than zero", .amount) }

        focus = nil
        problem = nil
        stage = .confirming
        let who = kind == .hosted ? "a shopper keep \(trimmedItem) stocked" : "\(name) spend from your account"
        guard await Owner.confirm("Confirm it's you to let \(who).") else {
            return refuse("That wasn't confirmed, so nothing was set up.", nil)
        }

        stage = .saving
        let input = API.NewShopper(
            name: name,
            kind: kind.rawValue,
            limit: amount,
            period: period,
            expiresAt: Dates.iso(endDate),
            job: kind == .hosted ? .init(item: trimmedItem, every: period, startNow: true) : nil,
            holder: kind == .person ? trimmedEmail : nil,
            requestId: UUID().uuidString
        )
        do {
            let shopper = try await store.create(input)
            if shopper.isWaiting {
                created = shopper
                stage = .connecting
            } else {
                if shopper.isHosted {
                    store.show(Banner(blocked: false, title: "\(shopper.name) is set up", detail: "It will shop in about half a minute"))
                }
                dismiss()
            }
        } catch {
            refuse(error.localizedDescription, nil)
        }
    }

    // MARK: Connecting an assistant

    private var connecting: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("One last step")
                .font(.system(size: 30, weight: .semibold))
                .tracking(-0.8)
                .padding(.top, 24)
            Text("\(assistant) can spend up to \(amountLabel) a \(period) at trusted stores, once it connects. Give it this one-time code.")
                .font(.system(size: 16))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)
            if let shopper = created.flatMap({ store.shopper($0.id) }) ?? created {
                PairingPanel(shopper: shopper)
                    .glassPanel()
            }
            Button("Done") { dismiss() }
                .buttonStyle(LensButtonStyle())
                .padding(.top, 8)
            Text("The code stays on the Shoppers tab until \(assistant) connects.")
                .font(.system(size: 13))
                .foregroundStyle(Color.soft)
                .frame(maxWidth: .infinity)
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

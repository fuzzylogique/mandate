// Signing in, and the first steps after: open the account, then add money.
import SwiftUI

struct SignInView: View {
    @Environment(AppStore.self) private var store

    enum Mode { case signIn, create }
    enum Field: Hashable { case name, email, password, address }

    @State private var mode: Mode = .signIn
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var showingAddress = false
    @State private var address = ""
    @FocusState private var focus: Field?

    var body: some View {
        ZStack {
            LightField()
                .onTapGesture { focus = nil }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Wordmark()
                        .frame(height: 44)
                        .padding(.top, 8)

                    Text(mode == .signIn ? "Welcome back" : "Let shoppers handle the buying")
                        .font(.system(size: 34, weight: .semibold))
                        .tracking(-1)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 48)
                    Text(mode == .signIn
                         ? "Sign in to see what your shoppers bought and what needs you."
                         : "Set a limit, pick trusted stores, and your account enforces it. You only step in for the exceptions.")
                        .font(.system(size: 16))
                        .foregroundStyle(Color.soft)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 10)

                    form
                        .padding(.top, 32)

                    if let problem = problem ?? store.problem {
                        Text(problem)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.blocked)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 14)
                            .padding(.horizontal, 6)
                    }

                    Button {
                        Task { await submit() }
                    } label: {
                        if busy {
                            ProgressView().tint(Color.ink)
                        } else {
                            Text(mode == .signIn ? "Sign in" : "Create account")
                        }
                    }
                    .buttonStyle(LensButtonStyle())
                    .disabled(busy)
                    .padding(.top, 22)

                    Button {
                        withAnimation(.snappy(duration: 0.25)) {
                            mode = mode == .signIn ? .create : .signIn
                            problem = nil
                        }
                    } label: {
                        Text(mode == .signIn ? "New here? Create an account" : "Already have an account? Sign in")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Color.glow)
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 44)
                    }
                    .padding(.top, 8)

                    connection
                        .padding(.top, 40)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear { address = store.serviceAddress }
    }

    private var form: some View {
        VStack(spacing: 0) {
            if mode == .create {
                field("Your name or business", text: $name, field: .name)
                    .textContentType(.name)
                    .textInputAutocapitalization(.words)
                divider
            }
            field("Email", text: $email, field: .email)
                .textContentType(mode == .create ? .emailAddress : .username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
            divider
            SecureField(mode == .create ? "Password, at least 12 characters" : "Password", text: $password)
                .focused($focus, equals: .password)
                // No strong-password sheet while creating: it covers the form mid-demo.
                .textContentType(mode == .create ? nil : .password)
                .submitLabel(.go)
                .onSubmit { Task { await submit() } }
                .font(.system(size: 17))
                .frame(height: 58)
        }
        .autocorrectionDisabled()
        .padding(.horizontal, 20)
        .glassPanel(28)
    }

    private func field(_ prompt: String, text: Binding<String>, field: Field) -> some View {
        TextField(prompt, text: text)
            .focused($focus, equals: field)
            .submitLabel(.next)
            .onSubmit { focus = field == .name ? .email : .password }
            .font(.system(size: 17))
            .frame(height: 58)
    }

    private var divider: some View {
        Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
    }

    /// Where the app finds the Mandate service. On a real phone this is the Mac's address.
    private var connection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { showingAddress.toggle() }
            } label: {
                Label("Service address", systemImage: showingAddress ? "chevron.down" : "chevron.right")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
                    .frame(minHeight: 32)
            }
            if showingAddress {
                TextField(AppStore.defaultAddress, text: $address)
                    .focused($focus, equals: .address)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .font(.system(size: 15, design: .monospaced))
                    .padding(.horizontal, 20)
                    .frame(height: 52)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .onSubmit(saveAddress)
                    .onChange(of: focus) { _, next in if next != .address { saveAddress() } }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func saveAddress() {
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != store.serviceAddress else { return }
        store.serviceAddress = trimmed
        store.problem = nil
    }

    private func submit() async {
        focus = nil
        problem = nil
        store.problem = nil
        saveAddress()
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces).lowercased()
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        guard trimmedEmail.contains("@") else { problem = "Enter your email address"; return }
        if mode == .create {
            guard !trimmedName.isEmpty else { problem = "Enter your name"; return }
            guard password.count >= 12 else { problem = "Use a password of at least 12 characters"; return }
        } else {
            guard !password.isEmpty else { problem = "Enter your password"; return }
        }
        busy = true
        do {
            if mode == .create {
                try await store.register(name: trimmedName, email: trimmedEmail, password: password)
            } else {
                try await store.login(email: trimmedEmail, password: password)
            }
            password = ""
        } catch {
            problem = error.localizedDescription
        }
        busy = false
    }
}

/// First run: open the account, then put some money in it.
struct SetupView: View {
    @Environment(AppStore.self) private var store

    enum Step { case open, money }

    @State private var step: Step = .open
    @State private var busy = false
    @State private var problem: String?
    @State private var amount = "50"

    private let amounts = ["25", "50", "100", "200"]

    var body: some View {
        ZStack {
            LightField()
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Wordmark()
                    Spacer()
                    Text(step == .open ? "Step 1 of 2" : "Step 2 of 2")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.soft)
                }
                .frame(height: 44)
                .padding(.top, 8)

                Spacer(minLength: 20)

                if step == .open { openStep } else { moneyStep }

                Spacer(minLength: 20)

                footer
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
        .onAppear { if store.hasAccount { step = .money } }
    }

    private var openStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image(systemName: "building.columns")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(Color.ink)
                .frame(width: 72, height: 72)
                .background(.white.opacity(0.92), in: .circle)
            Text("Open your account")
                .font(.system(size: 34, weight: .semibold))
                .tracking(-1)
                .padding(.top, 24)
            Text("Hi \(store.customer?.name ?? "there"). Your account holds the money your shoppers spend, and it enforces every rule you set, so nobody can spend more than you allow.")
                .font(.system(size: 16))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)

            VStack(alignment: .leading, spacing: 14) {
                point("lock", "Only you can change the rules.")
                point("checkmark.shield", "Payments only go to trusted stores.")
                point("doc.text", "Every purchase leaves a receipt nobody can edit.")
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
            .padding(.top, 28)
        }
    }

    private var moneyStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image(systemName: "arrow.down.to.line")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(Color.ink)
                .frame(width: 72, height: 72)
                .background(.white.opacity(0.92), in: .circle)
            Text("Add money")
                .font(.system(size: 34, weight: .semibold))
                .tracking(-1)
                .padding(.top, 24)
            Text("Your account is open. Move some money in from your bank so your shoppers have something to spend.")
                .font(.system(size: 16))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)

            VStack(spacing: 16) {
                AmountText(money: Money(amount), size: 58)
                AmountChips(amounts: amounts, selected: $amount)
                HStack(spacing: 10) {
                    Image(systemName: "building.columns")
                        .foregroundStyle(Color.glow)
                    Text("From your bank · demo transfer, test money only")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.soft)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity)
            .glassPanel()
            .padding(.top, 28)
        }
    }

    private var footer: some View {
        VStack(spacing: 10) {
            if let problem {
                Text(problem)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.blocked)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
            if busy {
                HStack(spacing: 12) {
                    ProgressView()
                    Text(step == .open ? "Opening your account… about ten seconds" : "Moving \(Money(amount).short) in…")
                        .font(.system(size: 16, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .glassEffect(.regular, in: .capsule)
            } else {
                Button(step == .open ? "Open my account" : "Add \(Money(amount).short)") {
                    Task { await go() }
                }
                .buttonStyle(LensButtonStyle())
            }
            Button {
                if step == .open { store.skippedSetup = true }
                store.settingUp = false
            } label: {
                Text(step == .open ? (store.shared.isEmpty ? "Not now" : "Not now, just use what's shared with me") : "Skip for now")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.soft)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 44)
            }
            .disabled(busy)
        }
    }

    private func go() async {
        busy = true
        problem = nil
        do {
            if step == .open {
                try await store.openAccount()
                withAnimation(.smooth(duration: 0.35)) { step = .money }
            } else {
                try await store.addMoney(amount)
                store.settingUp = false
            }
        } catch {
            problem = error.localizedDescription
        }
        busy = false
    }

    private func point(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(Color.glow)
                .frame(width: 24)
            Text(text)
                .font(.system(size: 15))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Preset dollar amounts as glass chips.
struct AmountChips: View {
    let amounts: [String]
    @Binding var selected: String

    var body: some View {
        HStack(spacing: 8) {
            ForEach(amounts, id: \.self) { option in
                let isSelected = option == selected
                Button { selected = option } label: {
                    Text(Money(option).short)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(isSelected ? Color.ink : .white)
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
}

/// Adding money later, from Home.
struct AddMoneySheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var amount = "50"
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        ZStack {
            LightField()
            VStack(spacing: 20) {
                Text("Add money")
                    .font(.system(size: 17, weight: .medium))
                    .padding(.top, 28)
                AmountText(money: Money(amount), size: 58)
                AmountChips(amounts: ["25", "50", "100", "200"], selected: $amount)
                Text("From your bank · demo transfer, test money only")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
                Spacer()
                if let problem {
                    Text(problem)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Color.blocked)
                        .multilineTextAlignment(.center)
                }
                if busy {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Moving \(Money(amount).short) in…")
                            .font(.system(size: 16, weight: .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 58)
                    .glassEffect(.regular, in: .capsule)
                } else {
                    Button("Add \(Money(amount).short)") {
                        Task {
                            busy = true
                            problem = nil
                            do {
                                try await store.addMoney(amount)
                                dismiss()
                            } catch {
                                problem = error.localizedDescription
                            }
                            busy = false
                        }
                    }
                    .buttonStyle(LensButtonStyle())
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(busy)
    }
}

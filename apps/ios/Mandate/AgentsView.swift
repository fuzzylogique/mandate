// The agents that can use this account's mandates: connecting them with a
// one-time code, what each one can sign with, and removing them.
import SwiftUI

struct AgentsView: View {
    @Environment(AppStore.self) private var store
    @State private var adding = false

    private var current: [AccountAgent] { store.agents.filter { !$0.isRemoved } }
    private var removed: [AccountAgent] { store.agents.filter(\.isRemoved) }

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Agents")
                        .font(.system(size: 30, weight: .semibold))
                        .tracking(-0.8)
                    Spacer()
                    Button { adding = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 18, weight: .medium))
                            .frame(width: 44, height: 44)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("Add agent")
                }
                .padding(.top, 8)

                Text("Agents shop for you under the mandates you give them. They can't raise a limit, and you can remove one at any time.")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
                    .fixedSize(horizontal: false, vertical: true)

                if current.isEmpty {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("No agents yet")
                            .font(.system(size: 20, weight: .medium))
                        Text("Add one to connect an assistant like Claude. It keeps its own key, and only that key can sign for the mandates you give it.")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.soft)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Add agent") { adding = true }
                            .buttonStyle(LensButtonStyle(height: 52))
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassPanel()
                }

                ForEach(current) { agent in
                    AgentCard(agent: agent)
                }

                if !removed.isEmpty {
                    Text("Removed")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                        .padding(.top, 14)
                    VStack(spacing: 0) {
                        ForEach(Array(removed.enumerated()), id: \.element.id) { index, agent in
                            HStack {
                                Text(agent.name)
                                    .font(.system(size: 15))
                                Spacer()
                                Text("Removed")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Color.blocked)
                            }
                            .lineLimit(1)
                            .frame(height: 48)
                            if index < removed.count - 1 {
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
        .sheet(isPresented: $adding) { AddAgentView() }
    }
}

/// One agent: who it is, how it signs, and the owner's controls.
struct AgentCard: View {
    @Environment(AppStore.self) private var store
    let agent: AccountAgent
    @State private var confirmingRemove = false
    @State private var busy = false
    @State private var problem: String?

    private var removing: Bool { store.removingAgents.contains(agent.id) }

    private var tone: Color {
        if agent.isRemoved { return .blocked }
        if agent.isWaiting { return .soft }
        return agent.verified ? .trusted : (agent.isConnected ? .soft : .blocked)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                Text(agent.initials)
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 46, height: 46)
                    .background(.white.opacity(0.16), in: .circle)
                    .overlay { Circle().strokeBorder(.white.opacity(0.3), lineWidth: 1) }
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(agent.name)
                        .font(.system(size: 17, weight: .medium))
                        .lineLimit(1)
                    Label(removing ? "Removing…" : agent.statusLabel, systemImage: agent.isWaiting ? "clock" : (agent.verified ? "checkmark.shield" : "exclamationmark.circle"))
                        .font(.system(size: 13))
                        .foregroundStyle(removing ? Color.soft : tone)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }

            if agent.isWaiting {
                ConnectSteps(agent: agent, busy: busy) { Task { await newCode() } }
            } else if agent.isConnected, let shortKey = agent.shortKey {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "key")
                        .font(.system(size: 17))
                        .foregroundStyle(Color.glow)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Signs with its own key")
                            .font(.system(size: 14))
                        Text(shortKey)
                            .font(.system(size: 14, weight: .medium, design: .monospaced))
                            .textSelection(.enabled)
                            .accessibilityLabel("Public key \(agent.publicKey ?? shortKey)")
                        Text("Mandate never holds its key and can't sign for it.")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.soft)
                    }
                }
            } else if !agent.holdsOwnKey {
                IdentificationRow(agent: agent)
            }

            if let link = agent.explorerUrl.flatMap(URL.init(string:)), !agent.isRemoved {
                Link(destination: link) {
                    Label("View registration on Stellar", systemImage: "arrow.up.right")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Color.glow)
                }
                .frame(minHeight: 32)
            }

            if let problem {
                Text(problem)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.blocked)
            }

            if agent.holdsOwnKey && !agent.isRemoved {
                Button("Remove agent", role: .destructive) { confirmingRemove = true }
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.blocked)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .disabled(removing || busy)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .confirmationDialog("Remove \(agent.name)? Its mandates are revoked too.", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await remove() } }
        } message: {
            Text("It's taken off your account's registry on Stellar and can't pay again.")
        }
    }

    private func newCode() async {
        busy = true; problem = nil
        do { _ = try await store.newCode(for: agent) }
        catch { problem = error.localizedDescription }
        busy = false
    }

    private func remove() async {
        problem = nil
        do { try await store.remove(agent) }
        catch { problem = error.localizedDescription }
    }
}

/// An agent registered by identification only: the value it shows alongside a mandate ID.
private struct IdentificationRow: View {
    let agent: AccountAgent
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Agent identification")
                .font(.system(size: 13))
                .foregroundStyle(Color.soft)
            HStack(spacing: 10) {
                Text(agent.id)
                    .font(.system(size: 12, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer(minLength: 0)
                Button(copied ? "Copied" : "Copy") {
                    UIPasteboard.general.string = agent.id
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                }
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.glow)
                .frame(minHeight: 44)
            }
        }
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
    }
}

/// How to connect an agent that holds its own key: the one-time code and where to use it.
struct ConnectSteps: View {
    let agent: AccountAgent
    let busy: Bool
    let makeNewCode: () -> Void
    @State private var copied = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if let pairing = agent.pairing, pairing.expiry > context.date {
                steps(pairing)
            } else {
                expired
            }
        }
    }

    private var expired: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("The connection code expired before \(agent.name) used it.")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)
            Button(busy ? "Making a new code…" : "Make a new code", action: makeNewCode)
                .buttonStyle(LensButtonStyle(height: 48))
                .disabled(busy)
        }
    }

    private func steps(_ pairing: AccountAgent.Pairing) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Give \(agent.name) this one-time code. It works once and expires at \(Dates.time(pairing.expiry)).")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)

            Button {
                UIPasteboard.general.string = pairing.code
                copied = true
                Task { try? await Task.sleep(for: .seconds(2)); copied = false }
            } label: {
                VStack(spacing: 6) {
                    Text(pairing.code)
                        .font(.system(size: 34, weight: .semibold, design: .monospaced))
                        .tracking(2)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Label(copied ? "Copied" : "Tap to copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(copied ? Color.trusted : Color.soft)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 18)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
            .sensoryFeedback(.success, trigger: copied) { _, now in now }
            .accessibilityLabel("Connection code \(pairing.code)")
            .accessibilityHint("Copies the code")

            VStack(alignment: .leading, spacing: 12) {
                step(1) {
                    Text("Add Mandate to the agent once. For Claude Code:")
                    Text("claude mcp add mandate -- node apps/agent/src/mcp.ts")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(.white.opacity(0.1), in: .rect(cornerRadius: 10))
                    Text("LangChain agents use createMandateTools(); scripts use pnpm agent.")
                }
                step(2) {
                    Text("Then tell it: \u{201C}Connect to Mandate with code \(pairing.code).\u{201D} It makes its own key, which never leaves it.")
                }
                step(3) {
                    Text("Give it a mandate. It can only pay verified sellers, within the limit, until it expires.")
                }
            }
        }
    }

    private func step<Content: View>(_ number: Int, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 24, height: 24)
                .background(.white.opacity(0.16), in: .circle)
            VStack(alignment: .leading, spacing: 6) { content() }
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Adding an agent: a name and how it pays, then the code to connect it with.
struct AddAgentView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var ownKey = true
    @State private var requestId = UUID().uuidString
    @State private var busy = false
    @State private var newCodeBusy = false
    @State private var problem: String?
    @State private var added: AccountAgent?
    @FocusState private var naming: Bool

    /// The agent as the account sees it now, so the sheet notices when it connects.
    private var live: AccountAgent? {
        guard let added else { return nil }
        return store.agent(added.id) ?? added
    }

    var body: some View {
        ZStack {
            LightField()
                .onTapGesture { naming = false }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    topBar
                    if let live {
                        connect(live)
                    } else {
                        form
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .showsBanner()
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(busy)
        .onAppear { naming = true }
    }

    private var topBar: some View {
        ZStack {
            Text(live.map { "Connect \($0.name)" } ?? "Add agent")
                .font(.system(size: 16, weight: .medium))
                .lineLimit(1)
                .padding(.horizontal, 56)
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("Close")
                .disabled(busy)
                Spacer()
            }
        }
        .frame(height: 44)
        .padding(.top, 20)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Agent name")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
                TextField("Like Claude or Grocery bot", text: $name)
                    .focused($naming)
                    .submitLabel(.done)
                    .autocorrectionDisabled()
                    .font(.system(size: 17, weight: .medium))
                    .padding(.horizontal, 22)
                    .frame(height: 56)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .disabled(busy)
                    .onChange(of: name) { _, next in
                        if next.count > 120 { name = String(next.prefix(120)) }
                        requestId = UUID().uuidString
                    }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("How it pays")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
                choice(true, "With its own key", "For Claude (MCP), LangChain or scripts. It connects with a one-time code and signs every payment itself.")
                choice(false, "With a mandate ID", "For the Pay page and chat. Mandate holds the key; the agent shows its identification and a secret mandate ID.")
            }

            if let problem {
                Text(problem)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.blocked)
            }

            Button {
                Task { await add() }
            } label: {
                if busy {
                    HStack(spacing: 10) {
                        ProgressView().tint(Color.ink)
                        Text(ownKey ? "Adding…" : "Registering on Stellar…")
                    }
                } else {
                    Text("Add agent")
                }
            }
            .buttonStyle(LensButtonStyle())
            .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(name.trimmingCharacters(in: .whitespaces).isEmpty ? 0.6 : 1)
        }
        .padding(.top, 8)
    }

    private func choice(_ value: Bool, _ title: String, _ detail: String) -> some View {
        let selected = ownKey == value
        return Button {
            guard ownKey != value else { return }
            ownKey = value
            requestId = UUID().uuidString
        } label: {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(selected ? Color.glow : Color.soft)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 16, weight: .medium))
                    Text(detail)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.soft)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
        .overlay {
            RoundedRectangle(cornerRadius: 22)
                .strokeBorder(selected ? Color.glow.opacity(0.8) : .clear, lineWidth: 1.5)
        }
        .disabled(busy)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder
    private func connect(_ agent: AccountAgent) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if agent.isConnected {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "checkmark.shield.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(Color.trusted)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(agent.name) is connected")
                            .font(.system(size: 18, weight: .semibold))
                        Text(agent.shortKey.map { "It signs with its own key \($0). Give it a mandate to let it buy." } ?? "It signs with its own key. Give it a mandate to let it buy.")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.soft)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel()
            } else {
                ConnectSteps(agent: agent, busy: newCodeBusy) { Task { await newCode(agent) } }
                    .padding(18)
                    .glassPanel()
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Waiting for \(agent.name) to connect…")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                }
                .frame(maxWidth: .infinity)
            }
            if let problem {
                Text(problem)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.blocked)
            }
            Button("Done") { dismiss() }
                .buttonStyle(LensButtonStyle())
        }
        .padding(.top, 8)
    }

    private func add() async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        naming = false
        busy = true; problem = nil
        do {
            let agent = try await store.addAgent(name: trimmed, ownKey: ownKey, requestId: requestId)
            busy = false
            if ownKey { added = agent } else { dismiss() }
        } catch {
            busy = false
            problem = error.localizedDescription
        }
    }

    private func newCode(_ agent: AccountAgent) async {
        newCodeBusy = true; problem = nil
        do { added = try await store.newCode(for: agent) }
        catch { problem = error.localizedDescription }
        newCodeBusy = false
    }
}

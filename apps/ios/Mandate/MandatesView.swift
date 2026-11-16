// Everyone who can spend from the account, and the detail of one of them.
import SwiftUI

struct MandatesView: View {
    @Environment(AppStore.self) private var store
    @State private var adding = false
    @State private var openMandate: Mandate?

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Mandates")
                        .font(.system(size: 30, weight: .semibold))
                        .tracking(-0.8)
                    Spacer()
                    Button { adding = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 18, weight: .medium))
                            .frame(width: 44, height: 44)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("New mandate")
                }
                .padding(.top, 8)

                if store.mandates.isEmpty {
                    Text("Nobody is shopping for you right now. Add a mandate to hand over a limit.")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.soft)
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassPanel()
                }

                ForEach(store.mandates) { mandate in
                    Button { openMandate = mandate } label: { row(mandate) }
                        .buttonStyle(.plain)
                }

                if !store.stopped.isEmpty {
                    Text("Stopped")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                        .padding(.top, 14)
                    VStack(spacing: 0) {
                        ForEach(Array(store.stopped.enumerated()), id: \.element.id) { index, mandate in
                            HStack {
                                Text(mandate.name)
                                    .font(.system(size: 15))
                                Spacer()
                                Text("Can't spend")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Color.soft)
                            }
                            .frame(height: 48)
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
        .fullScreenCover(isPresented: $adding) { NewMandateView() }
        .sheet(item: $openMandate) { MandateDetail(mandateID: $0.id) }
    }

    private func row(_ mandate: Mandate) -> some View {
        HStack(spacing: 16) {
            Ring(share: mandate.leftShare, color: .mandate(mandate.id))
                .frame(width: 46, height: 46)
            VStack(alignment: .leading, spacing: 2) {
                Text(mandate.name)
                    .font(.system(size: 17, weight: .medium))
                Text(store.working[mandate.id] ?? mandate.rule)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(mandate.leftMoney?.short ?? "")
                    .font(.system(size: 20, weight: .medium))
                Text("left")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.soft)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 18)
        .frame(height: 84)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 28))
        .accessibilityElement(children: .combine)
    }
}

/// One mandate: its limit, what it has bought, and the owner's controls.
struct MandateDetail: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let mandateID: Int
    @State private var confirmingStop = false
    @State private var openReceipt: Activity?
    @State private var secret: String?
    @State private var secretError: String?

    var body: some View {
        ZStack {
            LightField()
            if let mandate = store.mandate(mandateID) {
                ScrollView {
                    VStack(spacing: 22) {
                        header(mandate)
                        if mandate.isActive {
                            errand(mandate)
                        }
                        history(mandate)
                        if mandate.isActive {
                            Button("Stop this mandate", role: .destructive) { confirmingStop = true }
                                .font(.system(size: 16, weight: .medium))
                                .foregroundStyle(Color.blocked)
                                .frame(maxWidth: .infinity)
                                .frame(height: 56)
                                .glassEffect(.regular.interactive(), in: .capsule)
                                .disabled(store.working[mandate.id] != nil)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 36)
                    .padding(.bottom, 32)
                }
                .scrollIndicators(.hidden)
                .confirmationDialog(
                    "Stop \(mandate.name)?",
                    isPresented: $confirmingStop,
                    titleVisibility: .visible
                ) {
                    Button("Stop this mandate", role: .destructive) {
                        Task {
                            await store.stop(mandate)
                            dismiss()
                        }
                    }
                } message: {
                    Text("It won't be able to spend from your account again. Purchases it already made stay in your activity.")
                }
            }
        }
        .showsBanner()
        .presentationDragIndicator(.visible)
        .sheet(item: $openReceipt) { ReceiptView(item: $0) }
    }

    private func header(_ mandate: Mandate) -> some View {
        VStack(spacing: 10) {
            Text(mandate.name)
                .font(.system(size: 17, weight: .medium))
            ZStack {
                Ring(share: mandate.leftShare, color: .mandate(mandate.id), width: 10)
                VStack(spacing: 0) {
                    Text(mandate.leftMoney?.short ?? "Stopped")
                        .font(.system(size: mandate.isActive ? 40 : 22, weight: .medium))
                        .tracking(-1)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                    if mandate.isActive {
                        Text("left")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.soft)
                    }
                }
                .padding(.horizontal, 24)
            }
            .frame(width: 180, height: 180)
            .padding(.vertical, 6)
            Text(store.working[mandate.id] ?? mandate.rule)
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    private func errand(_ mandate: Mandate) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pay with this mandate").font(.system(size: 18, weight: .semibold))
            Text("Use the mandate ID and an agent identification registered to this account on the web Pay page or in your payment client.")
                .font(.system(size: 14)).foregroundStyle(Color.soft)
            if let secret {
                Text(secret).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                Button("Hide mandate ID") { self.secret = nil }
            } else {
                Button("Show mandate ID") {
                    Task {
                        do { secret = try await store.reveal(mandate); secretError = nil }
                        catch { secretError = error.localizedDescription }
                    }
                }
            }
            if let secretError { Text(secretError).foregroundStyle(Color.blocked) }
        }
        .padding(18).glassPanel()
    }

    @ViewBuilder
    private func history(_ mandate: Mandate) -> some View {
        let items = Array(store.activity(for: mandate).prefix(5))
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("What it's done")
                    .font(.system(size: 18, weight: .semibold))
                ActivityPanel(items: items) { openReceipt = $0 }
            }
        }
    }

    /// Catalog prices come as whole amounts ("2.4"); money is counted in seven decimal places.
    private func baseUnits(_ price: String) -> String {
        let value = (Decimal(string: price) ?? 0) * 10_000_000
        return NSDecimalNumber(decimal: value).stringValue
    }
}

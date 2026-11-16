// Buying with spending someone shared with you: search the stores, pick one, pay.
// Their rules on their account decide whether it goes through.
import SwiftUI

struct SharedShopView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let sharedID: String

    @State private var query = ""
    @State private var offers: [Offer] = []
    @State private var loading = false
    @State private var problem: String?
    @State private var choice: Offer?
    @State private var paying: String?
    @State private var outcome: PurchaseOutcome?
    @State private var search: Task<Void, Never>?

    private var shared: SharedSpending? { store.shared.first { $0.id == sharedID } }

    var body: some View {
        ZStack {
            LightField()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    topBar
                    if let shared { header(shared) }

                    HStack(spacing: 10) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(Color.soft)
                        TextField("Search the stores, like herbs", text: $query)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .submitLabel(.search)
                            .onSubmit { load() }
                    }
                    .font(.system(size: 17))
                    .padding(.horizontal, 20)
                    .frame(height: 54)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .onChange(of: query) { _, _ in
                        search?.cancel()
                        search = Task {
                            try? await Task.sleep(for: .milliseconds(350))
                            guard !Task.isCancelled else { return }
                            load()
                        }
                    }

                    if let outcome {
                        OutcomeLine(outcome: outcome, owner: shared?.ownerName)
                            .glassPanel(20)
                    }
                    if let problem {
                        Text(problem)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.blocked)
                    }

                    if loading && offers.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(24)
                    } else if offers.isEmpty {
                        Text("Nothing found. Try another word.")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.soft)
                            .padding(20)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassPanel()
                    } else {
                        list
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
        .task { load() }
        .confirmationDialog(
            choice.map { "Buy \($0.title.lowercased()) for \($0.money.text)?" } ?? "",
            isPresented: Binding(get: { choice != nil }, set: { if !$0 { choice = nil } }),
            titleVisibility: .visible
        ) {
            if let offer = choice {
                Button("Buy from \(offer.store.name)") { Task { await pay(offer) } }
            }
        } message: {
            if let offer = choice, let shared {
                Text(offer.store.trusted
                     ? "Paid from what \(shared.ownerName) shared with you."
                     : "\(offer.store.name) isn't a trusted store, so \(shared.ownerName)'s account will refuse it.")
            }
        }
    }

    private var topBar: some View {
        ZStack {
            Text("Shop")
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
            }
        }
        .frame(height: 44)
        .padding(.top, 20)
    }

    private func header(_ shared: SharedSpending) -> some View {
        VStack(spacing: 4) {
            Text("Shared by \(shared.ownerName)")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
            AmountText(money: shared.leftMoney, size: 52)
            Text("left of \(Money(shared.limit).short) \(Period.current(shared.period)) · trusted stores only")
                .font(.system(size: 13))
                .foregroundStyle(Color.soft)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private var list: some View {
        VStack(spacing: 0) {
            ForEach(Array(offers.enumerated()), id: \.element.id) { index, offer in
                Button { choice = offer } label: { row(offer) }
                    .buttonStyle(.plain)
                    .disabled(paying != nil || shared?.isActive != true)
                if index < offers.count - 1 {
                    Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 4)
        .glassPanel()
    }

    private func row(_ offer: Offer) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(offer.title)
                    .font(.system(size: 15, weight: .medium))
                HStack(spacing: 6) {
                    Text(offer.store.name)
                        .foregroundStyle(Color.soft)
                    if offer.store.trusted {
                        Label("Trusted", systemImage: "checkmark.shield")
                            .foregroundStyle(Color.trusted)
                    } else {
                        Label("Not a trusted store", systemImage: "exclamationmark.shield")
                            .foregroundStyle(Color.blocked)
                    }
                }
                .font(.system(size: 12))
            }
            Spacer(minLength: 8)
            if paying == offer.id {
                ProgressView()
            } else {
                Text(offer.money.text)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(offer.store.trusted ? .white : Color.blocked)
            }
        }
        .lineLimit(1)
        .frame(height: 62)
        .contentShape(.rect)
    }

    private func load() {
        guard let shared else { return }
        loading = true
        Task {
            do {
                offers = try await store.sharedOffers(shared, query: query.trimmingCharacters(in: .whitespaces))
                problem = nil
            } catch {
                problem = error.localizedDescription
            }
            loading = false
        }
    }

    private func pay(_ offer: Offer) async {
        guard let shared else { return }
        choice = nil
        paying = offer.id
        outcome = nil
        problem = nil
        do {
            outcome = try await store.sharedPay(shared, offer: offer)
        } catch {
            problem = error.localizedDescription
        }
        paying = nil
    }
}

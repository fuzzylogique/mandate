// The account owner: the account, trusted stores, how it's protected, where the app connects, and signing out.
import SwiftUI

struct YouView: View {
    @Environment(AppStore.self) private var store
    @State private var address = ""
    @State private var confirmingSignOut = false
    @FocusState private var editingAddress: Bool

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.customer?.name ?? "You")
                        .font(.system(size: 30, weight: .semibold))
                        .tracking(-0.8)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    if let email = store.customer?.email {
                        Text(email)
                            .font(.system(size: 14))
                            .foregroundStyle(Color.soft)
                    }
                }
                .padding(.top, 8)

                if let account = store.account, account.isOpen {
                    heading("Your account")
                    VStack(alignment: .leading, spacing: 0) {
                        ProofRow(label: "Balance", value: account.money.text)
                        if let address = account.address { ProofRow(label: "Account number", value: shortened(address)) }
                        if let link = account.explorerUrl.flatMap(URL.init(string:)) {
                            Link(destination: link) {
                                Label("View on Stellar", systemImage: "arrow.up.right")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Color.glow)
                                    .frame(minHeight: 40)
                            }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 8)
                    .glassPanel()
                }

                heading("Trusted stores")
                VStack(spacing: 0) {
                    let stores = store.trustedStores
                    if stores.isEmpty {
                        Text("No trusted stores yet.")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.soft)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(height: 56)
                    }
                    ForEach(Array(stores.enumerated()), id: \.element.address) { index, seller in
                        storeRow(seller, icon: "checkmark.shield", color: .trusted, detail: seller.domain)
                        if index < stores.count - 1 || !store.lookalikes.isEmpty {
                            Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
                        }
                    }
                    ForEach(Array(store.lookalikes.enumerated()), id: \.element.address) { index, seller in
                        storeRow(seller, icon: "exclamationmark.shield", color: .blocked,
                                 detail: seller.looksLike.map { "Not trusted · looks like \($0)" } ?? "Not trusted")
                        if index < store.lookalikes.count - 1 {
                            Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 2)
                .glassPanel()

                heading("How you're protected")
                VStack(alignment: .leading, spacing: 14) {
                    point("lock", "Shoppers never hold your money. Each one can only spend up to its limit, until its end date.")
                    point("checkmark.shield", "Payments only go to trusted stores. Look-alikes are refused.")
                    point("hand.raised", "Anything outside the rules comes to you. You can stop a shopper at any time.")
                    point("doc.text", "Every purchase leaves a receipt that can't be edited.")
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel()

                heading("Connection")
                VStack(alignment: .leading, spacing: 10) {
                    Text("Mandate service address")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.soft)
                    TextField(AppStore.defaultAddress, text: $address)
                        .focused($editingAddress)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .font(.system(size: 15, design: .monospaced))
                        .onSubmit(save)
                    Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
                    Label(store.problem ?? "Connected", systemImage: store.problem == nil ? "checkmark.circle" : "exclamationmark.circle")
                        .font(.system(size: 13))
                        .foregroundStyle(store.problem == nil ? Color.trusted : Color.blocked)
                }
                .padding(18)
                .glassPanel()

                Button("Sign out") { confirmingSignOut = true }
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.blocked)
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .padding(.top, 16)

                Text("Running on the \(store.overview?.network.name ?? "Stellar test network") · test money only")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.soft)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { address = store.serviceAddress }
        .onChange(of: editingAddress) { _, editing in
            if !editing { save() }
        }
        .confirmationDialog("Sign out of Mandate?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await store.signOut() } }
        } message: {
            Text("Your shoppers keep working within their rules while you're signed out.")
        }
    }

    private func storeRow(_ seller: Store, icon: String, color: Color, detail: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 20))
                .foregroundStyle(color)
            VStack(alignment: .leading, spacing: 1) {
                Text(seller.name)
                    .font(.system(size: 15, weight: .medium))
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(color == .blocked ? Color.blocked : Color.soft)
            }
            Spacer()
        }
        .frame(height: 60)
    }

    private func save() {
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != store.serviceAddress else { return }
        store.serviceAddress = trimmed
        Task { await store.refresh() }
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14))
            .foregroundStyle(Color.soft)
            .padding(.top, 8)
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

// The account owner: trusted stores, how the account is protected, and where the app connects.
import SwiftUI

struct YouView: View {
    @Environment(AppStore.self) private var store
    @State private var address = ""
    @FocusState private var editingAddress: Bool

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 12) {
                Text(store.overview?.owner.name ?? "You")
                    .font(.system(size: 30, weight: .semibold))
                    .tracking(-0.8)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .frame(height: 44)
                    .padding(.top, 8)

                heading("Trusted stores")
                VStack(spacing: 0) {
                    let stores = store.overview?.sellers ?? []
                    if stores.isEmpty {
                        Text("No trusted stores yet.")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.soft)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(height: 56)
                    }
                    ForEach(Array(stores.enumerated()), id: \.element.address) { index, seller in
                        HStack(spacing: 12) {
                            Image(systemName: "checkmark.shield")
                                .font(.system(size: 20))
                                .foregroundStyle(Color.trusted)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(seller.name)
                                    .font(.system(size: 15, weight: .medium))
                                Text(seller.domain)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Color.soft)
                            }
                            Spacer()
                        }
                        .frame(height: 60)
                        if index < stores.count - 1 {
                            Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 2)
                .glassPanel()

                heading("How you're protected")
                VStack(alignment: .leading, spacing: 14) {
                    point("lock", "Shoppers never hold your money. Each one can only spend up to its limit.")
                    point("checkmark.shield", "Payments only go to trusted stores. Look-alikes are refused.")
                    point("hand.raised", "You can stop a shopper at any time.")
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

                Text("Running on the Stellar test network")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.soft)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { address = store.serviceAddress }
        .onChange(of: editingAddress) { _, editing in
            if !editing { save() }
        }
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

// Everyone who can spend from the account, and the detail of one of them.
import SwiftUI

struct ShoppersView: View {
    @Environment(AppStore.self) private var store
    @State private var adding = false
    @State private var openShopper: Shopper?

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Shoppers")
                        .font(.system(size: 30, weight: .semibold))
                        .tracking(-0.8)
                    Spacer()
                    Button { adding = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 18, weight: .medium))
                            .frame(width: 44, height: 44)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("New shopper")
                }
                .padding(.top, 8)

                if store.shoppers.isEmpty {
                    Text("Nobody is shopping for you right now. Add a shopper to hand over a limit.")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.soft)
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassPanel()
                }

                ForEach(store.shoppers) { shopper in
                    Button { openShopper = shopper } label: { row(shopper) }
                        .buttonStyle(.plain)
                }

                if !store.stopped.isEmpty {
                    Text("Stopped")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                        .padding(.top, 14)
                    VStack(spacing: 0) {
                        ForEach(Array(store.stopped.enumerated()), id: \.element.id) { index, shopper in
                            HStack {
                                Text(shopper.name)
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
        .fullScreenCover(isPresented: $adding) { NewShopperView() }
        .sheet(item: $openShopper) { ShopperDetail(shopperID: $0.id) }
    }

    private func row(_ shopper: Shopper) -> some View {
        HStack(spacing: 16) {
            Ring(share: shopper.leftShare, color: .shopper(shopper.id))
                .frame(width: 46, height: 46)
            VStack(alignment: .leading, spacing: 2) {
                Text(shopper.name)
                    .font(.system(size: 17, weight: .medium))
                Text(store.working[shopper.id] ?? shopper.rule)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(shopper.leftMoney?.short ?? "")
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

/// One shopper: its limit, what it has bought, and the owner's controls.
struct ShopperDetail: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let shopperID: Int
    @State private var confirmingStop = false
    @State private var openReceipt: Activity?

    var body: some View {
        ZStack {
            LightField()
            if let shopper = store.shopper(shopperID) {
                ScrollView {
                    VStack(spacing: 22) {
                        header(shopper)
                        if shopper.isActive {
                            errand(shopper)
                        }
                        history(shopper)
                        if shopper.isActive {
                            Button("Stop this shopper", role: .destructive) { confirmingStop = true }
                                .font(.system(size: 16, weight: .medium))
                                .foregroundStyle(Color.blocked)
                                .frame(maxWidth: .infinity)
                                .frame(height: 56)
                                .glassEffect(.regular.interactive(), in: .capsule)
                                .disabled(store.working[shopper.id] != nil)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 36)
                    .padding(.bottom, 32)
                }
                .scrollIndicators(.hidden)
                .confirmationDialog(
                    "Stop \(shopper.name)?",
                    isPresented: $confirmingStop,
                    titleVisibility: .visible
                ) {
                    Button("Stop this shopper", role: .destructive) {
                        Task {
                            await store.stop(shopper)
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

    private func header(_ shopper: Shopper) -> some View {
        VStack(spacing: 10) {
            Text(shopper.name)
                .font(.system(size: 17, weight: .medium))
            ZStack {
                Ring(share: shopper.leftShare, color: .shopper(shopper.id), width: 10)
                VStack(spacing: 0) {
                    Text(shopper.leftMoney?.short ?? "Stopped")
                        .font(.system(size: shopper.isActive ? 40 : 22, weight: .medium))
                        .tracking(-1)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                    if shopper.isActive {
                        Text("left")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.soft)
                    }
                }
                .padding(.horizontal, 24)
            }
            .frame(width: 180, height: 180)
            .padding(.vertical, 6)
            Text(store.working[shopper.id] ?? shopper.rule)
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    /// Sends the shopper to buy something now, to see the rules at work.
    private func errand(_ shopper: Shopper) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Send it shopping")
                .font(.system(size: 18, weight: .semibold))
            VStack(spacing: 0) {
                let catalog = store.overview?.catalog ?? []
                ForEach(Array(catalog.enumerated()), id: \.element.id) { index, item in
                    Button {
                        Task { await store.send(shopper, toBuy: item) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title)
                                    .font(.system(size: 15, weight: .medium))
                                Text(item.seller.name)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Color.soft)
                            }
                            Spacer(minLength: 8)
                            Text(Money(base: baseUnits(item.price), token: shopper.token).text)
                                .font(.system(size: 15, weight: .medium))
                        }
                        .lineLimit(1)
                        .frame(height: 60)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    if index < catalog.count - 1 {
                        Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 4)
            .glassPanel()
            .disabled(store.working[shopper.id] != nil)
            .opacity(store.working[shopper.id] == nil ? 1 : 0.5)
        }
    }

    @ViewBuilder
    private func history(_ shopper: Shopper) -> some View {
        let items = Array(store.activity(for: shopper).prefix(5))
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

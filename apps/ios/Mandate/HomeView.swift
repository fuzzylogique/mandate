// Home: what's available, what needs you, and what just happened.
import SwiftUI

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @Binding var tab: AppTab
    @State private var adding = false
    @State private var addingMoney = false
    @State private var openShopper: Shopper?
    @State private var openReceipt: Activity?
    @State private var openShared: SharedSpending?

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                HStack {
                    Wordmark()
                    Spacer()
                    if let name = store.customer?.name {
                        Text(name)
                            .font(.system(size: 14))
                            .foregroundStyle(Color.soft)
                            .lineLimit(1)
                    }
                }
                .frame(height: 44)

                if let problem = store.problem {
                    Label(problem, systemImage: "wifi.exclamationmark")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.blocked)
                        .padding(.horizontal, 16)
                        .frame(height: 36)
                        .glassEffect(.regular, in: .capsule)
                        .padding(.top, 8)
                }

                if store.overview == nil {
                    loading
                } else {
                    if let balance = store.balance {
                        summary(balance)
                    } else {
                        openAccount
                    }
                    needsYou
                    sharedWithYou
                    if store.hasAccount { shoppers }
                    latest
                }
            }
        }
        // Before the sheets, so pull-to-refresh does not leak into them.
        .refreshable { await store.refresh() }
        .fullScreenCover(isPresented: $adding) { NewShopperView() }
        .sheet(isPresented: $addingMoney) { AddMoneySheet() }
        .sheet(item: $openShopper) { ShopperDetail(shopperID: $0.id) }
        .sheet(item: $openReceipt) { ReceiptView(item: $0) }
        .sheet(item: $openShared) { SharedShopView(sharedID: $0.id) }
    }

    private func summary(_ balance: Money) -> some View {
        VStack(spacing: 6) {
            Text("Available")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
            AmountText(money: balance)
            HStack(spacing: 8) {
                HStack(spacing: 10) {
                    Text("\(store.spentToday.text) spent today")
                    if store.blockedToday > 0 {
                        Circle().fill(.white.opacity(0.6)).frame(width: 4, height: 4)
                        Text("\(store.blockedToday) blocked")
                            .foregroundStyle(Color.blocked)
                    }
                }
                .font(.system(size: 13))
                .padding(.horizontal, 16)
                .frame(height: 36)
                .glassEffect(.regular, in: .capsule)

                Button { addingMoney = true } label: {
                    Label("Add", systemImage: "plus")
                        .font(.system(size: 13, weight: .medium))
                        .padding(.horizontal, 14)
                        .frame(height: 36)
                }
                .glassEffect(.regular.interactive(), in: .capsule)
                .accessibilityLabel("Add money")
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 26)
    }

    private var openAccount: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Open your account")
                .font(.system(size: 20, weight: .medium))
            Text("Your account holds the money your shoppers spend and enforces their rules.")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open my account") { store.settingUp = true }
                .buttonStyle(LensButtonStyle(height: 52))
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .padding(.top, 26)
    }

    @ViewBuilder
    private var needsYou: some View {
        let requests = store.requests
        if !requests.isEmpty {
            VStack(spacing: 10) {
                SectionHeading(text: "Needs you", count: requests.count)
                ForEach(requests) { RequestCard(request: $0) }
            }
            .padding(.top, 26)
        }
    }

    @ViewBuilder
    private var sharedWithYou: some View {
        if !store.shared.isEmpty {
            VStack(spacing: 10) {
                SectionHeading(text: "Shared with you")
                ForEach(store.shared) { shared in
                    Button { openShared = shared } label: { SharedCard(shared: shared) }
                        .buttonStyle(.plain)
                        .disabled(!shared.isActive)
                }
            }
            .padding(.top, 26)
        }
    }

    private var shoppers: some View {
        VStack(spacing: 10) {
            HStack {
                Text("Shoppers")
                    .font(.system(size: 18, weight: .semibold))
                Spacer()
                Button { adding = true } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("New shopper")
            }

            if store.shoppers.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Let someone shop for you")
                        .font(.system(size: 20, weight: .medium))
                    Text("Give a shopper a limit and trusted stores. It buys on its own, and you only hear about the exceptions.")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("New shopper") { adding = true }
                        .buttonStyle(LensButtonStyle(height: 52))
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel()
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: 12) {
                        ForEach(store.shoppers) { shopper in
                            Button { openShopper = shopper } label: { ShopperTile(shopper: shopper) }
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
                .scrollClipDisabled()
                .padding(.horizontal, -20)
            }
        }
        .padding(.top, 26)
    }

    @ViewBuilder
    private var latest: some View {
        let items = Array(store.activity.prefix(5))
        if !items.isEmpty {
            VStack(spacing: 10) {
                HStack {
                    Text("Recent")
                        .font(.system(size: 18, weight: .semibold))
                    Spacer()
                    Button("See all") { tab = .activity }
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Color.glow)
                        .frame(minHeight: 44)
                }
                ActivityPanel(items: items) { openReceipt = $0 }
            }
            .padding(.top, 20)
        }
    }

    private var loading: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading your account…")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .glassPanel()
        .padding(.top, 80)
    }
}

/// A blocked purchase waiting for the owner: allow it once, raise the limit, or say no.
struct RequestCard: View {
    @Environment(AppStore.self) private var store
    let request: ApprovalRequest

    var body: some View {
        let busy = store.deciding.contains(request.id)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: request.kind == "untrusted-store" ? "exclamationmark.shield.fill" : "hand.raised.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(Color.blocked)
                    .frame(width: 40, height: 40)
                    .background(Color.blocked.opacity(0.16), in: .circle)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(request.shopper.name) wants \(request.offer.title.lowercased())")
                        .font(.system(size: 16, weight: .semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Text(request.offer.store.name)
                        if !request.offer.store.trusted {
                            Text("Not a trusted store").foregroundStyle(Color.blocked)
                        }
                    }
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
                }
                Spacer(minLength: 8)
                Text(request.offer.money.text)
                    .font(.system(size: 18, weight: .medium))
            }

            Text(request.reason)
                .font(.system(size: 14))
                .foregroundStyle(Color.blocked)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)

            if request.kind == "untrusted-store" {
                Text("Your money didn't move. You can only say no to a store you don't trust.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
                    .padding(.top, 4)
            }

            if let error = store.requestErrors[request.id] {
                Text(error)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.blocked)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }

            if busy {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Working on it…")
                        .font(.system(size: 15, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 48)
                .padding(.top, 14)
            } else {
                HStack(spacing: 8) {
                    if request.canAllowOnce {
                        Button("Allow once") { confirmThen("allow-once", "Confirm it's you to pay \(request.offer.money.text) to \(request.offer.store.name).") }
                            .buttonStyle(LensButtonStyle(height: 46))
                    }
                    if request.canRaise, let limit = request.suggestedLimit {
                        Button("Raise to \(Money(limit).short)") { confirmThen("raise-limit", "Confirm it's you to raise \(request.shopper.name)'s limit to \(Money(limit).short).") }
                            .font(.system(size: 15, weight: .semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                            .glassEffect(.regular.interactive(), in: .capsule)
                    }
                    Button(request.canAllowOnce ? "No" : "No, don't pay") {
                        Task { await store.decide(request, "decline") }
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.blocked)
                    .frame(maxWidth: request.canAllowOnce ? 72 : .infinity)
                    .frame(height: 46)
                    .glassEffect(.regular.interactive(), in: .capsule)
                }
                .padding(.top, 14)
            }
        }
        .padding(18)
        .glassPanel()
        .animation(.snappy(duration: 0.2), value: busy)
    }

    private func confirmThen(_ decision: String, _ reason: String) {
        Task {
            guard await Owner.confirm(reason) else {
                store.requestErrors[request.id] = "That wasn't confirmed, so nothing changed."
                return
            }
            await store.decide(request, decision)
        }
    }
}

/// Spending someone else shared with you.
struct SharedCard: View {
    let shared: SharedSpending

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "gift")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Color.ink)
                .frame(width: 44, height: 44)
                .background(.white.opacity(0.92), in: .circle)
            VStack(alignment: .leading, spacing: 2) {
                Text("From \(shared.ownerName)")
                    .font(.system(size: 16, weight: .medium))
                Text(shared.isActive
                     ? "\(Money(shared.limit).short) a \(shared.period) at trusted stores"
                     : "No longer shared")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.soft)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(shared.leftMoney.short)
                    .font(.system(size: 20, weight: .medium))
                Text("left")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.soft)
            }
            if shared.isActive {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.soft)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 18)
        .frame(height: 84)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 28))
        .opacity(shared.isActive ? 1 : 0.6)
        .accessibilityElement(children: .combine)
    }
}

/// One shopper as a small glass tile: how much is left of its limit.
struct ShopperTile: View {
    @Environment(AppStore.self) private var store
    let shopper: Shopper

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                Ring(share: shopper.leftShare, color: .shopper(shopper.colorIndex))
                    .frame(width: 46, height: 46)
                    .padding(3)
                Spacer()
                Image(systemName: shopper.kindIcon)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
            }
            Text(shopper.name)
                .font(.system(size: 15, weight: .medium))
                .padding(.top, 12)
            if shopper.isWaiting {
                Text("Waiting")
                    .font(.system(size: 24, weight: .medium))
                    .tracking(-0.8)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(shopper.leftMoney.short)
                        .font(.system(size: 24, weight: .medium))
                        .tracking(-0.8)
                    Text("left")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                }
                .minimumScaleFactor(0.6)
            }
            Text(store.working[shopper.id] ?? (shopper.isWaiting ? "to connect" : "of \(shopper.limitMoney.short) a \(shopper.period)"))
                .font(.system(size: 12))
                .foregroundStyle(Color.soft)
        }
        .lineLimit(1)
        .padding(16)
        .frame(width: 156, height: 176, alignment: .topLeading)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 28))
        .accessibilityElement(children: .combine)
    }
}

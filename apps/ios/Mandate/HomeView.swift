// Home: what's available, who can spend it, and what just happened.
import SwiftUI

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @Binding var tab: AppTab
    @State private var adding = false
    @State private var openMandate: Mandate?
    @State private var openReceipt: Activity?

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                HStack {
                    Wordmark()
                    Spacer()
                    if let name = store.overview?.owner.name {
                        Text(name)
                            .font(.system(size: 14))
                            .foregroundStyle(Color.soft)
                    }
                }
                .frame(height: 44)

                if let balance = store.balance {
                    summary(balance)
                    mandates
                    latest
                } else {
                    waiting
                }
            }
        }
        .fullScreenCover(isPresented: $adding) { NewMandateView() }
        .sheet(item: $openMandate) { MandateDetail(mandateID: $0.id) }
        .sheet(item: $openReceipt) { ReceiptView(item: $0) }
    }

    private func summary(_ balance: Money) -> some View {
        VStack(spacing: 6) {
            Text("Available")
                .font(.system(size: 14))
                .foregroundStyle(Color.soft)
            AmountText(money: balance)
            HStack(spacing: 10) {
                Text("\(store.spentToday?.text ?? "") spent today")
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
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 26)
    }

    private var mandates: some View {
        VStack(spacing: 10) {
            HStack {
                Text("Mandates")
                    .font(.system(size: 18, weight: .semibold))
                Spacer()
                Button { adding = true } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("New mandate")
            }

            if store.mandates.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Let someone shop for you")
                        .font(.system(size: 20, weight: .medium))
                    Text("Give a mandate a limit. It can spend up to that, at trusted stores only, and you see every purchase.")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.soft)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("New mandate") { adding = true }
                        .buttonStyle(LensButtonStyle(height: 52))
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel()
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: 12) {
                        ForEach(store.mandates) { mandate in
                            Button { openMandate = mandate } label: { MandateCard(mandate: mandate) }
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
        let items = Array(store.activity.prefix(4))
        if !items.isEmpty {
            VStack(spacing: 10) {
                HStack {
                    Text("Latest")
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

    private var waiting: some View {
        VStack(spacing: 12) {
            if let problem = store.problem {
                Text(problem)
                    .font(.system(size: 17, weight: .medium))
                Text("Check that the Mandate service is running, then look under You for its address.")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
                    .multilineTextAlignment(.center)
            } else {
                ProgressView()
                Text("Opening your account…")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .glassPanel()
        .padding(.top, 80)
    }
}

/// One mandate as a glass card: how much is left of its limit.
struct MandateCard: View {
    @Environment(AppStore.self) private var store
    let mandate: Mandate

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Ring(share: mandate.leftShare, color: .mandate(mandate.id))
                .frame(width: 46, height: 46)
                .padding(3)
            Text(mandate.name)
                .font(.system(size: 15, weight: .medium))
                .padding(.top, 12)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(mandate.leftMoney?.short ?? "")
                    .font(.system(size: 24, weight: .medium))
                    .tracking(-0.8)
                Text("left")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.soft)
            }
            .minimumScaleFactor(0.6)
            Text(store.working[mandate.id] ?? mandate.allowance)
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

// The account as the app knows it: balance, shoppers, activity, and the
// things the owner can do. Refreshes itself every few seconds.
import Foundation
import Observation

/// A short notice shown at the top of the screen when a shopper pays or is blocked.
struct Banner: Identifiable, Equatable {
    let id = UUID()
    let blocked: Bool
    let title: String
    let detail: String
}

@MainActor
@Observable
final class AppStore {
    static let defaultAddress = "http://localhost:4022"
    private static let addressKey = "serviceAddress"

    var overview: Overview?
    var activity: [Activity] = []
    /// Set when the account can't be reached.
    var problem: String?
    var banner: Banner?
    /// What each shopper is doing right now, by id, e.g. "Buying…".
    var working: [Int: String] = [:]

    /// Where the Mandate service runs. On a real phone this is the Mac's address.
    var serviceAddress: String {
        didSet { UserDefaults.standard.set(serviceAddress, forKey: Self.addressKey) }
    }

    private var seen: Set<String>?
    private var loop: Task<Void, Never>?

    init() {
        serviceAddress = UserDefaults.standard.string(forKey: Self.addressKey) ?? Self.defaultAddress
    }

    private var api: API {
        API(base: URL(string: serviceAddress) ?? URL(string: Self.defaultAddress)!)
    }

    // MARK: Reading

    var token: TokenInfo? { overview?.account.token }
    var shoppers: [Shopper] { overview?.mandates.filter(\.isActive) ?? [] }
    var stopped: [Shopper] { overview?.mandates.filter { !$0.isActive } ?? [] }

    var balance: Money? {
        overview.map { Money(base: $0.account.balance, token: $0.account.token) }
    }

    var spentToday: Money? {
        guard let token else { return nil }
        let total = activity
            .filter { !$0.blocked && $0.token.id == token.id && Calendar.current.isDateInToday($0.date) }
            .reduce(Decimal(0)) { $0 + $1.money.value }
        return Money(value: total, token: token)
    }

    var blockedToday: Int {
        activity.filter { $0.blocked && Calendar.current.isDateInToday($0.date) }.count
    }

    func shopper(_ id: Int) -> Shopper? {
        overview?.mandates.first { $0.id == id }
    }

    func activity(for shopper: Shopper) -> [Activity] {
        activity.filter { $0.agent.ruleId == shopper.ruleId }
    }

    // MARK: Refreshing

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func refresh() async {
        do {
            async let nextOverview = api.overview()
            async let nextActivity = api.activity()
            let (newOverview, newActivity) = try await (nextOverview, nextActivity)
            overview = newOverview
            activity = newActivity
            problem = nil

            // Remember what was already there on first load; announce what comes after.
            if let known = seen {
                let arrived = newActivity.filter { !known.contains($0.id) }
                if let newest = arrived.first { announce(newest) }
                seen = known.union(newActivity.map(\.id))
            } else {
                seen = Set(newActivity.map(\.id))
            }
        } catch {
            problem = error.localizedDescription
        }
    }

    private func announce(_ item: Activity) {
        let next = item.blocked
            ? Banner(blocked: true, title: "Blocked: \(item.seller.name)", detail: "\(item.reason ?? "Blocked"). Nothing was paid.")
            : Banner(blocked: false, title: "\(item.agent.name) paid \(item.seller.name)", detail: "\(item.money.text) for \(item.item.lowercased())")
        banner = next
        Task {
            try? await Task.sleep(for: .seconds(4.5))
            if banner == next { banner = nil }
        }
    }

    // MARK: Actions

    func create(name: String, limit: String, period: String) async throws {
        _ = try await api.createShopper(name: name, limit: limit, period: period)
        await refresh()
    }

    func stop(_ shopper: Shopper) async {
        working[shopper.id] = "Stopping…"
        do {
            try await api.stop(ruleId: shopper.ruleId)
        } catch {
            problem = error.localizedDescription
        }
        working[shopper.id] = nil
        await refresh()
    }

    /// Sends a shopper to buy one thing. The result shows up as a notice and in activity.
    func send(_ shopper: Shopper, toBuy item: CatalogItem) async {
        working[shopper.id] = "Buying \(item.title.lowercased())…"
        do {
            _ = try await api.purchase(ruleId: shopper.ruleId, itemId: item.id)
        } catch {
            problem = error.localizedDescription
        }
        working[shopper.id] = nil
        await refresh()
    }
}

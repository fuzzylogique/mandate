// The account as the app knows it: balance, mandates, activity, and the
// things the owner can do. Refreshes itself every few seconds.
import Foundation
import Observation

/// A short notice shown at the top of the screen when a mandate pays or is blocked.
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
    var requiresSignIn = false
    var problem: String?
    var banner: Banner?
    /// What each mandate is doing right now, by id, e.g. "Buying…".
    var working: [Int: String] = [:]

    /// Where the Mandate service runs. On a real phone this is the Mac's address.
    var serviceAddress: String {
        didSet { UserDefaults.standard.set(serviceAddress, forKey: Self.addressKey) }
    }

    private var sessionVersion = 0
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
    var mandates: [Mandate] { overview?.mandates.filter(\.isActive) ?? [] }
    var stopped: [Mandate] { overview?.mandates.filter { !$0.isActive } ?? [] }

    var balance: Money? {
        overview.map { Money(base: $0.account.balance, token: $0.account.token) }
    }

    var spentToday: Money? {
        guard let token else { return nil }
        let total = activity
            .filter { $0.kind == "paid" && $0.token.id == token.id && Calendar.current.isDateInToday($0.date) }
            .reduce(Decimal(0)) { $0 + $1.money.value }
        return Money(value: total, token: token)
    }

    var blockedToday: Int {
        activity.filter { $0.blocked && Calendar.current.isDateInToday($0.date) }.count
    }

    func mandate(_ id: Int) -> Mandate? {
        overview?.mandates.first { $0.id == id }
    }

    func activity(for mandate: Mandate) -> [Activity] {
        activity.filter { $0.agent.ruleId == mandate.ruleId }
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
        let version = sessionVersion
        do {
            let (newOverview, newActivity) = try await api.workspace()
            guard version == sessionVersion else { return }
            overview = newOverview
            activity = newActivity
            problem = nil
            requiresSignIn = false

            // Remember what was already there on first load; announce what comes after.
            if let known = seen {
                let arrived = newActivity.filter { !known.contains($0.id) }
                if let newest = arrived.first { announce(newest) }
                seen = known.union(newActivity.map(\.id))
            } else {
                seen = Set(newActivity.map(\.id))
            }
        } catch {
            guard version == sessionVersion else { return }
            if (error as? APIError)?.status == 401 {
                requiresSignIn = true; overview = nil; activity = []; seen = nil
            }
            problem = error.localizedDescription
        }
    }

    func signIn(name: String?, email: String, password: String) async throws {
        try await api.signIn(name: name, email: email, password: password)
        sessionVersion += 1
        overview = nil; activity = []; seen = nil; requiresSignIn = false
        await refresh()
    }
    func signOut() async throws {
        try await api.signOut()
        sessionVersion += 1
        overview = nil; activity = []; seen = nil; requiresSignIn = true
    }
    func reveal(_ mandate: Mandate) async throws -> String { try await api.reveal(reference: mandate.reference) }

    private func announce(_ item: Activity) {
        if item.isFunding { return }
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

    func create(name: String, limit: String, period: String, expiresAt: String, requestId: String) async throws {
        _ = try await api.createMandate(name: name, limit: limit, period: period, expiresAt: expiresAt, requestId: requestId)
        await refresh()
    }

    func stop(_ mandate: Mandate) async {
        working[mandate.id] = "Stopping…"
        do {
            try await api.stop(reference: mandate.reference)
        } catch {
            problem = error.localizedDescription
        }
        working[mandate.id] = nil
        await refresh()
    }

}

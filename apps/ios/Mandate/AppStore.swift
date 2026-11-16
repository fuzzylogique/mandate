// The account as the app knows it: who is signed in, the balance, shoppers,
// requests and activity, and everything the owner can do. Refreshes itself
// every few seconds while the app is open.
import Foundation
import Observation
import UserNotifications

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

    enum Phase: Equatable { case launching, signedOut, signedIn }

    var phase: Phase = .launching
    var customer: Customer?
    var overview: Overview?
    var activity: [Activity] = []
    /// Set when the account can't be reached.
    var problem: String?
    var banner: Banner?
    /// What each shopper is doing right now, by id, e.g. "Shopping…".
    var working: [String: String] = [:]
    /// The last thing each shopper did when asked from this phone.
    var outcomes: [String: PurchaseOutcome] = [:]
    /// Requests being answered right now.
    var deciding: Set<String> = []
    var requestErrors: [String: String] = [:]
    /// Set once the owner skips opening an account (they only use shared spending).
    var skippedSetup = false
    /// True while the first-run steps are on screen.
    var settingUp = false

    /// Where the Mandate service runs. On a real phone this is the Mac's address.
    var serviceAddress: String {
        didSet { UserDefaults.standard.set(serviceAddress, forKey: Self.addressKey) }
    }

    private var seenActivity: Set<String>?
    private var seenRequests: Set<String>?
    private var loop: Task<Void, Never>?

    init() {
        serviceAddress = UserDefaults.standard.string(forKey: Self.addressKey) ?? Self.defaultAddress
    }

    private var api: API {
        API(base: URL(string: serviceAddress) ?? URL(string: Self.defaultAddress)!)
    }

    // MARK: Reading

    var account: Account? { overview?.account }
    var hasAccount: Bool { overview?.account.isOpen == true }
    var balance: Money? { hasAccount ? overview?.account.money : nil }
    var requests: [ApprovalRequest] { overview?.requests.filter { $0.status == "pending" } ?? [] }
    var shared: [SharedSpending] { overview?.shared ?? [] }
    var shoppers: [Shopper] { overview?.shoppers.filter(\.isLive) ?? [] }
    var stopped: [Shopper] { overview?.shoppers.filter { !$0.isLive } ?? [] }
    var trustedStores: [Store] { overview?.stores.filter(\.trusted) ?? [] }
    var lookalikes: [Store] { overview?.stores.filter { !$0.trusted } ?? [] }

    var spentToday: Money {
        let total = activity
            .filter { $0.paid && Calendar.current.isDateInToday($0.date) }
            .reduce(Decimal(0)) { $0 + $1.money.value }
        return Money(value: total)
    }

    var blockedToday: Int {
        activity.filter { $0.blocked && Calendar.current.isDateInToday($0.date) }.count
    }

    func shopper(_ id: String) -> Shopper? {
        overview?.shoppers.first { $0.id == id }
    }

    func activity(for shopper: Shopper) -> [Activity] {
        activity.filter { $0.shopper?.id == shopper.id }
    }

    // MARK: Signing in

    /// On launch: is there still a session?
    func resume() async {
        do {
            customer = try await api.me()
            await signedIn()
        } catch let error as APIError where error.signedOut {
            phase = .signedOut
        } catch {
            problem = error.localizedDescription
            phase = .signedOut
        }
    }

    func register(name: String, email: String, password: String) async throws {
        customer = try await api.register(name: name, email: email, password: password)
        await signedIn()
    }

    func login(email: String, password: String) async throws {
        customer = try await api.login(email: email, password: password)
        await signedIn()
    }

    private func signedIn() async {
        problem = nil
        await refresh()
        if overview?.account.isOpen == false { settingUp = true }
        phase = .signedIn
        start()
        await askForNotifications()
    }

    func signOut() async {
        stop()
        await api.logout()
        customer = nil
        overview = nil
        activity = []
        seenActivity = nil
        seenRequests = nil
        outcomes = [:]
        working = [:]
        requestErrors = [:]
        skippedSetup = false
        settingUp = false
        phase = .signedOut
    }

    // MARK: Refreshing

    /// Polls while the app is in front.
    func start() {
        guard loop == nil, phase == .signedIn || customer != nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { break }
                await self?.refresh()
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    func refresh() async {
        do {
            async let nextOverview = api.overview()
            async let nextActivity = api.activity()
            let (newOverview, newActivity) = try await (nextOverview, nextActivity)
            overview = newOverview
            customer = newOverview.customer
            activity = newActivity
            problem = nil
            noticeNewActivity(newActivity)
            noticeNewRequests(newOverview.requests.filter { $0.status == "pending" })
        } catch let error as APIError where error.signedOut {
            stop()
            phase = .signedOut
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Remember what was there on first load; announce what comes after.
    private func noticeNewActivity(_ items: [Activity]) {
        if let known = seenActivity {
            let arrived = items.filter { !known.contains($0.id) }
            // A blocked purchase that needs a decision gets its own notification instead.
            if let newest = arrived.first(where: { !($0.blocked && $0.requestId != nil) }) { announce(newest) }
            seenActivity = known.union(items.map(\.id))
        } else {
            seenActivity = Set(items.map(\.id))
        }
    }

    private func noticeNewRequests(_ pending: [ApprovalRequest]) {
        if let known = seenRequests {
            for request in pending where !known.contains(request.id) { notify(request) }
            seenRequests = known.union(pending.map(\.id))
        } else {
            seenRequests = Set(pending.map(\.id))
        }
    }

    private func announce(_ item: Activity) {
        let next: Banner
        if item.added {
            next = Banner(blocked: false, title: "Money added", detail: "\(item.money.text) is in your account")
        } else if item.blocked {
            next = Banner(blocked: true, title: "Blocked: \(item.storeName)", detail: "\(item.reason ?? "Blocked"). Nothing was paid.")
        } else {
            let who = item.byYou ? "You" : (item.shopper?.name ?? "A shopper")
            next = Banner(blocked: false, title: "\(who) paid \(item.storeName)", detail: "\(item.money.text) for \(item.item.lowercased())")
        }
        show(next)
    }

    func show(_ next: Banner) {
        banner = next
        Task {
            try? await Task.sleep(for: .seconds(4.5))
            if banner == next { banner = nil }
        }
    }

    // MARK: Notifications

    private func askForNotifications() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    private func notify(_ request: ApprovalRequest) {
        let content = UNMutableNotificationContent()
        content.title = "\(request.shopper.name) needs you"
        content.body = "\(request.offer.title) from \(request.offer.store.name), \(request.offer.money.text). \(request.reason)."
        content.sound = .default
        let note = UNNotificationRequest(identifier: "request-\(request.id)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(note)
    }

    // MARK: The account

    func openAccount() async throws {
        _ = try await api.openAccount()
        await refresh()
    }

    func addMoney(_ amount: String) async throws {
        _ = try await api.addMoney(amount)
        await refresh()
    }

    // MARK: Shoppers

    func create(_ input: API.NewShopper) async throws -> Shopper {
        let shopper = try await api.createShopper(input)
        await refresh()
        return shopper
    }

    func stop(_ shopper: Shopper) async {
        working[shopper.id] = "Stopping…"
        do {
            try await api.stop(shopper.id)
        } catch {
            show(Banner(blocked: true, title: "Couldn't stop \(shopper.name)", detail: error.localizedDescription))
        }
        working[shopper.id] = nil
        await refresh()
    }

    /// Shop now, or test the rules: really tries the payment, so the account's rules decide.
    func run(_ shopper: Shopper, test: String? = nil) async {
        working[shopper.id] = test == nil ? "Comparing stores…" : "Trying it…"
        outcomes[shopper.id] = nil
        do {
            let outcome = try await api.run(shopper.id, test: test)
            outcomes[shopper.id] = outcome
        } catch {
            outcomes[shopper.id] = PurchaseOutcome(status: "nothing", txHash: nil, explorerUrl: nil, offer: nil, note: nil, reason: error.localizedDescription, requestId: nil)
        }
        working[shopper.id] = nil
        await refresh()
    }

    func newPairingCode(_ shopper: Shopper) async {
        working[shopper.id] = "Making a new code…"
        do {
            _ = try await api.newPairingCode(shopper.id)
        } catch {
            show(Banner(blocked: true, title: "No new code", detail: error.localizedDescription))
        }
        working[shopper.id] = nil
        await refresh()
    }

    // MARK: Requests

    func decide(_ request: ApprovalRequest, _ decision: String) async {
        deciding.insert(request.id)
        requestErrors[request.id] = nil
        do {
            let result = try await api.decide(request.id, decision)
            if result.status == "failed" {
                requestErrors[request.id] = result.error ?? "That didn't go through. Try again."
            } else {
                // The blocked attempt on the shopper's card is settled now.
                if outcomes[request.shopper.id]?.requestId == request.id { outcomes[request.shopper.id] = nil }
            }
            if result.status != "failed" && decision != "decline" {
                let title = decision == "allow-once" ? "You paid \(request.offer.store.name)" : "Limit raised for \(request.shopper.name)"
                show(Banner(blocked: false, title: title, detail: "\(request.offer.money.text) for \(request.offer.title.lowercased())"))
            }
        } catch {
            requestErrors[request.id] = error.localizedDescription
        }
        deciding.remove(request.id)
        await refresh()
    }

    // MARK: Shared with you

    func sharedOffers(_ shared: SharedSpending, query: String) async throws -> [Offer] {
        try await api.sharedOffers(shared.id, query: query)
    }

    func sharedPay(_ shared: SharedSpending, offer: Offer) async throws -> PurchaseOutcome {
        let outcome = try await api.sharedPay(shared.id, offerId: offer.id)
        await refresh()
        return outcome
    }
}

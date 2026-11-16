// What the Mandate service sends (packages/shared/src/api.ts), and how money and dates are worded.
import Foundation

/// An amount in dollars. The service sends decimal strings like "2.4".
struct Money: Hashable {
    let value: Decimal

    init(value: Decimal) { self.value = value }

    init(_ text: String?) { self.init(value: Decimal(string: text ?? "") ?? 0) }

    private func number(minDigits: Int, maxDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        formatter.minimumFractionDigits = minDigits
        formatter.maximumFractionDigits = maxDigits
        return formatter.string(from: value as NSDecimalNumber) ?? "0"
    }

    private var isWhole: Bool {
        let double = NSDecimalNumber(decimal: value).doubleValue
        return double == double.rounded()
    }

    /// "$4.20"
    var text: String { "$\(number(minDigits: 2, maxDigits: 2))" }

    /// "$50" when there are no cents, otherwise "$17.60".
    var short: String { "$\(isWhole ? number(minDigits: 0, maxDigits: 0) : number(minDigits: 2, maxDigits: 2))" }

    /// The balance split for the large display: "$482" and ".60".
    var parts: (whole: String, cents: String, suffix: String) {
        let pieces = number(minDigits: 2, maxDigits: 2).split(separator: ".")
        let whole = String(pieces.first ?? "0")
        let cents = "." + String(pieces.count > 1 ? pieces[1] : "00")
        return ("$\(whole)", cents, "")
    }

    static func - (lhs: Money, rhs: Money) -> Money { Money(value: lhs.value - rhs.value) }
}

enum Period {
    /// "week" → "weekly"
    static func adverb(_ period: String) -> String {
        switch period {
        case "day": "daily"
        case "month": "monthly"
        default: "weekly"
        }
    }

    /// "week" → "this week"
    static func current(_ period: String) -> String {
        switch period {
        case "day": "today"
        case "month": "this month"
        default: "this week"
        }
    }
}

struct Customer: Codable, Hashable {
    let id: String
    let name: String
    let email: String
}

struct Account: Codable, Hashable {
    let status: String
    let address: String?
    let balance: String
    let currency: String
    let explorerUrl: String?

    var isOpen: Bool { status == "ready" }
    var money: Money { Money(balance) }
}

struct Store: Codable, Hashable {
    let address: String
    let name: String
    let domain: String
    let trusted: Bool
    let looksLike: String?
}

struct Offer: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let price: String
    let store: Store
    let url: String

    var money: Money { Money(price) }
}

struct ShopperJob: Codable, Hashable {
    let item: String
    let every: String
    let nextRunAt: String
    let lastRunAt: String?
    let lastResult: String?
}

struct Pairing: Codable, Hashable {
    let code: String
    let expiresAt: String
}

struct Shopper: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let kind: String
    let status: String
    let limit: String
    let spent: String
    let period: String
    let expiresAt: String
    let createdAt: String
    let job: ShopperJob?
    let holder: String?
    let pairing: Pairing?
    let ruleId: Int?
    let agentKey: String?
    let stopPending: Bool?

    var isHosted: Bool { kind == "hosted" }
    var isAssistant: Bool { kind == "assistant" }
    var isPerson: Bool { kind == "person" }
    var isActive: Bool { status == "active" }
    var isWaiting: Bool { status == "waiting" }
    /// Still on the list: working, or waiting to connect.
    var isLive: Bool { isActive || isWaiting }

    var limitMoney: Money { Money(limit) }
    var spentMoney: Money { Money(spent) }
    var leftMoney: Money { Money(value: max(0, limitMoney.value - spentMoney.value)) }

    /// Share of the limit already spent, 0 to 1.
    var spentShare: Double {
        guard limitMoney.value > 0 else { return 0 }
        return min(1, NSDecimalNumber(decimal: spentMoney.value / limitMoney.value).doubleValue)
    }

    /// Share of the limit still unspent, 0 to 1.
    var leftShare: Double { 1 - spentShare }

    /// A stable colour per shopper.
    var colorIndex: Int { id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) } }

    /// "Shops for you", "Your AI assistant", "Shared with sam@…"
    var kindLabel: String {
        switch kind {
        case "hosted": "Shops for you"
        case "assistant": "Your AI assistant"
        default: "Shared with \(holder ?? "someone")"
        }
    }

    var kindIcon: String {
        switch kind {
        case "hosted": "cart"
        case "assistant": "text.bubble"
        default: "person.2"
        }
    }

    /// "Keeps herbs stocked · weekly"
    var jobLine: String? {
        guard let job else { return nil }
        return "Keeps \(job.item.lowercased()) stocked · \(Period.adverb(job.every))"
    }

    /// "Up to $10 a week, at trusted stores only"
    var rule: String { "Up to \(limitMoney.short) a \(period), at trusted stores only" }

    var statusLabel: String {
        if stopPending == true { return "Stopping" }
        switch status {
        case "active": return "Active"
        case "waiting": return "Waiting to connect"
        case "expired": return "Ended"
        default: return "Stopped"
        }
    }
}

struct ShopperRef: Codable, Hashable {
    let id: String
    let name: String
    let kind: String?
}

struct ApprovalRequest: Codable, Identifiable, Hashable {
    let id: String
    let shopper: ShopperRef
    let offer: Offer
    let reason: String
    let kind: String
    let suggestedLimit: String?
    let status: String
    let createdAt: String
    let resolvedAt: String?
    let txHash: String?
    let error: String?

    var canAllowOnce: Bool { kind != "untrusted-store" }
    var canRaise: Bool { kind == "over-limit" && suggestedLimit != nil }
}

struct Proof: Codable, Hashable {
    let smartAccount: String
    let ruleId: Int?
    let agentKey: String?
    let checks: [String]
}

/// One line of activity: a payment, a blocked purchase, or money added.
struct Activity: Codable, Identifiable, Hashable {
    let id: String
    let kind: String
    let at: String
    let shopper: ShopperRef?
    let store: Store?
    let item: String
    let amount: String
    let note: String?
    let reason: String?
    let requestId: String?
    let paidBy: String?
    let txHash: String?
    let explorerUrl: String?
    let proof: Proof?

    var blocked: Bool { kind == "blocked" }
    var added: Bool { kind == "added" }
    var paid: Bool { kind == "paid" }
    var byYou: Bool { paidBy == "you" }
    var date: Date { Dates.parse(at) }
    var money: Money { Money(amount) }
    var storeName: String { store?.name ?? "A store" }
}

struct SharedSpending: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let ownerName: String
    let limit: String
    let spent: String
    let period: String
    let expiresAt: String
    let status: String

    var leftMoney: Money { Money(value: max(0, Money(limit).value - Money(spent).value)) }
    var isActive: Bool { status == "active" }
}

struct Network: Codable, Hashable {
    let name: String
    let explorerUrl: String
}

struct Overview: Codable {
    let customer: Customer
    let account: Account
    let shoppers: [Shopper]
    let stores: [Store]
    let requests: [ApprovalRequest]
    let shared: [SharedSpending]
    let network: Network
}

/// What happened when a shopper tried to buy: paid, blocked, or nothing to do.
struct PurchaseOutcome: Codable, Hashable {
    let status: String
    let txHash: String?
    let explorerUrl: String?
    let offer: Offer?
    let note: String?
    let reason: String?
    let requestId: String?

    /// One sentence for a notice.
    var summary: String {
        switch status {
        case "paid":
            guard let offer else { return "Paid" }
            return "Bought \(offer.title.lowercased()) from \(offer.store.name) for \(offer.money.text)"
        case "blocked":
            return "Blocked: \(reason ?? "the rules stopped it")"
        default:
            return reason ?? "Nothing to buy right now"
        }
    }
}

enum Dates {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain = ISO8601DateFormatter()

    static func parse(_ text: String) -> Date {
        withFraction.date(from: text) ?? plain.date(from: text) ?? .distantPast
    }

    static func iso(_ date: Date) -> String { withFraction.string(from: date) }

    static func time(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened).lowercased()
    }

    /// "2:14 pm" today, otherwise "Nov 13, 2:14 pm".
    static func short(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return time(date) }
        return "\(date.formatted(.dateTime.month(.abbreviated).day())), \(time(date))"
    }

    /// "Nov 13"
    static func day(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// "Saturday, November 14 at 2:14 pm"
    static func long(_ date: Date) -> String {
        "\(date.formatted(.dateTime.weekday(.wide).month(.wide).day())) at \(time(date))"
    }

    /// "in 3 days", "in 5 min", "now"
    static func relative(_ date: Date) -> String {
        if date.timeIntervalSinceNow < 60 { return "any moment" }
        return date.formatted(.relative(presentation: .numeric, unitsStyle: .wide))
    }
}

/// Shortens a long address for display: "CBX4…Q2ZA".
func shortened(_ text: String) -> String {
    guard text.count > 12 else { return text }
    return "\(text.prefix(4))…\(text.suffix(4))"
}

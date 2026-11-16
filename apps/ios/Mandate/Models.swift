// What the Mandate service sends, and how money and dates are worded.
import Foundation

struct TokenInfo: Codable, Hashable {
    let id: String
    let symbol: String
}

/// An amount in the account's currency. Dollar-pegged money reads as dollars;
/// anything else shows its symbol.
struct Money: Hashable {
    let value: Decimal
    let token: TokenInfo

    init(value: Decimal, token: TokenInfo) {
        self.value = value
        self.token = token
    }

    /// The service sends amounts as whole numbers with seven decimal places.
    init(base: String, token: TokenInfo) {
        self.init(value: (Decimal(string: base) ?? 0) / 10_000_000, token: token)
    }

    var isDollars: Bool { token.symbol == "USDC" || token.symbol == "USD" }

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

    private func wrap(_ number: String) -> String {
        isDollars ? "$\(number)" : "\(number) \(token.symbol)"
    }

    /// "$4.20"
    var text: String { wrap(number(minDigits: 2, maxDigits: 2)) }

    /// "$50" when there are no cents, otherwise "$17.60".
    var short: String { wrap(isWhole ? number(minDigits: 0, maxDigits: 0) : number(minDigits: 2, maxDigits: 2)) }

    /// The balance split for the large display: "$482", ".60" and a trailing symbol if any.
    var parts: (whole: String, cents: String, suffix: String) {
        let pieces = number(minDigits: 2, maxDigits: 2).split(separator: ".")
        let whole = String(pieces.first ?? "0")
        let cents = "." + String(pieces.count > 1 ? pieces[1] : "00")
        return (isDollars ? "$\(whole)" : whole, cents, isDollars ? "" : token.symbol)
    }
}

/// Someone you've allowed to spend, and the limit they spend under.
struct Mandate: Codable, Identifiable, Hashable {
    let reference: String
    let ruleId: Int
    let name: String
    let status: String
    let token: TokenInfo
    let limit: String?
    let spent: String
    let period: String?
    let createdAt: String

    var id: Int { ruleId }
    var isActive: Bool { status == "active" && limit != nil }

    var limitMoney: Money? { limit.map { Money(base: $0, token: token) } }
    var spentMoney: Money { Money(base: spent, token: token) }

    var leftMoney: Money? {
        guard let limitMoney else { return nil }
        return Money(value: max(0, limitMoney.value - spentMoney.value), token: token)
    }

    /// Share of the limit still unspent, 0 to 1.
    var leftShare: Double {
        guard let limitMoney, limitMoney.value > 0, let leftMoney else { return 0 }
        return NSDecimalNumber(decimal: leftMoney.value / limitMoney.value).doubleValue
    }

    /// "of $50 a week"
    var allowance: String {
        guard let limitMoney else { return "Stopped" }
        return "of \(limitMoney.short) a \(period ?? "day")"
    }

    /// "Up to $50 a week, at trusted stores only"
    var rule: String {
        guard let limitMoney else { return "Stopped" }
        return "Up to \(limitMoney.short) a \(period ?? "day"), at trusted stores only"
    }
}

struct Seller: Codable, Hashable {
    let address: String
    let name: String
    let domain: String
    let verified: Bool
}

struct CatalogItem: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let seller: Seller
    let price: String
}

struct Overview: Codable {
    struct Owner: Codable { let name: String }
    struct Account: Codable {
        let address: String
        let token: TokenInfo
        let balance: String
    }

    let owner: Owner
    let account: Account
    let mandates: [Mandate]
    let sellers: [Seller]
    let catalog: [CatalogItem]
}

/// One line of activity: a payment that went through, or one that was blocked.
struct Activity: Codable, Identifiable, Hashable {
    struct Who: Codable, Hashable {
        let ruleId: Int
        let name: String
    }

    let id: String
    let kind: String
    let at: String
    let agent: Who
    let seller: Seller
    let item: String
    let amount: String
    let token: TokenInfo
    let txHash: String?
    let reason: String?

    var blocked: Bool { kind == "declined" }
    var isFunding: Bool { kind == "funding" }
    var date: Date { Dates.parse(at) }
    var money: Money { Money(base: amount, token: token) }
}

struct PurchaseResult: Codable {
    let status: String
    let txHash: String?
    let reason: String?
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

    static func time(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened).lowercased()
    }

    /// "2:14 pm" today, otherwise "Nov 13, 2:14 pm".
    static func short(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return time(date) }
        return "\(date.formatted(.dateTime.month(.abbreviated).day())), \(time(date))"
    }

    /// "Saturday, November 14 at 2:14 pm"
    static func long(_ date: Date) -> String {
        "\(date.formatted(.dateTime.weekday(.wide).month(.wide).day())) at \(time(date))"
    }
}

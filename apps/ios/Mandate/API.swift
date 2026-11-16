// Calls to the Mandate service (apps/receipts). The session lives in a cookie,
// kept in the shared cookie store and backed up in the Keychain.
import Foundation
import Security

struct APIError: LocalizedError {
    let message: String
    var status: Int = 0
    var errorDescription: String? { message }
    var signedOut: Bool { status == 401 }
}

struct API {
    let base: URL

    static let cookieName = "mandate_session"

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = .shared
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        // Opening an account or setting up a shopper takes about ten seconds; a purchase a few.
        configuration.timeoutIntervalForRequest = 120
        return URLSession(configuration: configuration)
    }()

    private struct ErrorBody: Decodable { let error: String? }
    private struct Empty: Encodable {}

    // MARK: Signing in

    private struct Register: Encodable { let name, email, password: String }
    private struct Login: Encodable { let email, password: String }

    func register(name: String, email: String, password: String) async throws -> Customer {
        let customer: Customer = try await decode(send("auth/register", method: "POST", body: Register(name: name, email: email, password: password)))
        saveSession()
        return customer
    }

    func login(email: String, password: String) async throws -> Customer {
        let customer: Customer = try await decode(send("auth/login", method: "POST", body: Login(email: email, password: password)))
        saveSession()
        return customer
    }

    func logout() async {
        _ = try? await send("auth/logout", method: "POST", body: Empty())
        clearSession()
    }

    func me() async throws -> Customer {
        restoreSession()
        return try await decode(send("me"))
    }

    // MARK: The account

    private struct AddMoney: Encodable { let amount, requestId: String }

    func openAccount() async throws -> Account { try await decode(send("account", method: "POST", body: Empty())) }

    func addMoney(_ amount: String) async throws -> Account {
        try await decode(send("account/money", method: "POST", body: AddMoney(amount: amount, requestId: UUID().uuidString)))
    }

    func overview() async throws -> Overview { try await decode(send("overview")) }

    func activity() async throws -> [Activity] { try await decode(send("activity")) }

    // MARK: Shoppers

    struct NewShopper: Encodable {
        struct Job: Encodable { let item: String; let every: String; let startNow: Bool? }
        let name: String
        let kind: String
        let limit: String
        let period: String
        let expiresAt: String?
        let job: Job?
        let holder: String?
        let requestId: String
    }

    private struct Run: Encodable { let test: String? }
    private struct Decision: Encodable { let decision: String }

    func createShopper(_ input: NewShopper) async throws -> Shopper {
        try await decode(send("shoppers", method: "POST", body: input))
    }

    func stop(_ id: String) async throws {
        _ = try await send("shoppers/\(id)", method: "DELETE")
    }

    /// Shop now, or with `test` ("lookalike", "over-limit") try something the rules should refuse.
    func run(_ id: String, test: String? = nil) async throws -> PurchaseOutcome {
        try await decode(send("shoppers/\(id)/run", method: "POST", body: Run(test: test)))
    }

    func newPairingCode(_ id: String) async throws -> Shopper {
        try await decode(send("shoppers/\(id)/pairing", method: "POST", body: Empty()))
    }

    func decide(_ id: String, _ decision: String) async throws -> ApprovalRequest {
        try await decode(send("requests/\(id)", method: "POST", body: Decision(decision: decision)))
    }

    // MARK: Spending shared with you

    private struct Pay: Encodable { let offerId, requestId: String }

    func sharedOffers(_ id: String, query: String) async throws -> [Offer] {
        try await decode(send("shared/\(id)/offers", query: query))
    }

    func sharedPay(_ id: String, offerId: String) async throws -> PurchaseOutcome {
        try await decode(send("shared/\(id)/pay", method: "POST", body: Pay(offerId: offerId, requestId: UUID().uuidString)))
    }

    // MARK: Plumbing

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            #if DEBUG
            print("[api] decode \(T.self) failed: \(error)")
            #endif
            throw APIError(message: "Something unexpected came back. Try again.")
        }
    }

    private func send(_ path: String, method: String = "GET", body: (any Encodable)? = nil, query: String? = nil) async throws -> Data {
        var url = base.appending(path: "api").appending(path: path)
        if let query, !query.isEmpty { url.append(queryItems: [URLQueryItem(name: "q", value: query)]) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw APIError(message: "Can't reach your account right now.")
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "Something went wrong. Try again.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError(message: message ?? "Something went wrong. Try again.", status: http.statusCode)
        }
        return data
    }

    // MARK: Keeping the session

    private var cookieURL: URL { base.appending(path: "api") }

    private func saveSession() {
        guard let cookie = HTTPCookieStorage.shared.cookies(for: cookieURL)?.first(where: { $0.name == Self.cookieName })
        else { return }
        Keychain.save(cookie.value)
    }

    /// Puts the saved session back if the cookie store lost it.
    private func restoreSession() {
        let storage = HTTPCookieStorage.shared
        if storage.cookies(for: cookieURL)?.contains(where: { $0.name == Self.cookieName }) == true { return }
        guard let token = Keychain.load(), let host = base.host() else { return }
        let cookie = HTTPCookie(properties: [
            .name: Self.cookieName,
            .value: token,
            .domain: host,
            .path: "/api",
            .expires: Date().addingTimeInterval(30 * 86_400),
        ])
        if let cookie { storage.setCookie(cookie) }
    }

    private func clearSession() {
        Keychain.delete()
        for cookie in HTTPCookieStorage.shared.cookies ?? [] where cookie.name == Self.cookieName {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
    }
}

/// The signed-in session, kept on this device only.
enum Keychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "mandate.session",
        kSecAttrAccount as String: "session",
    ]

    static func save(_ value: String) {
        delete()
        var item = query
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    static func load() -> String? {
        var item = query
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(item as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

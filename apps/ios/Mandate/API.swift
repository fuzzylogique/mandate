// Calls the authenticated payment workspace used by the web dashboard.
import Foundation

struct APIError: LocalizedError {
    let message: String
    var status: Int? = nil
    var errorDescription: String? { message }
}

struct API {
    let base: URL
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 180
        return URLSession(configuration: configuration)
    }()
    private struct ErrorBody: Decodable { let error: String? }
    private struct Credentials: Encodable { let name: String?; let email: String; let password: String }
    private struct NewMandate: Encodable {
        let name: String; let limit: String; let period: String
        let recipientType = "agent"
        let recipient = "Account agents"
        let expiresAt: String
        let requestId: String
    }
    private struct Creation: Decodable { let mandate: WorkspaceMandate }
    private struct Secret: Decodable { let mandateId: String }

    func signIn(name: String?, email: String, password: String) async throws {
        _ = try await send(name == nil ? "auth/login" : "auth/register", method: "POST", body: Credentials(name: name, email: email, password: password))
    }
    func signOut() async throws { _ = try await send("auth/logout", method: "POST") }
    func workspace() async throws -> (Overview, [Activity]) {
        let workspace: Workspace = try decode(await send("workspace"))
        guard let account = workspace.accounts.first else { throw APIError(message: "Your main account is still being set up.") }
        let token = TokenInfo(id: account.currency, symbol: account.currency)
        let mandates = workspace.mandates.map { $0.view }
        let overview = Overview(owner: .init(name: workspace.customer.name), account: .init(address: account.address ?? account.id, token: token, balance: units(account.balance)), mandates: mandates, sellers: [], catalog: [])
        let activity = workspace.activity.map { entry in
            let mandate = workspace.mandates.first { $0.reference == entry.mandateReference }
            let agent = workspace.agents?.first { $0.id == entry.agentId }
            return Activity(id: entry.id, kind: entry.kind == "funding" ? "funding" : "paid", at: entry.createdAt,
                agent: .init(ruleId: mandate?.ruleId ?? -1, name: agent?.name ?? mandate?.name ?? "You"),
                seller: .init(address: entry.destination, name: entry.kind == "funding" ? "Account funding" : entry.destination, domain: "", verified: entry.kind == "payment" && entry.settlement == "stellar-testnet"),
                item: entry.reference, amount: units(entry.amount), token: .init(id: entry.currency, symbol: entry.currency), txHash: entry.txHash, reason: nil)
        }
        return (overview, activity)
    }
    func createMandate(name: String, limit: String, period: String, expiresAt: String, requestId: String) async throws -> Mandate {
        let result: Creation = try decode(await send("mandates", method: "POST", body: NewMandate(name: name, limit: limit, period: period, expiresAt: expiresAt, requestId: requestId)))
        return result.mandate.view
    }
    func stop(reference: String) async throws { _ = try await send("mandates/\(reference)", method: "DELETE") }
    func reveal(reference: String) async throws -> String {
        let result: Secret = try decode(await send("mandates/\(reference)/reveal", method: "POST"))
        return result.mandateId
    }
    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError(message: "Something unexpected came back. Try again.") }
    }
    private func send(_ path: String, method: String = "GET", body: (any Encodable)? = nil) async throws -> Data {
        let api = base.lastPathComponent == "api" ? base : base.appending(path: "api")
        var request = URLRequest(url: api.appending(path: path))
        request.httpMethod = method
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "content-type") }
        let data: Data; let response: URLResponse
        do { (data, response) = try await Self.session.data(for: request) }
        catch { throw APIError(message: "Can't reach your account right now.") }
        guard let http = response as? HTTPURLResponse else { throw APIError(message: "The service did not return an HTTP response.") }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError(message: message ?? "Something went wrong. Try again.", status: http.statusCode)
        }
        return data
    }
}

private func units(_ amount: String) -> String {
    NSDecimalNumber(decimal: (Decimal(string: amount, locale: Locale(identifier: "en_US_POSIX")) ?? 0) * 10_000_000).stringValue
}
private struct WorkspaceMandate: Decodable {
    let reference: String; let accountId: String; let ruleId: Int?; let name: String; let status: String
    let limit: String; let spent: String; let period: String; let currency: String?; let createdAt: String
    var view: Mandate {
        Mandate(reference: reference, ruleId: ruleId ?? -1, name: name, status: status, token: .init(id: currency ?? "USD", symbol: currency ?? "USD"), limit: units(limit), spent: units(spent), period: period, createdAt: createdAt)
    }
}
private struct Workspace: Decodable {
    struct Customer: Decodable { let name: String }
    struct Account: Decodable { let id: String; let address: String?; let currency: String; let balance: String }
    struct Agent: Decodable { let id: String; let name: String }
    struct Entry: Decodable {
        let id: String; let kind: String; let createdAt: String; let destination: String
        let reference: String; let amount: String; let currency: String; let settlement: String; let mandateReference: String?; let agentId: String?; let txHash: String?
    }
    let customer: Customer; let accounts: [Account]; let mandates: [WorkspaceMandate]; let activity: [Entry]; let agents: [Agent]?
}

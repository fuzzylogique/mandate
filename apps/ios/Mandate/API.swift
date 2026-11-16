// Calls to the Mandate service (apps/receipts).
import Foundation

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct API {
    let base: URL

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        // Setting up a shopper takes about ten seconds; a purchase a few.
        configuration.timeoutIntervalForRequest = 90
        return URLSession(configuration: configuration)
    }()

    private struct ErrorBody: Decodable { let error: String? }

    private struct NewShopper: Encodable {
        let name: String
        let limit: String
        let period: String
    }

    private struct Purchase: Encodable {
        let ruleId: Int
        let itemId: String
    }

    func overview() async throws -> Overview { try await decode(send("overview")) }

    func activity() async throws -> [Activity] { try await decode(send("activity")) }

    func createShopper(name: String, limit: String, period: String) async throws -> Shopper {
        try await decode(send("mandates", method: "POST", body: NewShopper(name: name, limit: limit, period: period)))
    }

    func stop(ruleId: Int) async throws {
        _ = try await send("mandates/\(ruleId)", method: "DELETE")
    }

    func purchase(ruleId: Int, itemId: String) async throws -> PurchaseResult {
        try await decode(send("purchases", method: "POST", body: Purchase(ruleId: ruleId, itemId: itemId)))
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(message: "Something unexpected came back. Try again.")
        }
    }

    private func send(_ path: String, method: String = "GET", body: (any Encodable)? = nil) async throws -> Data {
        var request = URLRequest(url: base.appending(path: path))
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

        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError(message: message ?? "Something went wrong. Try again.")
        }
        return data
    }
}

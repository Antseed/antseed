import Foundation

/// An HTTP/1.1 request as the app's loopback servers read it off a connection.
struct HTTPRequest: Equatable {
    let method: String
    /// The request target without its query.
    let path: String
    /// By lowercased name.
    let headers: [String: String]
    let body: Data

    enum Parsed: Equatable {
        case incomplete
        case malformed
        case request(HTTPRequest)
    }

    /// The request in `buffer` once its headers and body have arrived; a body declared longer than
    /// `maxBytes` is malformed.
    static func parse(_ buffer: Data, maxBytes: Int) -> Parsed {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else { return .incomplete }
        guard let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else { return .malformed }
        var lines = head.components(separatedBy: "\r\n")
        let start = lines.removeFirst().split(separator: " ")
        guard start.count >= 2 else { return .malformed }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        // Digits only, within the size limit: a sign, garbage or an overflow is a bad request, never a length.
        let declared = headers["content-length"] ?? "0"
        guard !declared.isEmpty, declared.allSatisfy(\.isASCII), declared.allSatisfy(\.isNumber),
              let length = Int(declared), length <= maxBytes else { return .malformed }
        let body = buffer[end.upperBound...]
        guard body.count >= length else { return .incomplete }
        let target = String(start[1])
        let path = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? target
        return .request(HTTPRequest(method: String(start[0]), path: path, headers: headers, body: Data(body.prefix(length))))
    }
}

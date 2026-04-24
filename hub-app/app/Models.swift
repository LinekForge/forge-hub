import Foundation

struct Session {
    let display: String
    let sid: String
    let timestamp: TimeInterval
    let time: String
}

enum DisplayItem {
    case header(String)
    case session(Session, isActive: Bool, displayName: String, isBold: Bool)
}

struct StaleSession {
    let file: URL
    let pid: Int
    let staleSID: String
    let startedAt: TimeInterval
}

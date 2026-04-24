import Foundation
import os

private let log = OSLog(subsystem: "com.linekforge.hub-app", category: "Store")

class SessionStore {
    private let starsFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/状态/session-stars.json")

    var stars: Set<String> = []

    func loadStars() {
        do {
            let data = try Data(contentsOf: starsFile)
            if let arr = try JSONSerialization.jsonObject(with: data) as? [String] {
                stars = Set(arr)
            }
        } catch {
            os_log("loadStars failed: %{public}@", log: log, type: .info, error.localizedDescription)
        }
    }

    func saveStars() {
        do {
            let data = try JSONSerialization.data(withJSONObject: Array(stars).sorted(), options: [.prettyPrinted])
            try data.write(to: starsFile, options: .atomic)
        } catch {
            os_log("saveStars failed: %{public}@", log: log, type: .error, error.localizedDescription)
        }
    }

    func toggleStar(_ sid: String) {
        if stars.contains(sid) {
            stars.remove(sid)
        } else {
            stars.insert(sid)
        }
        saveStars()
    }
}

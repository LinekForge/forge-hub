import Foundation
import os

private let log = OSLog(subsystem: "com.linekforge.hub-app", category: "Scanner")

class SessionScanner {
    var sessions: [Session] = []
    var activeSIDs: Set<String> = []
    var sessionPIDMap: [String: Int] = [:]
    var allActivePIDs: [Int] = []
    var staleSessions: [StaleSession] = []
    var hubTags: [String: String] = [:]   // keyed by session ID prefix (8 chars)
    var hubDescs: [String: String] = [:]  // keyed by session ID prefix (8 chars)
    var hubChannelSIDs: Set<String> = [] // sessions whose Hub instance has channels
    var hubChannelsBySID: [String: [String]] = [:] // SID → channel list
    var isScanning = false

    /// Called after core scan completes. HubExtension registers this to inject tags/descs.
    var onEnrich: (() -> Void)?

    // MARK: - Active Session Detection

    func scanActiveSessions() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let sessionsDir = home.appendingPathComponent(".claude/sessions")
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: sessionsDir, includingPropertiesForKeys: nil, options: .skipsHiddenFiles
        ) else { return }

        struct AliveEntry {
            let file: URL; let sid: String; let pid: Int; let startedAt: TimeInterval
        }
        var aliveEntries: [AliveEntry] = []

        for file in files where file.pathExtension == "json" {
            guard let rawData = try? Data(contentsOf: file) else { continue }
            var data = rawData
            if (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] == nil,
               let str = String(data: rawData, encoding: .utf8),
               let end = str.firstIndex(of: "}") {
                let trimmed = String(str[str.startIndex...end])
                if let fixed = trimmed.data(using: .utf8) { data = fixed }
            }
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sid = obj["sessionId"] as? String,
                  let pid = obj["pid"] as? Int else { continue }
            if kill(Int32(pid), 0) == 0 {
                let startedAt = (obj["startedAt"] as? Double ?? 0) / 1000.0
                aliveEntries.append(AliveEntry(file: file, sid: sid, pid: pid, startedAt: startedAt))
            }
        }

        var allJsonlSIDs: Set<String> = []
        let projectsDir = home.appendingPathComponent(".claude/projects")
        if let projects = try? FileManager.default.contentsOfDirectory(
            at: projectsDir, includingPropertiesForKeys: nil, options: .skipsHiddenFiles
        ) {
            for projDir in projects {
                if let jsonls = try? FileManager.default.contentsOfDirectory(
                    at: projDir, includingPropertiesForKeys: nil, options: .skipsHiddenFiles
                ) {
                    for jsonl in jsonls where jsonl.pathExtension == "jsonl" {
                        allJsonlSIDs.insert(jsonl.deletingPathExtension().lastPathComponent)
                    }
                }
            }
        }

        var staleEntries: [AliveEntry] = []
        var goodEntries: [AliveEntry] = []
        for entry in aliveEntries {
            if allJsonlSIDs.contains(entry.sid) { goodEntries.append(entry) }
            else { staleEntries.append(entry) }
        }

        staleSessions = staleEntries.map {
            StaleSession(file: $0.file, pid: $0.pid, staleSID: $0.sid, startedAt: $0.startedAt)
        }

        activeSIDs.removeAll()
        sessionPIDMap.removeAll()
        allActivePIDs.removeAll()
        for entry in goodEntries {
            activeSIDs.insert(entry.sid)
            sessionPIDMap[entry.sid] = entry.pid
            allActivePIDs.append(entry.pid)
        }

        // Hub enrichment (tags/descs) — injected by HubExtension if available
        hubTags.removeAll()
        hubDescs.removeAll()
        onEnrich?()
    }

    // MARK: - Session List Scanning

    func scanSessionsInBackground(completion: @escaping () -> Void) {
        if isScanning { return }
        isScanning = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else {
                DispatchQueue.main.async { completion() }
                return
            }
            self.scanActiveSessions()

            let legacyScriptPath = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".claude/自动化/scripts/scan-sessions.py").path
            let bundledScriptPath = Bundle.main.path(forResource: "scan-sessions", ofType: "py")
            let scriptPath = bundledScriptPath ?? legacyScriptPath

            guard FileManager.default.fileExists(atPath: scriptPath) else {
                DispatchQueue.main.async {
                    self.sessions = []
                    self.isScanning = false
                    completion()
                }
                return
            }

            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            process.arguments = [scriptPath]
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice

            var env = ProcessInfo.processInfo.environment
            let extra = "/opt/homebrew/bin:/usr/local/bin"
            if let existing = env["PATH"] {
                env["PATH"] = "\(extra):\(existing)"
            } else {
                env["PATH"] = "\(extra):/usr/bin:/bin"
            }
            process.environment = env

            do {
                try process.run()
                process.waitUntilExit()
            } catch {
                os_log("scan-sessions.py failed: %{public}@", log: log, type: .error, error.localizedDescription)
                DispatchQueue.main.async {
                    self.sessions = []
                    self.isScanning = false
                    completion()
                }
                return
            }

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""

            var found: [Session] = []
            for line in output.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                let parts = trimmed.components(separatedBy: "\u{1E}")
                if parts.count == 4 {
                    let ts = TimeInterval(parts[0]) ?? 0
                    found.append(Session(display: parts[2], sid: parts[3], timestamp: ts, time: parts[1]))
                }
            }

            DispatchQueue.main.async {
                self.sessions = found
                self.isScanning = false
                completion()
            }
        }
    }
}

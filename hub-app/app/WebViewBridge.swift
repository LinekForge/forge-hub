import Cocoa
import WebKit
import os

private let log = OSLog(subsystem: "com.linekforge.hub-app", category: "Bridge")

class WebViewBridge: NSObject, WKScriptMessageHandler {
    let scanner: SessionScanner
    let store: SessionStore
    let descStore: SessionDescriptionStore
    let hubClient: HubClient
    let terminal: TerminalAdapter
    weak var webView: WKWebView?

    init(scanner: SessionScanner, store: SessionStore, descStore: SessionDescriptionStore,
         hubClient: HubClient, terminal: TerminalAdapter) {
        self.scanner = scanner
        self.store = store
        self.descStore = descStore
        self.hubClient = hubClient
        self.terminal = terminal
        super.init()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String,
              let callbackId = body["callbackId"] as? String else {
            os_log("Bridge: invalid message format", log: log, type: .error)
            return
        }
        let params = body["params"] as? [String: Any] ?? [:]

        switch action {
        case "getSessions":
            let sessions = buildNativeSessions()
            respond(callbackId, result: sessions)

        case "getStarredSessions":
            respond(callbackId, result: Array(store.stars))

        case "getHubStatus":
            respond(callbackId, result: [
                "online": hubClient.isHubOnline,
                "everOnline": hubClient.isHubEverOnline
            ])

        case "getHubApiToken":
            respond(callbackId, result: hubClient.readAuthToken())

        case "openSession":
            if let sid = params["sid"] as? String {
                if isValidSessionId(sid) {
                    openSession(sid)
                    respond(callbackId, result: true)
                } else {
                    os_log("Bridge: rejected invalid session id '%{public}@'", log: log, type: .error, sid)
                    respond(callbackId, result: false)
                }
            } else {
                respond(callbackId, result: false)
            }

        case "focusTerminal":
            if let sid = params["sid"] as? String,
               let pid = scanner.sessionPIDMap[sid] {
                let ok = terminal.focusTerminalWindow(forPID: pid)
                respond(callbackId, result: ok)
            } else {
                respond(callbackId, result: false)
            }

        case "starSession":
            if let sid = params["sid"] as? String {
                store.toggleStar(sid)
            }
            respond(callbackId, result: true)

        case "renameSession":
            if let sid = params["sid"] as? String,
               let desc = params["description"] as? String {
                descStore.setDescription(sid, description: desc)
                if let pid = scanner.sessionPIDMap[sid] {
                    let instanceId = "\(hubClient.instancePrefix)\(pid)"
                    hubClient.setDescription(instanceId: instanceId, description: desc)
                }
                respond(callbackId, result: true)
            } else {
                respond(callbackId, result: false)
            }

        case "setSessionTag":
            if let sid = params["sid"] as? String,
               let tag = params["tag"] as? String {
                descStore.setTag(sid, tag: tag)
                if let pid = scanner.sessionPIDMap[sid] {
                    let instanceId = "\(hubClient.instancePrefix)\(pid)"
                    hubClient.setTag(instanceId: instanceId, tag: tag)
                }
                respond(callbackId, result: true)
            } else {
                respond(callbackId, result: false)
            }

        case "launchNewSession":
            terminal.openTerminal("cd ~ && claude")
            respond(callbackId, result: true)

        case "launchChannelSession":
            let channels = params["channels"] as? [String] ?? []
            let tag = params["tag"] as? String ?? ""
            let desc = params["description"] as? String ?? ""
            let history = parseHistoryConfig(params["history"], fallbackCount: params["historyCount"], channels: channels)
            hubClient.writeSessionFile(
                tag: tag, description: desc,
                channels: channels, history: history, isChannel: true
            )
            terminal.openTerminal("cd ~ && claude --dangerously-load-development-channels \(developmentChannelArgs())")
            respond(callbackId, result: true)

        case "resumeChannelSession":
            if let sid = params["sid"] as? String {
                guard isValidSessionId(sid) else {
                    os_log("Bridge: rejected invalid session id '%{public}@'", log: log, type: .error, sid)
                    respond(callbackId, result: false)
                    return
                }
                let channels = params["channels"] as? [String] ?? []
                let tag = params["tag"] as? String ?? ""
                let desc = params["description"] as? String ?? ""
                let history = parseHistoryConfig(params["history"], fallbackCount: params["historyCount"], channels: channels)
                hubClient.writeSessionFile(
                    tag: tag, description: desc,
                    channels: channels, history: history, isChannel: true
                )
                terminal.openTerminal("cd ~ && claude --resume \(sid) --dangerously-load-development-channels \(developmentChannelArgs())")
                respond(callbackId, result: true)
            } else {
                respond(callbackId, result: false)
            }

        case "fetchHubChannels":
            let channels = hubClient.fetchHubChannels()
            let result = channels.map { ["id": $0.id, "name": $0.name, "aliases": $0.aliases] as [String: Any] }
            respond(callbackId, result: result)

        case "getChannelPresets":
            let presets = hubClient.loadPresets()
            let result = presets.map { ["name": $0.name, "subscribe": $0.subscribe, "history": $0.history] as [String: Any] }
            respond(callbackId, result: result)

        case "writeNextSession":
            let tag = params["tag"] as? String ?? ""
            let desc = params["description"] as? String ?? ""
            let channels = params["channels"] as? [String] ?? []
            var history: [String: Int] = [:]
            if let h = params["history"] as? [String: Any] {
                for (k, v) in h { if let iv = v as? Int { history[k] = iv } }
            }
            hubClient.writeSessionFile(tag: tag, description: desc, channels: channels, history: history, isChannel: !channels.isEmpty || !history.isEmpty)
            respond(callbackId, result: true)

        case "pickFile":
            DispatchQueue.main.async { [weak self] in
                let panel = NSOpenPanel()
                panel.canChooseFiles = true
                panel.canChooseDirectories = false
                panel.allowsMultipleSelection = false
                panel.message = "选择要发送的文件"
                if panel.runModal() == .OK, let url = panel.url {
                    self?.respond(callbackId, result: url.path)
                } else {
                    self?.respond(callbackId, result: "")
                }
            }
            return

        case "sendFile":
            if let sid = params["sid"] as? String,
               isValidSessionId(sid),
               let filePath = params["filePath"] as? String,
               !filePath.isEmpty,
               let pid = scanner.sessionPIDMap[sid] {
                let instanceId = "\(hubClient.instancePrefix)\(pid)"
                respond(callbackId, result: hubClient.sendFile(instanceId: instanceId, filePath: filePath))
            } else {
                respond(callbackId, result: false)
            }

        case "getSessionHistory":
            if let sid = params["sid"] as? String {
                let limit = params["limit"] as? Int ?? 100
                let messages = readSessionHistory(sid: sid, limit: limit)
                respond(callbackId, result: messages)
            } else {
                respond(callbackId, result: [] as [Any])
            }

        case "getSessionDescriptions":
            let snapshot = descStore.snapshot()
            var result: [String: [String: Any]] = [:]
            for (key, val) in snapshot {
                result[key] = ["description": val.description, "tag": val.tag, "updatedAt": val.updatedAt]
            }
            respond(callbackId, result: result)

        case "quit":
            respond(callbackId, result: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                NSApplication.shared.terminate(nil)
            }

        default:
            os_log("Bridge: unknown action '%{public}@'", log: log, type: .error, action)
            rejectCallback(callbackId, error: "Unknown action: \(action)")
        }
    }

    // MARK: - Session Assembly

    private func parseHistoryConfig(_ raw: Any?, fallbackCount: Any?, channels: [String]) -> [String: Int] {
        var history: [String: Int] = [:]
        if let h = raw as? [String: Any] {
            for (key, value) in h {
                if let intValue = value as? Int, intValue >= 0 {
                    history[key] = intValue
                } else if let numberValue = value as? NSNumber, numberValue.intValue >= 0 {
                    history[key] = numberValue.intValue
                }
            }
        }
        if history.isEmpty {
            let count: Int?
            if let intValue = fallbackCount as? Int {
                count = intValue
            } else if let numberValue = fallbackCount as? NSNumber {
                count = numberValue.intValue
            } else {
                count = nil
            }
            if let count = count, count >= 0 {
                for channel in channels {
                    history[channel] = count
                }
            }
        }
        return history
    }

    private func developmentChannelArgs() -> String {
        return isEngineRegistered() ? "server:hub server:engine" : "server:hub"
    }

    private func isEngineRegistered() -> Bool {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let engineDir = home.appendingPathComponent(".forge-hub/engine-data")
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: engineDir.path, isDirectory: &isDir), isDir.boolValue {
            return true
        }

        let configPaths = [
            home.appendingPathComponent(".claude.json"),
            home.appendingPathComponent("Library/Application Support/Claude/claude_desktop_config.json"),
        ]
        for url in configPaths {
            guard let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let servers = obj["mcpServers"] as? [String: Any],
                  servers["engine"] != nil else { continue }
            return true
        }
        return false
    }

    func buildNativeSessions() -> [[String: Any]] {
        let stars = store.stars
        let descs = descStore.snapshot()

        return scanner.sessions.map { session in
            let sidPrefix = String(session.sid.prefix(8))
            let isActive = scanner.activeSIDs.contains(session.sid)
            let pid = scanner.sessionPIDMap[session.sid]
            let localDesc = descs[session.sid]

            var entry: [String: Any] = [
                "sid": session.sid,
                "display": session.display,
                "timestamp": session.timestamp,
                "time": session.time,
                "isActive": isActive,
                "isStarred": stars.contains(session.sid),
            ]
            if let pid = pid { entry["pid"] = pid }
            if let d = localDesc?.description, !d.isEmpty { entry["description"] = d }
            if let t = localDesc?.tag, !t.isEmpty { entry["tag"] = t }
            if let hd = scanner.hubDescs[sidPrefix], !hd.isEmpty { entry["hubDesc"] = hd }
            if let ht = scanner.hubTags[sidPrefix], !ht.isEmpty { entry["hubTag"] = ht }
            let displayName = (localDesc?.description ?? scanner.hubDescs[sidPrefix] ?? session.display)
            entry["pinyin"] = searchablePinyin(displayName)
            if let pid = pid {
                entry["hubInstanceId"] = "\(hubClient.instancePrefix)\(pid)"
            }
            entry["isChannel"] = scanner.hubChannelSIDs.contains(session.sid)
            if let ch = scanner.hubChannelsBySID[session.sid], !ch.isEmpty {
                entry["channels"] = ch
            }
            return entry
        }
    }

    // MARK: - Pinyin

    private func searchablePinyin(_ s: String) -> String {
        let mutable = NSMutableString(string: s)
        CFStringTransform(mutable, nil, kCFStringTransformToLatin, false)
        CFStringTransform(mutable, nil, kCFStringTransformStripDiacritics, false)
        let latin = (mutable as String).lowercased()
        let initials = latin
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .compactMap { $0.first }
            .map(String.init)
            .joined()
        return latin + " " + initials
    }

    // MARK: - JSONL History

    private func findSessionFile(sid: String) -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let projectsDir = home.appendingPathComponent(".claude/projects")
        guard let dirs = try? FileManager.default.contentsOfDirectory(
            at: projectsDir, includingPropertiesForKeys: nil, options: .skipsHiddenFiles
        ) else { return nil }
        for dir in dirs {
            let jsonl = dir.appendingPathComponent("\(sid).jsonl")
            if FileManager.default.fileExists(atPath: jsonl.path) {
                return jsonl
            }
        }
        return nil
    }

    private func readSessionHistory(sid: String, limit: Int) -> [[String: Any]] {
        guard let file = findSessionFile(sid: sid) else { return [] }
        guard let data = try? String(contentsOf: file, encoding: .utf8) else { return [] }

        let lines = data.components(separatedBy: "\n")
        var messages: [[String: Any]] = []

        for line in lines {
            guard !line.isEmpty else { continue }
            guard let jsonData = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else { continue }

            let type = obj["type"] as? String ?? ""
            guard type == "user" || type == "assistant" else { continue }

            let message = obj["message"] as? [String: Any] ?? [:]
            let role = message["role"] as? String ?? type

            var text = ""
            if let content = message["content"] {
                if let s = content as? String {
                    text = s
                } else if let arr = content as? [[String: Any]] {
                    let texts = arr.compactMap { block -> String? in
                        guard (block["type"] as? String) == "text" else { return nil }
                        return block["text"] as? String
                    }
                    text = texts.joined(separator: "\n")
                }
            }

            if text.isEmpty { continue }
            if text.hasPrefix("<system-reminder>") { continue }

            let truncated = text.count > 2000 ? String(text.prefix(2000)) + "…" : text

            messages.append([
                "role": role,
                "text": truncated,
            ])
        }

        if messages.count > limit {
            return Array(messages.suffix(limit))
        }
        return messages
    }

    // MARK: - Session Actions

    private func openSession(_ sid: String) {
        guard isValidSessionId(sid) else {
            os_log("Bridge: rejected invalid session id '%{public}@'", log: log, type: .error, sid)
            return
        }
        if let pid = scanner.sessionPIDMap[sid],
           terminal.focusTerminalWindow(forPID: pid) { return }

        let sidPrefix = String(sid.prefix(8))
        let desc = descStore.description(sid) ?? scanner.hubDescs[sidPrefix] ?? ""
        if !desc.isEmpty {
            hubClient.writeSessionFile(tag: "", description: desc, channels: [], history: [:])
        }
        terminal.openTerminal("cd ~ && claude --resume \(sid)")
    }

    private func isValidSessionId(_ sid: String) -> Bool {
        return sid.range(of: "^[0-9a-f-]+$", options: .regularExpression) != nil
    }

    // MARK: - Callback Helpers

    private func respond(_ callbackId: String, result: Any) {
        guard let webView = webView else { return }
        let json: String
        if let bool = result as? Bool {
            json = bool ? "true" : "false"
        } else if let str = result as? String {
            let escaped = str.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
            json = "\"\(escaped)\""
        } else if let num = result as? Int {
            json = String(num)
        } else if let num = result as? Double {
            json = String(num)
        } else if JSONSerialization.isValidJSONObject(result) {
            json = (try? JSONSerialization.data(withJSONObject: result))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        } else {
            json = "null"
        }
        let js = "window.__nativeBridge.resolve('\(callbackId)', \(json))"
        DispatchQueue.main.async { webView.evaluateJavaScript(js, completionHandler: nil) }
    }

    private func rejectCallback(_ callbackId: String, error: String) {
        guard let webView = webView else { return }
        let escaped = error.replacingOccurrences(of: "'", with: "\\'")
        let js = "window.__nativeBridge.reject('\(callbackId)', '\(escaped)')"
        DispatchQueue.main.async { webView.evaluateJavaScript(js, completionHandler: nil) }
    }
}

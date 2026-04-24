import Cocoa
import os

private let log = OSLog(subsystem: "com.linekforge.hub-app", category: "HubClient")

/// Hub 的 HTTP + 文件 I/O 层。不 own UI——所有 NSAlert 在 `ChannelDialog`。
///
/// Hub 离线时所有方法安全降级：HTTP 超时返空，文件读失败返空，不抛。
/// `isHubOnline` 由 `enrichScanResults` 更新，popover 据此降级通道按钮。
class HubClient {
    let scanner: SessionScanner

    /// Hub 当前是否可达。每次 `enrichScanResults` 更新——curl /instances
    /// 成功且能 parse JSON 即 true，连接失败/超时/格式错都算 false。
    private(set) var isHubOnline: Bool = false

    /// 本次 app 运行期间 Hub 是否曾经在线过。一旦 isHubOnline=true 过一次就设 true，不再回 false。
    /// UI 层用这个判断"是否显示 Hub 离线警告"——从未在线过的机器不打扰用户。
    private(set) var isHubEverOnline: Bool = false

    /// Hub 实际使用的 instance ID 前缀。从 /instances 返回值自动学到。
    /// 默认 "forge-"，Hub 在线后更新为实际值。
    private(set) var instancePrefix: String = "forge-"

    // MARK: - Types

    struct ChannelMeta {
        let id: String
        let name: String
        let aliases: [String]
    }

    struct ChannelPreset {
        let name: String
        let subscribe: [String]
        let history: [String: Int]
    }

    // MARK: - Constants

    static let defaultChannels = ["wechat", "telegram", "imessage", "feishu"]
    static let defaultDisplayNames: [String: String] = [
        "wechat": "微信", "telegram": "Telegram", "imessage": "iMessage", "feishu": "飞书"
    ]
    static let presetsFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".forge-hub/channel-presets.json")
    static let identitiesFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".forge-hub/state/_hub/instance-identities.json")
    static let nextSessionFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".forge-hub/next-session.json")

    // MARK: - Init

    init(scanner: SessionScanner) {
        self.scanner = scanner
    }

    // MARK: - Hub Metadata Enrichment

    /// 从 Hub /instances 和 identities 文件读取 tag/description，
    /// 通过 PID↔UUID 反向桥归一化到 UUID prefix key，写入 scanner.hubTags/hubDescs。
    /// 详见心智模型"Hub instance ID 方案演进"小节。
    func enrichScanResults() {
        var pidToSidPrefix: [String: String] = [:]
        var pidToFullSid: [String: String] = [:]
        for (sid, pid) in scanner.sessionPIDMap {
            pidToSidPrefix[String(pid)] = String(sid.prefix(8))
            pidToFullSid[String(pid)] = sid
        }
        scanner.hubChannelSIDs = []
        scanner.hubChannelsBySID = [:]

        // Fetch tags/descriptions from Hub API — 同时更新 isHubOnline 状态
        var online = false
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        task.arguments = ["-s", "--connect-timeout", "2", "http://localhost:9900/instances"]
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
            // curl exit 0 + 能 parse JSON 才算 online——区分"连不上 Hub"和"Hub 在但返回空列表"
            if task.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    online = true
                    if let instances = json["instances"] as? [[String: Any]] {
                        // 从第一个 id 学 Hub 的 instance 前缀
                        if let firstId = instances.first?["id"] as? String,
                           let dashIdx = firstId.firstIndex(of: "-") {
                            instancePrefix = String(firstId[...dashIdx])
                        }
                        for inst in instances {
                            guard let id = inst["id"] as? String else { continue }
                            // 不假设前缀——找第一个 "-" 后面的部分作为 PID
                            let pidStr = id.split(separator: "-", maxSplits: 1).last.map(String.init) ?? id
                            let key = pidToSidPrefix[pidStr] ?? pidStr
                            if let tag = inst["tag"] as? String, !tag.isEmpty {
                                scanner.hubTags[key] = tag
                            }
                            if let desc = inst["description"] as? String, !desc.isEmpty {
                                scanner.hubDescs[key] = desc
                            }
                            if let channels = inst["channels"] as? [String], !channels.isEmpty,
                               let fullSid = pidToFullSid[pidStr] {
                                scanner.hubChannelSIDs.insert(fullSid)
                                scanner.hubChannelsBySID[fullSid] = channels
                            }
                        }
                    }
                }
            }
        } catch {
            os_log("Hub instances API failed: %{public}@", log: log, type: .info, error.localizedDescription)
        }
        isHubOnline = online
        if online { isHubEverOnline = true }

        // Also read offline persistence
        if let data = try? Data(contentsOf: Self.identitiesFile),
           let all = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] {
            for (key, val) in all {
                let pidStr = key.split(separator: "-", maxSplits: 1).last.map(String.init) ?? key
                let prefix = pidToSidPrefix[pidStr] ?? pidStr
                if scanner.hubDescs[prefix] == nil, let desc = val["description"] as? String, !desc.isEmpty {
                    scanner.hubDescs[prefix] = desc
                }
                if scanner.hubTags[prefix] == nil, let tag = val["tag"] as? String, !tag.isEmpty {
                    scanner.hubTags[prefix] = tag
                }
            }
        }
    }

    // MARK: - Channel Data

    func fetchHubChannels() -> [ChannelMeta] {
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        task.arguments = ["-s", "--connect-timeout", "2", "http://localhost:9900/channels"]
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let channels = json["channels"] as? [[String: Any]] {
                return channels.compactMap { ch in
                    guard let id = ch["id"] as? String, let name = ch["name"] as? String else { return nil }
                    let aliases = ch["aliases"] as? [String] ?? []
                    return ChannelMeta(id: id, name: name, aliases: aliases)
                }
            }
        } catch {
            os_log("Hub channels API failed: %{public}@", log: log, type: .info, error.localizedDescription)
        }
        return Self.defaultChannels.map { id in
            ChannelMeta(id: id, name: Self.defaultDisplayNames[id] ?? id, aliases: [])
        }
    }

    func getUsedTags() -> Set<String> {
        var tags = Set<String>()
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        task.arguments = ["-s", "--connect-timeout", "2", "http://localhost:9900/instances"]
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let instances = json["instances"] as? [[String: Any]] {
                for inst in instances {
                    if let tag = inst["tag"] as? String { tags.insert(tag.uppercased()) }
                }
            }
        } catch {
            os_log("Hub getUsedTags failed: %{public}@", log: log, type: .info, error.localizedDescription)
        }
        return tags
    }

    // MARK: - Presets

    func loadPresets() -> [ChannelPreset] {
        guard let data = try? Data(contentsOf: Self.presetsFile),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return arr.compactMap { obj in
            guard let name = obj["name"] as? String,
                  let history = obj["history"] as? [String: Int] else { return nil }
            let subscribe = obj["subscribe"] as? [String] ?? Array(history.keys)
            return ChannelPreset(name: name, subscribe: subscribe, history: history)
        }
    }

    func savePreset(_ preset: ChannelPreset) {
        var presets = loadPresets()
        presets.removeAll { $0.name == preset.name }
        presets.append(preset)
        let arr: [[String: Any]] = presets.map { p in
            ["name": p.name, "subscribe": p.subscribe, "history": p.history]
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: arr, options: [.prettyPrinted])
            try data.write(to: Self.presetsFile, options: .atomic)
        } catch {
            os_log("savePreset failed: %{public}@", log: log, type: .error, error.localizedDescription)
        }
    }

    // MARK: - Session File

    /// 写 ~/.forge-hub/next-session.json，让 Hub 下次会话启动时读取。
    /// 文件被 Hub 消费后会自行清理，所以每次写都是覆盖。
    func writeSessionFile(tag: String, description: String, channels: [String], history: [String: Int]) {
        var obj: [String: Any] = [:]
        if !tag.isEmpty { obj["tag"] = tag }
        if !description.isEmpty { obj["description"] = description }
        if !channels.isEmpty { obj["channels"] = channels }
        if !history.isEmpty { obj["history"] = history }
        do {
            let data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted])
            try data.write(to: Self.nextSessionFile, options: .atomic)
        } catch {
            os_log("writeSessionFile failed: %{public}@", log: log, type: .error, error.localizedDescription)
        }
    }

    // MARK: - Tag Suggestion

    /// 从 description 首字取拉丁首字母（中文走 ToLatin 转拼音），和已用 tag 冲突时回退到未用字母。
    func suggestTag(from desc: String) -> String {
        guard let first = desc.first else { return "" }
        let str = String(first)
        let mutable = NSMutableString(string: str)
        CFStringTransform(mutable, nil, kCFStringTransformToLatin, false)
        CFStringTransform(mutable, nil, kCFStringTransformStripDiacritics, false)
        let initial = String(mutable.uppercased.prefix(1))

        let usedTags = getUsedTags()
        if !usedTags.contains(initial) { return initial }

        for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" {
            if !usedTags.contains(String(c)) { return String(c) }
        }
        return initial
    }

    // MARK: - Instance Tag / Description API

    /// POST /set-tag。instanceId 用 `<prefix><PID>`（prefix 从 /instances 自动学到）。
    func setTag(instanceId: String, tag: String) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        let body: [String: Any] = ["instance": instanceId, "tag": tag]
        let json = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
        task.arguments = ["-s", "-X", "POST", "http://localhost:9900/set-tag",
                          "-H", "Content-Type: application/json",
                          "-d", String(data: json, encoding: .utf8) ?? "{}"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch {
            os_log("setTag failed: %{public}@", log: log, type: .error, error.localizedDescription)
        }
    }

    /// POST /set-description。instanceId 用 `<prefix><PID>`。
    func setDescription(instanceId: String, description: String) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        let body: [String: Any] = ["instance": instanceId, "description": description]
        let json = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
        task.arguments = ["-s", "-X", "POST", "http://localhost:9900/set-description",
                          "-H", "Content-Type: application/json",
                          "-d", String(data: json, encoding: .utf8) ?? "{}"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch {
            os_log("setDescription failed: %{public}@", log: log, type: .error, error.localizedDescription)
        }
    }

    /// 同步更新 identities 文件的 offline 副本。API 成功后调——保证 Hub 重启后状态不丢。
    func updateIdentityDescription(instanceId: String, description: String) {
        guard let data = try? Data(contentsOf: Self.identitiesFile),
              var all = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return }
        if all[instanceId] == nil { all[instanceId] = [:] }
        all[instanceId]?["description"] = description
        if let jsonData = try? JSONSerialization.data(withJSONObject: all, options: [.prettyPrinted]) {
            try? jsonData.write(to: Self.identitiesFile, options: .atomic)
        }
    }

    // MARK: - Identities Lookup (for resume)

    /// 在 identities 里查后缀匹配 sidPrefix 的条目（用于 resumeChannel 继承 channels）。
    /// 不假设前缀——遍历所有 key，找第一个后缀 == sidPrefix 的。
    func lookupSavedIdentity(sidPrefix: String) -> (tag: String, desc: String, channels: [String]) {
        var tag = ""
        var desc = ""
        var channels: [String] = []
        if let data = try? Data(contentsOf: Self.identitiesFile),
           let all = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] {
            for (key, val) in all {
                let suffix = key.split(separator: "-", maxSplits: 1).last.map(String.init) ?? key
                if suffix == sidPrefix {
                    tag = val["tag"] as? String ?? ""
                    desc = val["description"] as? String ?? ""
                    channels = val["channels"] as? [String] ?? []
                    break
                }
            }
        }
        return (tag, desc, channels)
    }
}

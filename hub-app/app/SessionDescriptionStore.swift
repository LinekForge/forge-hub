import Foundation
import os

private let log = OSLog(subsystem: "com.linekforge.hub-app", category: "DescStore")

/// 用户给会话起的显示名字（description）和 @标签（tag）。
/// 按完整 sessionId（UUID）索引——永久稳定，不受 PID 变化或 session 退出影响。
struct SessionDescription: Codable {
    var description: String
    var tag: String
    var updatedAt: TimeInterval  // ms since epoch
}

/// 启动器 own 的会话名字本。
///
/// 设计原则（2026-04-19 晚重构）：
/// - **启动器是 description/tag 的 source of truth**，不依赖 Hub
/// - 文件在 `~/.claude/状态/session-descriptions.json`，和 session-stars.json 同目录
/// - key 是完整 sessionId（UUID）——永久稳定，天然规避 v2 死 PID gap
/// - Hub **不**写这个文件（写入只有一个 writer = 菜单栏，无 race）
/// - Hub 如果需要 description（比如回复标识 "Forge（引擎@P）："），
///   由菜单栏在 rename/openSession 时 best-effort 通知 Hub，不阻塞本地持久化
///
/// 和 Hub 的 `~/.forge-hub/state/_hub/instance-identities.json` 的区别：
/// - identities 是 Hub own 的 peer 连接状态——包括 channels、isChannel、以及（历史上）description
/// - 新架构下 identities 里的 description 作为兼容 fallback 保留，不再是权威
class SessionDescriptionStore {
    private let file = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/状态/session-descriptions.json")

    private var entries: [String: SessionDescription] = [:]

    // MARK: - Load / Save

    func load() {
        guard let data = try? Data(contentsOf: file) else {
            os_log("load: 文件不存在，用空状态启动", log: log, type: .info)
            entries = [:]
            return
        }
        if let decoded = try? JSONDecoder().decode([String: SessionDescription].self, from: data) {
            entries = decoded
            os_log("load: 读到 %d 条", log: log, type: .info, entries.count)
            return
        }
        os_log("load: decode 失败，用空状态", log: log, type: .error)
        entries = [:]
    }

    @discardableResult
    private func save() -> Bool {
        // 确保目录存在（~/.claude/状态/ 在 v2 盘整后应该已存在，但防御一下）
        let dir = file.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(entries)
            try data.write(to: file, options: .atomic)
            return true
        } catch {
            os_log("SessionDescriptionStore save 失败: %{public}@", log: log, type: .error, error.localizedDescription)
            return false
        }
    }

    // MARK: - Get / Set

    func get(_ sid: String) -> SessionDescription? {
        return entries[sid]
    }

    func description(_ sid: String) -> String? {
        let s = entries[sid]?.description ?? ""
        return s.isEmpty ? nil : s
    }

    func tag(_ sid: String) -> String? {
        let s = entries[sid]?.tag ?? ""
        return s.isEmpty ? nil : s
    }

    /// 设置 description，保留 tag。空字符串 = 清除 description。
    /// description 和 tag 都空时整条删除（避免无意义的空壳条目）。
    /// 返回 true 表示 save 成功；调用方可以据此 UI 反馈（比如弹"保存失败"警告）。
    @discardableResult
    func setDescription(_ sid: String, description: String) -> Bool {
        let desc = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentTag = entries[sid]?.tag ?? ""
        return write(sid: sid, description: desc, tag: currentTag)
    }

    /// 设置 tag，保留 description。语义同上。
    @discardableResult
    func setTag(_ sid: String, tag: String) -> Bool {
        let t = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentDesc = entries[sid]?.description ?? ""
        return write(sid: sid, description: currentDesc, tag: t)
    }

    private func write(sid: String, description: String, tag: String) -> Bool {
        // 诊断日志：每次 write 留痕——定位"条目莫名消失"的 ground truth
        // 查询：log show --predicate 'subsystem == "com.linekforge.hub-app" AND category == "DescStore"' --last 1d
        let action = (description.isEmpty && tag.isEmpty) ? "REMOVE" : "SET"
        os_log("write %{public}@ sid=%{public}@ desc=%{public}@ tag=%{public}@",
               log: log, type: .info,
               action, sid, description, tag)

        if description.isEmpty && tag.isEmpty {
            entries.removeValue(forKey: sid)
        } else {
            entries[sid] = SessionDescription(
                description: description,
                tag: tag,
                updatedAt: Date().timeIntervalSince1970 * 1000
            )
        }
        let ok = save()
        if !ok {
            os_log("write: save 返回 false, entries 内存已改但磁盘未持久化", log: log, type: .error)
        }
        return ok
    }

    // MARK: - Snapshot（给 popover 用的完整映射）

    /// 返回 `sid → SessionDescription` 的当前快照。用于 popover 每次 reload 时读取。
    func snapshot() -> [String: SessionDescription] {
        return entries
    }
}

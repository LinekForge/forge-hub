#!/usr/bin/env bun
/**
 * forge-hub CLI — package-level setup / install / doctor.
 *
 * 注意：这是**安装管理**入口，不是日常 hub 操作。日常用 `fh hub *`（forge-cli/forge.ts）。
 *
 * Commands:
 *   forge-hub install     一键部署 hub-server + hub-client + launchd plist + MCP 注册
 *   forge-hub uninstall   反向操作（保留 ~/.forge-hub state，不删 allowlist 等）
 *   forge-hub doctor      诊断 install 状态 + connectivity
 *   forge-hub --help      帮助
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const HUB_DIR = path.join(HOME, ".forge-hub");
const CHANNELS_RUNTIME = path.join(HOME, ".forge-hub", "channels");
const HUB_CLIENT_RUNTIME = path.join(HOME, ".claude", "channels", "hub");
const LAUNCHD_PLIST = path.join(HOME, "Library", "LaunchAgents", "com.forge-hub.plist");
const CLAUDE_JSON = path.join(HOME, ".claude.json");
const API_TOKEN_FILE = path.join(HUB_DIR, "api-token");

// 找包根目录（从 cli.ts 的位置反推）
const PKG_ROOT = path.dirname(new URL(import.meta.url).pathname);

function log(msg: string): void { console.log(msg); }
function die(msg: string): never { console.error(`❌ ${msg}`); process.exit(1); }

// ── install ─────────────────────────────────────────────────────────────────

function installCmd(): void {
  log("🔧 Forge Hub install\n");

  // 1. Check Bun
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
  } catch {
    die("Bun 未安装。请先安装 Bun: https://bun.sh/docs/installation");
  }
  log("✓ Bun 已安装");

  // 2. Install hub-server
  // redteam r2 M1: mkdirSync 带 mode 0o700，缩小 mkdir 默认 0o755 到 chmod
  // 0o700 之间的窗口（attacker 可在此毫秒级窗口写 api-token symlink 预埋）。
  fs.mkdirSync(CHANNELS_RUNTIME, { recursive: true, mode: 0o700 });
  const serverSrc = path.join(PKG_ROOT, "hub-server");
  cpDir(serverSrc, HUB_DIR, [".ts", ".json", ".lock"]);
  cpDir(path.join(serverSrc, "channels"), CHANNELS_RUNTIME, [".ts"]);
  // Security (redteam B3): chmod 700 CHANNELS_RUNTIME——防其他 user-level 进程
  // 写入恶意 plugin。fs.watch 已默认关闭（hub-server/channel-loader.ts），
  // 目录权限是第二层防御。
  try {
    fs.chmodSync(HUB_DIR, 0o700);
    fs.chmodSync(CHANNELS_RUNTIME, 0o700);
  } catch (err) {
    console.warn(`⚠️  chmod 700 失败: ${String(err)}`);
  }
  log(`✓ hub-server 部署到 ${HUB_DIR} (chmod 700)`);

  // 3. Install hub-client
  fs.mkdirSync(HUB_CLIENT_RUNTIME, { recursive: true });
  const clientSrc = path.join(PKG_ROOT, "hub-client");
  cpDir(clientSrc, HUB_CLIENT_RUNTIME, [".ts", ".json", ".lock", ".mcp.json"]);
  log(`✓ hub-client 部署到 ${HUB_CLIENT_RUNTIME}`);

  // 4. Install dependencies
  log("⏳ 安装依赖（bun install）...");
  execFileSync("bun", ["install"], { cwd: HUB_DIR, stdio: "inherit" });
  execFileSync("bun", ["install"], { cwd: HUB_CLIENT_RUNTIME, stdio: "inherit" });
  log("✓ 依赖装好");

  // 5. Write launchd plist (Mac only)
  if (os.platform() === "darwin") {
    const bunPath = which("bun") ?? "/opt/homebrew/bin/bun";
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.forge-hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${path.join(HUB_DIR, "hub.ts")}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(HUB_DIR, "hub.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(HUB_DIR, "hub-stderr.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(LAUNCHD_PLIST), { recursive: true });
    fs.writeFileSync(LAUNCHD_PLIST, plist, "utf-8");
    log(`✓ launchd plist 写入 ${LAUNCHD_PLIST}`);

    // Bootstrap
    try {
      const uid = String(process.getuid?.() ?? 501);
      try { execFileSync("launchctl", ["bootout", `gui/${uid}/com.forge-hub`], { stdio: "ignore" }); } catch {}
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, LAUNCHD_PLIST], { stdio: "inherit" });
      log("✓ Hub Server 已启动（launchd）");
    } catch (err) {
      console.warn(`⚠️  launchctl bootstrap 失败: ${String(err)}\n   你可以手动跑：launchctl bootstrap gui/$(id -u) ${LAUNCHD_PLIST}`);
    }
  } else {
    log(`ℹ️  非 macOS 平台（${os.platform()}），跳过 launchd 配置。请用 systemd / supervisor / pm2 等保活 \`bun ${HUB_DIR}/hub.ts\``);
  }

  // 6. Register MCP server in ~/.claude.json
  registerMcp();
  log("✓ MCP server 已注册到 ~/.claude.json");

  // 6.5 Sync HUB_API_TOKEN from env to ~/.forge-hub/api-token (chmod 600).
  // MCP subprocess inherits Claude Code env, not Hub's launchd env, so we can't
  // rely on env alone. The file gives hub-client / forge CLI a canonical fallback.
  // Rerun `forge-hub install` (or write the file manually) if you rotate the token.
  syncApiTokenFile();

  // 6.6 Create $HUB_DIR/sendable/ for /send-file path sandbox (redteam B2).
  // 任何本地文件必须放这里才能被 /send-file 发出；HTTP(S) URL 不受此限制。
  try {
    const sendableDir = path.join(HUB_DIR, "sendable");
    fs.mkdirSync(sendableDir, { recursive: true });
    fs.chmodSync(sendableDir, 0o700);
    log(`✓ sendable 目录创建: ${sendableDir} (chmod 700)`);
  } catch (err) {
    console.warn(`⚠️  sendable 目录创建失败: ${String(err)}`);
  }

  // 7. Symlink short alias `fh` for daily `fh hub allow` etc.
  // 之前用 `forge`——但和 Foundry (Ethereum 生态，200k+ stars) 的主命令冲突
  // (redteam 终审 P1-2)。改 `fh` 名字冲突概率接近零，且仍短。
  // 清理老的 `forge` symlink（如果存在）避免留孤儿。
  const fhBin = path.join(HOME, "bin", "fh");
  const oldForgeBin = path.join(HOME, "bin", "forge");
  try {
    fs.mkdirSync(path.dirname(fhBin), { recursive: true });
    // 清理老 forge symlink（只删指向本包的那种，避免误删用户其他 forge 工具）
    try {
      if (fs.lstatSync(oldForgeBin).isSymbolicLink()) {
        const target = fs.readlinkSync(oldForgeBin);
        if (target.includes("forge-hub") || target.includes("forge-cli/forge.ts")) {
          fs.unlinkSync(oldForgeBin);
          log(`✓ 清理老 symlink ~/bin/forge（指向本包）`);
        }
      }
    } catch { /* 不存在 / 其他工具的 forge 都不管 */ }
    if (fs.existsSync(fhBin)) fs.unlinkSync(fhBin);
    fs.symlinkSync(path.join(PKG_ROOT, "forge-cli", "forge.ts"), fhBin);
    log(`✓ fh CLI symlink: ${fhBin}（用 \`fh hub allow/status/peers\` 等）`);

  // S1b: surface approval_channels prerequisite for server:hub mode.
  // Without this hint, first-time users launching with `--dangerously-load-development-channels
  // server:hub` will hit auto-deny on every Bash tool call (no approval_channels → 503 →
  // hub-channel autoDenyPermission), with no clue what to fix.
  try {
    const hubConfigPath = path.join(HUB_DIR, "hub-config.json");
    const cfg = fs.existsSync(hubConfigPath)
      ? JSON.parse(fs.readFileSync(hubConfigPath, "utf-8"))
      : {};
    const approvalChannels = Array.isArray(cfg.approval_channels) ? cfg.approval_channels : [];
    if (approvalChannels.length === 0) {
      log("");
      log("💡 提示：要用 server:hub 模式（远程审批 → 手机）需要配 approval_channels：");
      log("   编辑 ~/.forge-hub/hub-config.json 加：");
      log('     { "approval_channels": ["wechat"] }   // 或你配好的其他通道');
      log("   不配的话，server:hub 模式下所有需要审批的工具会被 auto-deny。详见 配置.md §审批推送配置。");
    }
  } catch { /* cfg 读取失败不阻塞 install，doctor 会再次报 */ }
  } catch (err) {
    console.warn(`⚠️  fh symlink 失败: ${String(err)}\n   你可以手动: ln -sf ${path.join(PKG_ROOT, "forge-cli/forge.ts")} ${fhBin}`);
  }

  // 7.5 symlink `forge-hub` 指向 cli.ts——让文档里的 `forge-hub install/uninstall/doctor`
  // 变成真能跑的命令（首次 bootstrap 必须 `bun cli.ts install`，之后走 symlink）。
  const forgeHubBin = path.join(HOME, "bin", "forge-hub");
  try {
    if (fs.existsSync(forgeHubBin)) fs.unlinkSync(forgeHubBin);
    fs.symlinkSync(path.join(PKG_ROOT, "cli.ts"), forgeHubBin);
    log(`✓ forge-hub CLI symlink: ${forgeHubBin}（用 \`forge-hub install/uninstall/doctor\`）`);
  } catch (err) {
    console.warn(`⚠️  forge-hub symlink 失败: ${String(err)}\n   你可以手动: ln -sf ${path.join(PKG_ROOT, "cli.ts")} ${forgeHubBin}`);
  }

  // redteam r2 L4: 检测 ~/bin 在不在 PATH。现代 macOS 默认 zsh PATH 不含
  // $HOME/bin，新用户 install 完跑 `fh hub status` 会 command not found，
  // 第一印象灾难。显式提示加 export。
  const homeBinDir = path.dirname(fhBin);
  const pathDirs = (process.env.PATH ?? "").split(":");
  if (!pathDirs.includes(homeBinDir)) {
    log(`
⚠️  注意：${homeBinDir} 不在你的 PATH——\`fh\` 命令将无法直接调用。
   加到 shell 配置（zsh 默认）：
     echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
   然后重开 shell 或 source，再跑 \`fh hub status\` 验证。`);
  }

  const configDoc = path.join(PKG_ROOT, "配置.md");
  log(`
✅ Install 完成

下一步：
  1. 配通道凭证（微信 / Telegram / 飞书 / iMessage，按你要用的配一个就行）
     → ${configDoc}

  2. 启动 Claude Code：
     claude --dangerously-load-development-channels server:hub

  3. 验证：
     fh hub status

可选：
  • 启用远程审批 hook → README.md §启用远程审批
  • Touch ID 二次确认：export FORGE_HUB_AUTH_MODE=touchid（需自行装 touchid-verify）
`);
}

// ── uninstall ───────────────────────────────────────────────────────────────

function uninstallCmd(): void {
  log("🗑️  Forge Hub uninstall\n（注意：不删 ~/.forge-hub/state（allowlist / pending / 历史），如要全清自行 rm）\n");

  if (os.platform() === "darwin" && fs.existsSync(LAUNCHD_PLIST)) {
    try {
      const uid = String(process.getuid?.() ?? 501);
      execFileSync("launchctl", ["bootout", `gui/${uid}/com.forge-hub`], { stdio: "ignore" });
    } catch {}
    fs.unlinkSync(LAUNCHD_PLIST);
    log(`✓ launchd plist 已删除`);
  }

  if (fs.existsSync(HUB_DIR)) {
    for (const f of fs.readdirSync(HUB_DIR)) {
      if (f === "state") continue;
      const p = path.join(HUB_DIR, f);
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (err) {
        console.warn(`无法删除 ${p}: ${String(err)}`);
      }
    }
    log(`✓ ${HUB_DIR}/* 已清（保留 state/）`);
  }

  if (fs.existsSync(HUB_CLIENT_RUNTIME)) {
    fs.rmSync(HUB_CLIENT_RUNTIME, { recursive: true, force: true });
    log(`✓ ${HUB_CLIENT_RUNTIME} 已删`);
  }

  // 清理 ~/bin/ 下的 symlink——install 时建的两个入口
  for (const binName of ["fh", "forge-hub"] as const) {
    const binPath = path.join(HOME, "bin", binName);
    try {
      if (fs.lstatSync(binPath).isSymbolicLink()) {
        const target = fs.readlinkSync(binPath);
        // 只删指向本包的 symlink（防误删同名其他工具）
        if (target.includes("forge-hub") || target.includes("forge-cli/forge.ts")) {
          fs.unlinkSync(binPath);
          log(`✓ ${binPath} 已删`);
        }
      }
    } catch { /* ENOENT or not a symlink: skip */ }
  }

  // 取消 MCP 注册
  unregisterMcp();
  log("✓ MCP server 已从 ~/.claude.json 取消注册");

  log("\n✅ Uninstall 完成。state（~/.forge-hub/state/）保留，重装会复用。");
}

// ── doctor ──────────────────────────────────────────────────────────────────

function doctorCmd(): void {
  log("🩺 Forge Hub doctor\n");
  let ok = true;
  function check(name: string, pass: boolean, hint?: string): void {
    if (pass) {
      log(`✓ ${name}`);
    } else {
      log(`✗ ${name}${hint ? `\n   ${hint}` : ""}`);
      ok = false;
    }
  }

  check("Bun installed", which("bun") !== null, "https://bun.sh");
  check("Hub server runtime", fs.existsSync(path.join(HUB_DIR, "hub.ts")), "跑 forge-hub install");
  check("Hub client runtime", fs.existsSync(path.join(HUB_CLIENT_RUNTIME, "hub-channel.ts")), "跑 forge-hub install");
  check("LaunchAgent plist", os.platform() !== "darwin" || fs.existsSync(LAUNCHD_PLIST), "Mac 上跑 forge-hub install");
  check("MCP registered", isMcpRegistered(), "Hub channel 没在 ~/.claude.json");
  check("ffmpeg available（语音功能需要）", which("ffmpeg") !== null || !!process.env.FORGE_FFMPEG_PATH, "brew install ffmpeg 或设 FORGE_FFMPEG_PATH");
  check("lark-cli available（飞书通道需要）", which("lark-cli") !== null || !!process.env.FORGE_LARK_CLI, "npm i -g @larksuite/cli 或设 FORGE_LARK_CLI");

  // S1c: approval_channels check — informational warning, not a hard fail.
  // Not everyone uses server:hub mode, so empty approval_channels is legitimate for
  // local MCP tool usage. But surface it clearly so server:hub users can self-diagnose
  // the auto-deny trap.
  try {
    const hubConfigPath = path.join(HUB_DIR, "hub-config.json");
    const cfg = fs.existsSync(hubConfigPath)
      ? JSON.parse(fs.readFileSync(hubConfigPath, "utf-8"))
      : {};
    const approvalChannels = Array.isArray(cfg.approval_channels) ? cfg.approval_channels : [];
    if (approvalChannels.length > 0) {
      log(`✓ approval_channels configured: [${approvalChannels.join(", ")}]`);
    } else {
      log("⚠️  approval_channels 未配置（仅 server:hub 模式需要）");
      log("   server:hub 模式下需要审批的工具会被 auto-deny。编辑 ~/.forge-hub/hub-config.json 加 approval_channels，或仅用本地 MCP tools 模式可以忽略。");
    }
  } catch {
    log("⚠️  hub-config.json 读取失败，approval_channels 状态未知");
  }

  // Hub running?
  try {
    const port = process.env.FORGE_HUB_URL ?? "http://localhost:9900";
    const res = execFileSync("curl", ["-s", "-m", "2", `${port}/status`], { encoding: "utf-8" });
    const data = JSON.parse(res);
    log(`✓ Hub server running (v${data.version}, uptime ${Math.round(data.uptime / 60)}min)`);
  } catch {
    log("✗ Hub server not responding\n   检查 launchctl list | grep forge-hub，或前台跑 bun ~/.forge-hub/hub.ts");
    ok = false;
  }

  log(ok ? "\n✅ All checks passed" : "\n⚠️  有检查未通过，按提示修");
  if (!ok) process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function cpDir(src: string, dst: string, exts: string[]): void {
  if (!fs.existsSync(src)) die(`source 不存在: ${src}`);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const sp = path.join(src, f);
    const dp = path.join(dst, f);
    const stat = fs.statSync(sp);
    if (stat.isFile() && exts.some((e) => f.endsWith(e))) {
      fs.copyFileSync(sp, dp);
    }
  }
}

function which(cmd: string): string | null {
  try {
    return execFileSync("/usr/bin/which", [cmd], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

function readClaudeJson(): Record<string, unknown> {
  if (!fs.existsSync(CLAUDE_JSON)) return {};
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf-8"));
  } catch (err) {
    die(`~/.claude.json 损坏，无法继续: ${String(err)}`);
  }
}

function writeClaudeJson(data: Record<string, unknown>): void {
  // redteam r2 M2: 原子写入。直接 writeFileSync 中途被 kill -9 / 断电 / 磁盘满
  // 会留半截 JSON 或空文件——用户所有 MCP server 配置全挂（不止 hub）。
  // 方案: 写 .tmp 再 rename（POSIX rename 是原子操作）。失败清理 tmp。
  const tmp = `${CLAUDE_JSON}.tmp.${process.pid}`;
  const content = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, CLAUDE_JSON);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function registerMcp(): void {
  const data = readClaudeJson();
  const mcpServers = (data.mcpServers ?? {}) as Record<string, unknown>;
  const expectedArgs = [path.join(HUB_CLIENT_RUNTIME, "hub-channel.ts")];

  // Conflict check (redteam 终审 P1-5): 如果用户已有 mcpServers.hub 指向
  // 非本包的路径，静默覆盖会破坏用户另一项目。refuse + 明确 next-step。
  const existing = mcpServers.hub as { args?: unknown[] } | undefined;
  if (existing && Array.isArray(existing.args)) {
    const existingArg0 = String(existing.args[0] ?? "");
    if (existingArg0 !== expectedArgs[0]) {
      die(
        `~/.claude.json 已有名为 'hub' 的 MCP server，但 args 指向不同路径：\n` +
        `  现有: ${existingArg0}\n` +
        `  预期: ${expectedArgs[0]}\n` +
        `如果你另有项目占用 'hub' 这个名字，请手动处理：\n` +
        `  方案 1: 重命名你的其他 MCP server（~/.claude.json 里改 mcpServers.<你的名字>）\n` +
        `  方案 2: 跑 forge-hub uninstall 后再 install（如果老的 'hub' 就是本包的残留）\n`,
      );
    }
    // 相同路径——不是真冲突，是重装 refresh，放行
  }

  // Resolve bun to an absolute path for the MCP server command.
  // Claude Code spawns MCP subprocesses without inheriting the user's shell PATH
  // (e.g. launchd-started CC sees only the system default PATH). A bare "bun"
  // command would fail to resolve when bun is installed under ~/.bun/bin/ or
  // other non-system paths, resulting in the MCP server silently failing to
  // start. process.execPath is the bun binary currently running this install
  // script — using it guarantees the same bun that ran install will be used
  // by the MCP subprocess.
  const bunPath = process.execPath && process.execPath.includes("bun")
    ? process.execPath
    : which("bun") ?? "bun";

  mcpServers.hub = {
    command: bunPath,
    args: expectedArgs,
    env: {},
  };
  data.mcpServers = mcpServers;
  writeClaudeJson(data);
}

function syncApiTokenFile(): void {
  const fromEnv = process.env.HUB_API_TOKEN;
  if (!fromEnv) {
    // No env token: leave any existing file alone (user may manage it manually).
    if (fs.existsSync(API_TOKEN_FILE)) {
      log(`✓ API token 文件已存在（沿用）: ${API_TOKEN_FILE}`);
    }
    return;
  }
  try {
    // redteam r2 M1: mkdirSync 带 mode 0o700 防 attacker 在 0o755 window 预埋
    fs.mkdirSync(HUB_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(HUB_DIR, 0o700);
    // redteam r2 M1: 防 symlink TOCTOU——如果 API_TOKEN_FILE 是 attacker
    // 预埋的 symlink 指向 /tmp/xxx，writeFileSync 会 follow symlink 把 token
    // 写到 attacker 可读位置。lstatSync 不 follow symlink；如果是 symlink
    // 或非常规文件就 unlink 再写。
    try {
      const lst = fs.lstatSync(API_TOKEN_FILE);
      if (lst.isSymbolicLink() || !lst.isFile()) {
        fs.unlinkSync(API_TOKEN_FILE);
      }
    } catch {
      // ENOENT 正常（首次 install），继续
    }
    // O_EXCL 排他创建做双保险：刚 unlink 完的瞬间若被 attacker 重新预埋会 EEXIST
    try {
      fs.writeFileSync(API_TOKEN_FILE, fromEnv, { mode: 0o600, flag: "wx" });
    } catch (err) {
      // 用 inline 类型取 code，避免依赖 NodeJS.ErrnoException namespace
      // （项目没装 @types/node，bun 环境下 namespace 不可用）
      //
      // redteam r3 verification: EEXIST 分支必须 fail-closed, 不能 fallback
      // 覆盖写。原实现走 fallback writeFileSync(无 wx) 是错的——lstat 发生在
      // wx 之前，从 wx EEXIST 到 fallback 之间是**新 race 窗口**，attacker
      // 可在此窗口重建 symlink 诱导 fallback follow。直接 throw 让调用方
      // 人工处理是 tight fix（红队 verification.md §M1 tight-fix 建议）。
      if ((err as { code?: string })?.code === "EEXIST") {
        throw new Error(
          `${API_TOKEN_FILE} 在 lstat 后被重建（可能是 race / 另一个 install 并发跑 / attacker 抢注）。\n` +
          `请手动清理后重跑 install:\n` +
          `  rm -f ${API_TOKEN_FILE}\n` +
          `  forge-hub install`
        );
      }
      throw err;
    }
    fs.chmodSync(API_TOKEN_FILE, 0o600);
    log(`✓ API token 写入 ${API_TOKEN_FILE}（chmod 600，防 symlink TOCTOU，MCP 子进程将从此文件读 token）`);
  } catch (err) {
    console.warn(`⚠️  API token 写入失败: ${String(err)}\n   手动创建: echo -n $HUB_API_TOKEN > ${API_TOKEN_FILE} && chmod 600 $_`);
  }
}

function unregisterMcp(): void {
  const data = readClaudeJson();
  const mcpServers = (data.mcpServers ?? {}) as Record<string, unknown>;
  delete mcpServers.hub;
  data.mcpServers = mcpServers;
  writeClaudeJson(data);
}

function isMcpRegistered(): boolean {
  const data = readClaudeJson();
  const mcpServers = (data.mcpServers ?? {}) as Record<string, unknown>;
  return "hub" in mcpServers;
}

// ── dispatch ────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
switch (cmd) {
  case "install":
    installCmd();
    break;
  case "uninstall":
    uninstallCmd();
    break;
  case "doctor":
    doctorCmd();
    break;
  case "--help":
  case "-h":
  case undefined:
    log(`forge-hub — Multi-channel messaging hub for Claude Code

USAGE:
  forge-hub <command>

COMMANDS:
  install      一键部署到 ~/.forge-hub/ + ~/.claude/channels/hub/ + launchd + MCP 注册
  uninstall    反向操作（保留 state）
  doctor       诊断 install 状态 + connectivity
  --help       显示此帮助

REQUIREMENTS:
  - Bun >= 1.0
  - Claude Code CLI
  - macOS（Linux 部分功能可用，iMessage 通道仅 mac）

DOCS:
  README.md — 总览 + 远程审批接入
  部署.md — 详细部署步骤（手动方案）
  hub-docs/channel-plugin-guide.md — 写新通道插件
`);
    break;
  default:
    die(`未知命令: ${cmd}。试 forge-hub --help`);
}

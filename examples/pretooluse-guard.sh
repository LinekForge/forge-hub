#!/bin/bash
# Example PreToolUse hook — gate tool calls and route approval to Forge Hub channels.
#
# How it works:
#   1. Claude Code calls this hook BEFORE running any tool
#   2. Hook inspects tool_name + input, decides if user approval needed
#   3. If yes, returns permissionDecision: 'ask'
#   4. Claude Code then:
#      a. pops local terminal approval dialog
#      b. emits notifications/claude/channel/permission_request to all channels
#         with claude/channel/permission capability (i.e., Forge Hub)
#      c. whoever answers first (local or remote) wins; the other closes
#
# Install:
#   1. Copy this file to ~/.claude/hooks/pretooluse-guard.sh
#   2. Make it executable: chmod +x ~/.claude/hooks/pretooluse-guard.sh
#   3. Register in ~/.claude/settings.json:
#        "hooks": {
#          "PreToolUse": [
#            {
#              "hooks": [
#                { "type": "command", "command": "bash ~/.claude/hooks/pretooluse-guard.sh" }
#              ]
#            }
#          ]
#        }
#
# Customize the DANGEROUS patterns below to your needs. Too strict = too many
# approval prompts; too lax = Claude does destructive things unsupervised.

set -euo pipefail

INPUT=$(cat)

# Helper: return 'ask' verdict with a reason
emit_ask() {
  local reason="$1"
  python3 -c "
import json
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'ask',
        'permissionDecisionReason': '$reason'
    }
}))
"
  exit 0
}

# Check prerequisites — fail-closed (redteam 终审 P0-4).
# 之前这里 parse 失败 stderr 吞掉 → TOOL="" → 所有 grep miss → exit 0 放行。
# 一个"加安全"的 hook 在失败路径上解除防御 = 比没 hook 更糟。
# Fix: python3 缺失 / JSON parse 失败都显式 emit_ask，让 Claude 走 manual review。
if ! command -v python3 >/dev/null 2>&1; then
  emit_ask "pretooluse-guard requires python3 but it is not installed; manual review required."
fi

# Parse tool_name + command from JSON input (fail-closed if parse fails)
TOOL=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>&1) || {
  emit_ask "Unable to parse tool input JSON; manual review required."
}
COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>&1) || {
  emit_ask "Unable to parse tool input command; manual review required."
}

# Also fail-closed if TOOL came back empty (JSON missing tool_name is abnormal)
if [ -z "$TOOL" ]; then
  emit_ask "Empty tool_name in input; manual review required."
fi

# ── 1. Bash destructive commands ────────────────────────────────────────────
if [ "$TOOL" = "Bash" ]; then
  # rm / rmdir / find -delete / shred
  if printf '%s' "$COMMAND" | grep -qE '(^|\s|;|&&|\|\|)(rm|rmdir|find\s.*-delete|shred)\s'; then
    emit_ask "Destructive file operation detected; please confirm."
  fi
  # git force push / reset --hard
  if printf '%s' "$COMMAND" | grep -qE 'git\s+(push\s+--force|push\s+-f|reset\s+--hard)'; then
    emit_ask "Git history-rewriting command; please confirm."
  fi
  # network exfil (curl POST to non-localhost)
  # 注：POSIX ERE 不支持 negative lookahead `(?!...)`；用两步 grep + ! 取反实现"POST 且非本地"
  # if printf '%s' "$COMMAND" | grep -qE 'curl.*-X[[:space:]]+POST.*https?://' \
  #    && ! printf '%s' "$COMMAND" | grep -qE 'https?://(localhost|127\.)'; then
  #   emit_ask "Outbound POST detected; please confirm."
  # fi
  exit 0
fi

# ── 2. CC built-in tools that modify state ─────────────────────────────────
case "$TOOL" in
  Write|Edit|NotebookEdit)
    # Modifying files: optional gate. Comment out if too noisy.
    # emit_ask "File write/edit; please confirm."
    exit 0
    ;;
esac

# ── 3. MCP tools (opt-in list) ──────────────────────────────────────────────
# Uncomment tools you want to gate. Format is mcp__<server>__<tool>.
case "$TOOL" in
  mcp__computer-use__request_access)
    emit_ask "computer-use is requesting control of applications; please confirm."
    ;;
  mcp__computer-use__left_click|mcp__computer-use__type|mcp__computer-use__key)
    # Uncomment to gate every keystroke / click — very noisy but max control.
    # emit_ask "computer-use input event; please confirm."
    exit 0
    ;;
  # Add your own MCP tools here:
  # mcp__your-server__dangerous_tool)
  #   emit_ask "Custom dangerous tool; please confirm."
  #   ;;
esac

exit 0

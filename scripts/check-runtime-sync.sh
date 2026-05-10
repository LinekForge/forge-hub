#!/bin/bash
# 检查 OSS 和运行时是否同步。commit 前跑一下。
# 用法: bash scripts/check-runtime-sync.sh

set -e
cd "$(dirname "$0")/.."

HUB_RUNTIME="${HOME}/.forge-hub/source"
CLIENT_RUNTIME="${HOME}/.claude/自动化/channels/hub"
CLI_RUNTIME="${HOME}/.forge-hub/cli"
DRIFT=0

check() {
  local src="$1" dst="$2" label="$3"
  if [ ! -f "$dst" ]; then
    echo "  ❌ $label — 运行时不存在"
    DRIFT=1
  elif ! diff -q "$src" "$dst" >/dev/null 2>&1; then
    echo "  ❌ $label — 不同步"
    DRIFT=1
  fi
}

echo "hub-server:"
for f in hub.ts endpoints.ts config.ts types.ts channel-loader.ts channel-health.ts approval.ts rate-limit.ts history.ts hub-state.ts resolve.ts router.ts lock.ts tts.ts; do
  [ -f "hub-server/$f" ] && check "hub-server/$f" "$HUB_RUNTIME/$f" "$f"
done

echo "routes/:"
for f in hub-server/routes/*.ts; do
  [ -f "$f" ] && check "$f" "$HUB_RUNTIME/routes/$(basename $f)" "routes/$(basename $f)"
done

echo "channels/:"
for f in hub-server/channels/*.ts; do
  [ -f "$f" ] && check "$f" "$HUB_RUNTIME/channels/$(basename $f)" "channels/$(basename $f)"
done

echo "hub-client:"
check "hub-client/hub-channel.ts" "$CLIENT_RUNTIME/hub-channel.ts" "hub-channel.ts"
check "hub-client/session-config.ts" "$CLIENT_RUNTIME/session-config.ts" "session-config.ts"

echo "forge-cli:"
check "forge-cli/forge.ts" "$CLI_RUNTIME/forge.ts" "forge.ts"

echo ""
if [ $DRIFT -eq 0 ]; then
  echo "✅ 全部同步"
else
  echo "⚠ 有文件不同步。同步后再 commit。"
  exit 1
fi

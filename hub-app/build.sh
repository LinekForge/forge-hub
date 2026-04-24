#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HUB_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DASHBOARD_DIR="$HUB_ROOT/hub-dashboard"
APP_NAME="Forge Hub"
APP="$SCRIPT_DIR/$APP_NAME.app"
SRC="$SCRIPT_DIR/app"

echo "=== 编译 Forge Hub ==="

# 1. Quit existing
osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
sleep 1

# 2. Build dashboard
if [ -d "$DASHBOARD_DIR" ]; then
  echo "  → 编译 Dashboard..."
  (cd "$DASHBOARD_DIR" && bun install --frozen-lockfile 2>/dev/null; bun run build 2>&1 | tail -3)
fi

# 3. Create .app bundle
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$SRC/Info.plist" "$APP/Contents/"
echo -n "APPL????" > "$APP/Contents/PkgInfo"

# 4. Copy icon if exists
[ -f "$SRC/AppIcon.icns" ] && cp "$SRC/AppIcon.icns" "$APP/Contents/Resources/"
[ -f "$SRC/icon.png" ] && cp "$SRC/icon.png" "$APP/Contents/Resources/"
cp "$SCRIPT_DIR/shared/scan-sessions.py" "$APP/Contents/Resources/scan-sessions.py"

# 5. Bundle dashboard dist
if [ -d "$DASHBOARD_DIR/dist" ]; then
  echo "  → 打包 Dashboard 到 app bundle..."
  cp -r "$DASHBOARD_DIR/dist" "$APP/Contents/Resources/dashboard-dist"
fi

# 6. Compile Swift
echo "  → 编译 Swift..."
swiftc \
    "$SRC/Models.swift" \
    "$SRC/TerminalAdapter.swift" \
    "$SRC/SessionStore.swift" \
    "$SRC/SessionDescriptionStore.swift" \
    "$SRC/SessionScanner.swift" \
    "$SRC/HubClient.swift" \
    "$SRC/WebViewBridge.swift" \
    "$SRC/AppDelegate.swift" \
    "$SRC/main.swift" \
    -o "$APP/Contents/MacOS/ForgeHub" \
    -framework Cocoa \
    -framework WebKit \
    -target arm64-apple-macos13.0 \
    -suppress-warnings

# 7. Sign
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP"

echo "  ✓ $APP_NAME.app"
echo ""
echo "=== 完成 ==="
echo "启动：open \"$APP\""
echo "开发模式：\"$APP/Contents/MacOS/ForgeHub\" --dev"

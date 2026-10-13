#!/bin/zsh
# 打包成 macOS .app（+ .dmg）。不依赖 electron-builder：直接复用 node_modules 里的 Electron.app，
# 把应用代码放进 Contents/Resources/app，改名、换图标、ad-hoc 签名。
# 用法：npm install && npm run build
set -euo pipefail
cd "$(dirname "$0")/.."

# 固定用系统 rm（个别环境里 PATH 上的 rm 被包装过，删 .asar 会误报）
rm() { /bin/rm "$@"; }

NAME="飞书文档"
EXEC="FeishuDocs"
BUNDLE_ID="com.fsdoc.client"
VERSION=$(node -p "require('./package.json').version")
ARCH=$(uname -m)   # arm64 / x86_64，与本机 npm install 的 Electron 一致

SRC="node_modules/electron/dist/Electron.app"
[ -d "$SRC" ] || { echo "找不到 $SRC，请先 npm install"; exit 1; }

OUT="dist"
APP="$OUT/$NAME.app"
rm -rf "$APP" && mkdir -p "$OUT"
ditto "$SRC" "$APP"

RES="$APP/Contents/Resources"
rm -rf "$RES/default_app.asar" "$RES/app"
mkdir -p "$RES/app"
cp package.json main.js tabbar.html tabbar-preload.js pane-preload.js "$RES/app/"
cp build/icon.icns "$RES/icon.icns"
rm -f "$RES/electron.icns"

# Info.plist：名称 / 标识 / 图标 / 版本 / 可执行文件名
PL="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PL" 2>/dev/null || /usr/libexec/PlistBuddy -c "${1/Set/Add}" "$PL"; }
pb "Set :CFBundleName $NAME"
pb "Set :CFBundleDisplayName $NAME"
pb "Set :CFBundleIdentifier $BUNDLE_ID"
pb "Set :CFBundleExecutable $EXEC"
pb "Set :CFBundleIconFile icon.icns"
pb "Set :CFBundleShortVersionString $VERSION"
pb "Set :CFBundleVersion $VERSION"
/usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "$PL" 2>/dev/null || true
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$EXEC"

# ad-hoc 签名（改过 Info.plist 后必须重签，否则 macOS 报"已损坏"）
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" && echo "✅ 签名校验通过"

# DMG（含 Applications 快捷方式，拖拽安装）
DMG="$OUT/$NAME-$VERSION-$ARCH.dmg"
STAGE=$(mktemp -d)
ditto "$APP" "$STAGE/$NAME.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo "✅ $APP"
echo "✅ $DMG"

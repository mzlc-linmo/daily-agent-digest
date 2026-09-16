#!/bin/bash
# 在**没有 Developer ID 证书**的机器上打一个可安装的 DMG。
#
# 与 CI 的分工:
#   - 正式发布:scripts/ci-build.sh + scripts/ci-notarize.sh —— 需要 Developer ID 证书与
#     Apple 公证凭据,产出签名并公证过的 DMG;
#   - 本脚本:本机自用 / 内网分发。产出**未公证**的 DMG,别的机器首次打开要右键「打开」,
#     或者 `xattr -d com.apple.quarantine "/Applications/Daily Agent Digest.app"`。
#
# 与 CI 发布版保持一致的关键两点:
#   1. 引擎用 PyInstaller onedir 打进 App 包(Contents/Resources/engine),App 不依赖
#      外部安装的引擎 —— onefile 每次调用要解包 20MB,菜单动作会卡 3-6 秒;
#   2. DMG 里带 /Applications 快捷方式,拖拽即安装。
#
# 用法:scripts/build-dmg.sh [--skip-tests]
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST="$ROOT/dist"
ARCH=$(uname -m)
# 版本会随上报进 release_version(用于定位是哪个客户端产出的日报),所以不要用 dev。
VERSION=${DIGEST_RELEASE_VERSION:-v0.6.8}
VENV=${DIGEST_BUILD_VENV:-$ROOT/.build/venv}
PY="$VENV/bin/python"
APP="$DIST/Daily Agent Digest.app"
ENGINE_DIR="$DIST/engine-$ARCH"
DMG="$DIST/Daily-Agent-Digest-$VERSION-$ARCH.dmg"
VOLNAME="Daily Agent Digest $VERSION"

SKIP_TESTS=0
[ "${1:-}" = "--skip-tests" ] && SKIP_TESTS=1

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "本脚本只支持 macOS"
[ -f "$ROOT/daily_agent_digest.py" ] || die "找不到引擎源码:$ROOT/daily_agent_digest.py"
command -v hdiutil >/dev/null || die "缺少 hdiutil"
command -v swiftc >/dev/null || die "缺少 swiftc(需要 Xcode Command Line Tools)"

# ---------------------------------------------------------------- 构建环境 ---
# 独立 venv,不污染系统 Python;PyInstaller 版本与 CI 固定成同一个。
ensure_venv() {
  if [ ! -x "$PY" ]; then
    say "创建构建 venv:$VENV"
    python3 -m venv "$VENV"
  fi
  if ! "$PY" -c 'import PyInstaller' 2>/dev/null; then
    say "安装 PyInstaller 6.16.0(与 CI 同版本)"
    PIP_CACHE_DIR="$ROOT/.build/pipcache" TMPDIR="$ROOT/.build/tmp" \
      "$PY" -m pip install --quiet --upgrade pip pyinstaller==6.16.0
  fi
  "$PY" -c 'import PyInstaller; print("pyinstaller", PyInstaller.__version__)'
}

# ------------------------------------------------------------------- 构建 ---
# 先跑协议测试:打的包要真能上报,别把坏引擎装进 DMG。
run_tests() {
  [ "$SKIP_TESTS" = 1 ] && { say "跳过测试(--skip-tests)"; return; }
  say '运行核心协议测试'
  "$PY" -m unittest discover -s "$ROOT/tests" 2>&1 | tail -3
}

build_engine() {
  say "构建 onedir 引擎(arch=$ARCH)"
  rm -rf "$ENGINE_DIR"
  # workpath/specpath 放在 .build 下,避免把中间产物写进仓库根目录。
  # PYINSTALLER_CONFIG_DIR 必须显式指定:默认写 ~/Library/Application Support/pyinstaller,
  # 在受限环境(沙箱/CI)里那里不可写,会直接报 Operation not permitted。
  TMPDIR="$ROOT/.build/tmp" PYINSTALLER_CONFIG_DIR="$ROOT/.build/pyinstaller-cache" \
    "$VENV/bin/pyinstaller" --onedir --name daily-agent-digest \
    --distpath "$ENGINE_DIR" \
    --workpath "$ROOT/.build/onedir-work" \
    --specpath "$ROOT/.build/onedir-spec" \
    --noconfirm --log-level WARN \
    "$ROOT/daily_agent_digest.py"
  [ -x "$ENGINE_DIR/daily-agent-digest/daily-agent-digest" ] \
    || die "引擎没有产出:$ENGINE_DIR/daily-agent-digest/daily-agent-digest"
}

build_app() {
  say "构建菜单栏 App($VERSION)"
  rm -rf "$DIST/Daily Agent Digest.app"
  DIGEST_RELEASE_VERSION="$VERSION" DIGEST_UI_BUILD_ID="$VERSION" \
    bash "$ROOT/native/macos/build.sh" "$APP"
  # ditto 复制的是**目录内容**(不是把目录嵌进去),所以结果是
  # Contents/Resources/engine/daily-agent-digest 这个可执行文件 + 同级 _internal/ ——
  # 正是 Backend.init() 里第一个候选路径,也正是 PyInstaller 找 _internal 的位置。
  mkdir -p "$APP/Contents/Resources/engine"
  ditto "$ENGINE_DIR/daily-agent-digest" "$APP/Contents/Resources/engine"
  [ -x "$APP/Contents/Resources/engine/daily-agent-digest" ] \
    || die "引擎没有进包:Contents/Resources/engine/daily-agent-digest 不是可执行文件"
  [ -d "$APP/Contents/Resources/engine/_internal" ] || die "引擎缺少 _internal 目录"
}

# ad-hoc 签名:arm64 上未签名的 Mach-O 会被内核直接拒绝执行,所以每个 Mach-O 都要签,
# 再签外层 bundle 把资源封进去。(不是 Developer ID,别的机器仍会被 Gatekeeper 拦。)
sign_app() {
  say 'ad-hoc 签名(未公证)'
  while IFS= read -r -d '' item; do
    if file -b "$item" | grep -q 'Mach-O'; then
      codesign --force --sign - "$item" 2>/dev/null || die "签名失败:$item"
    fi
  done < <(find "$APP/Contents/Resources/engine" -type f -print0)
  codesign --force --sign - "$APP/Contents/MacOS/DailyAgentDigest"
  codesign --force --sign - "$APP"
  codesign --verify --strict "$APP" || die "App 签名校验失败"
}

# 断言 App 真的会用包内引擎,而不是悄悄回退到外部安装的引擎 —— 那会让 DMG 装到别的机器上直接不可用。
verify_bundled_engine() {
  local reported
  reported=$("$APP/Contents/MacOS/DailyAgentDigest" --engine-path || true)
  case "$reported" in
    */Contents/Resources/engine/daily-agent-digest) say "包内引擎已生效:$reported" ;;
    *) die "App 没有解析到包内引擎,实际解析为:$reported" ;;
  esac
  # 真的跑一次引擎:能执行 + 能应答 JSON 才算这个包是可用的。
  local home
  home=$(mktemp -d)
  if ! printf '{}' | DIGEST_HOME="$home" "$APP/Contents/Resources/engine/daily-agent-digest" \
        --app-command state >/dev/null 2>&1; then
    rm -rf "$home"
    die "包内引擎无法执行(onedir 布局或签名有问题)"
  fi
  rm -rf "$home"
  say '包内引擎可正常执行'
}

# ------------------------------------------------------------------- DMG ---
build_dmg() {
  say "制作 DMG:$DMG"
  # 卷名带版本:一是方便在 Finder / 挂载列表里区分是哪个包,二是避开与别人的同名卷冲突
  # —— hdiutil 建卷时要挂到 /Volumes/<卷名>,那里被占着只会报一句"目录非空",
  # 完全看不出是卷名冲突。
  #
  # 卷名里带版本号,所以同名卷只可能是**本脚本上一次构建**留下的残留挂载,
  # 直接卸掉即可(别人的镜像叫 "Daily Agent Digest",不会撞上这个带版本的名字)。
  # 不卸的话 hdiutil create 会失败,而失败原因完全指不到挂载点上。
  if [ -d "/Volumes/${VOLNAME}" ]; then
    say "卸载上一次构建残留的挂载卷:/Volumes/${VOLNAME}"
    hdiutil detach "/Volumes/${VOLNAME}" -quiet \
      || die "无法卸载 /Volumes/${VOLNAME}(可能正被 Finder 占用)。请手动执行:hdiutil detach \"/Volumes/${VOLNAME}\""
  fi
  local stage
  stage=$(mktemp -d)
  # 用 ditto 而不是 cp -R:保证扩展属性随 bundle 一起复制。
  ditto "$APP" "$stage/Daily Agent Digest.app"
  ln -s /Applications "$stage/Applications"
  rm -f "$DMG"
  # create 失败时也可能已经把卷挂上了,留下残留挂载点让下一次报"目录非空";
  # 这里兜底卸一次,不管成功失败。
  hdiutil create -volname "$VOLNAME" -srcfolder "$stage" -ov -format UDZO "$DMG" >/dev/null || {
    hdiutil detach "/Volumes/${VOLNAME}" -quiet 2>/dev/null || true
    rm -rf "$stage"
    die "hdiutil create 失败"
  }
  rm -rf "$stage"
}

# 按用户实际接触它的方式校验:挂载 → 检查 App 与拖拽入口 → 卸载。
#
# 挂载点用 mktemp 而不是让它自动挂到 /Volumes/<卷名>:自动挂载会占住 /Volumes 下的
# 同名目录,校验结束时若没卸干净,下一次构建就在 hdiutil create 处报"目录非空"。
verify_dmg() {
  say '校验 DMG'
  local mount rc=0
  mount=$(mktemp -d)
  # EXIT trap:无论从哪条路径退出(含 die 的 exit)都保证卸载,不留残留挂载。
  trap 'hdiutil detach "$mount" -quiet 2>/dev/null || true; rm -rf "$mount"' EXIT
  hdiutil attach "$DMG" -mountpoint "$mount" -nobrowse -quiet
  local embedded='' candidate
  for candidate in "$mount"/*.app; do
    [ -d "$candidate" ] && { embedded="$candidate"; break; }
  done
  [ -n "$embedded" ] || die "DMG 里没有 .app"
  codesign --verify --strict "$embedded" || die "DMG 内的 App 签名校验失败"
  [ -L "$mount/Applications" ] || die "DMG 缺少 Applications 快捷方式"
  [ -x "$embedded/Contents/Resources/engine/daily-agent-digest" ] || die "DMG 内的 App 没有内置引擎"
  hdiutil detach "$mount" -quiet || rc=$?
  trap - EXIT
  [ "$rc" = 0 ] || die "DMG 卸载失败"
  rm -rf "$mount"
  say 'DMG 校验通过(App 可拖拽安装、内置引擎在位)'
}

main() {
  ensure_venv
  run_tests
  build_engine
  build_app
  sign_app
  verify_bundled_engine
  build_dmg
  verify_dmg
  say ''
  say "产物:$DMG"
  say "版本:$VERSION  arch:$ARCH  大小:$(du -h "$DMG" | awk '{print $1}')"
  say "SHA256:$(shasum -a 256 "$DMG" | awk '{print $1}')"
  say ''
  say '未公证:别的机器首次打开需右键「打开」;若从网络下载被拦,执行'
  say '  xattr -dr com.apple.quarantine "/Applications/Daily Agent Digest.app"'
}

main

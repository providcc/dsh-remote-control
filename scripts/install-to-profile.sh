#!/bin/sh
# install-to-profile.sh — 构建插件并装进 DSH profile。
#
#   ./scripts/install-to-profile.sh                       # ~/.dsh/profiles/desktop
#   DSH_PROFILE=~/.dsh/profiles/tui ./scripts/install-to-profile.sh
#
# 装的是**一个 bundle，两半产物**（2026-10-03 起；之前是两包两个 bundle）：
#
#   dsh-remote-control/index.js    宿主侧：配对、中继、会话、命令，**外加**右栏自动弹码
#                                  那一半（当前配对码落 PNG + 一条同域只读路由）。
#   dsh-remote-control/client.cjs  浏览器面：轮询那条路由，把二维码**自动推进右栏**。
#
# 为什么原来拆两包、现在折一个：拆包是为了"某一代宿主没有 `webServer` 时只有那一行不激活，
# 配对/中继一行都不受影响"。折成一个包之后这个隔离由代码提供——`src/presentation/sidebar.ts`
# 只软探测 `webServer`，拿不到就整半不起；`tests/presentation-isolation.test.ts` 用**逐字段对照**
# 锁住这件事（同一个假上下文跑两遍，差别只许出现在 `state().sidebar` 那一块）。
#
# 为什么长这样（每条都是踩过坑换来的）：
# 1. **只拷产物**：两半都由 esbuild 打成自包含单文件（dist/bundle/*），
#    profile 里不需要 node_modules —— 旧实现要靠 `pnpm add file:` 装整个包，
#    而 pnpm 对 `file:` 依赖是硬链接拷贝，`tsc` 重建后 inode 变了、profile 里仍是旧副本。
# 2. **不跑 pnpm add**：它会重新解析 profile 里所有依赖（含若干 GitHub tarball），
#    网络抖一下就更新不了一个纯本地插件。
# 3. **改代码必须重启 Harness**：HMR 只热更 cordis.patch.yml 的配置，不会重新 import dist；
#    浏览器面同理，重新加载页面才会重新拉 client.cjs。
# 4. 首次安装才备份并改写 profile 的 package.json（注册进 bundles 列表），后续只换文件。
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
PLUGIN="$ROOT/packages/plugin"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/desktop}"
BUNDLE_ID="dsh-remote-control"
# 上一个形态遗留的第二条 bundle 名，只在"退役"那一步用到。
OLD_PRESENTATION_ID="dsh-remote-control-presentation"

if [ ! -d "$PROFILE" ]; then
  echo "install-to-profile: profile not found: $PROFILE" >&2
  exit 1
fi

# 装 profile 只需要**产物**；类型检查是 CI 的事（pnpm -r typecheck）。
# 这里刻意不跑 tsc：类型检查失败不该挡住"把当前代码装进宿主验证一把"。
# 协议层是外部 npm 依赖（dsh-remote-wire），由 `pnpm install` 落到 node_modules，
# esbuild 打包时直接内联，本脚本不再单独构建它。
echo "→ 构建：一次 esbuild 打包产出两半（index.js + client.cjs，协议层随依赖内联）…"
node "$ROOT/scripts/bundle-plugin.mjs"

built="$PLUGIN/dist/bundle/index.js"
client="$PLUGIN/dist/bundle/client.cjs"
version=$(node -p "require('$PLUGIN/package.json').version")
target="$PROFILE/node_modules/$BUNDLE_ID"

[ -f "$built" ] || { echo "install-to-profile: 缺宿主侧产物 $built" >&2; exit 1; }
[ -f "$client" ] || { echo "install-to-profile: 缺浏览器面产物 $client" >&2; exit 1; }

# **必须是真目录，不能是指回工作区的软链**。旧实现用 `pnpm add file:.../packages/plugin`
# 安装，profile 的 package.json 里就留下一条 `"dsh-remote-control": "file:..."`；
# 只要那条还在，`pnpm install` 就会把整个工作区包再物化一份进来，
# 于是宿主里同时跑着**两个插件实例**：两个 hostId、中继里两份会话、
# 手机连到哪一个全看谁先注册——真机取证时表现为"改了的代码没生效"，
# 而 status.json 的计数来自另一个实例，怎么都对不上账（这次就是被它误导了好几轮）。
if [ -L "$target" ]; then
  echo "install-to-profile: $target 是软链（指向 $(readlink "$target")）——profile 里还留着 file: 依赖" >&2
  echo "  先删掉 $PROFILE/package.json 的 dependencies.${BUNDLE_ID}，再重跑本脚本。" >&2
  exit 1
fi
# 整个目录先删后建：只删 index.js/package.json 的话，上一次 pnpm 物化出来的
# dist/、node_modules/ 会被当成当前版本的一部分。顺带清掉手工调试留下的残渣。
rm -rf "$target"
mkdir -p "$target"
cp "$built" "$target/index.js"
cp "$client" "$target/client.cjs"
cp "$PLUGIN/cordis.patch.yml" "$target/cordis.patch.yml"

# `dsh.bundle.patch` 是宿主认出这是一个 bundle 的入口字段——漏了它，
# 文件都在、profile 的 bundles 列表里也有名字，但插件根本不会被加载（踩过一次）。
# 浏览器面多两个字段：`exports["./client"]` 指向产物，`dsh.client.platform` 表明它是 web 面。
# `dsh.client.inject` 是**包名**列表（模块到达顺序），不是 cordis 服务名——空数组即可。
cat > "$target/package.json" <<JSON
{
  "name": "$BUNDLE_ID",
  "version": "$version",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.cjs",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": []
    }
  }
}
JSON
echo "   已写入 $target"
echo "     $BUNDLE_ID @ $version（含浏览器面 client.cjs）"

echo "→ 注册 bundle 到 profile 的 bundles 列表（幂等），并清掉旧的 file: 依赖与退役条目…"
node --input-type=module -e "
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
const file = '$PROFILE/package.json'
const id = '$BUNDLE_ID'
const retired = ['$OLD_PRESENTATION_ID']
if (!existsSync(file)) { console.error('profile 没有 package.json：' + file); process.exit(1) }
// 每次改写前都留一份原文：这文件里同时带着 hostToken，改坏了要能一眼回退。
writeFileSync(file + '.bak-drc-' + Math.floor(Date.now() / 1000), readFileSync(file))
const pkg = JSON.parse(readFileSync(file, 'utf8'))
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const list = pkg.dsh.profile.bundles || []
if (!list.includes(id)) list.push(id)
// 折并之后右栏那一半不再是独立条目。留着它只会多一条"bundle 在列表里但目录已删"的
// 加载失败记录，所以从列表里摘掉，并把它的安装目录一起删掉。
for (const name of retired) {
  const at = list.indexOf(name)
  if (at >= 0) {
    list.splice(at, 1)
    console.log('   从 bundles 列表摘掉退役条目 ' + name)
  }
  const dir = '$PROFILE/node_modules/' + name
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    console.log('   删除退役目录 ' + dir)
  }
}
pkg.dsh.profile.bundles = list
// 旧机制退役：'file:' 依赖会让 pnpm 再物化一份插件进 profile，
// 两个实例同时挂在中继上（两个 hostId、两份会话），手机连到谁全凭运气。
// 现在的安装方式只有这一条：本目录下的单文件 bundle + bundles 列表里的名字。
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  if (!pkg[field] || typeof pkg[field] !== 'object') continue
  for (const name of [id, ...retired]) {
    if (name in pkg[field]) {
      console.log('   删除 ' + field + '.' + name + ' = ' + JSON.stringify(pkg[field][name]))
      delete pkg[field][name]
    }
  }
}
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('   bundles:', list.join(', '))
"

echo
echo "✅ 已安装 $BUNDLE_ID（两半产物）→ $PROFILE/node_modules/"
echo "   下一步：**重启 Harness**（新代码不会被热加载；浏览器面还要重新加载页面），然后看"
echo "     cat ~/.dsh/dsh-remote-control/status.json"
echo "   关键四字段：carrier（services=真内核 / mock=内存替身 / none=配置或载体问题）、"
echo "               relay（online/connecting/offline）、relayProblem、"
echo "               sidebar（右栏那一半的软探测结果：route=registered / webServer=none / disabled）"
echo "   右栏自动弹码：在 DSH 里执行 /drc pair，右栏应自动出现二维码；"
echo "     没弹就看 <工作区>/.dsh/sidebar-qr.png 有没有落盘（工作区解析不出来时才落 ~/.dsh/sidebar-qr.png），"
echo "     status.json 的 sidebar 那块说了为什么没挂上路由，以及 crash 日志里有没有"
echo "     [dsh-remote-control sidebar] 开头的 console.error。"

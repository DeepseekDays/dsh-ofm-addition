/**
 * dsh-ofm-addition / install.mjs
 * ============================================================================
 * 把本插件挂进 DSH 的 desktop profile。**不跑 pnpm** —— DSH 运行时跑 pnpm 会重建
 * node_modules 并打断会话。本插件零依赖：index.js 只 import node 内置模块和相对
 * 路径，client.js 只 require 外壳已经提供的 react，所以目录联接就够了。
 *
 * 做三件事（全部可重复执行）：
 *   1. 在 `<profile>/node_modules/` 下建 junction → 本目录；
 *   2. 在 `<profile>/package.json` 的 dependencies 里加
 *      `"dsh-ofm-addition": "link:<本目录>"`；
 *   3. 在 `dsh.profile.bundles` 里追加 `dsh-ofm-addition`（若清单里已有
 *      `dsh-our-free-model`，就插到它后面；本插件只 insert 自己的 entry，
 *      不覆盖别人，顺序只为日志可读）。
 *
 * 用法：
 *   node install.mjs             安装 / 修复
 *   node install.mjs --uninstall  卸载（移除 junction 与两条清单记录，保留插件目录）
 *   node install.mjs --dry        只看要做哪些改动
 *
 * 装完必须**完全退出 DSH（含托盘）再启动**：bundle 列表与 client 模块表都是启动期
 * 读的，HMR 不会热加载新包。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'dsh-ofm-addition'
/** Our Free Model's bundle id, so the add-on can sit right after it. */
const UPSTREAM_BUNDLE = 'dsh-our-free-model'
const PROFILE = process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

const argv = process.argv.slice(2)
const UNINSTALL = argv.includes('--uninstall')
const DRY = argv.includes('--dry')

const manifestPath = path.join(PROFILE, 'package.json')
const modulesDir = path.join(PROFILE, 'node_modules')
const linkPath = path.join(modulesDir, PACKAGE_NAME)
const linkTarget = HERE.replaceAll('\\', '/')

const log = (...args) => console.log(...args)

if (!fs.existsSync(manifestPath)) {
  console.error(`找不到 profile 清单：${manifestPath}`)
  console.error('用 DSH_PROFILE_DIR 指定别的 profile 目录。')
  process.exit(1)
}

const original = fs.readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(original)

// --------------------------------------------------------------- 1. junction
const linkStat = fs.lstatSync(linkPath, { throwIfNoEntry: false })
if (UNINSTALL) {
  if (linkStat !== undefined) {
    if (DRY) log(`[dry] 删除 junction ${linkPath}`)
    else {
      // A junction is a directory; `rmSync` on it removes the link, not the target.
      fs.rmSync(linkPath, { recursive: true, force: true })
      log(`已删除 junction：${linkPath}`)
    }
  } else {
    log(`junction 不存在，跳过：${linkPath}`)
  }
} else if (linkStat !== undefined) {
  log(`junction 已存在（${linkStat.isSymbolicLink() ? 'symlink' : 'real'}）：${linkPath}`)
} else if (DRY) {
  log(`[dry] 创建 junction ${linkPath} -> ${linkTarget}`)
} else {
  fs.mkdirSync(modulesDir, { recursive: true })
  fs.symlinkSync(HERE, linkPath, 'junction')
  log(`已创建 junction：${linkPath} -> ${HERE}`)
}

// --------------------------------------------------------- 2. dependencies
manifest.dependencies ??= {}
const wantedSpec = `link:${linkTarget}`
if (UNINSTALL) {
  if (manifest.dependencies[PACKAGE_NAME] !== undefined) {
    delete manifest.dependencies[PACKAGE_NAME]
    log(`已从 dependencies 移除 ${PACKAGE_NAME}`)
  }
} else if (manifest.dependencies[PACKAGE_NAME] !== wantedSpec) {
  manifest.dependencies[PACKAGE_NAME] = wantedSpec
  log(`dependencies.${PACKAGE_NAME} = ${wantedSpec}`)
} else {
  log(`dependencies.${PACKAGE_NAME} 已是 ${wantedSpec}`)
}

// ------------------------------------------------------- 3. bundle 清单
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
// Some profiles also keep a second list at the top level; maintain it when present.
const lists = [manifest.dsh.profile.bundles]
if (Array.isArray(manifest.dsh.bundles)) lists.push(manifest.dsh.bundles)

for (const list of lists) {
  const at = list.indexOf(PACKAGE_NAME)
  if (UNINSTALL) {
    if (at >= 0) {
      list.splice(at, 1)
      log(`已从 bundles 移除 ${PACKAGE_NAME}`)
    }
    continue
  }
  if (at >= 0) {
    log(`bundles 里已有 ${PACKAGE_NAME}（位置 ${at}）`)
    continue
  }
  const upstream = list.indexOf(UPSTREAM_BUNDLE)
  if (upstream >= 0) {
    list.splice(upstream + 1, 0, PACKAGE_NAME)
    log(`bundles 里插到 ${UPSTREAM_BUNDLE} 之后（位置 ${upstream + 1}）`)
  } else {
    list.push(PACKAGE_NAME)
    log(`bundles 末尾追加 ${PACKAGE_NAME}`)
  }
}

// ------------------------------------------------------------------ 写回
const next = `${JSON.stringify(manifest, null, 2)}\n`
if (next === original) {
  log('清单无需改动。')
} else if (DRY) {
  log('[dry] package.json 有新内容，未写入。')
} else {
  const backup = `${manifestPath}.bak-ofm-addition-${Date.now()}`
  fs.copyFileSync(manifestPath, backup)
  fs.writeFileSync(manifestPath, next)
  log(`已写入 ${manifestPath}（备份：${path.basename(backup)}）`)
}

log('')
log(UNINSTALL ? '卸载完成。' : '安装完成。')
log('接下来：完全退出 DSH（含托盘）再重新启动。')
log('验证：设置 → OFM 增强；或故意把某个模型的输出上限调小，看截断后是否自动发出「继续」。')

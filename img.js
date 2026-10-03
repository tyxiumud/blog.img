#!/usr/bin/env node
'use strict'

/**
 * blog.img 图床助手（零依赖，只用 Node 内置模块）
 *
 *   node img.js check <文件|目录> [...]        查这些本地图片是否已经在图床里
 *   node img.js dupes [--blog <博客目录>]       列出图床里内容重复的图片
 *
 * 判定依据是文件内容的 MD5，不看文件名。因为重复上传时 PicGo 会在文件名后加
 * 时间戳后缀（如 xxx-165447711063045.png），按文件名比对永远查不出「其实已有」，
 * 只会越传越多。
 *
 * dupes 强烈建议带上 --blog，否则脚本不知道哪个副本正被博客引用，
 * 给出的「可删」列表可能包含不能删的文件。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const HOST_DIR = __dirname
const URL_BASE = 'https://cdn.jsdelivr.net/gh/tyxiumud/blog.img'
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
const TEXT_EXT = new Set(['.md', '.yml', '.yaml', '.js', '.pug', '.styl', '.css', '.html'])
const IGNORE = new Set([path.basename(__filename), 'README.md', '.imgbotconfig'])
const SKIP_DIR = new Set(['.git', 'node_modules', 'public', '.deploy_git'])

/** PicGo 重复上传时会追加的 11 位以上时间戳后缀 */
const isSuffixed = name => /-\d{11,}\./.test(name)

const md5 = buf => crypto.createHash('md5').update(buf).digest('hex')

/** 列出图床仓库里的图片文件名 */
function listHostImages () {
  return fs.readdirSync(HOST_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && !IGNORE.has(e.name) && IMG_EXT.has(path.extname(e.name).toLowerCase()))
    .map(e => e.name)
}

/** 建立 内容MD5 -> [文件名] 的索引 */
function buildIndex (names) {
  const index = new Map()
  for (const name of names) {
    const hash = md5(fs.readFileSync(path.join(HOST_DIR, name)))
    if (!index.has(hash)) index.set(hash, [])
    index.get(hash).push(name)
  }
  return index
}

/** 同名多副本且都未被引用时，挑一个最「干净」的作为保留名 */
function pickCanonical (names) {
  return names.slice().sort((a, b) => {
    const sa = isSuffixed(a) ? 1 : 0
    const sb = isSuffixed(b) ? 1 : 0
    if (sa !== sb) return sa - sb
    if (a.length !== b.length) return a.length - b.length
    return a.localeCompare(b)
  })[0]
}

/** 递归收集待检查的本地图片 */
function collectLocal (target, out) {
  const stat = fs.statSync(target)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIR.has(entry.name)) continue
      collectLocal(path.join(target, entry.name), out)
    }
    return out
  }
  if (IMG_EXT.has(path.extname(target).toLowerCase())) out.push(target)
  return out
}

/** 扫描博客，取出所有引用本图床的文件名 */
function collectRefs (blogDir) {
  const root = fs.existsSync(path.join(blogDir, 'source')) ? path.join(blogDir, 'source') : blogDir
  const pattern = /https?:\/\/cdn\.jsdelivr\.net\/gh\/tyxiumud\/blog\.img\/([^\s"')\]]+)/g
  const refs = new Set()

  ;(function walk (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name)) walk(path.join(dir, entry.name))
        continue
      }
      if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue
      const text = fs.readFileSync(path.join(dir, entry.name), 'utf8')
      for (const match of text.matchAll(pattern)) {
        refs.add(decodeURIComponent(match[1].split('?')[0]))
      }
    }
  })(root)

  return refs
}

function cmdCheck (targets) {
  if (!targets.length) {
    console.log('用法: node img.js check <文件或目录> [...]')
    process.exit(1)
  }

  const hostNames = listHostImages()
  const index = buildIndex(hostNames)

  let local
  try {
    local = targets.reduce((acc, t) => collectLocal(t, acc), [])
  } catch (e) {
    console.error('路径读取失败: ' + e.message)
    process.exit(1)
  }
  if (!local.length) {
    console.log('没有找到可检查的图片文件（支持: ' + [...IMG_EXT].join(' ') + '）')
    return
  }

  const already = []
  const missing = []

  for (const file of local) {
    const hit = index.get(md5(fs.readFileSync(file)))
    if (hit) already.push({ file, name: pickCanonical(hit), copies: hit.length })
    else missing.push(file)
  }

  console.log('图床现有图片 ' + hostNames.length + ' 个；待检查 ' + local.length + ' 个\n')

  if (already.length) {
    console.log('已在图床中（不必重复上传，直接用下面的 URL）:')
    for (const item of already) {
      const extra = item.copies > 1 ? '（图床内有 ' + item.copies + ' 个相同副本）' : ''
      console.log('  ' + item.file)
      console.log('    图床文件名: ' + item.name + extra)
      console.log('    URL: ' + URL_BASE + '/' + encodeURIComponent(item.name))
    }
    console.log('')
  }

  if (missing.length) {
    console.log('图床中没有（需要上传）:')
    for (const file of missing) console.log('  ' + file)
    console.log('')
  }

  console.log('小结: 已有 ' + already.length + ' 个，待上传 ' + missing.length + ' 个')
}

function cmdDupes (blogDir) {
  const hostNames = listHostImages()
  const index = buildIndex(hostNames)
  const groups = [...index.values()].filter(g => g.length > 1)
    .sort((a, b) => b.length - a.length)

  const refs = blogDir ? collectRefs(blogDir) : null
  const totalRedundant = groups.reduce((sum, g) => sum + g.length - 1, 0)

  console.log('图床图片 ' + hostNames.length + ' 个，内容唯一 ' + index.size + ' 个')
  console.log('重复组 ' + groups.length + ' 组，冗余副本 ' + totalRedundant + ' 个')

  if (!refs) {
    console.log('\n未提供 --blog，无法判断哪些副本正被博客引用。')
    console.log('下面是各组的全部副本，删除前请自行确认引用关系：\n')
    for (const group of groups) {
      console.log('[' + group.length + ' 个副本]')
      for (const name of group) console.log('    ' + name)
    }
    return
  }

  let deletable = 0
  let singleRefGroups = 0
  let multiRefGroups = 0
  const lines = []

  for (const group of groups) {
    const referenced = group.filter(n => refs.has(n))
    const unreferenced = group.filter(n => !refs.has(n))
    if (referenced.length === 1) singleRefGroups++
    else if (referenced.length > 1) multiRefGroups++

    // 有被引用的副本，就以它为保留项；整组都没被引用，才按「干净名字」挑一个保留
    const fallbackKeep = referenced.length ? null : pickCanonical(group)
    const removable = fallbackKeep ? unreferenced.filter(n => n !== fallbackKeep) : unreferenced
    deletable += removable.length

    lines.push('[' + group.length + ' 个副本]')
    if (referenced.length) {
      for (const name of referenced) lines.push('    引用中，保留: ' + name)
    } else {
      lines.push('    均未引用，建议保留: ' + fallbackKeep)
    }
    for (const name of removable) lines.push('    可删: ' + name)
    if (referenced.length > 1) {
      lines.push('    [!] 多个副本都被博客引用，需先把博客里的 URL 统一到其中一个，再删其余')
    }
  }

  const untouchedGroups = groups.length - singleRefGroups - multiRefGroups
  console.log('  每组保留 1 个，共可删除: ' + deletable + ' 个副本')
  if (singleRefGroups) console.log('  ' + singleRefGroups + ' 组保留的是博客正在引用的文件名（博客无需改动）')
  if (untouchedGroups) console.log('  ' + untouchedGroups + ' 组博客未引用，按最干净的文件名保留')
  if (multiRefGroups) console.log('  [!] ' + multiRefGroups + ' 组存在多个被引用的副本，需先统一博客 URL 再删')
  console.log('')
  for (const line of lines) console.log(line)
}

const argv = process.argv.slice(2)
let blogDir = null
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--blog') blogDir = argv[++i]
  else positional.push(argv[i])
}

const command = positional.shift()
switch (command) {
  case 'check':
    cmdCheck(positional)
    break
  case 'dupes':
    cmdDupes(blogDir)
    break
  default:
    console.log('blog.img 图床助手\n')
    console.log('  node img.js check <文件|目录> [...]        查本地图片是否已在图床里')
    console.log('  node img.js dupes [--blog <博客目录>]       列出图床里内容重复的图片')
}
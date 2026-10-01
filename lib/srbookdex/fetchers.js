import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fetchChannelItems, fetchContentDetail } from './wiki-api.js'
import { loadIndex, saveIndex, channelEntries, itemFilePath, readItemFile, writeItemFile, ensureDirs } from './base.js'
import { findChannelByKey, ACTIVE_CHANNELS } from './channels.js'
import { buildSearchText, htmlToText, cleanSectionName } from './render.js'
import { channelDir } from './paths.js'

/** 条目文件结构版本，改动解析结构时 +1（可用于以后批量重解析） */
export const SCHEMA_VERSION = 1

function hashSections(sections = []) {
  const normalized = sections.map(section => [cleanSectionName(section.name, ''), String(section.html || '')])
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

/** 列表里的 ext（筛选/表格/配图）可能很长，索引里只存哈希用于变化检测 */
function hashExt(ext) {
  return createHash('sha1').update(String(ext || '')).digest('hex')
}

function buildRecord(channel, brief, detail) {
  const sections = []
  const mainHtml = detail?.content || ''
  if (mainHtml && htmlToText(mainHtml)) sections.push({ name: '正文', html: mainHtml })
  for (const entry of detail?.contents || []) {
    const html = entry?.text || ''
    if (!html || !htmlToText(html)) continue
    sections.push({ name: cleanSectionName(entry?.name, '正文'), html })
  }
  const record = {
    id: brief.id,
    name: (detail?.title || brief.name || '').trim(),
    channel: channel.key,
    channelName: channel.name,
    summary: detail?.summary || brief.summary || '',
    icon: detail?.icon || brief.icon || '',
    ext: brief.ext || detail?.ext || '',
    url: `https://www.miyoushe.com/sr/wiki/content/${brief.id}/detail`,
    schema: SCHEMA_VERSION,
    sections,
    fetchedAt: Date.now()
  }
  record.hash = hashSections(sections)
  record.text = buildSearchText(record)
  return record
}

async function emitProgress(fn, payload) {
  if (typeof fn === 'function') await fn(payload)
}

/** 进程内的更新串行队列：命令、网页任务与每日自动更新不会并发写同一个索引文件 */
let updateChain = Promise.resolve()

/**
 * 更新一个分类（对外入口，进程内串行执行）
 * @param channelKey 分类 key（见 channels.js）
 * @param options.dryRun 只检查不落盘
 * @param options.deepCompare 逐条重新拉详情并比对正文（强制核对）
 * @returns { total, updated, failed, skipped }
 */
export function updateChannel(channelKey, options = {}) {
  const run = () => runUpdateChannel(channelKey, options)
  const next = updateChain.then(run, run)
  updateChain = next.then(() => undefined, () => undefined)
  return next
}

async function runUpdateChannel(channelKey, { onProgress, onError, dryRun = false, deepCompare = false } = {}) {
  const channel = findChannelByKey(channelKey)
  if (!channel) throw new Error(`未知分类：${channelKey}`)
  await ensureDirs()

  const index = await loadIndex()
  const prevItems = channelEntries(index, channelKey)
  const prevMap = new Map(prevItems.map(item => [String(item.id), item]))

  const list = await fetchChannelItems(channel.id, `${channel.name}列表`)
  const total = list.length
  const nextItems = []
  let done = 0
  let updated = 0
  let failed = 0

  for (const brief of list) {
    const prev = prevMap.get(brief.id)
    const fileName = path.basename(itemFilePath(channelKey, brief.name, brief.id))
    const prevFile = prev?.file ? path.join(channelDir(channelKey), prev.file) : ''

    const canReuse = !deepCompare && Boolean(prev?.hash) && Boolean(prevFile) && fss.existsSync(prevFile) && prev.extHash === hashExt(brief.ext)
    if (canReuse) {
      nextItems.push({ ...prev, name: brief.name || prev.name, icon: brief.icon || prev.icon, extHash: hashExt(brief.ext), summary: brief.summary || prev.summary || '' })
      done += 1
      if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { channel: channel.key, done, total })
      continue
    }

    try {
      const detail = await fetchContentDetail(brief.id, brief.name || `条目 ${brief.id}`)
      const record = buildRecord(channel, brief, detail)
      const changed = !prev || prev.hash !== record.hash || prev.file !== fileName || !fss.existsSync(prevFile || '')
      if (changed && !dryRun) {
        const target = path.join(channelDir(channelKey), fileName)
        if (prevFile && prevFile !== target && fss.existsSync(prevFile)) {
          try { await fs.rename(prevFile, target) } catch { }
        }
        await writeItemFile(target, record)
      }
      if (changed) updated += 1
      nextItems.push({
        id: record.id,
        name: record.name,
        file: fileName,
        hash: record.hash,
        icon: record.icon,
        extHash: hashExt(brief.ext),
        summary: record.summary
      })
    } catch (error) {
      failed += 1
      await emitProgress(onError, { channel: channel.key, name: brief.name || brief.id, error })
      if (prev) nextItems.push(prev)
    }

    done += 1
    if (total && (done % 25 === 0 || done === total)) await emitProgress(onProgress, { channel: channel.key, done, total })
  }

  if (!dryRun) {
    index.channels[channelKey] = {
      id: channel.id,
      name: channel.name,
      items: nextItems,
      updatedAt: Date.now()
    }
    await saveIndex(index)
  }

  return { total, updated, failed, key: channel.key, label: channel.name }
}

/** 更新多个分类 */
export async function updateChannels(channelKeys, options = {}) {
  const results = []
  for (const key of channelKeys) {
    const ret = await updateChannel(key, options)
    results.push(ret)
  }
  return results
}

/** 读取一个条目（用于回复） */
export async function loadItem(channelKey, id) {
  const index = await loadIndex()
  const entry = channelEntries(index, channelKey).find(item => String(item.id) === String(id))
  if (!entry?.file) return null
  return await readItemFile(path.join(channelDir(channelKey), entry.file))
}

/** 按名字找条目：归一化精确（忽略引号括号空白）→ 包含（取名字最短的那条） */
export function findEntryByName(index, channelKey, keyword) {
  const entries = channelEntries(index, channelKey)
  const raw = String(keyword || '').trim()
  if (!raw) return null
  const norm = value => String(value || '').replace(/[「」『』“”"'’‘《》()（）\s]/g, '').toLowerCase()
  const target = norm(raw)
  if (!target) return null
  const exact = entries.find(item => item.name === raw) || entries.find(item => norm(item.name) === target)
  if (exact) return exact
  const partial = entries.filter(item => norm(item.name).includes(target))
  if (!partial.length) return null
  partial.sort((a, b) => String(a.name).length - String(b.name).length)
  const shortest = String(partial[0].name).length
  const best = partial.filter(item => String(item.name).length === shortest)
  if (best.length === 1) return best[0]
  return { ambiguous: partial.slice(0, 15) }
}

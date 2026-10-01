import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { dataRoot, cacheRoot, indexFile, stateFile, channelDir, buildItemFileName } from './paths.js'
import { ACTIVE_CHANNELS, CHANNELS } from './channels.js'

const INDEX_VERSION = 1

export async function ensureDirs() {
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.mkdir(cacheRoot, { recursive: true })
  for (const channel of ACTIVE_CHANNELS) await fs.mkdir(channelDir(channel.key), { recursive: true })
}

function emptyIndex() {
  return { version: INDEX_VERSION, updatedAt: 0, channels: {} }
}

export async function loadIndex() {
  try {
    const parsed = JSON.parse(await fs.readFile(indexFile, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyIndex()
    parsed.channels = parsed.channels || {}
    return parsed
  } catch {
    return emptyIndex()
  }
}

export function loadIndexSync() {
  try {
    const parsed = JSON.parse(fss.readFileSync(indexFile, 'utf8'))
    parsed.channels = parsed.channels || {}
    return parsed
  } catch {
    return emptyIndex()
  }
}

export async function saveIndex(index) {
  await fs.mkdir(dataRoot, { recursive: true })
  const data = { version: INDEX_VERSION, updatedAt: Date.now(), channels: index.channels || {} }
  await fs.writeFile(indexFile, JSON.stringify(data, null, 2), 'utf8')
  return data
}

/** 某个分类在索引里的条目 */
export function channelEntries(index, channelKey) {
  return index?.channels?.[channelKey]?.items || []
}

/** 某个分类的条目文件绝对路径 */
export function itemFilePath(channelKey, name, id) {
  return path.join(channelDir(channelKey), buildItemFileName(name, id))
}

export async function readItemFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

export async function writeItemFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

export async function loadState() {
  try {
    return JSON.parse(await fs.readFile(stateFile, 'utf8'))
  } catch {
    return {}
  }
}

export async function saveState(patch = {}) {
  const state = { ...(await loadState()), ...patch, updatedAt: Date.now() }
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')
  return state
}

/** 各分类条目数统计 */
export function channelStats(index) {
  const stats = {}
  for (const channel of CHANNELS) stats[channel.key] = channelEntries(index, channel.key).length
  return stats
}

/** 全局条目数 */
export function totalItems(index) {
  return Object.values(channelStats(index)).reduce((sum, value) => sum + value, 0)
}

export { ACTIVE_CHANNELS, CHANNELS }

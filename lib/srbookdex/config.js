import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { cacheRoot, dataRoot } from './paths.js'
import { ACTIVE_CHANNELS, CHANNELS } from './channels.js'

const configFile = path.join(cacheRoot, 'config.json')

/** 每日自动更新时刻（GMT+8 整点）：任务 cron 与界面文案都用它 */
export const AUTO_UPDATE_HOUR_GMT8 = 5

/** 支持逐条强制核对的分类（全部已启用分类） */
export const FORCE_CHANNEL_OPTIONS = ACTIVE_CHANNELS.map(channel => ({ key: channel.key, label: channel.name }))
const FORCE_KEYS = FORCE_CHANNEL_OPTIONS.map(item => item.key)

function defaultConfig() {
  return {
    webui: {
      enabled: true,
      host: '0.0.0.0',
      port: 14523
    },
    autoUpdate: {
      enabled: true,
      forceChannels: []
    },
    fetch: {
      // 单次更新最多并发拉取的条目数（崩铁详情接口较宽松，保守取值）
      concurrency: 4
    }
  }
}

function normalizeForceChannels(value) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return [...new Set(values.map(item => String(item || '').trim()))].filter(key => FORCE_KEYS.includes(key))
}

function mergeConfig(raw = {}) {
  const def = defaultConfig()
  return {
    webui: { ...def.webui, ...(raw.webui || {}) },
    autoUpdate: {
      ...def.autoUpdate,
      ...(raw.autoUpdate || {}),
      forceChannels: normalizeForceChannels(raw?.autoUpdate?.forceChannels)
    },
    fetch: { ...def.fetch, ...(raw.fetch || {}) }
  }
}

export async function loadConfig() {
  try {
    return mergeConfig(JSON.parse(await fs.readFile(configFile, 'utf8')))
  } catch {
    const cfg = defaultConfig()
    await saveConfig(cfg)
    return cfg
  }
}

export function loadConfigSync() {
  try {
    return mergeConfig(JSON.parse(fss.readFileSync(configFile, 'utf8')))
  } catch {
    return defaultConfig()
  }
}

export async function saveConfig(config = {}) {
  const cfg = mergeConfig(config)
  await fs.mkdir(cacheRoot, { recursive: true })
  await fs.writeFile(configFile, JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

/** 每日自动更新的下次运行时间（GMT+8） */
export function getDefaultAutoUpdateInfo(now = Date.now()) {
  const gmt8Now = new Date(now + 8 * 3600 * 1000)
  const todayRun = Date.UTC(
    gmt8Now.getUTCFullYear(),
    gmt8Now.getUTCMonth(),
    gmt8Now.getUTCDate(),
    AUTO_UPDATE_HOUR_GMT8
  ) - 8 * 3600 * 1000
  const nextRunAt = now < todayRun ? todayRun : todayRun + 24 * 3600 * 1000
  return { nextRunAt, nextRunAtText: formatGmt8(nextRunAt) }
}

export function formatGmt8(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms) + 8 * 3600 * 1000)
  const pad = value => String(value).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export { dataRoot, CHANNELS, ACTIVE_CHANNELS }

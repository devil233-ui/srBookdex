import fss from 'node:fs'
import {
  ACTIVE_CHANNELS,
  buildNamePattern,
  findChannelByName
} from '../lib/srbookdex/channels.js'
import { loadIndex, channelEntries, channelStats, totalItems, ensureDirs } from '../lib/srbookdex/base.js'
import { updateChannel, loadItem, findEntryByName } from '../lib/srbookdex/fetchers.js'
import { formatFetchError, searchChannelContent } from '../lib/srbookdex/wiki-api.js'
import { buildItemText } from '../lib/srbookdex/render.js'
import { loadConfig, getDefaultAutoUpdateInfo, AUTO_UPDATE_HOUR_GMT8 } from '../lib/srbookdex/config.js'
import { startWebUi, getWebUiInfo } from '../lib/srbookdex/webui.js'

/** 已启用分类的名字与别名（长的在前），用于生成指令正则 */
const NAME_PATTERN = buildNamePattern()
/** 单条回复的字符上限 */
const REPLY_LIMIT = 1500
/** 序号会话有效期（毫秒） */
const SESSION_TTL = 60 * 60 * 1000

const sessions = new Map()

function sessionKey(e) {
  return `${e?.group_id || 'private'}:${e?.user_id || 'unknown'}`
}

function saveSession(e, payload) {
  sessions.set(sessionKey(e), { ...payload, at: Date.now() })
  return sessions.get(sessionKey(e))
}

function readSession(e) {
  const session = sessions.get(sessionKey(e))
  if (!session) return null
  if (Date.now() - session.at > SESSION_TTL) {
    sessions.delete(sessionKey(e))
    return null
  }
  return session
}

export class SrBookdex extends plugin {
  constructor() {
    super({
      name: '星穹铁道文本图鉴（srBookdex）',
      dsc: '崩坏：星穹铁道米游社 wiki 的文本检索与阅读（阅读物 / 任务 / 角色 / 光锥 / 遗器 / 道具材料）',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: `^[*＊](${NAME_PATTERN})强制更新$`,
          fnc: 'forceUpdateChannel',
          permission: 'master'
        },
        {
          reg: `^[*＊](${NAME_PATTERN})更新$`,
          fnc: 'updateChannelCommand',
          permission: 'master'
        },
        {
          reg: `^[*＊](${NAME_PATTERN})帮助\\d*$`,
          fnc: 'channelHelp'
        },
        {
          reg: `^[*＊](${NAME_PATTERN})搜索\\s*(.+)$`,
          fnc: 'channelSearch'
        },
        {
          reg: '^[*＊](统一更新|全部更新|同步更新)$',
          fnc: 'updateAllCommand',
          permission: 'master'
        },
        {
          reg: '^[*＊]搜索\\s*(.+)$',
          fnc: 'searchAll'
        },
        {
          reg: '^[*＊](图鉴网页|网页|web)$',
          fnc: 'showWebUi'
        },
        {
          reg: '^[*＊](\\d{1,4})\\s*(文本|图片)?$',
          fnc: 'pickByIndex'
        },
        {
          reg: '^[*＊](.+)$',
          fnc: 'pickByTitle'
        }
      ]
    })
  }

  init() {
    startWebUi({ logger: globalThis.logger }).catch(error => globalThis.logger?.error?.('[srBookdex.webui.start]', error))
    this.task = [
      {
        name: 'srBookdex 每日自动更新',
        cron: `0 0 ${AUTO_UPDATE_HOUR_GMT8} * * ?`,
        fnc: this.autoUpdateTick.bind(this)
      }
    ]
  }

  /* ── 回复辅助 ─────────────────────────────────────────── */

  makeReporter(label, { silent = false, every = 25 } = {}) {
    const errors = []
    return {
      onProgress: async ({ done, total }) => {
        if (silent || !total) return
        if (done % every !== 0 && done !== total) return
        await this.reply(`${label}：${done}/${total}`)
      },
      onError: async ({ name, error }) => {
        errors.push({ name, error })
        globalThis.logger?.error?.(`[srBookdex] ${label} 条目失败 ${name}`, error?.message || error)
      },
      errors
    }
  }

  async replyLong(text, imageUrl = '') {
    const content = String(text || '').trim() || '（没有可用文本）'
    const chunks = []
    for (let i = 0; i < content.length; i += REPLY_LIMIT) chunks.push(content.slice(i, i + REPLY_LIMIT))
    if (imageUrl && chunks.length) chunks[0] = `[icon]${chunks[0]}`
    for (const chunk of chunks.slice(0, 6)) {
      const image = chunk.startsWith('[icon]') ? globalThis.segment?.image?.(imageUrl) : null
      const body = chunk.replace(/^\[icon\]/, '')
      await this.reply(image ? [body, image] : body)
    }
    if (chunks.length > 6) await this.reply(`内容较长，已省略后续 ${chunks.length - 6} 段；可用网页或 *搜索 查看完整内容`)
    return true
  }

  async replySummary(results, title) {
    const lines = [title]
    let updated = 0
    for (const ret of results) {
      lines.push(`${ret.label}：扫描 ${ret.total} 条，本次更新 ${ret.updated} 条${ret.failed ? `，失败 ${ret.failed} 条` : ''}`)
      updated += ret.updated || 0
    }
    if (!updated) lines.push('本次没有检测到新内容')
    return this.reply(lines.join('\n'))
  }

  /* ── 更新指令 ─────────────────────────────────────────── */

  async updateChannelCommand() {
    const match = String(this.e.msg || '').match(new RegExp(`^[*＊](${NAME_PATTERN})更新$`))
    const channel = match && findChannelByName(match[1])
    if (!channel) return this.reply('没有识别到分类，用法如：*阅读物更新、*光锥强制更新')
    await this.reply(`开始更新${channel.name}（增量），请稍等…`)
    const reporter = this.makeReporter(`${channel.name}更新`)
    try {
      const ret = await updateChannel(channel.key, reporter)
      return this.replySummary([ret], `${channel.name}更新完成`)
    } catch (error) {
      globalThis.logger?.error?.('[srBookdex] 更新失败', error)
      return this.reply(`${channel.name}更新失败：${formatFetchError(error)}`)
    }
  }

  async forceUpdateChannel() {
    const match = String(this.e.msg || '').match(new RegExp(`^[*＊](${NAME_PATTERN})强制更新$`))
    const channel = match && findChannelByName(match[1])
    if (!channel) return this.reply('没有识别到分类，用法如：*阅读物强制更新')
    await this.reply(`开始强制核对${channel.name}：逐条读取米游社详情并与本地比对，条目多时较慢，请稍等…`)
    const reporter = this.makeReporter(`${channel.name}强制核对`)
    try {
      const ret = await updateChannel(channel.key, { ...reporter, deepCompare: true })
      return this.replySummary([ret], `${channel.name}强制核对完成`)
    } catch (error) {
      globalThis.logger?.error?.('[srBookdex] 强制核对失败', error)
      return this.reply(`${channel.name}强制核对失败：${formatFetchError(error)}`)
    }
  }

  async updateAllCommand() {
    await this.reply(`开始统一更新（${ACTIVE_CHANNELS.length} 个分类，增量），请稍等…`)
    const reporter = this.makeReporter('统一更新', { silent: true })
    const results = []
    for (const channel of ACTIVE_CHANNELS) {
      try {
        results.push(await updateChannel(channel.key, reporter))
      } catch (error) {
        globalThis.logger?.error?.(`[srBookdex] ${channel.name} 更新失败`, error)
        results.push({ key: channel.key, label: channel.name, total: 0, updated: 0, failed: 1 })
      }
    }
    return this.replySummary(results, '统一更新完成')
  }

  /* ── 帮助 / 搜索 / 阅读 ───────────────────────────────── */

  async channelHelp() {
    const match = String(this.e.msg || '').match(new RegExp(`^[*＊](${NAME_PATTERN})帮助(\\d*)$`))
    const channel = match && findChannelByName(match[1])
    if (!channel) return this.reply('没有识别到分类，用法如：*阅读物帮助')
    const page = Math.max(1, Number(match[2] || 1))
    const index = await loadIndex()
    const entries = channelEntries(index, channel.key)
    if (!entries.length) return this.reply(`还没有${channel.name}数据，请先发送 *${channel.name}更新`)

    const pageSize = 50
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize))
    const current = Math.min(page, totalPages)
    const slice = entries.slice((current - 1) * pageSize, current * pageSize)
    saveSession(this.e, { channelKey: channel.key, items: slice.map(item => ({ id: item.id, name: item.name })) })

    const lines = slice.map((item, i) => `${(current - 1) * pageSize + i + 1}. ${item.name}`)
    await this.reply(`${channel.name}（共 ${entries.length} 条，第 ${current}/${totalPages} 页）\n发送 *<序号> 查看内容，如 *1；翻页用 *${channel.name}帮助${current + 1}`)
    return this.replyLong(lines.join('\n'))
  }

  async channelSearch() {
    const match = String(this.e.msg || '').match(new RegExp(`^[*＊](${NAME_PATTERN})搜索\\s*(.+)$`))
    const channel = match && findChannelByName(match[1])
    const keyword = String(match?.[2] || '').trim()
    if (!channel || !keyword) return this.reply('用法如：*阅读物搜索 冷笑话')
    try {
      const list = await searchChannelContent(channel.id, keyword, { limit: 20 })
      if (!list.length) return this.reply(`在${channel.name}里没有搜到「${keyword}」`)
      saveSession(this.e, { channelKey: channel.key, items: list.map(item => ({ id: item.id, name: item.name })) })
      const lines = list.map((item, i) => `${i + 1}. ${item.name}${item.summary ? `（${item.summary}）` : ''}`)
      await this.reply(`${channel.name}搜索「${keyword}」：找到 ${list.length} 条`)
      return this.replyLong(lines.join('\n'))
    } catch (error) {
      return this.reply(`搜索失败：${formatFetchError(error)}`)
    }
  }

  async searchAll() {
    const match = String(this.e.msg || '').match(/^[*＊]搜索\s*(.+)$/)
    const keyword = String(match?.[1] || '').trim()
    if (!keyword) return this.reply('用法如：*搜索 冷笑话')
    const index = await loadIndex()
    const lower = keyword.toLowerCase()
    const hits = []
    for (const channel of ACTIVE_CHANNELS) {
      for (const item of channelEntries(index, channel.key)) {
        const haystack = `${item.name} ${item.summary || ''}`.toLowerCase()
        if (haystack.includes(lower)) hits.push({ channelKey: channel.key, channelName: channel.name, ...item })
        if (hits.length >= 30) break
      }
      if (hits.length >= 30) break
    }
    if (!hits.length) return this.reply(`没有找到「${keyword}」，可以用 *<分类>更新 拉取数据，或在网页里搜索全文`)
    saveSession(this.e, { channelKey: hits[0].channelKey, items: hits.map(item => ({ id: item.id, name: item.name, channelKey: item.channelKey })) })
    const lines = hits.map((item, i) => `${i + 1}. [${item.channelName}] ${item.name}`)
    await this.reply(`搜索「${keyword}」：找到 ${hits.length} 条`)
    return this.replyLong(lines.join('\n'))
  }

  async pickByIndex() {
    const match = String(this.e.msg || '').match(/^[*＊](\d{1,4})\s*(文本|图片)?$/)
    if (!match) return false
    const session = readSession(this.e)
    if (!session?.items?.length) return false
    const index = Number(match[1]) - 1
    const target = session.items[index]
    if (!target) return this.reply(`序号超出范围（当前列表共 ${session.items.length} 条）`)
    return this.readItemByChannel(target.channelKey || session.channelKey, target.id)
  }

  async pickByTitle() {
    const match = String(this.e.msg || '').match(/^[*＊](.+)$/)
    const keyword = String(match?.[1] || '').trim()
    if (!keyword) return false
    // 保留字：避免把 *更新 之类的残留当成条目名
    if (/^(更新|强制更新|帮助|搜索|统一更新|全部更新|同步更新)$/.test(keyword)) return false
    const index = await loadIndex()
    for (const channel of ACTIVE_CHANNELS) {
      const found = findEntryByName(index, channel.key, keyword)
      if (found && !found.ambiguous) return this.readItemByChannel(channel.key, found.id)
      if (found?.ambiguous?.length) {
        saveSession(this.e, { channelKey: channel.key, items: found.ambiguous.map(item => ({ id: item.id, name: item.name })) })
        const lines = found.ambiguous.map((item, i) => `${i + 1}. ${item.name}`)
        await this.reply(`在${channel.name}里匹配到多条，发送 *<序号> 选择：`)
        return this.replyLong(lines.join('\n'))
      }
    }
    return this.reply(`没有找到「${keyword}」，可以先用 *<分类>更新 拉取数据`)
  }

  async readItemByChannel(channelKey, id) {
    const item = await loadItem(channelKey, id)
    if (!item) return this.reply('这条内容还没有下载到本地，可以先执行对应分类的更新')
    const text = buildItemText(item)
    await this.reply(`【${item.channelName}】${item.name}\n${item.url}`)
    return this.replyLong(text, item.icon || '')
  }

  /* ── 网页 ─────────────────────────────────────────────── */

  async showWebUi() {
    const info = getWebUiInfo() || await startWebUi({ logger: globalThis.logger })
    const index = await loadIndex()
    return this.reply(`星穹铁道文本图鉴网页：${info?.url || '未启动'}\n当前已收录 ${totalItems(index)} 条，共 ${ACTIVE_CHANNELS.length} 个分类`)
  }

  /* ── 每日自动更新 ─────────────────────────────────────── */

  async autoUpdateTick() {
    const config = await loadConfig()
    if (!config.autoUpdate?.enabled) return false
    const reporter = this.makeReporter('每日自动更新', { silent: true })
    const forced = new Set(config.autoUpdate.forceChannels || [])
    const results = []
    for (const channel of ACTIVE_CHANNELS) {
      try {
        results.push(await updateChannel(channel.key, { ...reporter, deepCompare: forced.has(channel.key) }))
      } catch (error) {
        globalThis.logger?.error?.(`[srBookdex] 每日更新 ${channel.name} 失败`, error)
        results.push({ key: channel.key, label: channel.name, total: 0, updated: 0, failed: 1 })
      }
    }
    const summary = results.map(ret => `${ret.label} ${ret.updated}/${ret.total}`).join(' | ')
    globalThis.logger?.mark?.(`[srBookdex.autoUpdate] 完成 ${summary}`)
    return true
  }
}

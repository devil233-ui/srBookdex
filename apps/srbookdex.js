import fss from 'node:fs'
import {
  ACTIVE_CHANNELS,
  buildNamePattern,
  channelNames,
  findChannelByName
} from '../lib/srbookdex/channels.js'
import { loadIndex, channelEntries, channelStats, totalItems, ensureDirs } from '../lib/srbookdex/base.js'
import { updateChannel, loadItem, findEntryByName } from '../lib/srbookdex/fetchers.js'
import { formatFetchError, searchChannelContent } from '../lib/srbookdex/wiki-api.js'
import { searchBwiki, formatBwikiError } from '../lib/srbookdex/bwiki.js'
import { buildItemNodes, splitTextPages } from '../lib/srbookdex/render.js'
import { loadConfig, getDefaultAutoUpdateInfo, AUTO_UPDATE_HOUR_GMT8 } from '../lib/srbookdex/config.js'
import { startWebUi, getWebUiInfo } from '../lib/srbookdex/webui.js'
import { pluginDir, path } from '../lib/srbookdex/paths.js'

/** 已启用分类的名字与别名（长的在前），用于生成指令正则 */
const NAME_PATTERN = buildNamePattern()
/**
 * 指令前缀。
 * 注意：云崽的 loader 会把 `*` 开头的消息标准化成 `#星铁…`（srReg），全角 `＊` 不在此列，
 * 所以这里两种形式都要认，否则在群里发 `*阅读物帮助` 会被框架改写成 `#星铁阅读物帮助` 后匹配不到。
 */
const PREFIX = '(?:#?星铁\\s*|[*＊])'
/** 单条回复的字符上限 */
/** 序号会话有效期（毫秒） */
const SESSION_TTL = 60 * 60 * 1000

const sessions = new Map()
/** 每个用户保留最近几条列表会话：引用旧列表发序号时还能找回对应列表 */
const SESSION_KEEP = 8

function sessionKey(e) {
  return `${e?.group_id || 'private'}:${e?.user_id || 'unknown'}`
}

function liveSessions(e) {
  const list = (sessions.get(sessionKey(e)) || []).filter(session => session && Date.now() - session.at <= SESSION_TTL)
  sessions.set(sessionKey(e), list)
  return list
}

function saveSession(e, payload) {
  const session = { ...payload, messageIds: [], at: Date.now() }
  const list = liveSessions(e)
  list.push(session)
  sessions.set(sessionKey(e), list.slice(-SESSION_KEEP))
  return session
}

function readSession(e) {
  const list = liveSessions(e)
  return list.length ? list[list.length - 1] : null
}

/** 记下机器人自己发出的消息 id：用户「引用列表发序号」靠它找回会话 */
function rememberReply(session, res) {
  if (!session) return session
  const ids = Array.isArray(res?.message_id) ? res.message_id : (res?.message_id ? [res.message_id] : [])
  if (!ids.length) return session
  session.messageIds = [...new Set([...(session.messageIds || []), ...ids.map(String)])]
  session.at = Date.now()
  return session
}

/** 用户当前引用的消息 id（各适配器字段不同，取法和原神侧一致） */
async function quotedMessageId(e) {
  if (e?.reply_id) return String(e.reply_id)
  if (e?.quote?.id) return String(e.quote.id)
  if (e?.getReply) {
    try {
      const reply = await e.getReply()
      if (reply?.message_id) return String(reply.message_id)
    } catch { /* 拿不到就当没引用 */ }
  }
  return ''
}

/** 引用的正好是本插件发过的列表 → 返回那个会话，否则 null */
async function sessionFromQuote(e) {
  const id = await quotedMessageId(e)
  if (!id) return null
  const list = liveSessions(e)
  for (let i = list.length - 1; i >= 0; i--) {
    if ((list[i].messageIds || []).map(String).includes(id)) {
      list[i].at = Date.now()
      return list[i]
    }
  }
  return null
}
/** 关键词归一化：去掉引号/括号/空白，便于「灯塔」和「「灯塔」」都能匹配 */
function normalizeKeyword(value) {
  return String(value || '')
    .replace(/[「」『』“”"'’‘《》()（）\s]/g, '')
    .trim()
}

/** 把「名字图片」这类后缀拆掉 */
function splitOutputSuffix(value) {
  const raw = String(value || '').trim()
  const match = raw.match(/^(.*?)(图片|文本|语音)?$/)
  return { keyword: (match?.[1] || raw).trim(), wantImage: match?.[2] === '图片' }
}

/** 合并转发的分页与分批（与 bookdex 保持一致） */
const PAGE_CHARS = 800
const FORWARD_BATCH = 6

export class SrBookdex extends plugin {
  constructor() {
    super({
      name: '星穹铁道文本图鉴（srBookdex-plugin）',
      dsc: '崩坏：星穹铁道米游社 wiki 的文本检索与阅读（阅读物 / 任务 / 角色 / 光锥 / 遗器 / 道具材料）',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: `^${PREFIX}(${NAME_PATTERN})强制更新$`,
          fnc: 'forceUpdateChannel',
          permission: 'master'
        },
        {
          reg: `^${PREFIX}(${NAME_PATTERN})更新$`,
          fnc: 'updateChannelCommand',
          permission: 'master'
        },
        {
          reg: `^${PREFIX}(书角图鉴帮助|书籍图鉴帮助|srbookdex帮助)$`,
          fnc: 'totalHelp'
        },
        {
          reg: `^${PREFIX}(${NAME_PATTERN})帮助\\d*$`,
          fnc: 'channelHelp'
        },
        {
          reg: `^${PREFIX}(${NAME_PATTERN})搜索\\s*(.+)$`,
          fnc: 'channelSearch'
        },
        {
          reg: `^${PREFIX}(统一更新|全部更新|同步更新|书籍图鉴更新)$`,
          fnc: 'updateAllCommand',
          permission: 'master'
        },
        {
          reg: `^${PREFIX}搜索\\s*(.+)$`,
          fnc: 'searchAll'
        },
        {
          reg: `^${PREFIX}(图鉴网页|网页|web|书籍图鉴网页)$`,
          fnc: 'showWebUi'
        },
        {
          reg: `^${PREFIX}(${NAME_PATTERN})\\s+(.+)$`,
          fnc: 'categoryLookup'
        },
        {
          reg: `^(?:${PREFIX}\\s*)?(\\d{1,4})\\s*(文本|图片)?$`,
          fnc: 'pickByIndex'
        },
        {
          reg: `^${PREFIX}(.+)$`,
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

  /**
   * 把有序节点（文字页 / 图片）按批转成合并转发；一批最多 FORWARD_BATCH 段。
   * 转发失败时退回直接发送，保证内容一定发得出去。
   */
  async replyNodes(nodes, session = null) {
    const list = (nodes || []).filter(node => node && (node.type === 'image' ? Boolean(node.url) : String(node.text || '').trim()))
    if (!list.length) return true

    if (list.length === 1 && list[0].type === 'text') return rememberReply(session, await this.reply(list[0].text))

    let allOk = true
    for (let i = 0; i < list.length; i += FORWARD_BATCH) {
      const batch = list.slice(i, i + FORWARD_BATCH)
      const messages = batch.map(node => {
        if (node.type !== 'image') return node.text
        const segment = globalThis.segment?.image?.(node.url)
        return segment ? [segment] : ''
      }).filter(Boolean)
      try {
        const forward = globalThis.Bot?.makeForwardArray ? await globalThis.Bot.makeForwardArray(messages) : null
        if (!forward) throw new Error('Bot.makeForwardArray 不可用')
        rememberReply(session, await this.reply(forward))
      } catch (error) {
        allOk = false
        globalThis.logger?.warn?.('[srBookdex] 合并转发失败，改为直接发送', error?.message || error)
        for (const node of batch) {
          if (node.type === 'image') {
            const segment = globalThis.segment?.image?.(node.url)
            if (segment) rememberReply(session, await this.reply(segment))
          } else {
            rememberReply(session, await this.reply(node.text))
          }
        }
      }
    }
    return allOk
  }

  /** 文字列表（帮助 / 搜索结果）用合并转发折叠；session 用来记下消息 id，供「引用列表发序号」 */
  async replyFolded(lines, session = null) {
    const nodes = []
    for (const line of (lines || []).map(item => String(item || '').trim()).filter(Boolean)) {
      for (const page of splitTextPages(line, PAGE_CHARS)) nodes.push({ type: 'text', text: page })
    }
    return this.replyNodes(nodes, session)
  }

  /**
   * 回复条目：标题与链接单独发（不进折叠），正文按原始顺序折叠，图片内联在正文里。
   */
  async replyItem(item) {
    await this.reply(`【${item.channelName}】${item.name}\n${item.url}`)
    const nodes = buildItemNodes(item, { pageChars: PAGE_CHARS })
    if (!nodes.length) return this.reply('（这条没有可用正文）')
    return this.replyNodes(nodes)
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
    const match = String(this.e.msg || '').match(new RegExp(`^${PREFIX}(${NAME_PATTERN})更新$`))
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
    const match = String(this.e.msg || '').match(new RegExp(`^${PREFIX}(${NAME_PATTERN})强制更新$`))
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
    const match = String(this.e.msg || '').match(new RegExp(`^${PREFIX}(${NAME_PATTERN})帮助(\\d*)$`))
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
    const session = saveSession(this.e, { channelKey: channel.key, items: slice.map(item => ({ id: item.id, name: item.name })) })

    const lines = slice.map((item, i) => `${(current - 1) * pageSize + i + 1}. ${item.name}`)
    rememberReply(session, await this.reply(`${channel.name}（共 ${entries.length} 条，第 ${current}/${totalPages} 页）\n引用本条后发序号即可查看内容（可加“图片”）；翻页用 *${channel.name}帮助${current + 1}`))
    return this.replyFolded(lines, session)
  }

  async channelSearch() {
    const match = String(this.e.msg || '').match(new RegExp(`^${PREFIX}(${NAME_PATTERN})搜索\\s*(.+)$`))
    const channel = match && findChannelByName(match[1])
    const keyword = String(match?.[2] || '').trim()
    if (!channel || !keyword) return this.reply('用法如：*阅读物搜索 冷笑话')
    try {
      const list = await searchChannelContent(channel.id, keyword, { limit: 20 })
      if (!list.length) return this.reply(`在${channel.name}里没有搜到「${keyword}」`)
      const session = saveSession(this.e, { channelKey: channel.key, items: list.map(item => ({ id: item.id, name: item.name })) })
      const lines = list.map((item, i) => `${i + 1}. ${item.name}${item.summary ? `（${item.summary}）` : ''}`)
      rememberReply(session, await this.reply(`${channel.name}搜索「${keyword}」：找到 ${list.length} 条\n引用本条后发序号即可查看内容（可加“图片”）`))
      return this.replyFolded(lines, session)
    } catch (error) {
      return this.reply(`搜索失败：${formatFetchError(error)}`)
    }
  }
  async searchAll() {
    const match = String(this.e.msg || '').match(new RegExp(`^${PREFIX}搜索\\s*(.+)$`))
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
    if (!hits.length) return this.replyBwikiFallback(keyword)
    const session = saveSession(this.e, { channelKey: hits[0].channelKey, items: hits.map(item => ({ id: item.id, name: item.name, channelKey: item.channelKey })) })
    const lines = hits.map((item, i) => `${i + 1}. [${item.channelName}] ${item.name}`)
    rememberReply(session, await this.reply(`搜索「${keyword}」：找到 ${hits.length} 条\n引用本条后发序号即可查看内容（可加“图片”）`))
    return this.replyFolded(lines, session)
  }

  /**
   * 米游社文本库没有命中时的兜底：去 bwiki（B站 wiki）检索。
   * 只给词条链接与摘要——bwiki 的正文是模板拼出来的，抓下来一半是导航，不如让用户点进去看。
   */
  async replyBwikiFallback(keyword) {
    let result = null
    try {
      result = await searchBwiki('sr', keyword)
    } catch (error) {
      globalThis.logger?.warn?.('[srBookdex] bwiki 兜底检索失败', error?.message || error)
      return this.reply(`米游社文本库里没有「${keyword}」，bwiki 兜底检索也失败了：${formatBwikiError(error)}，可稍后重试`)
    }
    if (!result.hits.length) return this.reply(`没有找到「${keyword}」：米游社文本库和 bwiki 都没有相关条目`)
    await this.reply(`米游社文本库里没有「${keyword}」，bwiki 上有 ${result.total} 条，以下是前 ${result.hits.length} 条：`)
    const lines = result.hits.map((hit, i) => {
      const snippet = hit.snippet ? `\n  ↳ ${hit.snippet}` : ''
      return `${i + 1}. ${hit.title}${snippet}\n  🔗 ${hit.url}`
    })
    return this.replyFolded(lines)
  }

  /** `*<分类> <关键词>`：在该分类里按名字找（引号括号会被忽略） */
  async categoryLookup() {
    const match = String(this.e.msg || '').match(new RegExp(`^${PREFIX}(${NAME_PATTERN})\\s+(.+)$`))
    const channel = match && findChannelByName(match[1])
    if (!channel) return false
    const { keyword } = splitOutputSuffix(match[2])
    if (!keyword) return false
    const index = await loadIndex()
    const found = findEntryByName(index, channel.key, keyword)
    if (found && !found.ambiguous) return this.readItemByChannel(channel.key, found.id)
    if (found?.ambiguous?.length) {
      saveSession(this.e, { channelKey: channel.key, items: found.ambiguous.map(item => ({ id: item.id, name: item.name })) })
      const lines = found.ambiguous.map((item, i) => `${i + 1}. ${item.name}`)
      await this.reply(`${channel.name}里匹配到 ${found.ambiguous.length} 条，发送 *<序号> 选择：`)
      return this.replyFolded(lines)
    }
    // 本地没有就退回米游社的分类内搜索
    try {
      const list = await searchChannelContent(channel.id, keyword, { limit: 10 })
      if (!list.length) return this.reply(`${channel.name}里没有找到「${keyword}」`)
      saveSession(this.e, { channelKey: channel.key, items: list.map(item => ({ id: item.id, name: item.name })) })
      await this.reply(`${channel.name}搜索「${keyword}」：找到 ${list.length} 条，发送 *<序号> 查看`)
      return this.replyFolded(list.map((item, i) => `${i + 1}. ${item.name}`))
    } catch (error) {
      return this.reply(`查找失败：${formatFetchError(error)}`)
    }
  }

  /**
   * 序号查看：
   * - 引用本插件发过的列表后再发纯数字（可加“图片”）→ 按被引用的那条列表取；
   * - 直接发 *<序号> → 用该用户最近一次的列表（有引用时引用优先）。
   * 纯数字必须带引用，否则会把群里别人的数字消息吃掉。
   */
  async pickByIndex() {
    const raw = String(this.e.msg || '').trim()
    const normalized = raw.replace(/[０-９]/g, ch => String(ch.charCodeAt(0) - 65248))
    const prefixed = normalized.match(new RegExp(`^${PREFIX}(\\d{1,4})\\s*(文本|图片)?$`))
    const bare = prefixed ? null : normalized.match(/^(\d{1,4})\s*(文本|图片)?$/)
    if (!prefixed && !bare) return false

    const index = Number((prefixed || bare)[1]) - 1
    const session = await sessionFromQuote(this.e) || (prefixed ? readSession(this.e) : null)
    if (!session?.items?.length) return false
    const target = session.items[index]
    if (!target) return this.reply(`序号超出范围（当前列表共 ${session.items.length} 条）`)
    return this.readItemByChannel(target.channelKey || session.channelKey, target.id)
  }
  /** 分类名 + 关键词 写成一体时拆开（*敌对物种「灯塔」/ *敌人 灯塔 / *阅读物 冷笑话） */
  splitCategoryPrefix(raw) {
    const text = String(raw || '').trim()
    if (!text) return null
    const candidates = []
    for (const channel of ACTIVE_CHANNELS) {
      for (const name of channelNames(channel)) {
        if (text.startsWith(name)) candidates.push({ channel, name })
      }
    }
    const best = candidates.sort((a, b) => b.name.length - a.name.length)[0]
    if (!best) return null
    const keyword = text.slice(best.name.length).trim()
    return keyword ? { channel: best.channel, keyword } : null
  }

  /**
   * 全局按名字找：先精确（忽略引号括号空白），再包含。
   * 包含匹配取名字最短的那条，避免 `*灯塔` 被「在灯塔的光芒下」抢走。
   */
  async findGlobal(keyword) {
    const index = await loadIndex()
    const norm = value => String(value || '').replace(/[「」『』“”"'’‘《》()（）\s]/g, '').toLowerCase()
    const target = norm(keyword)
    if (!target) return null
    const exact = []
    const partial = []
    for (const channel of ACTIVE_CHANNELS) {
      for (const item of channelEntries(index, channel.key)) {
        const name = norm(item.name)
        if (name === target) exact.push({ channel, item })
        else if (name.includes(target)) partial.push({ channel, item })
      }
    }
    if (exact.length === 1) return { channel: exact[0].channel, item: exact[0].item }
    if (exact.length > 1) return { ambiguous: exact.slice(0, 15) }
    partial.sort((a, b) => String(a.item.name).length - String(b.item.name).length)
    if (!partial.length) return null
    const shortest = String(partial[0].item.name).length
    const best = partial.filter(entry => String(entry.item.name).length === shortest)
    if (best.length === 1) return { channel: best[0].channel, item: best[0].item }
    return { ambiguous: partial.slice(0, 15) }
  }

  async replyAmbiguous(entries, scopeName = '') {
    const key = entries[0]?.channel?.key || ''
    const session = saveSession(this.e, {
      channelKey: key,
      items: entries.map(entry => ({ id: entry.item.id, name: entry.item.name, channelKey: entry.channel.key }))
    })
    const lines = entries.map((entry, i) => `${i + 1}. [${entry.channel.name}] ${entry.item.name}`)
    rememberReply(session, await this.reply(`${scopeName ? `${scopeName}里` : ''}匹配到 ${entries.length} 条，引用本条后发序号选择：`))
    return this.replyFolded(lines, session)
  }
  async pickByTitle() {
    const match = String(this.e.msg || '').match(new RegExp(`^${PREFIX}(.+)$`))
    const { keyword: rawKeyword } = splitOutputSuffix(String(match?.[1] || '').trim())
    const keyword = rawKeyword.trim()
    if (!keyword) return false
    // 保留字：避免把 *更新 之类的残留当成条目名
    if (/^(更新|强制更新|帮助|搜索|统一更新|全部更新|同步更新)$/.test(keyword)) return false

    // 1) 「分类名 + 关键词」写成一体（*敌对物种「灯塔」这种没空格的写法）
    const scoped = this.splitCategoryPrefix(keyword)
    if (scoped) {
      const index = await loadIndex()
      const found = findEntryByName(index, scoped.channel.key, scoped.keyword)
      if (found && !found.ambiguous) return this.readItemByChannel(scoped.channel.key, found.id)
      if (found?.ambiguous?.length) {
        return this.replyAmbiguous(found.ambiguous.map(item => ({ channel: scoped.channel, item })), scoped.channel.name)
      }
    }

    // 2) 全局按名字找
    const hit = await this.findGlobal(scoped?.keyword || keyword)
    if (hit?.item) return this.readItemByChannel(hit.channel.key, hit.item.id)
    if (hit?.ambiguous?.length) return this.replyAmbiguous(hit.ambiguous)

    // 找不到就静默返回 false，把消息让给后面的插件（例如喵喵的 *面板 / *卡片 这类命令）
    return false
  }

  async readItemByChannel(channelKey, id) {
    const item = await loadItem(channelKey, id)
    if (!item) return this.reply('这条内容还没有下载到本地，可以先执行对应分类的更新')
    return this.replyItem(item)
  }

  /* ── 网页 ─────────────────────────────────────────────── */

  /** 总帮助图：对齐原神侧的 #书籍图鉴帮助 */
  async totalHelp() {
    const helpImg = path.join(pluginDir, 'resources', 'help-main.jpg')
    if (!fss.existsSync(helpImg)) return this.reply('总帮助图缺失，请重新安装或更新插件资源')
    const image = globalThis.segment?.image?.(`file://${helpImg}`)
    if (!image) return this.reply(`总帮助图：${helpImg}`)
    return this.reply(image)
  }

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

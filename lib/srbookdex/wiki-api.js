/**
 * 米游社崩铁 wiki 接口层
 *
 * 接口族：https://act-api-takumi.mihoyo.com/common/blackboard/sr_wiki/v1/*
 *   - 分类条目：GET /home/content/list?app_sn=sr_wiki&channel_id=<channel_id>
 *   - 条目详情：GET /content/info?app_sn=sr_wiki&content_id=<content_id>
 *   - 分类内搜索：GET /search/content?app_sn=sr_wiki&keyword=<必填>&channel_id=<channel_id>
 * 只需带 user-agent 与 referer（缺 referer 会被 WAF 挡成 403/404）。
 *
 * 请求走云崽核心的 lib/common/mys.js（节点优选 + 失败换 IP），拿不到就回退全局 fetch；
 * 与 bookdex 的 crypto-api 同一套做法，包括重试时强制重新解析（ttl: 0，避免整批坏池被缓存粘住）。
 */

const API_BASE = 'https://act-api-takumi.mihoyo.com/common/blackboard/sr_wiki/v1'
const APP_SN = 'sr_wiki'
const REFERER = 'https://www.miyoushe.com/sr/wiki/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const REQUEST_TIMEOUT_MS = 15000
const REQUEST_RETRIES = 2
const NODE_TIMEOUT_MS = 4000
const NODE_RETRIES = 3
const MYS_ERROR_TAG = '[mys]'

const coreMysFetch = await import('../../../../lib/common/mys.js')
  .then(m => (typeof m?.mysFetch === 'function' ? m.mysFetch : null))
  .catch(() => null)
if (!coreMysFetch) {
  globalThis.logger?.warn?.('[srBookdex] 未找到云崽 lib/common/mys.js，退回全局 fetch（无节点优选）')
}
const netFetch = coreMysFetch || ((url, options) => fetch(url, options))

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isMysNodeError(error) {
  return typeof error?.message === 'string' && error.message.startsWith(MYS_ERROR_TAG)
}

function describeFetchFailure(error) {
  if (isMysNodeError(error)) return '所有线路均连接失败'
  if (error?.name === 'TimeoutError') return '请求超时'
  return error?.message || '请求失败'
}

function getFetchErrorCode(error) {
  if (error?.cause?.code) return error.cause.code
  if (error?.code) return error.code
  return ['AbortError', 'TimeoutError'].includes(error?.name) ? error.name : ''
}

function isRetryable(error) {
  const code = getFetchErrorCode(error)
  if (['AbortError', 'TimeoutError'].includes(code)) return true
  if (String(code).startsWith('UND_ERR_')) return true
  if (isMysNodeError(error)) return true
  if (error?.name === 'TypeError' && /fetch failed/i.test(error?.message || '')) return true
  const status = Number(error?.status || 0)
  return status === 429 || status >= 500
}

function makeWikiError(message, { label, path, cause, status } = {}) {
  const code = getFetchErrorCode(cause)
  const suffix = code ? `（${code}）` : ''
  const error = new Error(`${message}${suffix}`)
  error.name = 'SrWikiError'
  error.path = path || ''
  error.label = label || ''
  error.status = status
  error.cause = cause
  error.userMessage = `${label || '崩铁 wiki 数据'}获取失败：${message}${suffix}。这通常是服务器到米游社接口的网络波动，不是图鉴数据损坏；请稍后重试。`
  return error
}

export function formatFetchError(error) {
  if (error?.userMessage) return error.userMessage
  if (isMysNodeError(error)) {
    return '崩铁 wiki 数据获取失败：所有线路均连接失败。这通常是服务器到米游社接口的网络波动，请稍后重试。'
  }
  const code = getFetchErrorCode(error)
  const suffix = code ? `（${code}）` : ''
  return `${error?.message || String(error)}${suffix}`
}

/**
 * 请求一个返回 JSON 的接口
 * @param path 相对 API_BASE 的路径（含查询串）
 * @param label 出错时给用户看的业务名
 */
async function requestJson(path, label = '') {
  let lastError = null
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    try {
      const res = await netFetch(`${API_BASE}/${path}`, {
        headers: {
          'user-agent': UA,
          referer: REFERER,
          accept: 'application/json, text/plain, */*'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // 只有云崽的 mysFetch 认识这两项；重试时强制重新解析节点（一次 DNS 可能整批返回不可达池）
        timeout: NODE_TIMEOUT_MS,
        retry: NODE_RETRIES,
        ...(attempt > 0 ? { ttl: 0 } : {})
      })
      if (!res.ok) {
        const error = makeWikiError(`HTTP ${res.status}`, { label, path, status: res.status })
        if (attempt < REQUEST_RETRIES && isRetryable(error)) {
          lastError = error
          await sleep(600 * (attempt + 1))
          continue
        }
        throw error
      }
      const json = await res.json().catch(error => {
        throw makeWikiError('接口返回内容不是有效 JSON', { label, path, cause: error })
      })
      if (json?.retcode !== 0) {
        throw makeWikiError(`${json?.message || '接口返回异常'}（retcode ${json?.retcode}）`, { label, path })
      }
      return json
    } catch (error) {
      const wrapped = error?.name === 'SrWikiError'
        ? error
        : makeWikiError(describeFetchFailure(error), { label, path, cause: error })
      if (attempt < REQUEST_RETRIES && isRetryable(error)) {
        lastError = wrapped
        await sleep(600 * (attempt + 1))
        continue
      }
      throw wrapped
    }
  }
  throw lastError || makeWikiError('请求失败', { label, path })
}

/** 从分类节点里收集所有条目（条目散落在多层 children 里） */
export function collectItems(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectItems(item, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (node.content_id !== undefined && node.content_id !== null) {
    out.push({
      id: String(node.content_id),
      name: (node.title || node.name || '').trim(),
      icon: node.icon || '',
      ext: node.ext || '',
      summary: node.summary || ''
    })
    return out
  }
  for (const value of Object.values(node)) collectItems(value, out)
  return out
}

/**
 * 取某个分类的完整条目列表
 * @param channelId 分类 channel_id
 * @param label 给用户看的业务名
 */
export async function fetchChannelItems(channelId, label = '') {
  const json = await requestJson(`home/content/list?app_sn=${APP_SN}&channel_id=${channelId}`, label || `分类 ${channelId}`)
  const items = collectItems(json?.data)
  const seen = new Set()
  return items.filter(item => {
    if (!item.id || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

/** 取分类树（含每个分类的名称与筛选定义），用于排障与分类名核对 */
export async function fetchChannelTree(rootChannelId = 17) {
  const json = await requestJson(`home/content/list?app_sn=${APP_SN}&channel_id=${rootChannelId}`, '分类树')
  const channels = []
  const walk = (node, parent = null) => {
    if (Array.isArray(node)) return node.forEach(item => walk(item, parent))
    if (!node || typeof node !== 'object') return
    if (node.id !== undefined && node.name) {
      channels.push({ id: String(node.id), name: node.name, parent })
      const children = node.children
      if (children) walk(children, node.name)
      return
    }
    for (const value of Object.values(node)) walk(value, parent)
  }
  walk(json?.data)
  return channels
}

/**
 * 取单个条目的详情
 * @param contentId 条目 id
 * @param label 给用户看的业务名（一般是条目名）
 */
export async function fetchContentDetail(contentId, label = '') {
  const json = await requestJson(`content/info?app_sn=${APP_SN}&content_id=${contentId}`, label || `条目 ${contentId}`)
  const content = json?.data?.content
  if (!content) throw makeWikiError('接口没有返回条目内容', { label, path: `content/info?content_id=${contentId}` })
  return content
}

/** 分类内搜索（keyword 必填） */
export async function searchChannelContent(channelId, keyword, { page = 1, limit = 20 } = {}) {
  const path = `search/content?app_sn=${APP_SN}&keyword=${encodeURIComponent(keyword)}&channel_id=${channelId}&page=${page}&limit=${limit}`
  const json = await requestJson(path, `搜索「${keyword}」`)
  const list = json?.data?.list || []
  return list.map(item => ({ id: String(item.id), name: (item.title || '').trim(), summary: item.summary || '', ext: item.ext || '', icon: item.icon || '' }))
}

export const WIKI = { API_BASE, APP_SN, REFERER }

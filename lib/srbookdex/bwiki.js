/**
 * BWiki（B站 wiki）兜底检索
 *
 * 只在米游社本地文本库没有命中时才调用：走 MediaWiki 自带的搜索接口，无需鉴权。
 *   GET https://wiki.biligame.com/{ys|sr}/api.php?action=query&list=search&srsearch=<关键词>
 * bwiki 偶尔会回风控页（xhh 抓卡池计时器时遇到过 567），所以带重试；失败不静默，交给调用方提示用户。
 *
 * 说明：这里给的是「词条在哪」而不是正文——bwiki 的正文是模板拼出来的，
 * 抓下来一半是导航和脚本，不如让用户点链接去站内看。
 */

const SITES = {
  ys: { key: 'ys', name: '原神', base: 'https://wiki.biligame.com/ys' },
  sr: { key: 'sr', name: '星穹铁道', base: 'https://wiki.biligame.com/sr' }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 12000
const REQUEST_RETRIES = 2
const SNIPPET_LIMIT = 100

/** 摘要里固定出现的样板文字与内联脚本（页面模板被索引进正文里了） */
const SNIPPET_NOISE = [
  /如果是第一次来[^。]*(?:。|$)/g,
  /觉得WIKI好玩的话[^。]*(?:。|$)/g,
  /MediaWiki:Timer(?:\s+\S+){1,3}\s*/g,
  /(?:window\.RLQ|document\.|\(function\()[\s\S]*$/g
]

/** 面包屑导航（可能出现在摘要开头，也可能被搜索片段切在前面）：连同紧邻的「编 刷 历 短 阅」一起砍掉 */
function stripNavTrail(text) {
  const home = text.indexOf('首页')
  if (home < 0) return text
  const hasChain = /[>＞]/.test(text.slice(home, home + 14))
  const tabs = text.slice(Math.max(0, home - 24), home).match(/(?:[编刷历短阅读签讨论]\s+)+$/)
  // 正文里偶然出现的「首页」，前面也没有标签文字：不动
  if (!hasChain && !tabs) return text
  const start = tabs ? home - tabs[0].length : home
  const stop = Math.min(text.length, home + 80)
  let cut = -1
  for (let i = home; i < stop; i++) if (text[i] === '>' || text[i] === '＞') cut = i
  const end = cut >= 0 ? cut + 1 : home
  return `${text.slice(0, start)} ${text.slice(end)}`
}

/** wiki 皮肤顶部的「编 刷 历 短 阅」标签文字 */
function stripTabWords(text) {
  return text.replace(/^(?:\s*(?:编|刷|历|短|阅|读|签|讨论)\s*){3,}/, '')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

/** 关键词/标题归一化：忽略引号括号空白，便于判断是不是同名词条 */
function normalizeTitle(value) {
  return String(value || '')
    .replace(/[「」『』“”"'’‘《》()（）\s\u00a0]/g, '')
    .toLowerCase()
}

/** bwiki 摘要带 HTML 高亮与实体，清掉才能进合并转发；末尾重复的词条名也去掉（标题已经单独列了） */
export function cleanBwikiSnippet(html, title = '') {
  let text = decodeEntities(String(html || '').replace(/<[^>]*>/g, ''))
  for (const pattern of SNIPPET_NOISE) text = text.replace(pattern, ' ')
  text = stripNavTrail(text)
  text = stripTabWords(text)
  text = text.replace(/\s+/g, ' ').trim().replace(/^[>》\-–—\s]+/, '')
  const echo = String(title || '').trim()
  if (echo) {
    if (text === echo) text = ''
    else {
      if (text.startsWith(echo)) text = text.slice(echo.length)
      if (text.endsWith(echo)) text = text.slice(0, -echo.length)
    }
  }
  text = text.replace(/^[>》\-–—~～、,，;；\s]+/, '').replace(/[>》\-–—~～、,，;；\s]+$/, '')
  if (text.length > SNIPPET_LIMIT) text = `${text.slice(0, SNIPPET_LIMIT)}…`
  return text
}

/** 词条链接：MediaWiki 用下划线代替空格，其余按 URL 编码 */
export function bwikiPageUrl(siteKey, title) {
  const site = SITES[siteKey]
  if (!site) throw new Error(`不认识的 bwiki 站点：${siteKey}`)
  return `${site.base}/${encodeURIComponent(String(title || '').replace(/\s+/g, '_'))}`
}

/** 标题与关键词完全同名的词条排到最前，其余保持接口给的相关度顺序 */
function prioritizeExact(hits, keyword) {
  const target = normalizeTitle(keyword)
  if (!target) return hits
  const exact = hits.filter(hit => normalizeTitle(hit.title) === target)
  if (!exact.length) return hits
  return [...exact, ...hits.filter(hit => normalizeTitle(hit.title) !== target)]
}

function describeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '请求超时'
  if (error?.status) return `HTTP ${error.status}`
  return error?.message || '请求失败'
}

/** 给用户看的失败说明 */
export function formatBwikiError(error) {
  return describeError(error)
}

/**
 * 检索 bwiki 词条
 * @param siteKey 'ys' | 'sr'
 * @param keyword 关键词
 * @param limit 最多取多少条
 * @returns { site, siteName, total, hits: [{ title, snippet, url, pageId }] }
 */
export async function searchBwiki(siteKey, keyword, { limit = 10 } = {}) {
  const site = SITES[siteKey]
  if (!site) throw new Error(`不认识的 bwiki 站点：${siteKey}`)

  const term = String(keyword || '').trim()
  const empty = { site: site.key, siteName: site.name, total: 0, hits: [] }
  if (!term) return empty

  const query = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: term,
    srlimit: String(Math.min(20, Math.max(1, limit))),
    srnamespace: '0',
    srinfo: 'totalhits',
    srprop: 'snippet',
    format: 'json',
    formatversion: '2'
  })
  const url = `${site.base}/api.php?${query.toString()}`

  let lastError = null
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`)
        error.status = res.status
        error.retryable = res.status === 429 || res.status >= 500
        throw error
      }
      const json = await res.json()
      const list = json?.query?.search
      if (!Array.isArray(list)) {
        // 风控页或接口变更：拿不到 search 数组时重试，仍然失败就给用户一个明确的失败提示
        const error = new Error('接口没有返回搜索结果')
        error.retryable = true
        throw error
      }
      const hits = list.map(item => ({
        title: String(item?.title || '').trim(),
        snippet: cleanBwikiSnippet(item?.snippet, item?.title),
        url: bwikiPageUrl(site.key, item?.title),
        pageId: item?.pageid ?? null
      })).filter(hit => hit.title)
      return {
        site: site.key,
        siteName: site.name,
        total: Number(json?.query?.searchinfo?.totalhits ?? hits.length) || hits.length,
        hits: prioritizeExact(hits, term)
      }
    } catch (error) {
      lastError = error
      if (attempt < REQUEST_RETRIES && error?.retryable !== false) {
        await sleep(500 * (attempt + 1))
        continue
      }
      break
    }
  }
  throw lastError || new Error('请求失败')
}

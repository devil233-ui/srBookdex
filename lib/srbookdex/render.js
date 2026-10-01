/**
 * 把崩铁 wiki 的富文本（HTML 片段）转成可读纯文本
 * 米游社返回的正文里常见：<p>、<br>、<strong>、<span>、<img>、表格，以及 &nbsp; 之类的实体
 */

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&mdash;': '—',
  '&hellip;': '…',
  '&middot;': '·'
}

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&[a-z]+;/gi, match => ENTITIES[match.toLowerCase()] ?? match)
}

/** 提取 HTML 里的图片地址 */
export function extractImages(html) {
  const images = []
  const regex = /<img[^>]+src=["']([^"']+)["']/gi
  let match
  while ((match = regex.exec(String(html || '')))) images.push(match[1])
  return images
}

/** HTML → 纯文本（保留段落换行） */
export function htmlToText(html) {
  let text = String(html || '')
  // 换行语义
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|table|section)>/gi, '\n')
  text = text.replace(/<(p|div|li|h[1-6]|tr|table|section)[^>]*>/gi, '\n')
  // 表格单元格用制表符分隔
  text = text.replace(/<\/(td|th)>/gi, '\t')
  // 图片先摘掉（正文里只保留文字）
  text = text.replace(/<img[^>]*>/gi, '')
  // 其余标签
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  // 去掉每行的多余空白，合并连续空行
  text = text
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/** 段标题清洗：米游社有时用「·」「-」占位，遗器等多标签页条目会用「页签1」这种占位名 */
export function cleanSectionName(name, fallback = '正文') {
  const raw = decodeEntities(String(name || '')).replace(/\s+/g, ' ').trim()
  if (!raw || /^页签\d*$/.test(raw)) return fallback
  return raw
}

/**
 * 按长度把长文本切成若干页（用于合并转发，避免一条消息过长）
 */
export function splitTextPages(text, size = 900) {
  const raw = String(text || '')
  if (!raw) return []
  if (raw.length <= size) return [raw]
  const pages = []
  let rest = raw
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    pages.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) pages.push(rest)
  return pages.filter(Boolean)
}

/**
 * 去掉正文里重复出现的段落块。
 * 米游社某些页面（例如敌人图鉴）会把同一张属性表渲染两遍，正文里就是同一大段文字连着出现两次。
 * 判定刻意保守：块要够大（默认 ≥20 行）且两次出现要挨得够近（默认间隔 ≤30 行）。
 * 实测放宽到 4~5 行 / 几百行间隔会误伤正常内容：任务里同一段对白会被不同分支重复引用、
 * 角色页面里也会有大段结构相似的重复段落。
 * @returns { text, removed } removed 为被删掉的行数
 */
export function dedupeBlocks(text, { minLines = 20, maxLines = 60, maxGap = 30 } = {}) {
  const lines = String(text || '').split('\n')
  if (lines.length < minLines * 2) return { text: String(text || ''), removed: 0 }
  const seen = new Map()
  const out = []
  let removed = 0
  let i = 0
  while (i < lines.length) {
    let matched = 0
    for (let len = Math.min(maxLines, lines.length - i); len >= minLines; len--) {
      const end = seen.get(lines.slice(i, i + len).join('\n'))
      if (end === undefined) continue
      if (i - end > maxGap) continue
      matched = len
      break
    }
    if (matched) {
      removed += matched
      i += matched
      continue
    }
    for (let len = minLines; len <= Math.min(maxLines, lines.length - i); len++) {
      const key = lines.slice(i, i + len).join('\n')
      if (!seen.has(key)) seen.set(key, i + len)
    }
    out.push(lines[i])
    i += 1
  }
  return { text: out.join('\n'), removed }
}

/**
 * 把条目正文拆成有序节点：文字页 与 图片 按原始位置交替（图片内联在正文里，不单独抽出来）
 * @param item 条目记录
 * @param options.pageChars 每页文字的最大字符数（合并转发的一段）
 */
export function buildItemNodes(item, { pageChars = 800, dedupe = true } = {}) {
  const nodes = []
  const seenImages = new Set()
  const pushText = (text, prefix = '') => {
    const content = prefix ? `${prefix}${text}` : text
    for (const page of splitTextPages(content, pageChars)) nodes.push({ type: 'text', text: page })
  }

  for (const section of item.sections || []) {
    const name = cleanSectionName(section.name, '')
    const prefix = name && name !== '正文' ? `【${name}】\n` : ''
    const html = String(section.html || section.text || '')
    if (!html) continue
    let buffer = ''
    let firstPageDone = false
    const flush = () => {
      const raw = htmlToText(buffer)
      buffer = ''
      if (!raw) return
      const text = dedupe ? dedupeBlocks(raw).text : raw
      if (!text) return
      pushText(text, firstPageDone ? '' : prefix)
      firstPageDone = true
    }
    for (const part of html.split(/(<img[^>]*>)/i)) {
      const image = part.match(/^<img[^>]*src=["']([^"']+)["']/i)
      if (image) {
        flush()
        const url = image[1]
        if (url && !seenImages.has(url)) {
          seenImages.add(url)
          nodes.push({ type: 'image', url })
        }
        continue
      }
      buffer += part
    }
    flush()
  }
  return nodes
}

/**
 * 组装用于回复的文本
 * @param item 条目记录
 * @param options.maxLength 单条最长的字符数（超出截断）
 */
export function buildItemText(item, { maxLength = 0 } = {}) {
  const parts = []
  const sections = item.sections || []
  for (const section of sections) {
    const name = cleanSectionName(section.name, '')
    const text = htmlToText(section.html || section.text || '')
    if (!text) continue
    parts.push(name && name !== '正文' ? `【${name}】\n${text}` : text)
  }
  let out = parts.join('\n\n').trim()
  if (!out) out = htmlToText(item.summary || '')
  if (maxLength && out.length > maxLength) out = `${out.slice(0, maxLength)}…（内容较长已截断，可用图片或网页查看完整内容）`
  return out
}

/** 组装索引用的纯文本（用于全库搜索） */
export function buildSearchText(item) {
  const chunks = [item.name, item.summary || '']
  for (const section of item.sections || []) {
    const name = cleanSectionName(section.name, '')
    const text = htmlToText(section.html || section.text || '')
    if (name) chunks.push(name)
    if (text) chunks.push(text)
  }
  return chunks.filter(Boolean).join('\n')
}

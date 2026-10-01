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

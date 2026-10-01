import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import { loadIndex, channelEntries, channelStats, totalItems } from './base.js'
import { ACTIVE_CHANNELS, findChannelByKey } from './channels.js'
import { loadItem, updateChannel } from './fetchers.js'
import { buildItemText } from './render.js'
import { loadConfig, saveConfig, FORCE_CHANNEL_OPTIONS, getDefaultAutoUpdateInfo, AUTO_UPDATE_HOUR_GMT8 } from './config.js'
import { formatFetchError } from './wiki-api.js'

const DEFAULT_PORT = 14523
const DEFAULT_HOST = '0.0.0.0'

let server = null
let info = null
const jobs = new Map()

function makeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function makeJob(type) {
  const job = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    status: 'running',
    step: '准备中',
    done: 0,
    total: 0,
    percent: 0,
    logs: [],
    startedAt: Date.now(),
    finishedAt: 0
  }
  jobs.set(job.id, job)
  setTimeout(() => jobs.delete(job.id), 2 * 3600 * 1000).unref?.()
  return job
}

function patchJob(job, patch = {}) {
  Object.assign(job, patch)
  if (job.total) job.percent = Math.min(100, Math.round((Number(job.done || 0) / Number(job.total || 1)) * 100))
}

function makeReporter(job, label) {
  return {
    onProgress: ({ done, total }) => patchJob(job, { step: `正在更新${label}`, done, total }),
    onError: ({ name, error }) => job.logs.push(`${label}${name ? `｜${name}` : ''}：${formatFetchError(error)}`)
  }
}

async function runJob(job, { channelKey, force }) {
  try {
    const targets = channelKey === 'all' ? ACTIVE_CHANNELS : [findChannelByKey(channelKey)].filter(Boolean)
    if (!targets.length) throw new Error('未知分类')
    const results = []
    for (const channel of targets) {
      patchJob(job, { step: `正在更新${channel.name}`, done: 0, total: 0 })
      const ret = await updateChannel(channel.key, { ...makeReporter(job, channel.name), deepCompare: Boolean(force) })
      results.push(ret)
      job.logs.push(`${channel.name}完成：扫描 ${ret.total} 条，更新 ${ret.updated} 条${ret.failed ? `，失败 ${ret.failed}` : ''}`)
    }
    patchJob(job, { status: 'done', step: '完成', percent: 100, results, finishedAt: Date.now() })
  } catch (error) {
    patchJob(job, { status: 'failed', step: '失败', error: formatFetchError(error), finishedAt: Date.now() })
  }
}

function apiBaseUrl(cfg) {
  const host = cfg.webui.publicHost || os.hostname()
  return `http://${cfg.webui.publicHost || '127.0.0.1'}:${cfg.webui.port}/`
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/status') {
    const index = await loadIndex()
    const cfg = await loadConfig()
    const next = getDefaultAutoUpdateInfo()
    return makeJson(res, 200, {
      channels: ACTIVE_CHANNELS.map(channel => ({
        key: channel.key,
        name: channel.name,
        id: channel.id,
        count: channelEntries(index, channel.key).length
      })),
      total: totalItems(index),
      autoUpdate: { ...cfg.autoUpdate, hour: AUTO_UPDATE_HOUR_GMT8, nextRunAtText: next.nextRunAtText },
      url: info?.url || apiBaseUrl(cfg)
    })
  }

  if (url.pathname === '/api/list') {
    const channelKey = url.searchParams.get('channel') || ACTIVE_CHANNELS[0].key
    const page = Math.max(1, Number(url.searchParams.get('page') || 1))
    const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get('pageSize') || 50)))
    const index = await loadIndex()
    const entries = channelEntries(index, channelKey)
    const slice = entries.slice((page - 1) * pageSize, page * pageSize)
    return makeJson(res, 200, {
      channel: channelKey,
      total: entries.length,
      page,
      pageSize,
      items: slice.map(item => ({ id: item.id, name: item.name, summary: item.summary || '' }))
    })
  }

  if (url.pathname === '/api/content') {
    const channelKey = url.searchParams.get('channel')
    const id = url.searchParams.get('id')
    const item = await loadItem(channelKey, id)
    if (!item) return makeJson(res, 404, { error: '本地没有这条内容，请先更新对应分类' })
    return makeJson(res, 200, {
      id: item.id,
      name: item.name,
      channelName: item.channelName,
      url: item.url,
      icon: item.icon,
      text: buildItemText(item)
    })
  }

  if (url.pathname === '/api/search') {
    const keyword = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const channelKey = url.searchParams.get('channel') || ''
    if (!keyword) return makeJson(res, 200, { items: [] })
    const index = await loadIndex()
    const targets = channelKey ? [findChannelByKey(channelKey)].filter(Boolean) : ACTIVE_CHANNELS
    const items = []
    for (const channel of targets) {
      for (const item of channelEntries(index, channel.key)) {
        const haystack = `${item.name} ${item.summary || ''}`.toLowerCase()
        if (!haystack.includes(keyword)) continue
        items.push({ channelKey: channel.key, channelName: channel.name, id: item.id, name: item.name, summary: item.summary || '' })
        if (items.length >= 100) break
      }
      if (items.length >= 100) break
    }
    return makeJson(res, 200, { items })
  }

  if (url.pathname === '/api/update' && req.method === 'POST') {
    const body = await readBody(req)
    for (const job of jobs.values()) {
      if (job.status === 'running') return makeJson(res, 409, { error: '已有更新任务在跑，请稍后再试' })
    }
    const job = makeJob(body.channel || 'all')
    runJob(job, { channelKey: body.channel || 'all', force: Boolean(body.force) })
    return makeJson(res, 200, { id: job.id })
  }

  if (url.pathname === '/api/job') {
    const job = jobs.get(url.searchParams.get('id'))
    if (!job) return makeJson(res, 404, { error: '任务不存在或已过期' })
    return makeJson(res, 200, job)
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const cfg = await loadConfig()
    const next = getDefaultAutoUpdateInfo()
    return makeJson(res, 200, {
      autoUpdate: {
        enabled: Boolean(cfg.autoUpdate.enabled),
        forceChannels: cfg.autoUpdate.forceChannels || [],
        hour: AUTO_UPDATE_HOUR_GMT8,
        nextRunAtText: next.nextRunAtText
      },
      forceOptions: FORCE_CHANNEL_OPTIONS
    })
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const cfg = await loadConfig()
    const body = await readBody(req)
    const next = {
      ...cfg,
      autoUpdate: {
        ...cfg.autoUpdate,
        enabled: body?.autoUpdate?.enabled === undefined ? cfg.autoUpdate.enabled : Boolean(body.autoUpdate.enabled),
        forceChannels: body?.autoUpdate?.forceChannels === undefined ? cfg.autoUpdate.forceChannels : body.autoUpdate.forceChannels
      }
    }
    return makeJson(res, 200, { ok: true, config: await saveConfig(next) })
  }

  return makeJson(res, 404, { error: '接口不存在' })
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>srBookdex · 星穹铁道文本图鉴</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#14161a;color:#e6e8eb}
header{padding:14px 18px;border-bottom:1px solid #262a31;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header b{font-size:16px}
header .small{color:#98a0ab}
main{display:grid;grid-template-columns:240px 1fr;gap:0;min-height:calc(100vh - 60px)}
aside{border-right:1px solid #262a31;padding:12px;overflow:auto}
aside button{display:flex;justify-content:space-between;width:100%;margin:3px 0;padding:7px 10px;border-radius:8px;border:0;background:#1c2027;color:#e6e8eb;cursor:pointer}
aside button.active{background:#2b6ef6}
aside button span{color:#98a0ab}
section{padding:16px 20px;overflow:auto}
input,button,textarea,select{font:inherit}
input[type=text]{padding:7px 10px;border-radius:8px;border:1px solid #2c313a;background:#1c2027;color:#e6e8eb;min-width:200px}
button.accent{background:#2b6ef6;color:#fff;border:0;border-radius:8px;padding:7px 12px;cursor:pointer}
button.ghost{background:#232833;color:#cbd2dc;border:0;border-radius:8px;padding:6px 10px;cursor:pointer}
.card{padding:10px 12px;border:1px solid #262a31;border-radius:10px;margin:6px 0;cursor:pointer;background:#191d23}
.card:hover{border-color:#3a4150}
.card .name{font-weight:600}
.card .meta{color:#98a0ab;font-size:12px}
pre{white-space:pre-wrap;word-break:break-word;background:#191d23;border:1px solid #262a31;border-radius:10px;padding:12px;max-height:62vh;overflow:auto}
.bar{height:8px;background:#232833;border-radius:999px;overflow:hidden;margin:8px 0}
.bar i{display:block;height:100%;background:#2b6ef6;width:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
label.check{display:inline-flex;gap:6px;align-items:center;background:#1c2027;border:1px solid #2c313a;border-radius:8px;padding:5px 9px}
</style></head><body>
<header><b>srBookdex</b><span class="small" id="health">加载中…</span>
<span class="row"><input type="text" id="q" placeholder="搜索已下载数据的标题/摘要"><button class="accent" id="searchBtn">搜索</button></span>
<span class="row"><button class="ghost" id="updateAll">统一更新</button><button class="ghost" id="settingsBtn">设置</button></span>
</header>
<main><aside id="tabs"></aside><section id="app"></section></main>
<div id="jobBox" style="display:none;padding:10px 18px;border-top:1px solid #262a31">
<div class="small" id="jobText"></div><div class="bar"><i id="jobBar"></i></div><pre id="jobLog" style="max-height:180px"></pre></div>
<script>
const el = id => document.getElementById(id)
const api = (url, opt = {}) => fetch(url, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) } })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j })
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]))
let state = { channel: '', page: 1, view: 'list', channels: [] }

async function boot() {
  const s = await api('/api/status')
  state.channels = s.channels
  if (!state.channel) state.channel = s.channels[0]?.key || ''
  el('health').textContent = '在线｜共 ' + s.total + ' 条｜自动更新 ' + (s.autoUpdate.enabled ? '开（每日 ' + s.autoUpdate.hour + ' 点，默认下次 ' + s.autoUpdate.nextRunAtText + '）' : '关')
  renderTabs()
  openChannel(state.channel, 1)
}

function renderTabs(stats) {
  el('tabs').innerHTML = state.channels.map(c =>
    '<button class="' + (c.key === state.channel ? 'active' : '') + '" onclick="openChannel(\\'' + c.key + '\\',1)"><span>' + esc(c.name) + '</span><span>' + c.count + '</span></button>').join('')
}

async function openChannel(key, page) {
  state.channel = key; state.page = page; state.view = 'list'
  renderTabs()
  const data = await api('/api/list?channel=' + key + '&page=' + page)
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))
  el('app').innerHTML = '<div class="row"><button class="accent" onclick="updateChannel(\\'' + key + '\\')">更新本分类</button>' +
    '<button class="ghost" onclick="updateChannel(\\'' + key + '\\',true)">强制核对</button>' +
    '<button class="ghost" ' + (page <= 1 ? 'disabled' : '') + ' onclick="openChannel(\\'' + key + '\\',' + (page - 1) + ')">上一页</button>' +
    '<button class="ghost" ' + (page >= totalPages ? 'disabled' : '') + ' onclick="openChannel(\\'' + key + '\\',' + (page + 1) + ')">下一页</button>' +
    '<span class="small">共 ' + data.total + ' 条，第 ' + page + '/' + totalPages + ' 页</span></div>' +
    '<div class="grid">' + data.items.map(item =>
      '<div class="card" onclick="openItem(\\'' + key + '\\',\\'' + item.id + '\\')"><div class="name">' + esc(item.name) + '</div><div class="meta">' + esc(item.summary || item.id) + '</div></div>').join('') + '</div>'
}

async function openItem(key, id) {
  state.view = 'item'
  const item = await api('/api/content?channel=' + key + '&id=' + encodeURIComponent(id))
  el('app').innerHTML = '<div class="row"><button class="ghost" onclick="openChannel(\\'' + key + '\\',' + state.page + ')">返回列表</button>' +
    '<b>' + esc(item.name) + '</b><span class="small">' + esc(item.channelName) + '｜<a style="color:#7ea6ff" href="' + esc(item.url) + '" target="_blank">米游社原页</a></span></div>' +
    '<pre>' + esc(item.text) + '</pre>'
}

async function doSearch() {
  const q = el('q').value.trim()
  if (!q) return openChannel(state.channel, 1)
  state.view = 'search'
  const data = await api('/api/search?q=' + encodeURIComponent(q))
  el('app').innerHTML = '<div class="row"><b>搜索：' + esc(q) + '</b><span class="small">找到 ' + data.items.length + ' 条</span></div>' +
    '<div class="grid">' + data.items.map(item =>
      '<div class="card" onclick="openItem(\\'' + item.channelKey + '\\',\\'' + item.id + '\\')"><span class="small">' + esc(item.channelName) + '</span><div class="name">' + esc(item.name) + '</div><div class="meta">' + esc(item.summary || '') + '</div></div>').join('') + '</div>'
}

async function updateChannel(key, force) {
  const data = await api('/api/update', { method: 'POST', body: JSON.stringify({ channel: key, force: Boolean(force) }) })
  el('jobBox').style.display = 'block'; el('jobLog').textContent = ''; pollJob(data.id)
}

async function updateAll() {
  const data = await api('/api/update', { method: 'POST', body: JSON.stringify({ channel: 'all' }) })
  el('jobBox').style.display = 'block'; el('jobLog').textContent = ''; pollJob(data.id)
}

async function pollJob(id) {
  try {
    const job = await api('/api/job?id=' + id)
    el('jobText').textContent = (job.status === 'running' ? '更新中：' : '更新结束：') + job.step + ' ' + (job.percent || 0) + '%'
    el('jobBar').style.width = (job.percent || 0) + '%'
    el('jobLog').textContent = (job.logs || []).slice(-8).join('\\n') + (job.error ? '\\n' + job.error : '')
    if (job.status === 'running') setTimeout(() => pollJob(id), 1500)
    else boot()
  } catch (e) { el('jobText').textContent = '进度获取失败：' + e.message }
}

async function showSettings() {
  const s = await api('/api/settings')
  const force = new Set(s.autoUpdate.forceChannels || [])
  el('app').innerHTML = '<div class="row"><button class="ghost" onclick="openChannel(\\'' + state.channel + '\\',1)">返回</button><b>设置</b></div>' +
    '<div class="row"><label class="check"><input type="checkbox" id="autoEnabled" ' + (s.autoUpdate.enabled ? 'checked' : '') + '> 每日自动更新（' + s.autoUpdate.hour + ':00，下次 ' + esc(s.autoUpdate.nextRunAtText) + '）</label></div>' +
    '<div class="small">每日强制核对的分类（逐条重新比对正文，条目多时较慢）：</div><div class="row">' +
    s.forceOptions.map(o => '<label class="check"><input type="checkbox" class="forceCh" data-key="' + esc(o.key) + '" ' + (force.has(o.key) ? 'checked' : '') + '> ' + esc(o.label) + '</label>').join('') +
    '</div><div class="row"><button class="accent" onclick="saveSettings()">保存</button></div>'
}

async function saveSettings() {
  const forceChannels = [...document.querySelectorAll('.forceCh')].filter(x => x.checked).map(x => x.dataset.key)
  await api('/api/settings', { method: 'POST', body: JSON.stringify({ autoUpdate: { enabled: el('autoEnabled').checked, forceChannels } }) })
  showSettings()
}

el('searchBtn').onclick = doSearch
el('q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch() })
el('updateAll').onclick = updateAll
el('settingsBtn').onclick = showSettings
boot().catch(e => { el('app').innerHTML = '<p>加载失败：' + esc(e.message) + '</p>' })
</script></body></html>`
}

export async function startWebUi({ logger } = {}) {
  if (server) return info
  const cfg = await loadConfig()
  const port = Number(cfg.webui?.port || DEFAULT_PORT)
  const host = cfg.webui?.host || DEFAULT_HOST
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(pageHtml())
    } catch (error) {
      logger?.error?.('[srBookdex.webui]', error)
      if (!res.headersSent) makeJson(res, 500, { error: formatFetchError(error) })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  info = { port, host, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/` }
  logger?.mark?.(`[srBookdex.webui] listening ${host}:${port}`)
  return info
}

export function getWebUiInfo() {
  return info
}

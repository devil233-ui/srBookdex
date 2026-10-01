import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 插件根目录（lib/srbookdex/ 往上两级） */
export const pluginDir = path.resolve(here, '..', '..')
export const pluginFolder = path.basename(pluginDir)

export const dataRoot = path.join(pluginDir, 'data')
export const cacheRoot = path.join(dataRoot, 'cache')
export const indexFile = path.join(dataRoot, 'index.json')
export const stateFile = path.join(dataRoot, 'state.json')
export const webConfigFile = path.join(cacheRoot, 'webui.json')

/** 分类目录 data/<key>/ */
export function channelDir(key) {
  return path.join(dataRoot, key)
}

/** 条目文件名：<安全名>__<id>.json */
export function buildItemFileName(name, id) {
  return `${slugify(name)}__${id}.json`
}

/** 把名字变成安全的文件名片段 */
export function slugify(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[.\s]+$/, '')
    || 'unnamed'
}

export { path }

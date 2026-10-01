/**
 * srBookdex 分类表（米游社崩铁 wiki 的 channel）
 *
 * stage 的含义：
 *   1 = 第一批实现（文本量大的主体内容，对应 bookdex 的书籍 / 剧情 / 角色故事 / 武器故事 / 圣遗物故事）
 *   2 = 第二批实现（道具材料类，结构与第一批一致，直接复用同一套抓取与渲染）
 *   0 = 暂不实现（信息结构复杂或展示价值低，需要时把 stage 改成 1/2 即可接入）
 *
 * key：内部标识，同时用作 data/ 下的目录名
 * id：米游社崩铁 wiki 的 channel_id（2026-10-01 实测）
 * aliases：用户可能敲的名字，含跨游戏叫法（光锥⇄武器、遗器⇄圣遗物、阅读物⇄书籍）
 */
export const CHANNELS = [
  // ── 第一批：文本量大 ─────────────────────────────────────────────
  { key: 'readable', id: 31, name: '阅读物', aliases: ['书籍', '书'], stage: 1, unit: '本' },
  { key: 'quest', id: 25, name: '任务', aliases: ['剧情', '剧情文本'], stage: 1, unit: '条' },
  { key: 'character', id: 18, name: '角色', aliases: ['角色故事', '角色故事文本'], stage: 1, unit: '个' },
  { key: 'lightcone', id: 19, name: '光锥', aliases: ['光锥故事', '武器', '武器故事'], stage: 1, unit: '个' },
  { key: 'relic', id: 30, name: '遗器', aliases: ['遗器故事', '圣遗物', '圣遗物故事'], stage: 1, unit: '套' },

  // ── 第二批：道具材料类 ───────────────────────────────────────────
  { key: 'material', id: 20, name: '养成材料', aliases: ['材料', '培养材料'], stage: 2, unit: '条' },
  { key: 'consumable', id: 36, name: '消耗品', aliases: [], stage: 2, unit: '条' },
  { key: 'questitem', id: 53, name: '任务道具', aliases: [], stage: 2, unit: '条' },
  { key: 'valuable', id: 54, name: '贵重物', aliases: ['珍奇物'], stage: 2, unit: '条' },
  { key: 'othermaterial', id: 55, name: '其他材料', aliases: [], stage: 2, unit: '条' },
  { key: 'specialitem', id: 158, name: '特殊道具', aliases: [], stage: 2, unit: '条' },
  { key: 'dreampass', id: 217, name: '梦境护照', aliases: ['梦境手册'], stage: 2, unit: '条' },
  { key: 'suevent', id: 103, name: '模拟宇宙·事件图鉴', aliases: ['模拟宇宙事件', '事件图鉴'], stage: 2, unit: '条' },
  { key: 'lilikan', id: 227, name: '狸狸社刊', aliases: ['社刊'], stage: 2, unit: '期' },

  // ── 暂不实现（要接入时把 stage 改掉即可） ────────────────────────
  { key: 'achievement', id: 173, name: '成就攻略', aliases: ['成就'], stage: 0, unit: '条' },
  { key: 'zhuguang', id: 102, name: '逐光捡金', aliases: [], stage: 0, unit: '条' },
  { key: 'enemy', id: 23, name: '敌对物种', aliases: ['敌人', '敌方'], stage: 1, unit: '个' },
  { key: 'dress', id: 157, name: '装扮', aliases: ['时装'], stage: 0, unit: '套' },
  { key: 'furniture', id: 216, name: '家具', aliases: [], stage: 0, unit: '件' },
  { key: 'pet', id: 236, name: '随宠', aliases: [], stage: 0, unit: '个' },
  { key: 'shop', id: 99, name: '商店', aliases: [], stage: 0, unit: '家' },
  { key: 'commission', id: 100, name: '委托', aliases: [], stage: 0, unit: '条' },
  { key: 'titan', id: 189, name: '负世泰坦', aliases: [], stage: 0, unit: '个' },
  { key: 'golden', id: 193, name: '黄金裔', aliases: [], stage: 0, unit: '个' },
  { key: 'goldenwiki', id: 186, name: '黄金裔WIKI', aliases: [], stage: 0, unit: '个' },
  { key: 'activity', id: 114, name: '活动', aliases: [], stage: 0, unit: '个' },
  { key: 'loot', id: 171, name: '战利品收集', aliases: [], stage: 0, unit: '条' },
  { key: 'su', id: 125, name: '模拟宇宙', aliases: [], stage: 0, unit: '条' }
]

/** 已启用的分类（stage 1 / 2） */
export const ACTIVE_CHANNELS = CHANNELS.filter(item => item.stage > 0)

/** 分类的全部可用写法（本名 + 别名） */
export function channelNames(channel) {
  return [channel.name, ...(channel.aliases || [])]
}

/**
 * 生成匹配用正则片段：所有已启用分类的名字与别名，按长度倒序（长的在前，避免 `武器` 抢掉 `武器故事`）
 * @param onlyStage 只取指定阶段（不传则取全部已启用分类）
 */
export function buildNamePattern(onlyStage) {
  const list = ACTIVE_CHANNELS.filter(item => !onlyStage || item.stage === onlyStage)
  const names = [...new Set(list.flatMap(channelNames))]
  return names.sort((a, b) => b.length - a.length).join('|')
}

/** 按用户输入的写法找到分类（最长匹配优先） */
export function findChannelByName(name) {
  const raw = String(name || '').trim()
  if (!raw) return null
  const matches = []
  for (const channel of CHANNELS) {
    for (const candidate of channelNames(channel)) {
      if (candidate === raw) matches.push({ channel, len: candidate.length })
    }
  }
  return matches.sort((a, b) => b.len - a.len)[0]?.channel || null
}

/** 按 key 找分类 */
export function findChannelByKey(key) {
  return CHANNELS.find(item => item.key === key) || null
}

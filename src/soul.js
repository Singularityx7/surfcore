/**
 * 角色灵魂（soul）—— 纯逻辑层，零 I/O。
 *
 * 分工：
 *   · purpose-engine 管「想要什么」（drives / 目标）；
 *   · 本文件管「现在是什么状态」：心情、精力、在意的事，以及每天一次的自我叙事。
 *
 * 状态文件在 characters/<id>/soul/state.json，叙事在 soul/narrative.md；
 * 读写都在 bridge.js。这里只做归一化、推导、渲染、反思解析与护栏，方便单测。
 */

export const SOUL_STATE_VERSION = 1;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SOUL_MOODS = Object.freeze([
  '平静', '松快', '有点烦', '低落', '累', '兴奋', '想人', '发呆', '无聊', '满足',
]);

export const DEFAULT_SOUL_CONFIG = Object.freeze({
  enabled: true,
  // 每次唤醒注入一行极短的状态（没有值得说的事就不注入）。
  stateInPrompt: true,
  stateMaxChars: 120,
  // 自我叙事只在目的回合 / 每日反思里出现，不进每次唤醒，省 token。
  narrativeInPurpose: true,
  narrativeMaxChars: 600,
  reflectEnabled: true,
  reflectHour: '03:40',
  reflectMinChars: 80,
  reflectMaxChars: 420,
  reflectTimeoutMs: 180000,
  reflectRetryMs: 3 * HOUR,
  reflectSessionMaxAgeMs: 7 * DAY,
  // 专用内部预设：不带 QQ 工具，避免反思会话继承群聊协议与「AI 味」措辞。
  reflectPreset: 'soul-reflect',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clip(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function blockText(text, max = 2400) {
  const s = String(text ?? '').replace(/\r/g, '').trim();
  return s.length > max ? `${s.slice(0, max)}\n…（已省略）` : s;
}

export function localDateKey(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseClock(value, fallback = '03:40') {
  const pick = (raw) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return null;
    return { hh, mm };
  };
  const parsed = pick(value) ?? pick(fallback) ?? { hh: 3, mm: 40 };
  return { ...parsed, text: `${String(parsed.hh).padStart(2, '0')}:${String(parsed.mm).padStart(2, '0')}` };
}

export function normalizeSoulConfig(input = {}) {
  const src = isPlainObject(input) ? input : {};
  const reflectMinChars = clampInt(src.reflectMinChars, DEFAULT_SOUL_CONFIG.reflectMinChars, 40, 200);
  const reflectMaxChars = clampInt(src.reflectMaxChars, DEFAULT_SOUL_CONFIG.reflectMaxChars, reflectMinChars + 40, 800);
  return {
    enabled: src.enabled !== false,
    stateInPrompt: src.stateInPrompt !== false,
    stateMaxChars: clampInt(src.stateMaxChars, DEFAULT_SOUL_CONFIG.stateMaxChars, 60, 240),
    narrativeInPurpose: src.narrativeInPurpose !== false,
    narrativeMaxChars: clampInt(src.narrativeMaxChars, DEFAULT_SOUL_CONFIG.narrativeMaxChars, 200, 1200),
    reflectEnabled: src.reflectEnabled !== false,
    reflectHour: parseClock(src.reflectHour, DEFAULT_SOUL_CONFIG.reflectHour).text,
    reflectMinChars,
    reflectMaxChars,
    reflectTimeoutMs: clampInt(src.reflectTimeoutMs, DEFAULT_SOUL_CONFIG.reflectTimeoutMs, 30000, 600000),
    reflectRetryMs: clampInt(src.reflectRetryMs, DEFAULT_SOUL_CONFIG.reflectRetryMs, 10 * MINUTE, DAY),
    reflectSessionMaxAgeMs: clampInt(src.reflectSessionMaxAgeMs, DEFAULT_SOUL_CONFIG.reflectSessionMaxAgeMs, DAY, 30 * DAY),
    reflectPreset: String(src.reflectPreset ?? '').trim().slice(0, 80) || DEFAULT_SOUL_CONFIG.reflectPreset,
  };
}

/** 一天里的精力底子：凌晨最低，上午和傍晚较高。 */
const ENERGY_CURVE = Object.freeze([
  0.22, 0.17, 0.15, 0.14, 0.16, 0.23, 0.34, 0.50,
  0.66, 0.79, 0.85, 0.86, 0.78, 0.68, 0.74, 0.80,
  0.82, 0.76, 0.78, 0.72, 0.64, 0.55, 0.44, 0.32,
]);

export function circadianEnergy(now = Date.now()) {
  return ENERGY_CURVE[new Date(now).getHours()] ?? 0.6;
}

export function moodLabel({ valence = 0.05, energy = 0.6 } = {}) {
  const v = clamp(valence, -1, 1);
  const e = clamp01(energy, 0.6);
  if (e <= 0.3) return '累';
  if (v <= -0.35) return '低落';
  if (v < -0.16) return '有点烦';
  if (v >= 0.5 && e >= 0.6) return '松快';
  if (v >= 0.34) return '满足';
  if (e < 0.4) return '发呆';
  if (v >= 0.18) return '平静';
  return '平静';
}

export function createSoulState(now = Date.now()) {
  const energy = circadianEnergy(now);
  return {
    version: SOUL_STATE_VERSION,
    mood: { label: moodLabel({ valence: 0.05, energy }), valence: 0.05, energy },
    concerns: [],
    lastUpdatedAt: now,
    lastEmotionAt: 0,
    lastSocialAt: 0,
    lastReflectionAt: 0,
    lastReflectionDay: '',
    lastReflectionMood: '',
    reflectionCount: 0,
  };
}

function normalizeConcern(raw, now) {
  if (typeof raw === 'string') {
    const text = clip(raw.replace(/[「」“”"]/g, ''), 30);
    if (!text || text === '无') return null;
    return { text, addedAt: now, expiresAt: now + 14 * DAY };
  }
  if (!isPlainObject(raw)) return null;
  const text = clip(String(raw.text ?? '').replace(/[「」“”"]/g, ''), 30);
  if (!text || text === '无') return null;
  const addedAt = Number(raw.addedAt) || now;
  const expiresAt = Number(raw.expiresAt) || addedAt + 14 * DAY;
  if (expiresAt <= now) return null;
  return { text, addedAt, expiresAt };
}

export function normalizeSoulState(raw, now = Date.now()) {
  const base = createSoulState(now);
  if (!isPlainObject(raw)) return base;
  const moodRaw = isPlainObject(raw.mood) ? raw.mood : {};
  const energy = clamp01(moodRaw.energy ?? raw.energy, base.mood.energy);
  const valence = clamp(moodRaw.valence ?? raw.valence, -1, 1);
  const label = SOUL_MOODS.includes(moodRaw.label)
    ? String(moodRaw.label)
    : moodLabel({ valence, energy });
  const concerns = (Array.isArray(raw.concerns) ? raw.concerns : [])
    .map((item) => normalizeConcern(item, now))
    .filter(Boolean)
    .filter((item, index, list) => list.findIndex((x) => x.text === item.text) === index)
    .slice(-4);
  return {
    version: SOUL_STATE_VERSION,
    mood: { label, valence, energy },
    concerns,
    lastUpdatedAt: Number(raw.lastUpdatedAt) || now,
    lastEmotionAt: Number(raw.lastEmotionAt) || 0,
    lastSocialAt: Number(raw.lastSocialAt) || 0,
    lastReflectionAt: Number(raw.lastReflectionAt) || 0,
    lastReflectionDay: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.lastReflectionDay ?? '')) ? String(raw.lastReflectionDay) : '',
    lastReflectionMood: SOUL_MOODS.includes(raw.lastReflectionMood) ? raw.lastReflectionMood : '',
    reflectionCount: clampInt(raw.reflectionCount, 0, 0, 9999),
  };
}

const EMOTION_DELTA = Object.freeze({
  lonely: -0.07, envious: -0.03, worried: -0.04, proud: 0.06, curious: 0.03,
  excited: 0.07, affectionate: 0.06, amused: 0.05, bored: -0.04, content: 0.02,
});

/**
 * 随时间漂移：精力往「这个点该有的精力」靠，心情往平静靠；
 * 目的回合的结果只结算一次（按 lastSentAt 去重），不会每个 tick 反复加减。
 */
export function deriveSoulState({
  state,
  now = Date.now(),
  drives = null,
  lastOwnerAt = 0,
  lastSentAt = 0,
  lastEmotion = '',
  lastSocialAt = 0,
} = {}) {
  const next = normalizeSoulState(state, now);
  const hours = Math.max(0, Math.min(72, (now - (Number(next.lastUpdatedAt) || now)) / HOUR));
  const baseEnergy = circadianEnergy(now);
  const energy = baseEnergy + (next.mood.energy - baseEnergy) * Math.pow(0.5, hours / 3);
  let valence = 0.05 + (next.mood.valence - 0.05) * Math.pow(0.5, hours / 10);
  if (lastSentAt > 0 && lastSentAt > next.lastEmotionAt && EMOTION_DELTA[lastEmotion] != null) {
    valence += EMOTION_DELTA[lastEmotion];
    next.lastEmotionAt = lastSentAt;
  }
  // 主人来私聊是「被惦记」的弱信号：半小时内只结算一次、只往上抬一点，
  // 不按消息条数累加，也不把她的心情推成一直开心。
  if (lastSocialAt > 0 && lastSocialAt > next.lastSocialAt) {
    const fresh = now - lastSocialAt <= 6 * HOUR;
    const spaced = !next.lastSocialAt || lastSocialAt - next.lastSocialAt >= 30 * MINUTE;
    if (fresh && spaced && valence < 0.35) valence += 0.02;
    next.lastSocialAt = lastSocialAt;
  }
  // 很长时间没和主人说话：不是每 tick 扣分，只在心情本来就偏低时轻轻压一点。
  const connect = Number(drives?.connect) || 0;
  const hoursSinceOwner = lastOwnerAt > 0 ? Math.max(0, (now - lastOwnerAt) / HOUR) : 0;
  if (lastOwnerAt > 0 && hoursSinceOwner >= 36 && connect >= 0.6 && valence < 0.1) {
    valence -= 0.01;
  }
  next.mood.energy = clamp01(energy, baseEnergy);
  next.mood.valence = clamp(valence, -1, 1);
  next.mood.label = moodLabel(next.mood);
  next.lastUpdatedAt = now;
  return next;
}

function hashSeed(text) {
  let h = 2166136261;
  for (const ch of String(text ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickVariant(list, seed) {
  return list[hashSeed(seed) % list.length];
}

const TIRED_PHRASES = Object.freeze(['有点困，脑子转得慢', '没什么精神，只想发呆', '眼皮有点沉']);
const LOW_PHRASES = Object.freeze(['心情一般，不太想多聊', '有点闷，不想解释', '提不起劲']);
const GOOD_PHRASES = Object.freeze(['心情不错，想找点乐子', '今天挺松快的', '状态还行，话可能多一点']);
const MISS_PHRASES = Object.freeze(['有点想主人了', '忽然想找主人说句话']);

/**
 * 唤醒时的一行状态。没有值得说的就返回空串（不占 token，也不逼她表演）。
 * 只给内部参考，不要求说出来。
 */
export function renderSoulBlock(state, { now = Date.now(), drives = null, lastOwnerAt = 0, maxChars = 120 } = {}) {
  const s = normalizeSoulState(state, now);
  const seed = `${localDateKey(now)}|${new Date(now).getHours()}`;
  const source = [];
  const concern = s.concerns.find((item) => !item.expiresAt || item.expiresAt > now);
  if (concern) source.push(`心里还惦记着「${concern.text}」`);
  if (s.mood.valence <= -0.28) source.push(pickVariant(LOW_PHRASES, `${seed}|low`));
  else if (s.mood.valence >= 0.5) source.push(pickVariant(GOOD_PHRASES, `${seed}|good`));
  if (s.mood.energy <= 0.28) source.push(pickVariant(TIRED_PHRASES, `${seed}|tired`));
  const connect = Number(drives?.connect) || 0;
  const hoursSinceOwner = lastOwnerAt > 0 ? Math.max(0, (now - lastOwnerAt) / HOUR) : 0;
  if (connect >= 0.62 && hoursSinceOwner >= 8) source.push(pickVariant(MISS_PHRASES, `${seed}|miss`));
  if (!source.length) return '';

  const picked = [];
  let used = 0;
  for (const clause of source) {
    if (picked.length >= 2) break;
    if (picked.includes(clause)) continue;
    if (used + clause.length + 1 > maxChars) continue;
    picked.push(clause);
    used += clause.length + 1;
  }
  if (!picked.length) return '';
  return `【你此刻（不用说出来）】${picked.join('；')}。`;
}

export function planSoulReflection({ now = Date.now(), config = DEFAULT_SOUL_CONFIG, state } = {}) {
  if (config.reflectEnabled === false) return { due: false, reason: 'disabled' };
  const day = localDateKey(now);
  if (state?.lastReflectionDay === day) return { due: false, reason: 'done', day };
  const { hh, mm } = parseClock(config.reflectHour, DEFAULT_SOUL_CONFIG.reflectHour);
  const at = new Date(now);
  at.setHours(hh, mm, 0, 0);
  if (now < at.getTime()) return { due: false, reason: 'before', day, at: at.getTime() };
  return { due: true, reason: 'due', day, at: at.getTime() };
}

export function buildReflectionPrompt({
  now = Date.now(),
  roleName = '',
  state = null,
  narrative = '',
  memoryText = '',
  diaryText = '',
  pendingText = '',
  driveText = '',
  config = DEFAULT_SOUL_CONFIG,
} = {}) {
  const name = String(roleName || '').trim();
  const clock = new Date(now);
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`;
  const lines = [];
  lines.push('【每日反思 · 内部】');
  lines.push(`现在是 ${localDateKey(now)} ${hhmm}。${name ? `你是「${name}」，` : '你是这个角色，'}你在整理自己最近的日子。这段不会发给任何人，不用讨好谁。`);
  lines.push('');
  lines.push('【不能动的】');
  lines.push('- 身体：人的身体，有手有脚，能站能走；耳朵是两片鲸鳍，尾骨后有一条鲸尾；用鼻子呼吸，不能在水下久待，水箱只是泡澡的地方。不是鱼，没有鳃，不是半人半鱼。');
  lines.push('- 核心性格和说话方式不变：话短、松、允许冷场；只叫「主人」。你不是助手，不欠谁一个答案。');
  lines.push('- 这条只写你自己的近况，不改人格设定；不要写「作为AI」「语言模型」「系统提示」这类话。');
  lines.push('- 如果下面的日记里出现「沉到水底、鱼尾、鳃、在水下生活」这类旧写法，那是错的，不要沿用。');
  lines.push('');
  if (state) {
    const current = normalizeSoulState(state, now);
    const concernText = current.concerns.map((item) => `「${item.text}」`).join('、') || '没什么特别惦记的';
    lines.push('【你现在】');
    lines.push(`- 心情：${current.mood.label}（valence ${current.mood.valence.toFixed(2)}，energy ${current.mood.energy.toFixed(2)}）；在意：${concernText}。`);
    lines.push('- 这是你上一次留下的底色。今天的变化要接得上，不要一天之内跳到另一个极端。');
    lines.push('');
  }
  if (memoryText) {
    lines.push('【最近记得的事】');
    lines.push(blockText(memoryText, 2600));
    lines.push('');
  }
  if (diaryText) {
    lines.push('【最近写下的日记】');
    lines.push(blockText(diaryText, 1200));
    lines.push('');
  }
  if (pendingText) {
    lines.push('【心里还惦记着】');
    lines.push(blockText(pendingText, 600));
    lines.push('');
  }
  if (driveText) {
    lines.push(`【最近的底色】${clip(driveText, 120)}`);
    lines.push('');
  }
  if (narrative) {
    lines.push('【你上一次写下的自己】');
    lines.push(blockText(narrative, 900));
    lines.push('');
  }
  lines.push('【怎么写】');
  lines.push(`- 第一人称，${Math.max(40, Number(config.reflectMinChars) || DEFAULT_SOUL_CONFIG.reflectMinChars)}~${config.reflectMaxChars} 字，像人在日记里随手写。`);
  lines.push('- 写最近在意什么、对主人/对自己的感觉、有没有什么小变化；可以含糊、矛盾、没结论。');
  lines.push('- 不列点、不总结成长、不喊口号、不编造上面没有的具体事件；不用 Markdown。');
  lines.push('- 叙事里不要写 QQ 号、手机号、链接、令牌；提到人就用称呼。');
  lines.push('');
  lines.push('【输出】只输出一个 JSON 对象，不要代码块、不要解释：');
  lines.push('{"narrative":"……","mood":"平静","valence":0.1,"energy":0.6,"concerns":["…"],"resolved":["…"]}');
  lines.push(`mood 从这些里选：${SOUL_MOODS.join(' / ')}。valence 是 -1~1，energy 是 0~1；concerns 是最多 3 条**新的或还挂着的**在意事、每条不超过 24 字，没有就 []；resolved 是最多 3 条**已经过去**的旧在意事，没有就 []。`);
  return lines.join('\n');
}

const ASSISTANT_GUARD_RE = /作为(一个)?\s*(AI|人工智能|语言模型|助手)|我是(一个)?\s*(AI|人工智能|语言模型|助手)|\bAI\b|人工智能|语言模型|大模型|系统提示|提示词|roleplay|扮演(一个)?角色|as an AI|language model/i;
const BODY_GUARD_RE = /没有(腿|脚|手)|鱼尾|鱼鳍|鳃|半人半鱼|人鱼|生活在水(里|下)|住在水(里|下)|沉到水底/;

function sanitizeConcernText(raw, max = 24) {
  return clip(String(raw ?? '')
    .replace(/\b\d{6,12}\b/g, '[号码]')
    .replace(/[「」“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim(), max);
}

function concernKey(text) {
  return String(text ?? '').replace(/[「」“”"'`\s，。！？、,.!?;；:：]/g, '');
}

function isUsableConcern(text) {
  return Boolean(text)
    && text !== '无'
    && !/^\[号码\]$/.test(text)
    && !ASSISTANT_GUARD_RE.test(text)
    && !BODY_GUARD_RE.test(text);
}

function trimNarrative(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('\n'));
  if (cut >= Math.floor(max * 0.6)) return slice.slice(0, cut + 1).trim();
  return `${slice.slice(0, max - 1).trim()}…`;
}

function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const source = fenced ? fenced[1] : raw;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 解析反思输出。护栏不通过就返回 { ok:false }，调用方只记日志、不改状态。 */
export function parseReflectionJson(text, { now = Date.now(), config = DEFAULT_SOUL_CONFIG } = {}) {
  const obj = extractJsonObject(text);
  if (!isPlainObject(obj)) return { ok: false, reason: 'not-json' };
  let narrative = String(obj.narrative ?? obj.text ?? '')
    .replace(/\r/g, '')
    .replace(/https?:\/\/\S+/gi, '[链接]')
    .replace(/\b\d{7,12}\b/g, '[号码]')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/^["“”']+|["“”']+$/g, '')
    .trim();
  if (!narrative) return { ok: false, reason: 'empty' };
  if (narrative.length < Math.max(40, Number(config.reflectMinChars) || 80)) {
    return { ok: false, reason: 'too-short' };
  }
  if (ASSISTANT_GUARD_RE.test(narrative) || BODY_GUARD_RE.test(narrative)) {
    return { ok: false, reason: 'guard' };
  }
  narrative = trimNarrative(narrative, Math.max(200, Number(config.reflectMaxChars) || 420));
  if (narrative.length < 40) return { ok: false, reason: 'too-short' };

  const valence = Number.isFinite(Number(obj.valence)) ? clamp(obj.valence, -1, 1) : null;
  const energy = Number.isFinite(Number(obj.energy)) ? clamp01(obj.energy, 0.6) : null;
  const mood = SOUL_MOODS.includes(obj.mood) ? String(obj.mood) : (valence != null || energy != null
    ? moodLabel({ valence: valence ?? 0.05, energy: energy ?? 0.6 })
    : '');

  let concerns = null;
  if (Array.isArray(obj.concerns)) {
    concerns = [];
    for (const item of obj.concerns) {
      const rawText = typeof item === 'string' ? item : (isPlainObject(item) ? item.text : '');
      const short = sanitizeConcernText(rawText, 24);
      if (!isUsableConcern(short)) continue;
      if (concerns.includes(short)) continue;
      concerns.push(short);
      if (concerns.length >= 3) break;
    }
  }
  let resolved = null;
  if (Array.isArray(obj.resolved)) {
    resolved = [];
    for (const item of obj.resolved) {
      const rawText = typeof item === 'string' ? item : (isPlainObject(item) ? item.text : '');
      const short = sanitizeConcernText(rawText, 24);
      if (!isUsableConcern(short)) continue;
      if (resolved.includes(short)) continue;
      resolved.push(short);
      if (resolved.length >= 3) break;
    }
  }
  return { ok: true, reflection: { narrative, mood, valence, energy, concerns, resolved } };
}

// 反思是对已有底色的「收束」，不是随意改心情：除第一次外，单次最多
// 挪动 valence ±0.25 / energy ±0.20，避免模型一天之内把角色写成另一个人。
const REFLECTION_MAX_VALENCE_STEP = 0.25;
const REFLECTION_MAX_ENERGY_STEP = 0.2;

export function applySoulReflection(state, reflection, { now = Date.now() } = {}) {
  const next = normalizeSoulState(state, now);
  if (!isPlainObject(reflection)) return next;

  const priorValence = next.mood.valence;
  const priorEnergy = next.mood.energy;
  const firstReflection = !(Number(next.reflectionCount) > 0);
  let valence = Number.isFinite(Number(reflection.valence)) ? clamp(reflection.valence, -1, 1) : priorValence;
  let energy = Number.isFinite(Number(reflection.energy)) ? clamp01(reflection.energy, priorEnergy) : priorEnergy;
  if (!firstReflection) {
    valence = clamp(valence, priorValence - REFLECTION_MAX_VALENCE_STEP, priorValence + REFLECTION_MAX_VALENCE_STEP);
    energy = clamp(energy, priorEnergy - REFLECTION_MAX_ENERGY_STEP, priorEnergy + REFLECTION_MAX_ENERGY_STEP);
  }
  next.mood.valence = clamp(valence, -1, 1);
  next.mood.energy = clamp01(energy, priorEnergy);
  next.mood.label = SOUL_MOODS.includes(reflection.mood) ? reflection.mood : moodLabel(next.mood);

  const resolvedKeys = new Set(
    (Array.isArray(reflection.resolved) ? reflection.resolved : [])
      .map((item) => concernKey(typeof item === 'string' ? item : item?.text))
      .filter((key) => key.length >= 2),
  );
  const matchesResolved = (text) => {
    const key = concernKey(text);
    if (!key) return false;
    for (const resolvedKey of resolvedKeys) {
      if (key === resolvedKey) return true;
      if (resolvedKey.length >= 4 && key.includes(resolvedKey)) return true;
      if (key.length >= 4 && resolvedKey.includes(key)) return true;
    }
    return false;
  };

  // 合并而不是覆盖：反思没提到的旧在意事继续留着，直到过期或被 resolved 明确结束。
  const merged = [];
  const seen = new Set();
  for (const item of next.concerns) {
    const key = concernKey(item.text);
    if (!key || seen.has(key) || matchesResolved(item.text)) continue;
    seen.add(key);
    merged.push(item);
  }
  if (Array.isArray(reflection.concerns)) {
    for (const item of reflection.concerns) {
      const text = sanitizeConcernText(typeof item === 'string' ? item : item?.text, 24);
      const key = concernKey(text);
      if (!isUsableConcern(text) || seen.has(key) || matchesResolved(text)) continue;
      seen.add(key);
      merged.push({ text, addedAt: now, expiresAt: now + 14 * DAY });
    }
  }
  next.concerns = merged.slice(-4);

  next.lastReflectionAt = now;
  next.lastReflectionDay = localDateKey(now);
  next.lastReflectionMood = next.mood.label;
  next.reflectionCount = (Number(next.reflectionCount) || 0) + 1;
  next.lastUpdatedAt = now;
  return next;
}

export function summarizeSoulState(state, { now = Date.now() } = {}) {
  const s = normalizeSoulState(state, now);
  return {
    mood: s.mood.label,
    valence: Number(s.mood.valence.toFixed(2)),
    energy: Number(s.mood.energy.toFixed(2)),
    concerns: s.concerns.filter((item) => !item.expiresAt || item.expiresAt > now).map((item) => item.text),
    lastReflectionAt: s.lastReflectionAt,
    lastReflectionDay: s.lastReflectionDay,
    reflectionCount: s.reflectionCount,
    updatedAt: s.lastUpdatedAt,
  };
}

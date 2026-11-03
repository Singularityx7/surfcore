// 角色灵魂（src/soul.js）的离线单测。
// 覆盖：配置归一化 / 状态归一化 / 精力漂移 / 情绪只结算一次 / 唤醒块 / 每日反思排程 / 反思 JSON 护栏。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applySoulReflection, buildReflectionPrompt, createSoulState, DEFAULT_SOUL_CONFIG,
  deriveSoulState, moodLabel, normalizeSoulConfig, normalizeSoulState,
  parseReflectionJson, planSoulReflection, renderSoulBlock, summarizeSoulState,
} from '../src/soul.js';

const AT_10 = new Date(2026, 9, 30, 10, 0, 0, 0).getTime();
const AT_03 = new Date(2026, 9, 30, 3, 0, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

test('配置：坏值收敛，反思时段回退默认', () => {
  const cfg = normalizeSoulConfig({
    reflectHour: '25:99', stateMaxChars: 9999, reflectMinChars: 500,
    reflectMaxChars: 10, reflectRetryMs: 1,
  });
  assert.equal(cfg.reflectHour, '03:40');
  assert.equal(cfg.stateMaxChars, 240);
  assert.ok(cfg.reflectMinChars <= 200);
  assert.ok(cfg.reflectMaxChars >= cfg.reflectMinChars + 40);
  assert.equal(cfg.reflectRetryMs, 10 * 60 * 1000);
  assert.equal(normalizeSoulConfig({ enabled: false }).enabled, false);
  assert.equal(DEFAULT_SOUL_CONFIG.reflectEnabled, true);
  assert.equal(DEFAULT_SOUL_CONFIG.reflectPreset, 'soul-reflect');
  assert.equal(normalizeSoulConfig({}).reflectPreset, 'soul-reflect');
  assert.equal(normalizeSoulConfig({ reflectPreset: 'custom-reflect' }).reflectPreset, 'custom-reflect');
});

test('状态：坏值回默认，过期/重复的在意事被清掉', () => {
  const now = AT_10;
  const state = normalizeSoulState({
    mood: { label: '不存在', valence: 9, energy: -3 },
    concerns: [
      { text: '主人面试', addedAt: now - HOUR, expiresAt: now + HOUR },
      { text: '旧事', addedAt: now - 30 * 24 * HOUR, expiresAt: now - HOUR },
      { text: '主人面试', addedAt: now - HOUR, expiresAt: now + HOUR },
      '无',
    ],
    lastReflectionDay: '2026-10-29',
    reflectionCount: -5,
  }, now);
  assert.equal(state.mood.valence, 1);
  assert.equal(state.mood.energy, 0);
  assert.ok(['累', '低落', '有点烦', '发呆'].includes(state.mood.label));
  assert.deepEqual(state.concerns.map((c) => c.text), ['主人面试']);
  assert.equal(state.reflectionCount, 0);
});

test('精力：随时间回到这个点该有的水平', () => {
  const now = AT_10;
  const tired = { ...createSoulState(now), mood: { label: '累', valence: 0.05, energy: 0.1 }, lastUpdatedAt: now - 6 * HOUR };
  const derived = deriveSoulState({ state: tired, now, drives: { connect: 0.2 } });
  assert.ok(derived.mood.energy > 0.5, `6 小时后精力应回升，实际 ${derived.mood.energy}`);
  assert.ok(derived.mood.energy < 0.9);
  assert.equal(derived.lastUpdatedAt, now);
});

test('情绪：同一次主动发言只结算一次', () => {
  const now = AT_10;
  const base = { ...createSoulState(now), mood: { label: '平静', valence: 0.1, energy: 0.8 }, lastUpdatedAt: now - HOUR };
  const once = deriveSoulState({ state: base, now, lastSentAt: now - 30 * 60 * 1000, lastEmotion: 'lonely' });
  assert.ok(once.mood.valence < 0.1);
  const twice = deriveSoulState({ state: once, now: now + 10 * 60 * 1000, lastSentAt: now - 30 * 60 * 1000, lastEmotion: 'lonely' });
  assert.equal(twice.lastEmotionAt, once.lastEmotionAt);
  assert.ok(Math.abs(twice.mood.valence - once.mood.valence) < 0.02);
});

test('社交信号：主人来私聊只轻抬一次，不按消息条数累加', () => {
  const now = AT_10;
  const base = {
    ...createSoulState(now),
    mood: { label: '平静', valence: 0.1, energy: 0.8 },
    lastUpdatedAt: now - 10 * 60 * 1000,
    lastSocialAt: now - 2 * HOUR,
  };
  const once = deriveSoulState({ state: base, now, lastSocialAt: now - 5 * 60 * 1000 });
  assert.ok(once.mood.valence > base.mood.valence, '主人来私聊应轻抬心情');
  assert.equal(once.lastSocialAt, now - 5 * 60 * 1000);

  const twice = deriveSoulState({ state: once, now: now + 10 * 60 * 1000, lastSocialAt: now - 5 * 60 * 1000 });
  assert.ok(Math.abs(twice.mood.valence - once.mood.valence) < 0.01, '同一条消息不能反复结算');

  const close = deriveSoulState({ state: once, now: now + 10 * 60 * 1000, lastSocialAt: now });
  assert.equal(close.lastSocialAt, now);
  assert.ok(Math.abs(close.mood.valence - once.mood.valence) < 0.02, '30 分钟内连续来消息只推进水位，不再累加');
});

test('唤醒块：平常不注入；累/惦记/想人时最多两句', () => {
  const neutral = { ...createSoulState(AT_10), mood: { label: '平静', valence: 0.05, energy: 0.85 } };
  assert.equal(renderSoulBlock(neutral, { now: AT_10, drives: { connect: 0.2 } }), '');

  const low = {
    ...createSoulState(AT_03),
    mood: { label: '累', valence: -0.5, energy: 0.12 },
    concerns: [{ text: '主人面试', addedAt: AT_03, expiresAt: AT_03 + 24 * HOUR }],
  };
  const block = renderSoulBlock(low, { now: AT_03, drives: { connect: 0.3 }, maxChars: 120 });
  assert.match(block, /^【你此刻（不用说出来）】/);
  assert.match(block, /主人面试/);
  assert.ok(block.length <= 120);

  const missing = {
    ...createSoulState(AT_10),
    mood: { label: '平静', valence: 0.05, energy: 0.8 },
  };
  const missBlock = renderSoulBlock(missing, { now: AT_10, drives: { connect: 0.8 }, lastOwnerAt: AT_10 - 20 * HOUR });
  assert.match(missBlock, /想主人|找主人/);
});

test('反思排程：到点前不跑，跑过当天不再跑', () => {
  const cfg = normalizeSoulConfig({ reflectHour: '03:40' });
  const at0300 = new Date(2026, 9, 30, 3, 0, 0, 0).getTime();
  const at0400 = new Date(2026, 9, 30, 4, 0, 0, 0).getTime();
  const state = createSoulState(at0300);
  assert.equal(planSoulReflection({ now: at0300, config: cfg, state }).due, false);
  assert.equal(planSoulReflection({ now: at0400, config: cfg, state }).due, true);
  const done = { ...state, lastReflectionDay: '2026-10-30' };
  assert.equal(planSoulReflection({ now: at0400, config: cfg, state: done }).due, false);
  assert.equal(planSoulReflection({ now: at0400, config: normalizeSoulConfig({ reflectEnabled: false }), state }).due, false);
});

test('反思解析：代码块 JSON、长度、护栏、号码与条数', () => {
  const cfg = normalizeSoulConfig({});
  const longNarrative = `${'今天没什么大事，就是有点累。'.repeat(40)}`;
  const ok = parseReflectionJson(`\`\`\`json\n${JSON.stringify({
    narrative: longNarrative,
    mood: '累',
    valence: -0.2,
    energy: 0.35,
    concerns: ['主人明天面试', '123456789', '无', '主人明天面试', '想早点睡'],
  })}\n\`\`\``, { now: AT_03, config: cfg });
  assert.equal(ok.ok, true);
  assert.ok(ok.reflection.narrative.length <= cfg.reflectMaxChars);
  assert.equal(ok.reflection.mood, '累');
  assert.deepEqual(ok.reflection.concerns, ['主人明天面试', '想早点睡']);

  assert.equal(parseReflectionJson('这不是 JSON', { now: AT_03, config: cfg }).reason, 'not-json');
  assert.equal(parseReflectionJson(JSON.stringify({ narrative: '太短' }), { now: AT_03, config: cfg }).reason, 'too-short');
  assert.equal(parseReflectionJson(JSON.stringify({ narrative: `${'作为AI，我没有腿。'.repeat(30)}` }), { now: AT_03, config: cfg }).reason, 'guard');
  assert.equal(parseReflectionJson(JSON.stringify({ narrative: `${'今天有点累，想早点睡。'.repeat(20)}我没有腿。` }), { now: AT_03, config: cfg }).reason, 'guard');
  assert.equal(parseReflectionJson(JSON.stringify({ narrative: `${'今天有点累，想早点睡。'.repeat(20)}AI味有点重。` }), { now: AT_03, config: cfg }).reason, 'guard');

  const redacted = parseReflectionJson(JSON.stringify({
    narrative: `${'今天有点累，想早点睡。'.repeat(20)}有个群友留了 123456789 这个号。`,
    resolved: ['主人面试', '123456789', '无'],
  }), { now: AT_03, config: cfg });
  assert.equal(redacted.ok, true);
  assert.ok(redacted.reflection.narrative.includes('[号码]'), '叙事里的长数字应脱敏');
  assert.ok(!redacted.reflection.narrative.includes('123456789'));
  assert.deepEqual(redacted.reflection.resolved, ['主人面试']);
});

test('反思落地：更新心情/在意的事/当天标记', () => {
  const now = AT_03;
  const before = createSoulState(now);
  const after = applySoulReflection(before, {
    narrative: '写给自己看的一段话。',
    mood: '低落',
    valence: -0.4,
    energy: 0.3,
    concerns: ['主人面试'],
  }, { now });
  assert.equal(after.mood.label, '低落');
  assert.equal(after.mood.valence, -0.4);
  assert.equal(after.mood.energy, 0.3);
  assert.equal(after.concerns[0].text, '主人面试');
  assert.equal(after.lastReflectionDay, '2026-10-30');
  assert.equal(after.reflectionCount, 1);
  assert.equal(summarizeSoulState(after, { now }).mood, '低落');
});

test('反思落地：合并旧在意事、resolved 了结，不因空数组清空', () => {
  const now = AT_03;
  const before = {
    ...createSoulState(now),
    mood: { label: '平静', valence: 0, energy: 0.5 },
    reflectionCount: 1,
    concerns: [
      { text: '主人面试', addedAt: now - 2 * HOUR, expiresAt: now + 24 * HOUR },
      { text: '想早点睡', addedAt: now - HOUR, expiresAt: now + 24 * HOUR },
    ],
  };
  const after = applySoulReflection(before, {
    mood: '平静',
    valence: 0.1,
    energy: 0.55,
    concerns: ['论文'],
    resolved: ['主人面试'],
  }, { now });
  assert.deepEqual(after.concerns.map((c) => c.text), ['想早点睡', '论文']);
  assert.equal(after.mood.valence, 0.1);
  assert.equal(after.mood.energy, 0.55);

  const kept = applySoulReflection(after, { narrative: '没有新的在意事。' }, { now: now + HOUR });
  assert.deepEqual(kept.concerns.map((c) => c.text), ['想早点睡', '论文'], '没有 concerns 字段时不能清空');

  const cleared = applySoulReflection(kept, { concerns: [], resolved: ['想早点睡'] }, { now: now + 2 * HOUR });
  assert.deepEqual(cleared.concerns.map((c) => c.text), ['论文'], '空 concerns 只表示没有新增，不等于清空');
});

test('反思落地：第二次起限制单日心情/精力跳变', () => {
  const now = AT_03;
  const before = {
    ...createSoulState(now),
    mood: { label: '平静', valence: 0.1, energy: 0.55 },
    reflectionCount: 2,
  };
  const after = applySoulReflection(before, { mood: '兴奋', valence: 0.9, energy: 1 }, { now });
  assert.ok(Math.abs(after.mood.valence - 0.35) < 1e-9);
  assert.ok(Math.abs(after.mood.energy - 0.75) < 1e-9);
  assert.equal(after.mood.label, '兴奋');

  const down = applySoulReflection(before, { valence: -0.9, energy: 0 }, { now });
  assert.ok(Math.abs(down.mood.valence - -0.15) < 1e-9);
  assert.ok(Math.abs(down.mood.energy - 0.35) < 1e-9);
});

test('反思提示词：身体边界、当前状态锚点与素材截断', () => {
  const cfg = normalizeSoulConfig({});
  const state = {
    ...createSoulState(AT_03),
    mood: { label: '有点烦', valence: -0.3, energy: 0.45 },
    concerns: [{ text: '主人面试', addedAt: AT_03, expiresAt: AT_03 + 24 * HOUR }],
  };
  const prompt = buildReflectionPrompt({
    now: AT_03,
    roleName: '大肥鱼',
    state,
    narrative: '上次写的话。',
    memoryText: '记忆'.repeat(5000),
    diaryText: '日记'.repeat(2000),
    pendingText: '- 惦记的事',
    driveText: '最近比较想要：陪、玩',
    config: cfg,
  });
  assert.match(prompt, /不是鱼，没有鳃/);
  assert.match(prompt, /有手有脚/);
  assert.match(prompt, /不要写「作为AI」/);
  assert.match(prompt, /大肥鱼/);
  assert.match(prompt, /只输出一个 JSON 对象/);
  assert.match(prompt, /【你现在】/);
  assert.match(prompt, /有点烦/);
  assert.match(prompt, /主人面试/);
  assert.match(prompt, /不要一天之内跳到另一个极端/);
  assert.match(prompt, /"resolved":\[/);
  assert.ok(prompt.includes(`${cfg.reflectMinChars}~${cfg.reflectMaxChars} 字`), '提示词的最小字数应与配置一致');
  assert.ok(prompt.length < 9000);
});

test('心情标签：极端值有明确归属', () => {
  assert.equal(moodLabel({ valence: -0.6, energy: 0.7 }), '低落');
  assert.equal(moodLabel({ valence: 0.6, energy: 0.8 }), '松快');
  assert.equal(moodLabel({ valence: 0.05, energy: 0.15 }), '累');
});

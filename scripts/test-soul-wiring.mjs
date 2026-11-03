// 灵魂状态「接线」回归：核心模块单测通过，不代表桥接真的用上了它。
// 静态断言关键接线 + 用真实 bridge.js（VM fixture）验证唤醒注入确实出现/消失。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const bridge = read('src/bridge.js');
const character = read('src/character-persona.js');
const configExample = read('config.example.json');
const pkg = JSON.parse(read('package.json'));
const soulPreset = read('dsh/agent-presets/soul-reflect/agent.cordis.yml');
const bundlePkg = JSON.parse(read('plugins/surfcore/package.json'));

// 1) 模块与配置：灵魂层接进桥接，默认配置可从 config.json 覆盖。
assert.match(bridge, /from '\.\/soul\.js'/, '桥接没有引入 soul 模块');
assert.match(bridge, /normalizeSoulConfig/, '桥接没有归一化 soul 配置');
assert.match(bridge, /cfg\.soul\s*=/, 'cfg 上没有挂 soul 配置');

// 2) 状态与叙事跟随当前角色；没有角色时回退 state/soul。
assert.match(character, /soulDir:\s*path\.join\(dir, 'soul'\)/, '角色路径缺少 soul 目录');
assert.match(character, /soulState:\s*path\.join\(dir, 'soul', 'state\.json'\)/, '角色路径缺少 soul/state.json');
assert.match(character, /soulNarrative:\s*path\.join\(dir, 'soul', 'narrative\.md'\)/, '角色路径缺少 soul/narrative.md');
assert.match(character, /soulChangelog/, '角色路径缺少 soul/changelog.jsonl');
assert.match(bridge, /characterPaths\(cur\.id\)\.soulDir/, '桥接没有把灵魂状态放进角色目录');
assert.match(bridge, /path\.join\(STATE_DIR, 'soul'\)/, '桥接缺少无角色时的 state/soul 回退');

// 3) 快照/回档要带上灵魂文件；changelog 是追加历史，不进快照。
assert.match(character, /for \(const file of \['state\.json', 'narrative\.md', 'narrative\.prev\.md'\]\) \{\s*copyFile\(path\.join\(paths\.soulDir, file\)/, '快照没有带灵魂文件');
assert.match(character, /for \(const file of \['state\.json', 'narrative\.md', 'narrative\.prev\.md'\]\) \{\s*copyFile\(path\.join\(source, 'soul', file\)/, '回档没有恢复灵魂文件');

// 4) 调度：DSH 就绪后启动；状态更新 + 每日反思都在循环里。
assert.match(bridge, /function startSoulLoop\(/, '桥接缺少灵魂循环');
assert.match(bridge, /function soulTick\(/, '桥接缺少灵魂 tick');
assert.match(bridge, /function runSoulReflection\(/, '桥接缺少每日反思');
assert.match(bridge, /planSoulReflection\(/, '灵魂 tick 没有判断反思是否到点');
assert.match(bridge, /deriveSoulState\(/, '灵魂 tick 没有随时间漂移心情/精力');
assert.match(bridge, /startSoulLoop\(\)/, 'DSH 就绪后没有启动灵魂循环');

// 5) 注入：唤醒只加一行状态块；目的是把自我叙事当动机先验。
assert.match(bridge, /const soulLine = soulWakeBlock\(key, st\)/, 'v2 唤醒没有取灵魂状态块');
assert.match(bridge, /memoryCardLine \+ soulLine/, 'v2 唤醒没有拼上灵魂状态块');
assert.match(bridge, /function soulWakeBlock\(key, st\)/, '桥接缺少灵魂状态块函数');
assert.match(bridge, /readSoulNarrative\(\)[\s\S]{0,800}【你最近的样子（自己写的，不是设定）】/, '目的提示词没有注入自我叙事');
assert.match(bridge, /narrativeInPurpose/, '目的提示词缺少叙事开关');

// 6) 内部反思会话：复用 learner 通道，token 归到「内部:灵魂反思」，不被清理误删。
assert.match(bridge, /internal:灵魂反思/, 'token 账本没有灵魂反思归属');
assert.match(bridge, /ensureSoulReflectSession/, '桥接缺少反思会话管理');
assert.match(bridge, /frame\.sessionId !== soulReflectSessionId/, '事件泵会误删反思会话');
// 会话 id 跟着角色走：换角色后不能复用旧角色的人格/上下文。
assert.match(bridge, /session: path\.join\(dir, 'session\.json'\)/, '灵魂路径缺少按角色隔离的 session.json');
assert.match(bridge, /readJsonSafe\(SOUL_PATHS\.session/, '反思会话没有从角色目录读取');
assert.match(bridge, /characterId: currentCharacterId/, '反思会话没有记录角色 id');
assert.match(bridge, /saved\?\.characterId !== currentCharacterId/, '反思会话没有校验角色是否变化');
assert.match(bridge, /api\.events\.forget\?\.\(oldId\)/, '反思会话退役没有退订事件流');
// 反思用专用预设：不挂 QQ 工具，避免继承群聊协议与「AI 味」措辞。
assert.match(bridge, /resolvePresetName\(cfg\.soul\?\.reflectPreset \|\| 'soul-reflect'/, '反思没有默认用专用 preset');
assert.match(soulPreset, /soul-reflect-guard/, 'soul-reflect preset 缺少全拒守卫');
assert.doesNotMatch(soulPreset, /mcp__snowluma__|mcp__web-search-safe__/, 'soul-reflect preset 不应挂 QQ/联网 MCP');
assert.doesNotMatch(soulPreset, /id:\s*tool-web|id:\s*tool-ask-user|id:\s*tool-todo/, 'soul-reflect preset 不应挂工具行');
assert.ok(bundlePkg.dsh?.bundle?.patch?.includes('./presets/soul-reflect.patch.yml'), 'bundle 没有声明 soul-reflect patch');
// 反思提示词必须带上当前状态锚点，否则模型可以一天写成另一个人。
assert.match(bridge, /buildReflectionPrompt\(\{[\s\S]{0,200}state: soulState/, '反思提示词没有带当前状态');
assert.match(bridge, /lastSocialAt: lastOwnerAt/, '灵魂 tick 没有把主人私聊作为社交信号');
assert.match(bridge, /function invalidateSlangLearnerSession\(\)[\s\S]{0,400}api\.events\.forget\?\.\(oldId\)/, '黑话学习会话退役没有退订事件流');

// 7) 控制台：状态查询 + 手动触发反思。
assert.match(bridge, /\/api\/soul\/status/, '桥接缺少 /api/soul/status');
assert.match(bridge, /\/api\/soul\/reflect/, '桥接缺少 /api/soul/reflect');
assert.match(bridge, /summarizeSoulState\(soulState\)/, '控制台状态没有灵魂摘要');

// 8) 默认配置与测试脚本。
const example = JSON.parse(configExample);
assert.equal(example.soul?.enabled, true, 'config.example.json 缺少 soul 默认配置');
assert.equal(example.soul?.stateInPrompt, true, 'config.example.json 缺少状态注入开关');
assert.ok(example.soul?.reflectHour, 'config.example.json 缺少反思时间');
assert.equal(example.soul?.reflectPreset, 'soul-reflect', 'config.example.json 缺少专用反思 preset');
assert.equal(pkg.scripts?.['test:soul'], 'node scripts/test-soul.mjs', 'package.json 缺少 test:soul');
assert.equal(pkg.scripts?.['test:soul-wiring'], 'node scripts/test-soul-wiring.mjs', 'package.json 缺少 test:soul-wiring');

// 9) 真实 bridge.js（VM fixture）：读到状态就注入，没状态就不占 token；叙事能读。
const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
const soulState = {
  mood: { valence: -0.6, energy: 0.8 },
  concerns: [{ text: '主人明天面试', addedAt: Date.now() }],
};
const harness = await bridgeHarness({
  config: { ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } },
  files: {
    'state/soul/state.json': soulState,
    'state/soul/narrative.md': '这几天我话少了点，但心里一直记着主人面试的事。\n',
  },
});
try {
  assert.match(harness.readSoulNarrative(), /主人面试/, '桥接没有读到灵魂叙事');
  const wake = harness.buildWakePromptV2('private:123', 'question');
  assert.match(wake, /【你此刻（不用说出来）】/, 'v2 唤醒没有注入灵魂状态块');
  assert.match(wake, /主人明天面试/, '灵魂状态块没有带出在意的事');
  assert.equal(harness.soulWakeBlock('group:456', harness.getSocialV2State('group:456')), '', '群聊不应注入私下的灵魂状态');
  assert.equal(harness.buildWakePromptV2('group:456', 'question').includes('【你此刻'), false, '群聊唤醒不应出现灵魂状态块');
  harness.cfg.soul.stateInPrompt = false;
  assert.equal(harness.soulWakeBlock('private:123', harness.getSocialV2State('private:123')), '', '关掉注入开关后仍注入');
  harness.cfg.soul.stateInPrompt = true;
  harness.cfg.soul.enabled = false;
  assert.equal(harness.soulWakeBlock('private:123', harness.getSocialV2State('private:123')), '', '关掉总开关后仍注入');
} finally {
  await harness.close();
}

// 10) 平静状态不注入：省 token 是设计目标，不能退化成每轮一句空话。
const calm = await bridgeHarness({
  config: { ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } },
  files: { 'state/soul/state.json': { mood: { valence: 0.05, energy: 0.6 }, concerns: [] } },
});
try {
  assert.equal(calm.soulWakeBlock('private:123', calm.getSocialV2State('private:123')), '', '平静状态不应注入');
  assert.equal(calm.buildWakePromptV2('private:123', 'question').includes('【你此刻'), false, '平静唤醒不应出现状态块');
} finally {
  await calm.close();
}

console.log('soul wiring: OK');

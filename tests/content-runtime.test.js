import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONTENT } from '../src/content/index.js';
import { compileContentGraph, ContentValidationError, formatDescription, evaluateCondition } from '../src/systems/content-registry.js';
import { computeDerived } from '../src/systems/derived.js';
import { createGameRuntime } from '../src/systems/runtime.js';
import { createSaveAdapter, createMemoryStorage, SAVE_KEY } from '../src/systems/persistence.js';
import { createSaveState, migrateAndNormalizeState, stateHash } from '../src/systems/state.js';
import { gemsForRunCoins, reincarnationRequirement } from '../src/systems/progression.js';
import { formatNumber } from '../src/core/number.js';
import { createTrustedTime } from '../src/core/trusted-time.js';
import { decodeSave, encodeSave } from '../src/systems/save-integrity.js';
import { verifyDeveloperPassword } from '../src/systems/developer-access.js';
import { createRngState, nextInt, nextDouble, nextIntRange, nextDoubleRange, randRange, drawRandom } from '../src/core/rng.js';
import { BUILDING_UPGRADE_DATA } from '../src/content/definitions/building-upgrades-data.js';
import { evaluateFormula } from '../src/systems/formula.js';

function fixture(initial = null, { failSave = false, nowStart = 1000, content = CONTENT, seed = 0x6d2b79f5, timeVerified = false, mode = 'development' } = {}) {
  let now = nowStart;
  const storage = createMemoryStorage();
  if (failSave) storage.setItem = () => { throw new Error('quota'); };
  const adapter = createSaveAdapter({ storage });
  if (initial) adapter.save(initial);
  const clock = { wallNow: () => now, monotonicNow: () => now };
  const game = createGameRuntime({ content, saveAdapter: adapter, clock, seed, mode, isTimeVerified: () => timeVerified });
  return { game, storage, adapter, clock, advance: value => { now += value; } };
}
const initial = () => {
  const state = createSaveState({ now: 1000, contentVersions: ['base-v1'] });
  state.resources.coins = 1e12; state.resources.mana = 10000;
  return state;
};
const assertClose = (actual, expected, message = '') => {
  const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} expected ${expected}, got ${actual}`);
};

test('number formatting switches to four-decimal scientific notation at 1000T', () => {
  assert.equal(formatNumber(999e12), '999T');
  assert.equal(formatNumber(1e15), '1.0000e15');
  assert.equal(formatNumber(1.3848e275), '1.3848e275');
  assert.equal(formatNumber(1.23456789e20), '1.2346e20');
  assert.equal(formatNumber(-1.23456789e20), '-1.2346e20');
});

test('content graph contains six playable factions', async () => {
  const { game } = fixture();
  const factions = game.graph.arraysByKind.get('faction');
  assert.deepEqual(factions.map(item => item.id), ['fairy', 'goblin', 'elven', 'angel', 'undead', 'demon']);
  assert.deepEqual(factions.filter(item => item.purchase === null).map(item => item.id), []);
  assert.ok(factions.every(item => item.factionCoin?.enabled));
  assert.equal(game.graph.arraysByKind.get('story').length, 8);
  assert.ok(game.graph.arraysByKind.get('trophy').length >= 8);
  assert.equal(game.graph.arraysByKind.get('building').some(item => item.alignment === 'neutral'), false);
  await game.start();
});

test('facility artwork resolves to 18 bodies and 414 numbered upgrades with identical bodies and gold-to-purple tiers', async () => {
  const buildings = CONTENT.definitions.filter(item => item.kind === 'building');
  const upgrades = CONTENT.definitions.filter(item => item.kind === 'upgrade' && item.ui.category === 'building');
  assert.equal(buildings.length, 18);
  assert.equal(upgrades.length, 414);
  const bodyOf = svg => svg.match(/  <g id="[^"]+-body">[\s\S]*?  <\/g>/)?.[0];
  const mix = (left, right, t) => {
    const a = left.match(/\w\w/g).map(value => parseInt(value, 16));
    const b = right.match(/\w\w/g).map(value => parseInt(value, 16));
    return `#${a.map((value, index) => Math.round(value + (b[index] - value) * t).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  };
  for (const building of buildings) {
    assert.equal(building.ui.icon, `assets/images/content-icons/buildings/${building.id}.svg`);
    const base = await readFile(new URL(`../${building.ui.icon}`, import.meta.url), 'utf8');
    const body = bodyOf(base);
    assert.ok(body, `${building.id} has an identifiable facility body`);
    for (let tier = 1; tier <= 23; tier++) {
      const id = `${building.id}-tier${tier}`;
      const upgrade = upgrades.find(item => item.id === id);
      assert.ok(upgrade, `${id} is defined`);
      assert.equal(upgrade.ui.icon, `assets/images/content-icons/upgrades/${id}.svg`);
      const svg = await readFile(new URL(`../${upgrade.ui.icon}`, import.meta.url), 'utf8');
      assert.equal(bodyOf(svg), body, `${id} preserves the exact facility body`);
      assert.equal(svg.match(/id="upgrade-tier-\d+"/g)?.length, 1, `${id} has one badge`);
      assert.ok(svg.includes(`id="upgrade-tier-${tier}"`), `${id} has the correct tier badge`);
      assert.ok(svg.includes(`<title id="title">${upgrade.name} · 第${tier}段</title>`));
      assert.ok(svg.includes(`<desc id="desc">`), `${id} has a description`);
      assert.doesNotMatch(svg, /<script|<image|<animate|filter=|<linearGradient|<radialGradient|font-family/);
      if (tier >= 4) {
        const badge = svg.match(/  <g id="upgrade-tier-\d+">[\s\S]*?  <\/g>/)[0];
        const colors = [...badge.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(match => match[1]);
        const t = (tier - 3) / 20;
        assert.deepEqual(colors.slice(1, 4), [
          mix('E7CA74', 'A875D8', t), mix('F5E4A8', 'D3B9EF', t), mix('B09552', '74509A', t),
        ], `${id} uses the exact interpolated palette`);
      }
    }
  }
});

test('startup validation aggregates duplicate IDs and unknown actions', () => {
  const duplicate = CONTENT.definitions[0];
  const invalid = { ...CONTENT.definitions.find(item => item.kind === 'trophy'), id: 'invalid.trophy', grants: [{ type: 'notAnAction' }] };
  assert.throws(() => compileContentGraph({ definitions: [...CONTENT.definitions, duplicate, invalid], packs: CONTENT.packs }), error => {
    assert.ok(error instanceof ContentValidationError);
    assert.ok(error.errors.some(item => item.includes('duplicate global ID')));
    assert.ok(error.errors.some(item => item.includes('unknown action')));
    return true;
  });
});

test('start immediately queues prologue and first wage is persistent and idempotent', async () => {
  const { game, storage } = fixture();
  await game.start();
  assert.equal(game.dispatch({ type: 'start' }).ok, true);
  assert.deepEqual(game.select('storyQueue').map(item => item.id), ['intro.onboarding']);
  assert.ok(storage.getItem(SAVE_KEY), 'critical story start saves synchronously');
  assert.equal(game.dispatch({ type: 'story.close', id: 'intro.onboarding' }).ok, true);
  game.dispatch({ type: 'work' });
  assert.deepEqual(game.select('storyQueue').map(item => item.id), ['intro.first_wage']);
  const unlocked = Object.keys(game.select('state').permanentUnlocks);
  game.dispatch({ type: 'work' });
  assert.deepEqual(Object.keys(game.select('state').permanentUnlocks), unlocked);
  assert.equal(game.select('state').stats.total.clicks, 2);
});

test('purchase, faction selection, spell source and timer expiry use one transactional rule set', async () => {
  const { game } = fixture(initial());
  await game.start();
  assert.equal(game.dispatch({ type: 'purchase', id: 'good' }).ok, true);
  assert.equal(game.dispatch({ type: 'purchase', id: 'fairy' }).ok, true);
  assert.equal(game.dispatch({ type: 'purchase', id: 'goblin' }).reason, 'HIDDEN_SYSTEM');
  assert.equal(game.dispatch({ type: 'purchase', id: 'farm', amount: 10 }).ok, true);
  assert.equal(game.dispatch({ type: 'purchase', id: 'fairy-1' }).ok, true);
  assert.equal(game.dispatch({ type: 'cast', id: 'fairyChanting' }).ok, true);
  assert.equal(game.select('state').timers.spells.fairyChanting.dueAt, 10);
  assert.ok(game.select('derived').production > 500000);
  game.tick(10);
  assert.equal(game.select('state').timers.spells.fairyChanting, undefined);
  assert.ok(game.select('derived').production < 500000);
  assert.equal(game.select('state').owned.run['fairy-1'], true);
});

test('rejected purchase is atomic and does not change authoritative hash', async () => {
  const { game } = fixture();
  await game.start();
  const before = game.select('stateHash');
  const result = game.dispatch({ type: 'purchase', id: 'farm' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NEED_RESOURCE');
  assert.equal(game.select('stateHash'), before);
});

test('critical save failure rolls back story, trophy and state changes', async () => {
  const { game } = fixture(null, { failSave: true });
  await game.start();
  const before = game.select('stateHash');
  const result = game.dispatch({ type: 'start' });
  assert.equal(result.ok, false);
  assert.equal(game.select('storyQueue').length, 0);
  assert.deepEqual(game.select('state').permanentUnlocks, {});
  assert.equal(game.select('stateHash'), before);
  assert.equal(game.select('saveStatus').dirty, true);
});

test('same seed, commands and ticks replay to the same hash', async () => {
  const run = async () => {
    const { game } = fixture(initial());
    await game.start();
    game.dispatch({ type: 'start' });
    game.dispatch({ type: 'story.close', id: 'intro.onboarding' });
    for (let index = 0; index < 20; index++) game.dispatch({ type: 'work' });
    game.dispatch({ type: 'purchase', id: 'good' });
    game.dispatch({ type: 'purchase', id: 'fairy' });
    for (let index = 0; index < 10; index++) game.dispatch({ type: 'work' });
    game.tick(0.2); game.tick(0.4);
    return game.select('stateHash');
  };
  assert.equal(await run(), await run());
});

test('schema 3 migration preserves supported progress and quarantines removed content', () => {
  const graph = compileContentGraph(CONTENT);
  const old = {
    schemaVersion: 3, coins: 1000, gems: 2, mana: 50,
    buildings: { farm: 5, deepMine: 9 }, upgrades: ['fairy-1', 'unknown-upgrade'],
    alignment: 'good', faction: 'fairy', activeSpells: { fairyChanting: 5 },
    trophies: ['trophy.first_click'],
    story: { pending: [], read: ['intro.onboarding'], history: [], intro: { completed: false } },
    stats: { total: { clicks: 10 }, run: { coins: 1000 } },
  };
  const { state, report } = migrateAndNormalizeState(old, graph);
  assert.equal(report.from, 3); assert.equal(report.to, 6);
  assert.equal(state.resources.coins, 1000); assert.equal(state.buildings.farm, 5);
  assert.equal(state.owned.run['fairy-1'], true);
  assert.equal(state.spellSources.fairyChanting.fairy, true);
  assert.equal(state.story.completed['intro.onboarding'], true);
  assert.equal(state.quarantined.unknownIds.deepMine, 9);
  assert.equal(state.quarantined.unknownIds['unknown-upgrade'], true);
});

test('save adapter recovers a valid previous slot without overwriting corrupt raw data', () => {
  const storage = createMemoryStorage();
  const adapter = createSaveAdapter({ storage });
  adapter.save(createSaveState());
  storage.setItem(`${SAVE_KEY}:previous`, JSON.stringify(createSaveState()));
  storage.setItem(SAVE_KEY, '{truncated');
  const loaded = adapter.load();
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.corruptedRaw, '{truncated');
  assert.equal(storage.getItem(`${SAVE_KEY}:corrupt`), '{truncated');
  assert.ok(loaded.raw);
});

test('offline settlement uses event segments rather than 200ms replay', async () => {
  const seeded = initial(); seeded.buildings.farm = 10; seeded.lastWallClock = 0;
  const { game } = fixture(seeded, { nowStart: 20000 });
  await game.start();
  assert.equal(game.select('state').resources.coins, 1e12 + 200);
  assert.equal(game.select('state').stats.total.offlineTime, 20);
});

test('background settlement applies wages mana and all assistant FC in one segment', async () => {
  const seeded = initial();
  seeded.buildings.farm = 10;
  seeded.resources.mana = 0;
  seeded.owned.run['farm-tier1'] = true;
  seeded.owned.run['farm-tier2'] = true;
  const { game } = fixture(seeded);
  await game.start();
  const before = game.select('state').resources.coins;
  const current = game.select('derived');
  const seconds = 8 * 3600;
  const result = game.dispatch({ type: 'background.settle', seconds });
  assert.equal(result.ok, true);
  assert.equal(result.report.segments, 1, 'an idle eight-hour background period needs one calculation');
  assertClose(game.select('state').resources.coins, before + current.production * current.offlineMultiplier * seconds);
  assert.equal(game.select('state').resources.mana, game.select('derived').manaMax);
  assert.equal(game.select('state').stats.run.time, seconds);
  assert.equal(game.select('state').stats.total.offlineTime, seconds);
  const expected = Math.round(current.assistants * current.fcChance * seconds / 100);
  assert.equal(expected, 5760);
  assert.equal(result.report.factionCoinsPending, expected);
  assert.deepEqual(result.report.factionCoinsFound, {});
  assert.equal(game.select('factionCoins').pending, expected);
  assert.equal(game.select('state').stats.total.factionCoins, 0);
  game.tick(0.2);
  assert.equal(game.select('state').stats.total.factionCoins, expected);
  assert.equal(game.select('factionCoins').pending, 0);
  assert.ok(Object.values(game.select('state').resources.factionCoins).every(Number.isInteger));
});

test('offline and background settlement advance time and mana without production', async () => {
  const seeded = createSaveState({ now: 1000, contentVersions: ['base-v1'] });
  const { game } = fixture(seeded);
  await game.start();
  const result = game.dispatch({ type: 'background.settle', seconds: 30 });
  assert.equal(result.ok, true);
  assert.equal(game.select('state').stats.run.time, 30);
  assert.equal(game.select('state').resources.mana, 30);
  assert.equal(game.select('state').resources.coins, 0);

  const closed = createSaveState({ now: 0, contentVersions: ['base-v1'] });
  const reopened = fixture(closed, { nowStart: 5000 });
  await reopened.game.start();
  assert.equal(reopened.game.select('state').stats.run.time, 5, 'short closed sessions are settled too');
  assert.equal(reopened.game.select('state').resources.mana, 5);
});

test('background settlement splits at spell expiry instead of replaying ticks', async () => {
  const seeded = initial();
  seeded.buildings.farm = 10;
  seeded.spellSources.holyLight = { good: true };
  seeded.timers.spells.holyLight = { remaining: 10 };
  const { game } = fixture(seeded);
  await game.start();
  const result = game.dispatch({ type: 'background.settle', seconds: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.report.segments, 2);
  assert.equal(game.select('state').timers.spells.holyLight, undefined);
  assert.equal(game.select('state').stats.run.time, 30);
});

test('abdication uses original gem growth and preserves trophies and prologue', async () => {
  const seeded = initial(); seeded.stats.run.coins = 1e12; seeded.permanentUnlocks['trophy.first_click'] = true;
  const { game } = fixture(seeded);
  await game.start();
  const retired = game.dispatch({ type: 'abdicate' });
  assert.equal(retired.ok, true); assert.equal(retired.result.earned, 1);
  assert.equal(game.select('state').resources.gems, 1);
  assert.deepEqual(game.select('state').buildings, {});
  assert.equal(game.select('state').permanentUnlocks['trophy.first_click'], true);
  assert.deepEqual(game.select('storyQueue').map(item => item.id), ['intro.first_retirement']);
  game.dispatch({ type: 'story.close', id: 'intro.first_retirement' });
  assert.equal(game.select('state').story.groups.prologue, true);
  assert.equal(game.dispatch({ type: 'reincarnate' }).ok, false, 'one gem is not enough for original R1');
});

test('original reincarnation threshold, reset and R1 power apply together', async () => {
  assert.equal(gemsForRunCoins(1e12), 1);
  assert.equal(gemsForRunCoins(3e12), 2);
  assert.equal(reincarnationRequirement(0), 1e27);
  assert.equal(reincarnationRequirement(1), 1e30);
  const seeded = initial(); seeded.resources.gems = 1e27;
  const { game } = fixture(seeded);
  await game.start();
  assert.equal(game.select('reincarnation').visible, true);
  assert.equal(game.dispatch({ type: 'reincarnate' }).ok, true);
  assert.equal(game.select('state').progression.reincarnations, 1);
  assert.equal(game.select('state').progression.ascension, 0);
  assert.equal(game.select('state').resources.gems, 0);
  assert.equal(game.select('reincarnation').visible, false);
  assert.equal(game.select('derived').manaRegen, 3);
  assert.equal(game.select('derived').fcChance, 20, 'R1 grants ten FC chance percentage points');
  assert.equal(game.select('derived').offlineMultiplier, 5.5);
  assert.equal(game.select('reincarnation').requirement, 1e30);
});

test('ordinary tick evaluates no content reactions and reuses derived cache', async () => {
  const { game } = fixture(initial());
  await game.start();
  let message;
  game.subscribe(value => { if (value.commandType === 'tick') message = value; });
  game.tick(0.2);
  assert.equal(message.diagnostics.lastTransaction.rules, 0);
  assert.equal(message.diagnostics.lastTransaction.queueDepth, 0);
});

test('a new trophy requires only a definition to join reactions, selectors and sparse state', async () => {
  const template = CONTENT.definitions.find(item => item.id === 'trophy.first_click');
  const added = {
    ...template, id: 'trophy.content_update', name: '内容包更新', rewardId: 'trophy.content_update',
    description: '新增定义即可解锁。', reactions: [{ event: 'work.clicked', priority: 10 }], effects: [],
  };
  const content = { packs: CONTENT.packs, definitions: [...CONTENT.definitions, added] };
  const adapter = createSaveAdapter({ storage: createMemoryStorage() });
  const game = createGameRuntime({ content, saveAdapter: adapter, clock: { wallNow: () => 1000, monotonicNow: () => 0 } });
  await game.start();
  assert.equal(game.dispatch({ type: 'work' }).ok, true);
  assert.equal(game.select('state').permanentUnlocks[added.id], true);
  assert.equal(game.select('content', { id: added.id }).status, 'OWNED');
});

test('story choices validate, persist and execute declarative actions once', async () => {
  const template = CONTENT.definitions.find(item => item.id === 'intro.onboarding');
  const choiceStory = {
    ...template, id: 'intro.choice_test', title: '选择测试', rewardId: 'intro.choice_test', grants: [],
    reactions: [{ event: 'game.started', priority: 1 }],
    choices: [{ id: 'accept', label: '接受', actions: [{ type: 'grantResource', resource: 'coins', amount: { constant: 5 } }] }],
  };
  const adapter = createSaveAdapter({ storage: createMemoryStorage() });
  const game = createGameRuntime({ content: { packs: CONTENT.packs, definitions: [...CONTENT.definitions, choiceStory] }, saveAdapter: adapter, clock: { wallNow: () => 1000, monotonicNow: () => 0 } });
  await game.start(); game.dispatch({ type: 'start' });
  assert.equal(game.dispatch({ type: 'story.choice', id: choiceStory.id, choiceId: 'accept' }).ok, true);
  assert.equal(game.select('state').resources.coins, 5);
  assert.equal(game.select('state').story.choices[choiceStory.id], 'accept');
  game.dispatch({ type: 'story.close', id: choiceStory.id });
  const coins = game.select('state').resources.coins;
  game.dispatch({ type: 'story.choice', id: choiceStory.id, choiceId: 'accept' });
  assert.equal(game.select('state').resources.coins, coins);
});

test('fivefold reaction content does not add work to an ordinary tick', async () => {
  const trophies = CONTENT.definitions.filter(item => item.kind === 'trophy');
  const copies = Array.from({ length: 4 }, (_, batch) => trophies.map(item => ({
    ...item, id: `${item.id}.stress${batch}`, rewardId: `${item.id}.stress${batch}`,
    reactions: item.reactions.map(reaction => ({ ...reaction })), effects: [],
  }))).flat();
  const { game } = fixture(initial());
  const stress = createGameRuntime({ content: { packs: CONTENT.packs, definitions: [...CONTENT.definitions, ...copies] }, saveAdapter: createSaveAdapter({ storage: createMemoryStorage() }), clock: { wallNow: () => 1000, monotonicNow: () => 0 } });
  await game.start(); await stress.start();
  let message;
  stress.subscribe(value => { if (value.commandType === 'tick') message = value; });
  stress.tick(0.2);
  assert.equal(message.diagnostics.lastTransaction.rules, 0);
  assert.equal(message.diagnostics.lastTransaction.queueDepth, 0);
});

test('aggregate building dependencies invalidate the affected formula group after purchase', async () => {
  const { game } = fixture(initial());
  await game.start();
  game.dispatch({ type: 'purchase', id: 'evil' });
  game.dispatch({ type: 'purchase', id: 'goblin' });
  game.dispatch({ type: 'purchase', id: 'slavePen', amount: 10 });
  game.dispatch({ type: 'purchase', id: 'goblin-2' });
  const before = game.select('derived').outputs.slavePen;
  game.dispatch({ type: 'purchase', id: 'slavePen', amount: 10 });
  const after = game.select('derived').outputs.slavePen;
  assert.ok(after > before * 2, `expected aggregate bonus to increase: ${before} -> ${after}`);
});

test('building selector returns accurate per-second gain for the current bulk purchase', async () => {
  const { game } = fixture(initial());
  await game.start();
  const ten = game.select('content', { id: 'farm', amount: 10 });
  assert.equal(ten.quantity, 10);
  assert.equal(ten.viewModel.purchaseProduction, 20);
  game.dispatch({ type: 'purchase', id: 'farm', amount: 10 });
  const one = game.select('content', { id: 'farm', amount: 1 });
  assert.equal(one.viewModel.purchaseProduction, 2);
  assert.equal(game.select('state').resources.coins, 1e12 - ten.costs[0].value, 'preview itself does not spend resources');
});

test('Gem Power unlock applies production and FC bonuses then resets with the run', async () => {
  const seeded = initial();
  seeded.resources.gems = 100;
  seeded.buildings.farm = 10;
  seeded.stats.run.coins = 1e12;
  const { game } = fixture(seeded);
  await game.start();
  assert.equal(game.select('derived').production, 20);
  assert.equal(game.select('content', { id: 'gemPower' }).status, 'PURCHASABLE');
  assert.equal(game.dispatch({ type: 'purchase', id: 'gemPower' }).ok, true);
  assertClose(game.select('derived').production, 20 * (1 + 0.01 * (100 * 2) ** 0.9));
  assert.equal(game.select('derived').fcChance, 12);
  assert.equal(game.dispatch({ type: 'abdicate' }).ok, true);
  assert.equal(game.select('state').owned.run.gemPower, undefined);
  assert.equal(game.select('derived').production, 0);
  assert.notEqual(game.select('content', { id: 'gemPower' }).status, 'HIDDEN_SYSTEM');
});
test('player-facing names match the workplace naming reference without changing stable IDs', () => {
  const graph = compileContentGraph(CONTENT);
  const expected = {
    good: '理想路线', evil: '务实路线', holyLight: '奋斗动员', bloodFrenzy: '狼性狂热',
    'fairy-1': '需求培养土', 'fairy-2': '产品新人', 'fairy-3': '人性化默认值',
    'goblin-1': '强势现金流', 'goblin-2': '人力外包结算', 'goblin-3': '极简成本控制',
    'farm-tier1': '工位轮换', 'inn-tier1': '精品咖啡', 'blacksmith-tier1': '重型订书锤',
    warriorBarracks: '奋斗培训室', 'warriorBarracks-tier1': '青铜任务卡', 'heavensGate-tier1': '高维权限密钥',
    gemPower: '期权激励',
  };
  for (const [id, name] of Object.entries(expected)) assert.equal(graph.definitionsById.get(id).name, name, id);
});

test('all production Chinese names match runtime definitions', async () => {
  const document = JSON.parse(await readFile(new URL('../data/production/production_items.json', import.meta.url), 'utf8'));
  const graph = compileContentGraph(CONTENT);
  assert.equal(document.items.length, 1018);
  for (const item of document.items) {
    assert.equal(graph.definitionsById.get(item.id)?.name, item.name_zh, item.id);
  }
});

test('mana regeneration override applies immediately and persists through the setting command', async () => {
  const { game } = fixture();
  await game.start();
  assert.equal(game.dispatch({ type: 'setting', key: 'manaRegenOverride', value: -1 }).ok, false);
  assert.equal(game.dispatch({ type: 'setting', key: 'manaRegenOverride', value: 7 }).ok, true);
  assert.equal(game.select('derived').manaRegen, 7);
  game.tick(0.5);
  assert.equal(game.select('state').resources.mana, 3.5);
  assert.equal(game.select('state').settings.manaRegenOverride, 7);
});

test('alignment commitment stays selected until retirement and awards its story trophy once', async () => {
  const { game } = fixture(initial());
  await game.start();
  assert.equal(game.dispatch({ type: 'purchase', id: 'good' }).ok, true);
  assert.equal(game.select('content', { id: 'good' }).status, 'SELECTED');
  assert.deepEqual(game.select('storyQueue').map(item => item.id), ['alignment.idealism']);
  assert.equal(game.select('state').permanentUnlocks['trophy.alignment.idealism'], true);
  assert.equal(game.dispatch({ type: 'purchase', id: 'evil' }).reason, 'LOCKED_REQUIREMENT');
  game.dispatch({ type: 'story.close', id: 'alignment.idealism' });
  assert.equal(game.dispatch({ type: 'purchase', id: 'good' }).reason, 'SELECTED');
  assert.equal(game.select('storyQueue').length, 0);

  game.select('state').stats.run.coins = 1e8;
  assert.equal(game.dispatch({ type: 'abdicate' }).ok, true);
  assert.equal(game.select('state').selections.alignment, null);
  game.dispatch({ type: 'story.close', id: 'intro.first_retirement' });
  game.select('state').resources.coins = 1e12;
  assert.equal(game.dispatch({ type: 'purchase', id: 'evil' }).ok, true);
  assert.deepEqual(game.select('storyQueue').map(item => item.id), ['alignment.pragmatism']);
  assert.equal(game.select('state').permanentUnlocks['trophy.alignment.pragmatism'], true);
  game.dispatch({ type: 'story.close', id: 'alignment.pragmatism' });
});

test('the first two upgrade tiers of every ordinary building grant exactly one assistant', () => {
  const graph = compileContentGraph(CONTENT);
  for (const building of graph.arraysByKind.get('building').filter(item => item.id !== 'hallOfLegends')) {
    for (const tier of [1, 2, 3]) {
      const upgrade = graph.definitionsById.get(`${building.id}-tier${tier}`);
      const granted = upgrade.effects
        .filter(effect => effect.stat === 'assistants.count')
        .reduce((sum, effect) => sum + effect.value.constant, 0);
      assert.equal(granted, tier <= 2 ? 1 : 0, `${upgrade.id} assistant grant`);
    }
  }
});

test('assistants produce five percent of click reward each without producing real clicks', async () => {
  const seeded = initial(); seeded.buildings.farm = 25;
  const { game } = fixture(seeded);
  await game.start();
  assert.equal(game.dispatch({ type: 'purchase', id: 'farm-tier1' }).ok, true);
  assert.equal(game.select('derived').assistants, 1);
  assert.equal(game.dispatch({ type: 'purchase', id: 'farm-tier2' }).ok, true);
  const derived = game.select('derived');
  assert.equal(derived.assistants, 2);
  assert.equal(derived.clickReward, 1);
  assert.equal(derived.buildingProduction, 300);
  assertClose(derived.assistantProduction, 0.1, 'two assistants at base click reward');
  assertClose(derived.production, 300.1, 'building plus assistant production');
  const before = game.select('state');
  const producedCoins = before.stats.run.coins;
  const clicks = before.stats.total.clicks;
  const clickCoins = before.stats.total.clickCoins;
  game.tick(2);
  assertClose(game.select('state').stats.run.coins - producedCoins, derived.production * 2, 'continuous assistant income');
  assert.equal(game.select('state').stats.total.clicks, clicks, 'assistants do not increment clicks');
  assert.equal(game.select('state').stats.total.clickCoins, clickCoins, 'assistants do not increment click income');
});

test('click skills propagate to assistants while building-only multipliers stay on buildings', async () => {
  const seeded = initial(); seeded.buildings.farm = 5; seeded.resources.gems = 100;
  const { game } = fixture(seeded);
  await game.start();
  game.dispatch({ type: 'purchase', id: 'good' });
  game.dispatch({ type: 'purchase', id: 'farm-tier1' });
  game.dispatch({ type: 'purchase', id: 'gemPower' });
  const gemMultiplier = 1 + 0.01 * (100 * 2) ** 0.9;
  let derived = game.select('derived');
  assert.equal(derived.assistants, 1);
  assertClose(derived.buildingProduction, 20 * gemMultiplier);
  assertClose(derived.assistantProduction, 0.05, 'Gem Power does not multiply assistant production');

  game.dispatch({ type: 'cast', id: 'callToArms' });
  const globalActive = game.select('derived');
  const globalRatio = globalActive.buildingProduction / derived.buildingProduction;
  assert.ok(globalRatio > 1);
  assertClose(globalActive.assistantProduction, derived.assistantProduction, 'global building spell excludes assistants');
  assert.equal(globalActive.clickReward, 1, 'global production does not inflate manual clicks');

  game.dispatch({ type: 'cast', id: 'holyLight' });
  derived = game.select('derived');
  assert.equal(derived.clickReward, 18.5);
  assertClose(derived.assistantProduction, globalActive.assistantProduction * 18.5, 'click skill multiplier');

  game.tick(20);
  derived = game.select('derived');
  assert.equal(derived.clickReward, 1);
  assertClose(derived.assistantProduction, 0.05, 'spell expiry restores base assistant output');
  game.dispatch({ type: 'work' });
  derived = game.select('derived');
  assert.equal(derived.clickReward, 1.05);
  assertClose(derived.assistantProduction, 0.0525, 'permanent click reward upgrade propagates');
});

test('building production can affect assistants through click bonuses without a second global multiplication', async () => {
  const seeded = initial();
  seeded.buildings.farm = 10;
  seeded.resources.gems = 100;
  seeded.owned.run['farm-tier1'] = true;
  seeded.owned.run['elven-2'] = true;
  seeded.owned.run.gemPower = true;
  const { game } = fixture(seeded);
  await game.start();
  const derived = game.select('derived');
  assert.equal(derived.assistants, 1);
  assertClose(derived.clickReward, 1 + 0.5 * derived.buildingProduction);
  assertClose(derived.assistantProduction, 0.05 * derived.clickReward);
});

test('Goblin assistant count recalculates only when queued Greed coins enter era found', async () => {
  const seeded = initial();
  seeded.stats.ascension.factionCoinsByFaction.fairy = 16;
  seeded.spellSources.goblinsGreed = { goblin: true };
  const { game } = fixture(seeded);
  await game.start();
  game.dispatch({ type: 'purchase', id: 'evil' });
  game.dispatch({ type: 'purchase', id: 'goblin' });
  game.dispatch({ type: 'purchase', id: 'goblin-1' });
  const expected = count => Math.floor(1.25 * Math.log(1 + count) ** 1.5);
  assert.equal(game.select('derived').assistants, expected(16));
  const quantity = 80 + 2.25 * Math.log(10) ** 2.25;
  const cast = game.dispatch({ type: 'cast', id: 'goblinsGreed' });
  assert.equal(cast.ok, true);
  assert.equal(game.select('state').resources.mana, 9600, 'Greed costs 400 mana');
  assert.equal(game.select('state').timers.spells.goblinsGreed.dueAt, 8);
  assert.equal(game.select('state').stats.ascension.factionCoins, 16, 'cast does not immediately enter found');
  assert.equal(game.select('factionCoins').pending, quantity);
  assert.equal(game.select('derived').assistants, expected(16));
  game.tick(0.2);
  assert.equal(game.select('state').stats.ascension.factionCoins, 16 + Math.floor(quantity));
  assert.equal(game.select('factionCoins').pending, 0);
  assert.equal(game.select('derived').assistants, expected(16 + Math.floor(quantity)));
});

test('legacy building upgrades restore assistants through migration and abdication clears them', async () => {
  const legacy = {
    schemaVersion: 3, coins: 1e12, gems: 0, mana: 0,
    buildings: { farm: 10 }, upgrades: ['farm-tier1', 'farm-tier2'],
    stats: { run: { coins: 1e12 }, total: { clicks: 1 } },
    story: { pending: [], read: [], history: [], intro: {} },
  };
  const { game } = fixture(legacy);
  await game.start();
  assert.equal(game.select('derived').assistants, 2);
  assertClose(game.select('derived').assistantProduction, 0.1);
  assert.equal(game.dispatch({ type: 'abdicate' }).ok, true);
  assert.equal(game.select('state').owned.run['farm-tier1'], undefined);
  assert.equal(game.select('state').owned.run['farm-tier2'], undefined);
  assert.equal(game.select('derived').assistants, 0);
  assert.equal(game.select('derived').assistantProduction, 0);
});

test('reincarnation clears run-scoped assistant upgrades and their production', async () => {
  const seeded = initial(); seeded.resources.gems = 1e27; seeded.buildings.farm = 10;
  seeded.owned.run['farm-tier1'] = true; seeded.owned.run['farm-tier2'] = true;
  const { game } = fixture(seeded);
  await game.start();
  assert.equal(game.select('derived').assistants, 2);
  assert.equal(game.dispatch({ type: 'reincarnate' }).ok, true);
  assert.equal(game.select('derived').assistants, 1);
  assertClose(game.select('derived').assistantProduction, 0.05 * 1.02);
  assertClose(game.select('derived').production, 0.05 * 1.02);
});

test('spell descriptions resolve the current Fairy Chanting text', () => {
  const spell = CONTENT.definitions.find(item => item.id === 'fairyChanting');
  const graph = compileContentGraph(CONTENT);
  assert.equal(formatDescription(spell, graph), '根据见习工位、茶水间与打印维修间的有效总数，在 {spellDuration} 秒内提高这三类设施产出，当前倍率 ×{effect:fairyChanting}。');
});

test('assistant count and production modifiers compose through generic additive and multiplicative channels', async () => {
  const group = (name, phase, stat, operation, constant) => ({ group: `test.${name}`, phase, stat, target: { type: 'global' }, operation, value: { constant }, stacking: operation === 'add' || operation === 'addPercent' ? 'add' : 'multiply' });
  const extension = {
    ...CONTENT.definitions.find(item => item.id === 'gemPower'), id: 'test.assistantModifiers',
    effects: [
      group('countAdd', 'assistants', 'assistants.count', 'add', 2),
      group('countMult', 'assistants', 'assistants.count', 'multiplyPercent', 200),
      group('productionAdd', 'global', 'assistants.production', 'addPercent', 100),
      group('productionMult', 'global', 'assistants.production', 'multiplyPercent', 50),
    ],
  };
  const content = { packs: CONTENT.packs, definitions: [...CONTENT.definitions, extension] };
  const seeded = initial(); seeded.buildings.farm = 1;
  seeded.owned.run['farm-tier1'] = true; seeded.owned.run[extension.id] = true;
  const { game } = fixture(seeded, { content });
  await game.start();
  const derived = game.select('derived');
  assert.equal(derived.assistants, 9, '(1 building assistant + 2) × 3');
  assertClose(derived.assistantProduction, 1.35, '9 × 1 × 5% × 2 × 1.5');
  assertClose(derived.production, 5.35);
});

test('derived dependency fingerprints refresh assistant scaling without clearing unrelated formulas', async () => {
  const countFromFarms = {
    ...CONTENT.definitions.find(item => item.id === 'gemPower'), id: 'test.countFromFarms',
    effects: [{ group: 'test.countFromFarms', phase: 'assistants', stat: 'assistants.count', target: { type: 'global' }, operation: 'add', value: { formula: 'x', variables: { x: 'buildings.farm' } }, stacking: 'add' }],
  };
  const scaling = {
    ...CONTENT.definitions.find(item => item.id === 'gemPower'), id: 'test.assistantScaling',
    effects: [{ group: 'test.assistantScaling', phase: 'global', stat: 'global.production', target: { type: 'global' }, operation: 'addPercent', value: { formula: '10 * x', variables: { x: 'derived.assistants' } }, stacking: 'add' }],
  };
  const content = { packs: CONTENT.packs, definitions: [...CONTENT.definitions, countFromFarms, scaling] };
  const seeded = initial(); seeded.buildings.farm = 1;
  seeded.owned.run[countFromFarms.id] = true; seeded.owned.run[scaling.id] = true;
  const { game } = fixture(seeded, { content });
  await game.start();
  let derived = game.select('derived');
  assert.equal(derived.assistants, 1);
  assertClose(derived.buildingProduction, 2.2);
  assertClose(derived.assistantProduction, 0.05);
  game.dispatch({ type: 'purchase', id: 'farm' });
  derived = game.select('derived');
  assert.equal(derived.assistants, 2);
  assertClose(derived.buildingProduction, 4.8, 'derived.assistants dependency must refresh from 1 to 2');
  assertClose(derived.assistantProduction, 0.1);
});

test('conditional effects and pre-cast derived conditions support the Fairy Choir boundary', async () => {
  for (const baseAssistants of [44, 45]) {
    const choirId = `trophy.fairy_choir_test_${baseAssistants}`;
    const base = {
      ...CONTENT.definitions.find(item => item.id === 'gemPower'), id: `test.baseAssistants${baseAssistants}`,
      effects: [{ group: `test.baseAssistants${baseAssistants}`, phase: 'assistants', stat: 'assistants.count', target: { type: 'global' }, operation: 'add', value: { constant: baseAssistants }, stacking: 'add' }],
    };
    const choir = {
      ...CONTENT.definitions.find(item => item.id === 'trophy.first_click'), id: choirId, rewardId: choirId, effects: [],
      reactions: [{ event: 'spell.cast', priority: 50, when: { all: [
        { op: 'eventDataEquals', path: 'spellId', value: 'fairyChanting' },
        { op: 'statAtLeast', path: 'derived.assistants', value: 45 },
      ] } }],
    };
    const spellEffect = {
      group: `test.fairyChoir${baseAssistants}`, phase: 'assistants', stat: 'assistants.count', target: { type: 'global' },
      operation: 'multiplyPercent', value: { constant: 200 }, stacking: 'multiply', when: { op: 'owned', id: choirId },
    };
    const content = {
      packs: CONTENT.packs,
      definitions: [...CONTENT.definitions.map(item => item.id === 'fairyChanting' ? { ...item, effects: [...item.effects, spellEffect] } : item), base, choir],
    };
    const seeded = initial(); seeded.spellSources.fairyChanting = { fairy: true }; seeded.owned.run[base.id] = true;
    const { game } = fixture(seeded, { content });
    await game.start();
    assert.equal(game.select('derived').assistants, baseAssistants);
    assert.equal(game.dispatch({ type: 'cast', id: 'fairyChanting' }).ok, true);
    assert.equal(Boolean(game.select('state').permanentUnlocks[choirId]), baseAssistants === 45);
    assert.equal(game.select('derived').assistants, baseAssistants === 45 ? 135 : 44);
    game.tick(10);
    assert.equal(game.select('derived').assistants, baseAssistants, 'spell expiry removes the conditional multiplier');
  }
});


test('manual clicks use all six factions before alignment and after joining Fairy', async () => {
  const { game } = fixture(null, { seed: 2718 });
  await game.start();
  const factionIds = game.graph.arraysByKind.get('faction').map(item => item.id);
  for (let index = 0; index < 800; index++) game.dispatch({ type: 'work' });
  let state = game.select('state');
  for (const id of factionIds) assert.ok(state.resources.factionCoins[id] > 0, `${id} can drop before alignment`);
  assert.equal(state.stats.run.factionCoins, Object.values(state.resources.factionCoins).reduce((sum, value) => sum + value, 0));
  state.resources.coins = 1e12;
  game.dispatch({ type: 'purchase', id: 'good' });
  game.dispatch({ type: 'purchase', id: 'fairy' });
  const before = { ...state.resources.factionCoins };
  for (let index = 0; index < 800; index++) game.dispatch({ type: 'work' });
  state = game.select('state');
  for (const id of factionIds) assert.ok(state.resources.factionCoins[id] > before[id], `${id} remains eligible after joining Fairy`);
});

test('an additional declarative faction enters the same drop pool without runtime changes', async () => {
  const fairy = CONTENT.definitions.find(item => item.id === 'fairy');
  const custom = { ...fairy, id: 'customFaction', name: '测试部', factionCoin: { ...fairy.factionCoin } };
  const content = { packs: CONTENT.packs, definitions: [...CONTENT.definitions, custom] };
  const { game } = fixture(null, { content, seed: 4242 });
  await game.start();
  for (let index = 0; index < 600; index++) game.dispatch({ type: 'work' });
  assert.ok(game.select('state').resources.factionCoins.customFaction > 0);
});

test('Fairy treaty is free only at R0 with zero gems and later spends twenty target FC without reducing found', async () => {
  const free = initial();
  const { game: freeGame } = fixture(free);
  await freeGame.start();
  freeGame.dispatch({ type: 'purchase', id: 'good' });
  assert.deepEqual(freeGame.select('content', { id: 'fairy' }).costs, []);
  assert.equal(freeGame.dispatch({ type: 'purchase', id: 'fairy' }).ok, true);

  const seeded = initial(); seeded.resources.gems = 1; seeded.resources.factionCoins.fairy = 19;
  const { game } = fixture(seeded);
  await game.start();
  game.dispatch({ type: 'purchase', id: 'good' });
  assert.equal(game.select('content', { id: 'fairy' }).status, 'NEED_RESOURCE');
  assert.equal(game.dispatch({ type: 'purchase', id: 'fairy' }).reason, 'NEED_RESOURCE');
  assert.equal(game.select('state').selections.faction, null);
  game.select('state').resources.factionCoins.fairy = 20;
  game.select('state').stats.run.factionCoins = 20;
  game.select('state').stats.run.factionCoinsByFaction.fairy = 20;
  const model = game.select('content', { id: 'fairy' });
  assert.equal(model.costs[0].resource, 'factionCoin.target');
  assert.equal(model.costs[0].value, 20);
  assert.equal(game.dispatch({ type: 'purchase', id: 'fairy' }).ok, true);
  assert.equal(game.select('state').resources.factionCoins.fairy, 0);
  assert.equal(game.select('state').stats.run.factionCoins, 20);
  assert.equal(game.select('state').stats.run.factionCoinsByFaction.fairy, 20);
});

test('abdication clears FC balances and run found while preserving longer scopes', async () => {
  const seeded = initial();
  seeded.stats.run.coins = 1e12;
  seeded.resources.factionCoins = { fairy: 5, goblin: 7 };
  for (const scope of ['run', 'r', 'ascension', 'total']) {
    seeded.stats[scope].factionCoins = 12;
    seeded.stats[scope].factionCoinsByFaction = { fairy: 5, goblin: 7 };
  }
  const { game } = fixture(seeded);
  await game.start();
  assert.equal(game.dispatch({ type: 'abdicate' }).ok, true);
  const state = game.select('state');
  assert.deepEqual(state.resources.factionCoins, {});
  assert.equal(state.stats.run.factionCoins, 0);
  assert.deepEqual(state.stats.run.factionCoinsByFaction, {});
  assert.equal(state.stats.r.factionCoins, 12);
  assert.deepEqual(state.stats.r.factionCoinsByFaction, { fairy: 5, goblin: 7 });
  assert.equal(state.stats.ascension.factionCoins, 12);
  assert.deepEqual(state.stats.ascension.factionCoinsByFaction, { fairy: 5, goblin: 7 });
  assert.equal(state.stats.total.factionCoins, 12);
  assert.deepEqual(state.stats.total.factionCoinsByFaction, { fairy: 5, goblin: 7 });
});

test('online assistants apply guaranteed chance, triple count and integer grants without clicks', async () => {
  const chance = {
    ...CONTENT.definitions.find(item => item.id === 'gemPower'), id: 'test.highFcChance',
    effects: [{ group: 'test.highFcChance', phase: 'factionCoin', stat: 'factionCoin.chance', target: { type: 'global' }, operation: 'add', value: { constant: 140 }, stacking: 'add' }],
  };
  const seeded = initial();
  seeded.owned.run['farm-tier1'] = true; seeded.owned.run['farm-tier2'] = true; seeded.owned.run[chance.id] = true;
  const { game } = fixture(seeded, { content: { packs: CONTENT.packs, definitions: [...CONTENT.definitions, chance] } });
  await game.start();
  assert.equal(game.select('derived').assistants, 2);
  assert.equal(game.select('derived').fcChance, 150);
  assert.equal(game.select('factionCoins').assistant.expectedPerSecond, 9);
  game.tick(1); game.tick(1); game.tick(1);
  const state = game.select('state');
  assert.equal(state.stats.run.factionCoins, 9);
  assert.equal(Object.values(state.resources.factionCoins).reduce((sum, value) => sum + value, 0), 9);
  assert.ok(Object.values(state.resources.factionCoins).every(Number.isInteger));
  assert.equal(state.stats.run.clicks, 0);
  assert.equal(state.stats.run.clickCoins, 0);
});

test('offline assistants round expected FC into pending and flush on the next online tick', async () => {
  const seeded = initial();
  seeded.owned.run['farm-tier1'] = true; seeded.owned.run['farm-tier2'] = true;
  seeded.lastWallClock = 0;
  const { game } = fixture(seeded, { nowStart: 50000 });
  let offlineFact;
  game.subscribe(message => {
    offlineFact = message.facts.find(fact => fact.type === 'offline.settled') || offlineFact;
  });
  const started = await game.start();
  assert.equal(started.offlineReport.factionCoinsPending, 10);
  assert.deepEqual(started.offlineReport.factionCoinsFound, {});
  assert.equal(offlineFact.payload.factionCoinsPending, 10);
  assert.deepEqual(game.select('lastOfflineReport'), started.offlineReport);
  assert.equal(game.select('state').stats.run.factionCoins, 0);
  assert.equal(game.select('factionCoins').pending, 10);
  game.tick(0.2);
  assert.equal(game.select('state').stats.run.factionCoins, 10);
  assert.equal(game.select('factionCoins').pending, 0);
  assert.equal(game.select('state').stats.run.clicks, 0);
  assert.equal(game.select('state').stats.run.clickCoins, 0);
});

test('faction coin selector exposes immutable copies, six-faction expectations and pending', async () => {
  const seeded = initial();
  seeded.owned.run['farm-tier1'] = true; seeded.owned.run['farm-tier2'] = true;
  seeded.resources.factionCoins.fairy = 3;
  for (const scope of ['run', 'r', 'ascension', 'total']) seeded.stats[scope].factionCoinsByFaction = { fairy: 3, goblin: 2 };
  const { game } = fixture(seeded);
  await game.start();
  const model = game.select('factionCoins');
  assert.equal(model.chance, 10);
  assert.equal(model.pending, 0);
  assert.deepEqual(model.pool, ['fairy', 'goblin', 'elven', 'angel', 'undead', 'demon'].map(factionId => ({ factionId, weight: 1 })));
  assert.equal(model.balances.fairy, 3);
  assert.deepEqual(model.found, { run: 5, r: 5, ascension: 5, total: 5 });
  assert.equal(model.foundByFaction.run.fairy, 3);
  assertClose(model.assistant.expectedPerSecond, 0.6);
  assertClose(model.assistant.expectedPerFaction.fairy, 0.1);
  model.balances.fairy = 999;
  model.assistant.expectedPerFaction.fairy = 999;
  assert.equal(game.select('state').resources.factionCoins.fairy, 3);
  assertClose(game.select('factionCoins').assistant.expectedPerFaction.fairy, 0.1);
  const remainderHit = nextDouble({ rng: createRngState() }, 'drops:factionCoin') * 100 <= 20;
  game.tick(1); game.tick(1); game.tick(1);
  assert.equal(game.select('state').stats.run.factionCoins, 5 + (remainderHit ? 3 : 0));
});

test('Greed flushes random-cache facts into every scoped per-faction ledger on the next tick', async () => {
  const { game } = fixture(initial());
  await game.start();
  game.dispatch({ type: 'purchase', id: 'evil' });
  game.dispatch({ type: 'purchase', id: 'goblin' });
  assert.equal(game.dispatch({ type: 'cast', id: 'goblinsGreed' }).ok, true);
  assert.equal(game.select('state').stats.run.factionCoins, 0);
  const result = game.tick(0.2);
  const expected = Math.floor(80 + 2.25 * Math.log(10) ** 2.25);
  const state = game.select('state');
  assert.ok(result.facts.some(fact => fact.type === 'factionCoins.found' && fact.payload.source === 'randomCache'));
  for (const scope of ['run', 'r', 'ascension', 'total']) {
    assert.equal(state.stats[scope].factionCoins, expected);
    assert.equal(Object.values(state.stats[scope].factionCoinsByFaction).reduce((sum, value) => sum + value, 0), expected);
  }
});

test('schema 4 upgrades to schema 6 without inventing historical ledgers or build history', () => {
  const graph = compileContentGraph(CONTENT);
  const old = createSaveState({ now: 1000 });
  old.schemaVersion = 4;
  old.resources.factionCoins.fairy = 9;
  old.stats.run.factionCoins = 12;
  old.owned.run['farm-tier1'] = true;
  old.rng.streams['drops:manualClick'] = { calls: 2, value: 123 };
  for (const scope of ['run', 'r', 'ascension', 'total']) delete old.stats[scope].factionCoinsByFaction;
  const { state, report } = migrateAndNormalizeState(old, graph);
  assert.deepEqual(report, { from: 4, to: 6, migrated: true, migrationNotes: ['buildingsBuilt starts at zero in each scope; current buildings are not treated as historical purchases.'] });
  assert.ok(Object.values(state.stats).every(scope => scope.buildingsBuilt === 0));
  assert.equal(state.resources.factionCoins.fairy, 9);
  assert.equal(state.stats.run.factionCoins, 0, 'aggregate is recomputed from the available per-faction ledger');
  assert.deepEqual(state.stats.run.factionCoinsByFaction, {});
  assert.equal(state.owned.run['farm-tier1'], true);
  assert.deepEqual(state.rng.streams['drops:manualClick'], { calls: 2, value: 123 });
});

test('schema 6 normalization floors FC, rebuilds totals and filters timers activity and RNG', () => {
  const graph = compileContentGraph(CONTENT);
  const saved = createSaveState();
  saved.resources.factionCoins = { fairy: 9.9, goblin: 3.2 };
  saved.stats.run.factionCoins = 999;
  saved.stats.run.factionCoinsByFaction = { fairy: 2.5, goblin: -1, unknown: 4 };
  saved.stats.total.factionCoinsByFaction = { fairy: 4.9, goblin: 1.8 };
  saved.timers.tasks.greenFingersDiscount = { remaining: 600 };
  saved.stats.run.spellActivity = { fairyChanting: 2.5, taxCollection: -1, unknown: 4 };
  saved.rng.streams['drops:factionCoin'] = { calls: 3, value: 123 };
  saved.rng.streams.greenFingersDiscount = { calls: 4, value: 456 };
  saved.rng.streams.invalid = { calls: 'bad', value: 789 };
  saved.factionCoinCache = 99;
  saved.assistantTickAccumulator = 29;
  const { state, report } = migrateAndNormalizeState(saved, graph);
  assert.equal(report.migrated, false);
  assert.deepEqual(state.resources.factionCoins, { fairy: 9, goblin: 3 });
  assert.deepEqual(state.stats.run.factionCoinsByFaction, { fairy: 2 });
  assert.equal(state.stats.run.factionCoins, 2);
  assert.equal(state.stats.total.factionCoins, 5);
  assert.equal(state.timers.tasks.greenFingersDiscount.remaining, 120);
  assert.deepEqual(state.stats.run.spellActivity, { fairyChanting: 2.5 });
  assert.deepEqual(state.stats.r.spellActivity, {});
  assert.equal(state.rng.streams['drops:factionCoin'], undefined);
  assert.deepEqual(state.rng.streams.greenFingersDiscount, { calls: 4, value: 456 });
  assert.equal(state.rng.streams.invalid, undefined);
  assert.equal(state.factionCoinCache, undefined);
  assert.equal(state.assistantTickAccumulator, undefined);
  assert.equal(state.quarantined.invalidValues.goblin, -1);
  assert.equal(state.quarantined.unknownIds.unknown, 4);
});

test('reincarnation clears run and r per-faction found while preserving ascension and total', async () => {
  const seeded = initial(); seeded.resources.gems = 1e27;
  for (const scope of ['run', 'r', 'ascension', 'total']) {
    seeded.stats[scope].factionCoins = 4;
    seeded.stats[scope].factionCoinsByFaction = { fairy: 1, goblin: 3 };
  }
  const { game } = fixture(seeded);
  await game.start();
  assert.equal(game.dispatch({ type: 'reincarnate' }).ok, true);
  const state = game.select('state');
  assert.deepEqual(state.stats.run.factionCoinsByFaction, {});
  assert.deepEqual(state.stats.r.factionCoinsByFaction, {});
  assert.deepEqual(state.stats.ascension.factionCoinsByFaction, { fairy: 1, goblin: 3 });
  assert.deepEqual(state.stats.total.factionCoinsByFaction, { fairy: 1, goblin: 3 });
});


test('Fairy and Goblin Pact Alliance gates unlock tiers and spend only FC balances', async () => {
  for (const [faction, alignment] of [['fairy', 'good'], ['goblin', 'evil']]) {
    const seeded = initial();
    seeded.resources.coins = 1e21;
    seeded.resources.factionCoins[faction] = 1000;
    const { game } = fixture(seeded);
    await game.start();
    game.dispatch({ type: 'purchase', id: alignment });
    game.dispatch({ type: 'purchase', id: faction });
    const status = id => game.select('content', { id }).status;
    assert.equal(status(`${faction}-pact`), 'HIDDEN_SYSTEM');
    for (const number of [1, 2, 3]) assert.equal(game.dispatch({ type: 'purchase', id: `${faction}-${number}` }).ok, true);
    assert.equal(status(`${faction}-pact`), 'PURCHASABLE');
    assert.equal(status(`${faction}-4`), 'HIDDEN_SYSTEM');
    assert.equal(game.dispatch({ type: 'purchase', id: `${faction}-pact` }).ok, true);
    assert.equal(game.select('state').resources.factionCoins[faction], 900);
    for (const number of [4, 5, 6]) {
      assert.equal(status(`${faction}-${number}`), 'PURCHASABLE');
      assert.equal(game.dispatch({ type: 'purchase', id: `${faction}-${number}` }).ok, true);
    }
    assert.equal(status(`${faction}-alliance`), 'PURCHASABLE');
    assert.equal(status(`${faction}-7`), 'HIDDEN_SYSTEM');
    assert.equal(game.dispatch({ type: 'purchase', id: `${faction}-alliance` }).ok, true);
    assert.equal(game.select('state').resources.factionCoins[faction], 400);
    for (const number of [7, 8, 9]) assert.equal(status(`${faction}-${number}`), 'PURCHASABLE');
    assert.equal(game.select('state').stats.run.factionCoins, 0);
  }
});

test('all nine Fairy upgrades compose their exact targets and dynamic formulas', async () => {
  const seeded = initial();
  seeded.resources.coins = 1e21;
  seeded.selections.alignment = 'good'; seeded.selections.faction = 'fairy';
  seeded.buildings = { farm: 10, inn: 20, blacksmith: 30, cathedral: 5 };
  for (let number = 1; number <= 9; number++) seeded.owned.run[`fairy-${number}`] = true;
  const { game } = fixture(seeded);
  await game.start();
  const expected = blacksmiths => {
    const low3 = 30 + blacksmiths;
    const assistants = Math.floor(0.3 * low3 ** 0.7);
    const localMult = 1 + 5 * Math.log(1 + assistants) ** 2.5 / 100;
    const globalMult = 1 + 1.25 * low3 ** 0.75 / 100;
    const outputs = {
      farm: 10 * 602 * localMult * globalMult,
      inn: 20 * 606 * localMult * globalMult,
      blacksmith: blacksmiths * 620 * localMult * globalMult,
    };
    return { low3, assistants, globalMult, outputs };
  };
  let derived = game.select('derived');
  let values = expected(30);
  assertClose(derived.buildingCostMultipliers.farm, 1.13);
  assertClose(derived.buildingCostMultipliers.inn, 1.13);
  assertClose(derived.buildingCostMultipliers.blacksmith, 1.13);
  assertClose(derived.buildingCostMultipliers.cathedral, 1.15, 'FR1 discount excludes other facilities');
  for (const id of ['farm', 'inn', 'blacksmith']) assertClose(derived.outputs[id], values.outputs[id]);
  assertClose(derived.clickReward, 1 + Object.values(values.outputs).reduce((sum, value) => sum + value, 0));
  assertClose(derived.manaRegen, 1 + 3 * values.low3 ** 0.3);
  assertClose(derived.manaMax, 1000 + 1.3 * 5 ** 0.7);
  assertClose(derived.fcChance, 30);
  assert.equal(derived.assistants, values.assistants);
  assert.equal(game.dispatch({ type: 'purchase', id: 'blacksmith' }).ok, true);
  derived = game.select('derived');
  values = expected(31);
  assertClose(derived.manaRegen, 1 + 3 * values.low3 ** 0.3);
  assertClose(derived.clickReward, 1 + Object.values(values.outputs).reduce((sum, value) => sum + value, 0));
  assert.equal(derived.assistants, values.assistants);
  assert.equal(game.select('state').stats.run.buildingMax.blacksmith, 31);
});

test('Tax Collection coins count toward every production scope and first retirement', async () => {
  const seeded = createSaveState({ now: 1000, contentVersions: ['base-v1'] });
  seeded.resources.coins = 202e6; seeded.resources.mana = 10000; seeded.buildings.farm = 1e6;
  const scopes = ['run', 'r', 'ascension', 'total'];
  for (const scope of scopes) seeded.stats[scope].coins = 41.8e6;
  const { game } = fixture(seeded);
  await game.start();
  const expected = game.select('derived').production * game.select('derived').taxSeconds;
  const beforeCoins = game.select('state').resources.coins;
  assertClose(expected, 60e6);
  assert.equal(game.dispatch({ type: 'cast', id: 'taxCollection' }).ok, true);
  assertClose(game.select('state').resources.coins - beforeCoins, expected);
  for (const scope of scopes) assertClose(game.select('state').stats[scope].coins - 41.8e6, expected, scope);
  assert.equal(game.select('retirement').eligible, true);
  assert.equal(game.dispatch({ type: 'abdicate' }).ok, true);
  assert.equal(game.select('state').stats.total.abdications, 1);
});

test('Goblin economy upgrades use natural logs, era casts and Black Market gem/offline parts', async () => {
  const seeded = initial();
  seeded.resources.coins = 1e6; seeded.resources.gems = 10;
  seeded.selections.alignment = 'evil'; seeded.selections.faction = 'goblin';
  seeded.buildings = { farm: 10, witchConclave: 20 };
  seeded.stats.run.spellCasts.taxCollection = 99;
  seeded.stats.ascension.spellCasts.taxCollection = 9;
  for (const id of ['gemPower', 'goblin-3', 'goblin-4', 'goblin-5', 'goblin-6', 'goblin-8']) seeded.owned.run[id] = true;
  const { game } = fixture(seeded);
  await game.start();
  const taxSeconds = 30 + 1.5 * Math.sqrt(30);
  const globalPercent = 4 * Math.log(1 + taxSeconds) ** 2;
  const manaMultiplier = 1 + (15 + 0.5 * Math.log(1 + 1e6) ** 1.25) / 100;
  const blackMarketMultiplier = 1 + (100 + 2 * Math.log(11)) / 100;
  let derived = game.select('derived');
  assertClose(derived.taxSeconds, taxSeconds);
  assertClose(derived.manaRegen, manaMultiplier);
  assertClose(derived.offlineMultiplier, 0.5 * (1 + Math.log(10) ** 2 / 100));
  assertClose(derived.outputs.farm, 20 * (1 + globalPercent / 100) * (1 + 0.01 * (10 * 2 * blackMarketMultiplier) ** 0.9));
  const before = derived;
  assert.equal(game.dispatch({ type: 'cast', id: 'taxCollection' }).ok, true);
  assert.equal(game.select('state').stats.run.spellCasts.taxCollection, 100);
  assert.equal(game.select('state').stats.ascension.spellCasts.taxCollection, 10);
  derived = game.select('derived');
  assertClose(derived.offlineMultiplier, 0.5 * (1 + Math.log(11) ** 2 / 100), 'GB8 reads era rather than run casts');
  assert.ok(derived.manaRegen > before.manaRegen, 'coin gain refreshes Goblin Economists');
  assert.equal(game.graph.definitionsById.get('goblin-8').effects.some(effect => effect.stat === 'factionCoin.chance'), false);
});

test('Goblin Central Bank duplicates complete Tax actions, stats and timers without recursion', async () => {
  const mana = {
    ...CONTENT.definitions.find(item => item.id === 'gemPower'), id: 'test.maxMana',
    effects: [{ group: 'test.maxMana', phase: 'mana', stat: 'mana.max', target: { type: 'global' }, operation: 'add', value: { constant: 9000 }, stacking: 'add' }],
  };
  const content = {
    packs: CONTENT.packs,
    definitions: [...CONTENT.definitions.map(item => item.id === 'taxCollection' ? {
      ...item, castActions: [...item.castActions, { type: 'grantResource', resource: 'gems', amount: { constant: 2 } }],
    } : item), mana],
  };
  const seeded = initial();
  seeded.selections.alignment = 'evil'; seeded.selections.faction = 'goblin';
  seeded.buildings.farm = 10; seeded.owned.run['goblin-7'] = true; seeded.owned.run[mana.id] = true;
  seeded.timers.spells.goblinsGreed = { remaining: 8 };
  const { game } = fixture(seeded, { content });
  await game.start();
  const before = game.select('derived');
  const times = 1 + Math.floor(1.5 * Math.log(1 + before.manaMax / 1000) ** 1.5);
  assert.equal(times, 6);
  const coins = game.select('state').resources.coins;
  const result = game.dispatch({ type: 'cast', id: 'callToArms' });
  assert.equal(result.ok, true);
  assert.equal(game.select('state').resources.mana, 9600, 'duplicate Tax is free');
  assertClose(game.select('state').resources.coins - coins, before.production * before.taxSeconds * times);
  assert.equal(game.select('state').resources.gems, times * 2, 'every castAction runs once per duplicate');
  assert.equal(game.select('state').stats.run.spellCasts.callToArms, 1);
  assert.equal(game.select('state').stats.run.spellCasts.taxCollection, times);
  assert.equal(game.select('state').stats.run.spellsCast, times + 1);
  assert.equal(game.select('state').timers.spells.goblinsGreed.dueAt, 8, 'duplicate Tax preserves unrelated active spells');
  assert.ok(result.facts.some(fact => fact.type === 'spell.cast' && fact.payload.spellId === 'taxCollection' && fact.payload.free && fact.payload.times === times && fact.payload.sourceId === 'goblin-7'));
  assert.equal(game.dispatch({ type: 'cast', id: 'taxCollection' }).ok, true);
  assert.equal(game.select('state').stats.run.spellsCast, times + 2);
  assert.equal(game.select('state').stats.run.spellCasts.taxCollection, times + 1, 'manual Tax does not recursively duplicate itself');
});

test('Fools Gold reads per-building reincarnation maximum without flooring', async () => {
  const seeded = initial();
  seeded.selections.alignment = 'evil'; seeded.selections.faction = 'goblin';
  seeded.owned.run['goblin-4'] = true;
  seeded.buildings.witchConclave = 25;
  seeded.stats.r.buildingMax.witchConclave = 25;
  const { game } = fixture(seeded);
  await game.start();
  assertClose(game.select('derived').fcChance, 10 + 2 * 25 ** 0.6);
  game.dispatch({ type: 'purchase', id: 'witchConclave', amount: 10 });
  assert.equal(game.select('state').stats.r.buildingMax.witchConclave, 35);
  assertClose(game.select('derived').fcChance, 10 + 2 * 35 ** 0.6);
});

test('Green Fingers Discount uses 120 seconds, continuous rolls, one snapshot and one offline multiplier', async () => {
  const makeSave = () => {
    const saved = createSaveState({ now: 1000 });
    saved.buildings.farm = 10;
    saved.owned.run['farm-tier1'] = true; saved.owned.run['farm-tier2'] = true;
    saved.owned.run['goblin-9'] = true;
    saved.timers.tasks.greenFingersDiscount = { remaining: 600 };
    return saved;
  };
  const { game } = fixture(makeSave());
  await game.start();
  assert.equal(game.select('state').timers.tasks.greenFingersDiscount.dueAt, 120, 'legacy timers are capped at 120 seconds');
  const facts = [];
  game.subscribe(message => facts.push(...message.facts.filter(fact => fact.type === 'greenFingersDiscount.triggered')));
  const snapshot = game.select('derived');
  game.tick(600);
  assert.equal(facts.length, 1, 'a large online tick triggers at most once');
  assert.ok(facts[0].payload.seconds > 1 && facts[0].payload.seconds < 1500);
  assert.notEqual(facts[0].payload.seconds, Math.floor(facts[0].payload.seconds));
  const timeFactor = 1 + 0.01 * 600 ** 0.8;
  assertClose(facts[0].payload.earned, (snapshot.buildingProduction + snapshot.assistantProduction * timeFactor) * facts[0].payload.seconds);
  assert.equal(game.select('state').timers.tasks.greenFingersDiscount.dueAt, 720);
  game.tick(1200);
  assert.equal(facts.length, 2);
  assert.equal(game.select('state').timers.tasks.greenFingersDiscount.dueAt, 1920);
  game.select('state').resources.gems = 1e27;
  assert.equal(game.dispatch({ type: 'reincarnate' }).ok, true);
  assert.equal(game.select('state').owned.run['goblin-9'], undefined);
  assert.equal(game.select('state').timers.tasks.greenFingersDiscount, undefined);

  const offlineSave = makeSave();
  offlineSave.lastWallClock = 0;
  const offlineFixture = fixture(offlineSave, { nowStart: 2000000 });
  let onlineFact = null;
  offlineFixture.game.subscribe(message => { onlineFact ||= message.facts.find(fact => fact.type === 'greenFingersDiscount.triggered') || null; });
  const started = await offlineFixture.game.start();
  const multiplier = started.offlineReport.greenFingersMultiplier;
  assert.ok(multiplier > 21 && multiplier < 101);
  assert.equal(onlineFact, null, 'offline does not replay online GFD events');
  assert.equal(offlineFixture.game.select('state').rng.streams.greenFingersDiscount.calls, 1, 'offline draws exactly one multiplier');
  assertClose(started.offlineReport.earned, 120.1 * 0.5 * 2000 * multiplier);
  assert.equal(offlineFixture.game.select('state').timers.tasks.greenFingersDiscount.dueAt, 2120);
});

test('new sparse spell and building maximum stats are backward compatible', () => {
  const graph = compileContentGraph(CONTENT);
  const saved = createSaveState();
  saved.stats.run.spellCasts = { taxCollection: 3, unknown: 2 };
  saved.stats.r.buildingMax = { witchConclave: 40 };
  delete saved.stats.total.spellCasts; delete saved.stats.total.buildingMax;
  const { state, report } = migrateAndNormalizeState(saved, graph);
  assert.equal(report.migrated, false);
  assert.deepEqual(state.stats.run.spellCasts, { taxCollection: 3 });
  assert.deepEqual(state.stats.r.buildingMax, { witchConclave: 40 });
  assert.deepEqual(state.stats.total.spellCasts, {});
  assert.deepEqual(state.stats.total.buildingMax, {});
  assert.equal(state.quarantined.unknownIds.unknown, 2);
});


test('six factions use ID-matched pure vector SVG icons with confirmed stacking', async () => {
  const graph = compileContentGraph(CONTENT);
  const paths = new Set();
  const layouts = {
    1: ['translate(1.5, 1.5) scale(0.95)'],
    2: ['translate(12, 2.5) scale(0.76)', 'translate(1.5, 8.5) scale(0.76)'],
    3: ['translate(9.5, -0.5) scale(0.68)', 'translate(18, 14) scale(0.68)', 'translate(1.5, 16) scale(0.68)'],
  };
  for (const faction of ['fairy', 'goblin', 'elven', 'angel', 'undead', 'demon']) {
    const factionDefinition = graph.definitionsById.get(faction);
    assert.equal(factionDefinition.ui.icon, `assets/images/content-icons/factions/${faction}.svg`);
    const entries = [factionDefinition, graph.definitionsById.get(`${faction}-pact`), graph.definitionsById.get(`${faction}-alliance`)];
    for (let number = 1; number <= 9; number++) entries.push(graph.definitionsById.get(`${faction}-${number}`));
    assert.equal(entries.length, 12);
    for (const entry of entries) {
      assert.equal(entry.ui.icon, `assets/images/content-icons/factions/${entry.id}.svg`);
      paths.add(entry.ui.icon);
      const svg = await readFile(new URL(`../${entry.ui.icon}`, import.meta.url), 'utf8');
      assert.match(svg, /<svg[^>]+width="64"[^>]+height="64"/);
      assert.match(svg, /<polygon/);
      assert.doesNotMatch(svg, /<image|base64|<script|<foreignObject|<animate|filter=/);
      if (entry.kind === 'faction') assert.doesNotMatch(svg, /contract-tier/);
    }
    for (let tier = 1; tier <= 3; tier++) {
      for (let variant = 1; variant <= 3; variant++) {
        const id = `${faction}-${(tier - 1) * 3 + variant}`;
        const svg = await readFile(new URL(`../${graph.definitionsById.get(id).ui.icon}`, import.meta.url), 'utf8');
        const transforms = [...svg.matchAll(/<g id="[^"]+" transform="([^"]+)"/g)].map(match => match[1]);
        assert.deepEqual(transforms, layouts[variant]);
      }
    }
  }
  assert.equal(paths.size, 72);
});

test('all 569 department spell exchange trophy and misc images use ID-matched pure vector resources', async () => {
  const prefix = 'assets/images/content-icons/';
  const entries = CONTENT.definitions.filter(item => /^(factions|exchange|spells|trophies|misc)\//.test(item.ui?.icon?.slice(prefix.length) || ''));
  const paths = new Set();
  assert.equal(entries.length, 569);
  for (const entry of entries) {
    const directory = entry.ui.icon.slice(prefix.length).split('/')[0];
    const generic = entry.ui.icon === `${prefix}trophies/generic-trophy.svg`;
    if (!generic) assert.equal(entry.ui.icon, `${prefix}${directory}/${entry.id}.svg`);
    paths.add(entry.ui.icon);
    const svg = await readFile(new URL(`../${entry.ui.icon}`, import.meta.url), 'utf8');
    assert.match(svg, /<svg[^>]+width="64"[^>]+height="64"/);
    const title = svg.match(/<title>(.*?)<\/title>/)?.[1];
    if (!generic) assert.ok(title?.includes(entry.name), `${entry.id} title matches the current entry name`);
    assert.match(svg, /<desc>.*<\/desc>/);
    assert.doesNotMatch(svg, /<image|base64|<script|<foreignObject|<animate|filter=/);
  }
  assert.equal(paths.size, 158);
});

test('upgraded spells reuse trophy artwork shared with their linked upgrades', async () => {
  const links = {
    fairyChanting: 'fairyChoir', moonBlessing: 'sunBlessing', godsHand: 'godsRest',
    goblinsGreed: 'greedDrive', nightTime: 'trueNight', hellfireBlast: 'hellRush',
  };
  for (const [spellId, trophyId] of Object.entries(links)) {
    const spell = CONTENT.definitions.find(item => item.id === spellId);
    assert.equal(spell.ui.icon, `assets/images/content-icons/spells/${spellId}.svg`);
    assert.equal(spell.ui.upgradeId, `${trophyId}Upgrade`);
    assert.equal(spell.ui.upgradedIcon, `assets/images/content-icons/trophies/${trophyId}.svg`);
    const trophyArt = await readFile(new URL(`../${spell.ui.upgradedIcon}`, import.meta.url), 'utf8');
    const upgradeArt = await readFile(new URL(`../assets/images/content-icons/factions/${trophyId}Upgrade.svg`, import.meta.url), 'utf8');
    assert.equal(upgradeArt, trophyArt, `${trophyId} upgrade and upgraded spell share the trophy artwork`);
  }
});

test('Champion trophies reuse their Heritage vector artwork without changing the drawings', async () => {
  const links = {
    fairyChampion: 'fairyHeritage', elvenChampion: 'elvenHeritage', angelChampion: 'angelicHeritage',
    goblinChampion: 'goblinHeritage', undeadChampion: 'undeadHeritage', demonChampion: 'demonicHeritage',
  };
  for (const [trophyId, heritageId] of Object.entries(links)) {
    const trophy = CONTENT.definitions.find(item => item.id === trophyId);
    assert.equal(trophy.ui.icon, `assets/images/content-icons/trophies/${trophyId}.svg`);
    const trophySvg = await readFile(new URL(`../${trophy.ui.icon}`, import.meta.url), 'utf8');
    const heritageSvg = await readFile(new URL(`../assets/images/content-icons/factions/${heritageId}.svg`, import.meta.url), 'utf8');
    assert.equal(trophySvg.slice(trophySvg.indexOf('<g')), heritageSvg.slice(heritageSvg.indexOf('<g')), trophyId);
  }
});

test('assistant FC rate ignores click multipliers and offline settlement remains pending', async () => {
  const makeAssistantSave = () => {
    const seeded = initial();
    seeded.selections.alignment = 'good';
    seeded.buildings.farm = 10;
    seeded.owned.run['farm-tier1'] = true; seeded.owned.run['farm-tier2'] = true;
    return seeded;
  };
  const { game } = fixture(makeAssistantSave());
  await game.start();
  assertClose(game.select('factionCoins').assistant.expectedPerSecond, 0.6);
  assert.equal(game.dispatch({ type: 'cast', id: 'holyLight' }).ok, true);
  assert.equal(game.select('derived').clickReward, 18.5);
  assertClose(game.select('factionCoins').assistant.expectedPerSecond, 0.6, 'click skills do not change assistant FC expectation');
  game.tick(11); game.tick(11); game.tick(11);
  assert.ok(Object.values(game.select('state').resources.factionCoins).every(Number.isInteger));

  const offline = makeAssistantSave();
  offline.lastWallClock = 0;
  offline.timers.spells.holyLight = { remaining: 10 };
  const offlineFixture = fixture(offline, { nowStart: 20000 });
  const started = await offlineFixture.game.start();
  assert.equal(started.offlineReport.factionCoinsPending, 4);
  assert.deepEqual(started.offlineReport.factionCoinsFound, {});
  assert.equal(offlineFixture.game.select('derived').clickReward, 1);
});

test('assistant FC ignores Golden Pots click production and Tax grants no FC', async () => {
  const seeded = initial();
  seeded.selections.alignment = 'good'; seeded.selections.faction = 'fairy';
  seeded.buildings = { farm: 10, inn: 10, blacksmith: 10 };
  seeded.owned.run['farm-tier1'] = true; seeded.owned.run['farm-tier2'] = true;
  seeded.owned.run['fairy-5'] = true;
  const { game } = fixture(seeded);
  await game.start();
  const derived = game.select('derived');
  assert.ok(derived.clickReward > 1, 'Golden Pots raises base click production');
  assertClose(game.select('factionCoins').assistant.expectedPerSecond, 1.8);
  assert.equal(game.select('factionCoins').assistant.expectedPerFaction.fairy, 0.3);
  game.tick(1); game.tick(1); game.tick(1);
  const beforeTax = { ...game.select('state').resources.factionCoins };
  assert.equal(game.dispatch({ type: 'cast', id: 'taxCollection' }).ok, true);
  assert.deepEqual(game.select('state').resources.factionCoins, beforeTax);
});

test('manual click FC grants one coin per hit regardless of click buffs', async () => {
  const seeded = initial();
  seeded.selections.alignment = 'good';
  seeded.owned.run['goblin-4'] = true;
  seeded.stats.r.buildingMax.witchConclave = 1e10;
  const { game } = fixture(seeded);
  await game.start();
  const manualFact = result => result.facts.find(fact => fact.type === 'factionCoins.found' && fact.payload.source === 'manualClick');
  assert.equal(manualFact(game.dispatch({ type: 'work' })).payload.amount, 1);
  assert.equal(game.dispatch({ type: 'cast', id: 'holyLight' }).ok, true);
  assert.equal(manualFact(game.dispatch({ type: 'work' })).payload.amount, 1);
  assert.equal(game.select('state').stats.run.factionCoins, 2);
});

test('Fairy Chanting costs 800, scales at two building counts and records FR7 activity', async () => {
  for (const buildings of [{ farm: 10, inn: 20, blacksmith: 30 }, { farm: 1, inn: 2, blacksmith: 3 }]) {
    const seeded = initial();
    seeded.selections.alignment = 'good';
    seeded.spellSources.fairyChanting = { fairy: true };
    seeded.buildings = buildings;
    seeded.resources.gems = 100;
    seeded.owned.run.gemPower = true;
    seeded.owned.run['fairy-7'] = true;
    const { game } = fixture(seeded);
    await game.start();
    const before = game.select('derived');
    const low3 = Object.values(buildings).reduce((sum, value) => sum + value, 0);
    const gemMultiplier = perGem => 1 + 0.01 * (100 * perGem) ** 0.9;
    assert.equal(game.dispatch({ type: 'cast', id: 'fairyChanting' }).ok, true);
    assert.equal(game.select('state').resources.mana, 9200);
    const active = game.select('derived');
    const chantingMultiplier = 20000 ** (1 + 0.02 * low3 ** 0.2);
    for (const id of Object.keys(buildings)) assertClose(active.outputs[id] / before.outputs[id], chantingMultiplier, `${id} at ${low3} low-tier buildings`);
    game.tick(2);
    assert.equal(game.select('state').stats.run.spellActivity.fairyChanting, 2);
    assert.equal(game.select('state').stats.ascension.spellActivity.fairyChanting, 2);
    const activityProduction = gemMultiplier(2 + 0.35 * 2 ** 0.65) / gemMultiplier(2);
    assertClose(game.select('derived').outputs.farm / active.outputs.farm, activityProduction, 'FR7 reads active time this era');
    game.tick(8);
    assert.equal(game.select('state').stats.run.spellActivity.fairyChanting, 10);
    assert.equal(game.select('state').timers.spells.fairyChanting, undefined);
    assertClose(game.select('derived').outputs.farm, before.outputs.farm * gemMultiplier(2 + 0.35 * 10 ** 0.65) / gemMultiplier(2));
    game.tick(2);
    assert.equal(game.select('state').stats.run.spellActivity.fairyChanting, 10, 'expired spells stop accumulating activity');
  }
});


test('all 391 building upgrades match names, unlocks, dynamic costs and shared ascension effects', async () => {
  const facilityNames = {
    farm: ['Farms', 'Farm'], inn: ['Inns', 'Inn'], blacksmith: ['Blacksmiths', 'Blacksmith'],
    warriorBarracks: ['Warrior Barracks', 'Warrior Barrack'], slavePen: ['Slave Pens', 'Slave Pen'],
    knightsJoust: ['Knights Jousts', 'Knights Joust'], orcishArena: ['Orcish Arenas', 'Orcish Arena'],
    wizardTower: ['Wizard Towers', 'Wizard Tower'], witchConclave: ['Witch Conclaves', 'Witch Conclave'],
    cathedral: ['Cathedrals', 'Cathedral'], darkTemple: ['Dark Temples', 'Dark Temple'],
    citadel: ['Citadels', 'Citadel'], necropolis: ['Necropolises', 'Necropolis'],
    royalCastle: ['Royal Castles', 'Royal Castle'], evilFortress: ['Evil Fortresses', 'Evil Fortress'],
    heavensGate: ["Heaven's Gates", "Heaven's Gate"], hellPortal: ['Hell Portals', 'Hell Portal'],
  };
  const source = await readFile(new URL('../docs/原版设施建筑升级独特建筑与奖杯全量清单.md', import.meta.url), 'utf8');
  const nameSource = await readFile(new URL('../docs/无限工时-全量Upgrades与奖杯职场换皮名称对照.md', import.meta.url), 'utf8');
  const finalNameSource = await readFile(new URL('../docs/1.0.2 与 1.1.0 全版本条目译名修订与定稿清单.md', import.meta.url), 'utf8');
  const original = new Map();
  for (const line of source.split('\n')) {
    const parts = line.split('|').slice(1, -1).map(part => part.trim());
    if (parts.length < 9 || !/^\d+$/.test(parts[1])) continue;
    const entry = Object.entries(facilityNames).find(([, aliases]) => aliases.includes(parts[0]));
    if (entry) original.set(`${entry[0]}:${Number(parts[1])}`, parts);
  }
  const translatedNames = new Map();
  for (const line of nameSource.split('\n')) {
    const parts = line.split('|').slice(1, -1).map(part => part.trim());
    if (parts.length !== 5 || parts[0] !== '设施升级') continue;
    const match = parts[1].match(/^building:(.+):(\d+):(.+)$/);
    if (match) translatedNames.set(`${parts[2]}:${Number(match[2])}`, parts[4]);
  }
  const graph = compileContentGraph(CONTENT);
  const buildingNames = new Set([...graph.definitionsById.values()].filter(item => item.kind === 'building').map(item => item.name));
  const finalizedNames = new Map();
  for (const line of finalNameSource.split('## 第二部分')[0].split('\n')) {
    const parts = line.split('|').slice(1, -1).map(part => part.trim());
    if (parts.length !== 5 || !buildingNames.has(parts[0])) continue;
    finalizedNames.set(`${parts[0]}:${parts[2]}`, parts[3].replaceAll('**', ''));
  }
  assert.equal(original.size, 391);
  assert.equal(finalizedNames.size, 212);
  const percent = text => Number(text.match(/by ([\d.]+)%/)?.[1]);
  for (const [id, [plural, singular]] of Object.entries(facilityNames)) {
    for (const tier of Array.from({ length: 23 }, (_, index) => index + 1)) {
      const upgrade = graph.definitionsById.get(`${id}-tier${tier}`);
      const originalRow = original.get(`${id}:${tier}`);
      assert.ok(upgrade, `${id} tier ${tier} exists`);
      assert.ok(originalRow, `${id} tier ${tier} has a source row`);
      const translatedName = translatedNames.get(`${singular}:${tier}`);
      const expectedName = finalizedNames.get(`${graph.definitionsById.get(id).name}:${translatedName}`) || translatedName;
      assert.equal(upgrade.name, expectedName);
      assert.equal(upgrade.sourceName, originalRow[2]);
      assert.equal(upgrade.tier, tier);
      assert.equal(upgrade.era.minR, tier === 23 ? 100 : tier >= 20 ? 40 : 0);
      assert.equal(upgrade.era.maxA, 2);
      const expectedRequirement = Number(originalRow[3].match(/(\d+) [^\d]+$/)[1]);
      assert.deepEqual(upgrade.visible.all[1], { op: 'buildingOwned', id, value: expectedRequirement });
      assert.ok(originalRow[3].endsWith(`${expectedRequirement} ${originalRow[0]}`));
      assert.deepEqual(upgrade.purchase.requires, [{ op: 'notOwned', id: upgrade.id }]);
      const baseCost = graph.definitionsById.get(id).purchase.costs[0].amount.constant;
      const expectedCost = ascension => Math.round(baseCost * (1 + 0.15 / (ascension * 5 || 1)) ** expectedRequirement) * 10 * tier;
      const costAt = ascension => {
        const state = createSaveState(); state.progression.ascension = ascension;
        const costs = upgrade.purchase.costs.filter(cost => evaluateCondition(graph, cost.when, { state, derived: {} }));
        assert.equal(costs.length, 1, `${upgrade.id} has one active cost at A${ascension}`);
        return costs[0].amount.constant !== undefined ? costs[0].amount.constant : evaluateFormula(costs[0].amount.formula);
      };
      const rawData = BUILDING_UPGRADE_DATA[id][tier - 1];
      assert.equal(Object.hasOwn(rawData, 'cost'), false, `${upgrade.id} has no stored approximate cost`);
      if (id === 'farm' && tier === 1) {
        assert.equal(upgrade.purchase.costs.length, 1);
        assert.equal(costAt(0), 0, 'Farm tier 1 is free even at A0');
      } else if (tier <= 19) {
        assert.equal(originalRow[5], 'Free');
        assert.equal(upgrade.purchase.costs.length, 2);
        assertClose(costAt(0), expectedCost(0), `${upgrade.id} dynamic A0 cost`);
        assert.equal(costAt(1), 0);
        assert.equal(costAt(2), 0);
        assert.equal(Object.hasOwn(rawData, 'postPercent'), false);
      } else if (tier <= 22) {
        assert.equal(upgrade.purchase.costs.length, 3);
        assertClose(costAt(1), expectedCost(1), `${upgrade.id} dynamic A1 cost`);
        assert.equal(costAt(2), 0, `${upgrade.id} is free at A2`);
      } else {
        assert.equal(upgrade.purchase.costs.length, 3);
        assertClose(costAt(2), expectedCost(2), `${upgrade.id} dynamic A2 cost`);
      }
      const preParts = originalRow[6].split('<br>');
      const productionEffects = upgrade.effects.filter(effect => effect.stat === 'building.production');
      const correctedPercent = ['farm', 'inn', 'blacksmith'].includes(id) && tier === 19 ? 500
        : !['farm', 'inn', 'blacksmith'].includes(id) && tier >= 20 && tier <= 22 ? 75
          : percent(preParts[0]);
      assert.equal(productionEffects.length, 1);
      assert.equal(productionEffects[0].value.constant, correctedPercent, `${upgrade.id} shared A0/A1/A2 effect`);
      assert.equal(productionEffects[0].target.ids[0], id);
      assert.equal(productionEffects[0].when, undefined);
      const assistantEffects = upgrade.effects.filter(effect => effect.stat === 'assistants.count');
      assert.equal(assistantEffects.length, tier <= 2 ? 1 : 0);
      if (tier <= 2) {
        assert.equal(originalRow[8], 'Adds 1 Assistant');
        assert.equal(assistantEffects[0].value.constant, 1);
      }
    }
  }
});

test('building upgrade era gates and dynamic ascension purchase values work at runtime', async () => {
  const make = (reincarnations, ascension, farms = 5) => {
    const seeded = initial();
    seeded.progression.reincarnations = reincarnations;
    seeded.progression.ascension = ascension;
    seeded.buildings.farm = farms;
    return seeded;
  };
  const pre = fixture(make(0, 0));
  await pre.game.start();
  assert.equal(pre.game.select('content', { id: 'farm-tier1' }).costs[0].value, 0);
  assert.equal(pre.game.dispatch({ type: 'purchase', id: 'farm-tier1' }).ok, true);
  assertClose(pre.game.select('derived').outputs.farm, 20);
  assert.equal(pre.game.select('derived').assistants, 1);

  const post = fixture(make(40, 1));
  await post.game.start();
  assert.equal(post.game.select('content', { id: 'farm-tier1' }).costs[0].value, 0);
  assert.equal(post.game.dispatch({ type: 'purchase', id: 'farm-tier1' }).ok, true);
  assertClose(post.game.select('derived').outputs.farm, 5 * 2 * 2 * 21.1);
  assert.equal(post.game.select('derived').assistants, 45);

  const r39 = fixture(make(39, 1, 3500));
  await r39.game.start();
  assert.equal(r39.game.select('content', { id: 'farm-tier20' }).status, 'HIDDEN_SYSTEM');
  const r40 = fixture(make(40, 1, 3500));
  await r40.game.start();
  assert.notEqual(r40.game.select('content', { id: 'farm-tier20' }).status, 'HIDDEN_SYSTEM');
  assertClose(r40.game.select('content', { id: 'farm-tier20' }).costs[0].value, Math.round(10 * 1.03 ** 3500) * 200);

  const r100 = fixture(make(100, 2, 18000));
  await r100.game.start();
  assert.notEqual(r100.game.select('content', { id: 'farm-tier23' }).status, 'HIDDEN_SYSTEM');
  assertClose(r100.game.select('content', { id: 'farm-tier23' }).costs[0].value, Math.round(10 * 1.015 ** 18000) * 230);
  assert.equal(r100.game.select('content', { id: 'farm-tier20' }).costs[0].value, 0, 'tier 20–22 are free at A2');
  const a3 = fixture(make(160, 3, 18000));
  await a3.game.start();
  assert.equal(a3.game.select('content', { id: 'farm-tier1' }).status, 'HIDDEN_SYSTEM');
  assert.equal(a3.game.select('content', { id: 'farm-tier23' }).status, 'HIDDEN_SYSTEM');
});

test('all 323 early building upgrades keep identical actual multipliers across A0 A1 A2', () => {
  const graph = compileContentGraph(CONTENT);
  for (const building of graph.arraysByKind.get('building').filter(item => item.id !== 'hallOfLegends')) {
    for (let tier = 1; tier <= 19; tier++) {
      const id = `${building.id}-tier${tier}`;
      const expected = 1 + graph.definitionsById.get(id).effects.find(effect => effect.stat === 'building.production').value.constant / 100;
      for (let ascension = 0; ascension <= 2; ascension++) {
        const state = createSaveState();
        state.progression.ascension = ascension;
        state.buildings[building.id] = BUILDING_UPGRADE_DATA[building.id][tier - 1].requirement;
        state.owned.run[id] = true;
        const derived = computeDerived(state, graph);
        assertClose(derived.unitOutputs[building.id] / building.production, expected, `${id} at A${ascension}`);
      }
    }
  }
});

test('numbered upgrades, Fairy faction bonuses and Fairy Chanting compose in separate layers', async () => {
  const seeded = initial();
  seeded.buildings.farm = 25;
  seeded.owned.run['farm-tier1'] = true; seeded.owned.run['farm-tier2'] = true;
  seeded.owned.run['fairy-1'] = true; seeded.owned.run['fairy-2'] = true;
  seeded.spellSources.fairyChanting = { fairy: true };
  const { game } = fixture(seeded);
  await game.start();
  const fairyTwo = 5 * Math.log(3) ** 2.5;
  const expectedBase = 25 * 602 * 2 * 3 * (1 + fairyTwo / 100);
  assertClose(game.select('derived').outputs.farm, expectedBase);
  assert.equal(game.dispatch({ type: 'cast', id: 'fairyChanting' }).ok, true);
  const chanting = 20000 ** (1 + 0.02 * 25 ** 0.2);
  assertClose(game.select('derived').outputs.farm, expectedBase * chanting);
});


test('GitHub Pages time uses Date Age and round trip while local time stays offline', async () => {
  let monotonic = 100;
  let localWall = 1000;
  let fetchCalls = 0;
  const local = await createTrustedTime({
    hostname: 'localhost', href: 'http://localhost:4173/',
    fetchImpl: async () => { fetchCalls++; throw new Error('unexpected fetch'); },
    wallNow: () => localWall, monotonicNow: () => monotonic,
  });
  assert.equal(fetchCalls, 0);
  localWall = 999999;
  monotonic += 500;
  assert.equal(local.now(), 1500);
  assert.equal(local.isVerified(), false);

  const serverDate = Date.parse('Thu, 19 Nov 2026 04:23:07 GMT');
  const github = await createTrustedTime({
    hostname: 'ttt2718.github.io', href: 'https://ttt2718.github.io/moyugame/',
    fetchImpl: async url => {
      fetchCalls++;
      assert.equal(url.hostname, 'ttt2718.github.io');
      assert.equal(url.pathname, '/moyugame/');
      assert.ok(url.searchParams.has('__time'));
      monotonic += 100;
      return { ok: true, headers: new Headers({ Date: new Date(serverDate).toUTCString(), Age: '2' }) };
    },
    wallNow: () => 0, monotonicNow: () => monotonic,
  });
  assert.equal(github.isVerified(), true);
  assert.equal(github.now(), serverDate + 2050);
  monotonic += 1000;
  assert.equal(github.now(), serverDate + 3050);
});

test('signed save export and import preserve active spell dueAt timers', async () => {
  const first = fixture(initial());
  await first.game.start();
  assert.equal(first.game.dispatch({ type: 'purchase', id: 'good' }).ok, true);
  assert.equal(first.game.dispatch({ type: 'purchase', id: 'fairy' }).ok, true);
  assert.equal(first.game.dispatch({ type: 'cast', id: 'fairyChanting' }).ok, true);
  await first.game.save();
  const exported = first.adapter.listSlots().main;
  const importedAdapter = createSaveAdapter({ storage: createMemoryStorage() });
  importedAdapter.import(exported);
  const restored = createGameRuntime({ content: CONTENT, saveAdapter: importedAdapter, clock: first.clock });
  await restored.start();
  assert.deepEqual(restored.select('state').timers.spells.fairyChanting, { dueAt: 10 });
  assert.equal(restored.select('state').stats.run.spellCasts.fairyChanting, 1);
  assert.equal(restored.select('state').selections.faction, 'fairy');
  assert.equal(restored.select('state').resources.mana, 9200);
});

test('signed saves reject payload and trusted timestamp tampering but accept legacy saves', () => {
  const state = createSaveState({ now: 1000 });
  state.resources.coins = 500;
  const raw = encodeSave(state);
  assert.deepEqual(decodeSave(raw), { payload: state, legacy: false });
  const envelope = JSON.parse(raw);
  envelope.payload.resources.coins = 501;
  assert.throws(() => decodeSave(JSON.stringify(envelope)), /SAVE_INTEGRITY_MISMATCH/);
  const valid = encodeSave(state);
  const changedTime = JSON.parse(valid);
  changedTime.payload.lastWallClock = 0;
  assert.throws(() => decodeSave(JSON.stringify(changedTime)), /SAVE_INTEGRITY_MISMATCH/);
  assert.deepEqual(decodeSave(JSON.stringify(state)), { payload: state, legacy: true });
  assert.throws(() => decodeSave(JSON.stringify(state), { allowLegacy: false }), /UNSIGNED_SAVE_IMPORT/);
  const storage = createMemoryStorage();
  const adapter = createSaveAdapter({ storage });
  assert.throws(() => adapter.import(JSON.stringify(state)), /UNSIGNED_SAVE_IMPORT/);
  assert.equal(storage.getItem(SAVE_KEY), null);
  adapter.import(raw);
  assert.equal(decodeSave(storage.getItem(SAVE_KEY)).payload.resources.coins, 500);
});

test('save recovery re-signs mismatched payloads only through the explicit recovery method', () => {
  const state = createSaveState({ now: 1000 });
  state.resources.coins = 500;
  const envelope = JSON.parse(encodeSave(state));
  envelope.payload.resources.coins = 501;
  const damaged = JSON.stringify(envelope);
  const adapter = createSaveAdapter({ storage: createMemoryStorage() });
  assert.throws(() => adapter.import(damaged), /SAVE_INTEGRITY_MISMATCH/);
  assert.equal(decodeSave(damaged, { allowIntegrityMismatch: true }).integrityMismatch, true);
  adapter.recover(damaged);
  assert.equal(decodeSave(adapter.listSlots().main).payload.resources.coins, 501);
  assert.equal(adapter.listSlots().corrupt, damaged);
});

test('offline settlement caps all time at thirty days and tracks cumulative and maximum offline time', async () => {
  const unverified = fixture(initial());
  await unverified.game.start();
  const localReport = unverified.game.dispatch({ type: 'background.settle', seconds: 31 * 86400 }).report;
  assert.equal(localReport.seconds, 30 * 86400);
  assert.equal(localReport.requestedSeconds, 31 * 86400);
  assert.equal(localReport.verified, false);
  assert.equal(localReport.capped, true);
  assert.equal(unverified.game.select('state').stats.total.offlineTime, 30 * 86400);
  assert.equal(unverified.game.select('state').stats.total.offlineTimeMax, 30 * 86400);

  const seeded = initial();
  seeded.owned.run['goblin-9'] = true;
  const verified = fixture(seeded, { timeVerified: true });
  const facts = [];
  verified.game.subscribe(message => facts.push(...message.facts));
  await verified.game.start();
  const report = verified.game.dispatch({ type: 'background.settle', seconds: 31 * 86400 }).report;
  assert.equal(report.seconds, 30 * 86400);
  assert.equal(report.verified, true);
  assert.equal(report.capped, true);
  assert.equal(facts.some(fact => fact.type === 'greenFingersDiscount.triggered'), false);
  assert.ok(report.greenFingersMultiplier > 21 && report.greenFingersMultiplier < 101);
  assert.equal(verified.game.select('state').rng.streams.greenFingersDiscount.calls, 1);
  verified.game.dispatch({ type: 'background.settle', seconds: 60 });
  assert.equal(verified.game.select('state').stats.total.offlineTime, 30 * 86400 + 60);
  assert.equal(verified.game.select('state').stats.total.offlineTimeMax, 30 * 86400);
});

test('production clears saved mana override and rejects direct setting while developer mode remains available', async () => {
  const seeded = initial();
  seeded.settings.manaRegenOverride = 999;
  const production = fixture(seeded, { mode: 'production' });
  await production.game.start();
  assert.equal(production.game.select('state').settings.manaRegenOverride, null);
  const rejected = production.game.dispatch({ type: 'setting', key: 'manaRegenOverride', value: 7 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'DEVELOPER_LOCKED');
  assert.equal(await production.game.unlockDeveloper('0000'), false);
  assert.equal(await verifyDeveloperPassword('0000'), false);
  assert.equal(production.game.dispatch({ type: 'developer.reward' }).reason, 'DEVELOPER_LOCKED');
  const development = fixture(initial());
  await development.game.start();
  assert.equal(await development.game.unlockDeveloper('test'), true);
  const reward = development.game.dispatch({ type: 'developer.reward' });
  assert.equal(reward.ok, true);
  assert.equal(reward.result.amount, 1e60);
  assert.equal(development.game.select('state').resources.coins, 1e60);
  for (const scope of ['run', 'r', 'ascension', 'total']) assert.equal(development.game.select('state').stats[scope].coins, 1e60);
});


test('Park–Miller RNG matches known values, normalizes legacy state and exposes range helpers', () => {
  const known = { rng: createRngState() };
  known.rng.streams.known = { calls: 0, value: 1 };
  assert.equal(nextInt(known, 'known'), 16807);
  assert.equal(nextInt(known, 'known'), 282475249);
  assert.equal(nextInt(known, 'known'), 1622650073);
  assert.deepEqual(known.rng.streams.known, { calls: 3, value: 1622650073 });

  const normalized = { rng: createRngState() };
  normalized.rng.streams.legacy = { calls: 0, value: 0 };
  const normalizedZero = nextInt(normalized, 'legacy');
  assert.ok(normalizedZero >= 1 && normalizedZero <= 2147483646);
  normalized.rng.streams.legacy = { calls: 0, value: 2147483647 };
  assert.equal(nextInt(normalized, 'legacy'), 16807);

  const nextState = () => {
    const state = { rng: createRngState() };
    state.rng.streams.range = { calls: 0, value: 1 };
    return state;
  };
  const unit = nextDouble(nextState(), 'range');
  assert.equal(unit, 16807 / 2147483647);
  assert.equal(nextIntRange(nextState(), 'range', 2, 5), Math.round(1.5001 + 3.9998 * unit));
  assert.equal(nextDoubleRange(nextState(), 'range', 2, 5), 2 + 3 * unit);
  assert.equal(randRange(nextState(), 'range', 2, 5), 2 + 3 * unit);
  assert.equal(drawRandom(nextState(), 'range'), unit);
  const bounded = { rng: createRngState() };
  for (let index = 0; index < 100; index++) {
    const value = nextIntRange(bounded, 'bounded', -2, 2);
    assert.ok(Number.isInteger(value) && value >= -2 && value <= 2);
  }
});

test('RNG metadata validates declarations and drives saved/transient persistence', async () => {
  const template = CONTENT.definitions.find(item => item.id === 'gemPower');
  const transient = { ...template, id: 'test.transientRng', rngStream: 'test:transient', rngPersistence: 'transient' };
  const saved = { ...template, id: 'test.savedRng', rngStream: 'test:saved' };
  const spell = { ...CONTENT.definitions.find(item => item.id === 'taxCollection'), id: 'test.rngSpell', rngStream: 'test:spellSaved' };
  const content = { packs: CONTENT.packs, definitions: [...CONTENT.definitions, transient, saved, spell] };
  const graph = compileContentGraph(content);
  assert.equal(graph.rngPersistence['drops:factionCoin'], 'transient');
  assert.equal(graph.rngPersistence.greenFingersDiscount, 'saved');
  assert.equal(graph.rngPersistence['test:transient'], 'transient');
  assert.equal(graph.rngPersistence['test:saved'], 'saved');
  assert.equal(graph.rngPersistence['test:spellSaved'], 'saved');

  const { game, storage } = fixture(initial(), { content });
  await game.start();
  const state = game.select('state');
  state.rng.streams['drops:factionCoin'] = { calls: 1, value: 11 };
  state.rng.streams['test:transient'] = { calls: 2, value: 22 };
  state.rng.streams['test:saved'] = { calls: 3, value: 33 };
  state.rng.streams['test:spellSaved'] = { calls: 4, value: 44 };
  state.rng.streams.greenFingersDiscount = { calls: 5, value: 55 };
  await game.save();
  const persisted = decodeSave(storage.getItem(SAVE_KEY)).payload;
  assert.equal(persisted.rng.streams['drops:factionCoin'], undefined);
  assert.equal(persisted.rng.streams['test:transient'], undefined);
  assert.deepEqual(persisted.rng.streams['test:saved'], { calls: 3, value: 33 });
  assert.deepEqual(persisted.rng.streams['test:spellSaved'], { calls: 4, value: 44 });
  assert.deepEqual(persisted.rng.streams.greenFingersDiscount, { calls: 5, value: 55 });
  assert.ok(state.rng.streams['test:transient'], 'saving does not erase the live stream');

  const invalid = [
    { ...template, id: 'test.emptyRng', rngStream: '' },
    { ...template, id: 'test.unknownRng', rngStream: 'test:unknown', rngPersistence: 'other' },
    { ...template, id: 'test.orphanRng', rngPersistence: 'saved' },
    { ...template, id: 'test.conflictRng', rngStream: 'greenFingersDiscount', rngPersistence: 'transient' },
  ];
  assert.throws(() => compileContentGraph({ packs: CONTENT.packs, definitions: [...CONTENT.definitions, ...invalid] }), error => {
    assert.ok(error.errors.some(item => item.includes('rngStream must be non-empty')));
    assert.ok(error.errors.some(item => item.includes('unknown rngPersistence')));
    assert.ok(error.errors.some(item => item.includes('rngPersistence requires rngStream')));
    assert.ok(error.errors.some(item => item.includes('conflicting rngPersistence')));
    return true;
  });
});

test('shared random cache allocates small amounts individually and large amounts with equal base shares', async () => {
  const run = async amount => {
    const content = {
      packs: CONTENT.packs,
      definitions: CONTENT.definitions.map(item => item.id === 'goblinsGreed' ? {
        ...item, castActions: [{ type: 'grantResource', resource: 'factionCoin.randomEligible', amount: { constant: amount } }],
      } : item),
    };
    const seeded = initial(); seeded.spellSources.goblinsGreed = { goblin: true };
    const { game } = fixture(seeded, { content });
    await game.start();
    game.dispatch({ type: 'cast', id: 'goblinsGreed' });
    assert.equal(game.select('state').stats.run.factionCoins, 0);
    game.tick(0.2);
    return game.select('state').resources.factionCoins;
  };
  const small = await run(5);
  assert.equal(Object.values(small).reduce((sum, value) => sum + value, 0), 5);
  assert.ok(Object.values(small).every(value => Number.isInteger(value) && value >= 0 && value <= 5));
  const large = await run(1000);
  assert.equal(Object.values(large).reduce((sum, value) => sum + value, 0), 1000);
  assert.ok(Object.values(large).every(value => value >= 150));
  assert.ok(Object.values(large).some(value => value > 150));
});

test('Greed uses effective gems for Q and era found for its production buff', async () => {
  const seeded = initial();
  seeded.resources.gems = 100;
  seeded.buildings.farm = 10;
  seeded.stats.run.factionCoinsByFaction.goblin = 100;
  seeded.stats.ascension.factionCoinsByFaction.goblin = 1000;
  seeded.spellSources.goblinsGreed = { goblin: true };
  const { game } = fixture(seeded);
  await game.start();
  const cast = game.dispatch({ type: 'cast', id: 'goblinsGreed' });
  assert.equal(cast.ok, true);
  assertClose(game.select('factionCoins').pending, 80 + 2.25 * Math.log(110) ** 2.25);
  const buff = 1 + (30 + 3 * Math.log(1001) ** 3) / 100;
  assertClose(game.select('derived').outputs.farm, 20 * buff);
});

test('FR4 performs one automatic click per active spell per accumulated second', async () => {
  const seeded = initial();
  seeded.selections.alignment = 'good';
  seeded.owned.run['fairy-4'] = true;
  const { game } = fixture(seeded);
  await game.start();
  game.dispatch({ type: 'cast', id: 'callToArms' });
  game.dispatch({ type: 'cast', id: 'holyLight' });
  game.tick(0.2);
  assert.equal(game.select('state').stats.run.clicks, 0);
  game.tick(1); game.tick(1); game.tick(1);
  assert.equal(game.select('state').stats.run.clicks, 6);
  assertClose(game.select('state').stats.run.clickCoins, game.select('derived').clickReward * 6);
  assert.ok(game.select('state').stats.run.coins >= game.select('state').stats.run.clickCoins);
});

test('assistant accumulator preserves fractions, caps frames, skips offline and rolls back transactions', async () => {
  const chance = {
    ...CONTENT.definitions.find(item => item.id === 'gemPower'), id: 'test.accumulatorChance',
    effects: [{ group: 'test.accumulatorChance', phase: 'factionCoin', stat: 'factionCoin.chance', target: { type: 'global' }, operation: 'add', value: { constant: 140 }, stacking: 'add' }],
  };
  const content = { packs: CONTENT.packs, definitions: [...CONTENT.definitions, chance] };
  const seeded = initial();
  seeded.owned.run['farm-tier1'] = true; seeded.owned.run['farm-tier2'] = true; seeded.owned.run[chance.id] = true;
  const { game } = fixture(seeded, { content });
  await game.start();
  for (let index = 0; index < 9; index++) game.tick(0.1);
  assert.equal(game.select('state').stats.run.factionCoins, 0);
  const offline = game.dispatch({ type: 'background.settle', seconds: 10 });
  assert.equal(offline.report.factionCoinsPending, 30);
  game.tick(0.1);
  assert.equal(game.select('state').stats.run.factionCoins, 39, 'offline time does not advance the online accumulator');
  game.tick(50); game.tick(50);
  assert.equal(game.select('state').stats.run.factionCoins, 39, 'each large frame contributes only one third of a second');
  game.tick(50);
  assert.equal(game.select('state').stats.run.factionCoins, 48);
  const unsubscribe = game.subscribe(message => { if (message.commandType === 'tick') throw new Error('forced rollback'); });
  assert.equal(game.tick(50).ok, false);
  assert.equal(game.select('state').stats.run.factionCoins, 48);
  unsubscribe();
  game.tick(50); game.tick(50);
  assert.equal(game.select('state').stats.run.factionCoins, 48);
  game.tick(50);
  assert.equal(game.select('state').stats.run.factionCoins, 57, 'failed tick restores the fractional accumulator');
});

test('failed flush transaction rolls back the shared FC cache without losing it', async () => {
  const seeded = initial(); seeded.spellSources.goblinsGreed = { goblin: true };
  const { game } = fixture(seeded);
  await game.start();
  game.dispatch({ type: 'cast', id: 'goblinsGreed' });
  const pending = game.select('factionCoins').pending;
  const unsubscribe = game.subscribe(message => { if (message.commandType === 'tick') throw new Error('forced rollback'); });
  assert.equal(game.tick(0.2).ok, false);
  assert.equal(game.select('state').stats.run.factionCoins, 0);
  assert.equal(game.select('factionCoins').pending, pending);
  unsubscribe();
  game.tick(0.2);
  assert.equal(game.select('state').stats.run.factionCoins, Math.floor(pending));
});

test('abdication and reincarnation preserve in-memory RNG streams', async () => {
  const seeded = initial();
  seeded.stats.run.coins = 1e12;
  seeded.resources.gems = 1e27;
  const { game } = fixture(seeded);
  await game.start();
  game.dispatch({ type: 'work' });
  const beforeRetirement = structuredClone(game.select('state').rng);
  assert.equal(game.dispatch({ type: 'abdicate' }).ok, true);
  assert.deepEqual(game.select('state').rng, beforeRetirement);
  game.dispatch({ type: 'work' });
  const beforeReincarnation = structuredClone(game.select('state').rng);
  assert.equal(game.dispatch({ type: 'reincarnate' }).ok, true);
  assert.deepEqual(game.select('state').rng, beforeReincarnation);
});

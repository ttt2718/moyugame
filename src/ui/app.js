import { CONTENT } from '../content/index.js';
import { createGameRuntime } from '../systems/runtime.js';
import { createSaveAdapter } from '../systems/persistence.js';
import { formatNumber, formatTime } from '../core/number.js';
import { createStoryModal } from './story/story-modal.js';
import { evaluateCondition, formatDescription, pathValue } from '../systems/content-registry.js';
import { evaluateFormula } from '../systems/formula.js';
import { resolveValuePath } from '../systems/derived.js';
import { effectiveClicksR, elvenDiplomacyBonus, spellDuration } from '../systems/effective.js';
import { createTrustedTime } from '../core/trusted-time.js';

const $ = id => document.getElementById(id);
const editableSelector = 'input, textarea, [contenteditable="true"]';
function editableElement(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  return element?.closest(editableSelector) || null;
}
function clearUnexpectedSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || editableElement(selection.anchorNode)) return;
  selection.removeAllRanges();
}
for (const eventName of ['selectstart', 'contextmenu', 'dragstart']) {
  document.addEventListener(eventName, event => {
    if (!editableElement(event.target)) event.preventDefault();
  }, true);
}
document.addEventListener('selectionchange', clearUnexpectedSelection);

/**
 * 注入部门影响力（Faction Coin）网格布局与悬浮/点击/长按名称提示样式：
 * 1. 每行至少排列两个部门（auto-fit + min(44%, 84px) 保证窄屏与弹窗内也至少两列）。
 * 2. 默认仅展示图标与数值，名称通过固定定位的 tooltip 展示，避免被父容器裁剪。
 */
function ensureFactionCoinStyles() {
  if (document.getElementById('faction-coin-ui-style')) return;
  const style = document.createElement('style');
  style.id = 'faction-coin-ui-style';
  style.textContent = `
    #factionCoinList {
      display: grid !important;
      grid-template-columns: repeat(auto-fit, minmax(min(44%, 84px), 1fr)) !important;
      gap: 6px 8px !important;
      align-items: center;
    }
    #factionCoinList .faction-coin-item {
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      gap: 6px;
      min-width: 0;
      padding: 4px 8px;
      border-radius: 8px;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      touch-action: manipulation;
      transition: background-color 0.15s ease, transform 0.12s ease;
    }
    #factionCoinList .faction-coin-item:hover,
    #factionCoinList .faction-coin-item:focus-visible,
    #factionCoinList .faction-coin-item.fc-tooltip-open {
      background: rgba(255, 255, 255, 0.1);
      outline: none;
    }
    #factionCoinList .faction-coin-item img {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      object-fit: contain;
      pointer-events: none;
    }
    #factionCoinList .faction-coin-item b {
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    .faction-coin-tooltip {
      position: fixed;
      left: 0;
      top: 0;
      z-index: 9999;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(15, 23, 42, 0.95);
      color: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.35);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.38);
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.14s ease, visibility 0.14s ease;
    }
    #factionCoinList .faction-coin-item.fc-tooltip-open .faction-coin-tooltip {
      opacity: 1;
      visibility: visible;
    }
  `;
  document.head.appendChild(style);
}
ensureFactionCoinStyles();

const money = value => `¥ ${formatNumber(value)}`;
const saveAdapter = createSaveAdapter();
let game;
let graph;
let timeSource;
let currentUserId = '';
let resetting = false;
let importingSave = false;
let pendingSaveRecovery = null;
let activeTab = 'work';
let panelReturnFocus = null;
let panelHistory = false;
let quickStructure = '';
let facilityStructure = '';
let lastUpgradeRailRender = 0;
let upgradeRailStructure = '';
const expandedUpgradeCollections = new Set();
const collapsedTrophyGroups = new Set();
let manaEditorUnlocked = false;
let logs = ['打卡成功。系统提示：请勿寻找公司的出口。'];
let toastTimer;
let lastCoinSound = 0;
let lastTick = performance.now();
let backgroundStartedAt = null;
let backgroundRetryAfter = 0;
const assistantFactionCoinGains = new Map();
const coinSoundPools = Array.from({ length: 8 }, (_, index) => {
  const pool = Array.from({ length: 3 }, () => {
    const audio = new Audio(`assets/audio/coin-${String(index + 1).padStart(2, '0')}.ogg`);
    audio.preload = 'auto'; return audio;
  });
  pool.index = 0; return pool;
});
const trophySound = new Audio('assets/audio/trophy-unlocked.wav');
trophySound.preload = 'auto';
trophySound.volume = 0.18;
function playTrophySound() {
  trophySound.currentTime = 0;
  trophySound.play().catch(() => {});
}
const purchaseSounds = {
  building: new Audio('assets/audio/register-buy.wav'),
  upgrade: new Audio('assets/audio/register-buy.wav'),
};
for (const audio of Object.values(purchaseSounds)) {
  audio.preload = 'auto';
  audio.volume = 0.2;
}
function playPurchaseSound(kind) {
  const audio = purchaseSounds[kind];
  audio.currentTime = 0;
  audio.play().catch(() => {});
}
const state = () => game.select('state');
const derived = () => game.select('derived');
const playerRole = () => '员工';
const definition = id => graph.definitionsById.get(id);
const effectValue = effect => {
  if (!effect) return 0;
  if (effect.value.constant !== undefined) return Number(effect.value.constant);
  const targetId = effect.target?.type === 'buildings' ? effect.target.ids[0]
    : effect.target?.type === 'tier' ? content('building').find(item => item.tier === effect.target.id && (item.alignment === 'any' || item.alignment === state().selections.alignment))?.id : null;
  const target = targetId ? definition(targetId) : null;
  const variables = Object.fromEntries(Object.entries(effect.value.variables || {}).map(([name, path]) => [
    name, resolveValuePath(path, { state: state(), graph, target, derived: derived() }),
  ]));
  return evaluateFormula(effect.value.formula, variables);
};
const description = item => {
  let text = formatDescription(item, graph);
  const context = { state: state(), derived: derived() };
  const activeEffect = stat => effectValue(item.effects.find(candidate => candidate.stat === stat
    && (!candidate.when || evaluateCondition(graph, candidate.when, context))));
  if (text.includes('{activeProductionPercent}')) text = text.replaceAll('{activeProductionPercent}', formatNumber(activeEffect('building.production')));
  if (text.includes('{activeGlobalPercent}')) text = text.replaceAll('{activeGlobalPercent}', formatNumber(activeEffect('global.production')));
  text = text.replace(/\{effect:([^}]+)\}/g, (_, group) => formatNumber(effectValue(item.effects.find(effect => effect.group === group))));
  text = text.replace(/\{castAmount:(\d+)\}/g, (_, index) => {
    const action = item.castActions?.[Number(index)];
    return action ? formatNumber(Math.floor(effectValue({ value: action.amount }))) : '0';
  });
  if (text.includes('{maxManaTaxTimes}')) text = text.replaceAll('{maxManaTaxTimes}', formatNumber(1 + Math.floor(1.5 * Math.log(1 + derived().manaMax / 1000) ** 1.5)));
  if (text.includes('{spellDuration}')) text = text.replaceAll('{spellDuration}', formatNumber(spellDuration(state(), graph, item, derived())));
  if (text.includes('{elvenDiplomacyBonus}')) text = text.replaceAll('{elvenDiplomacyBonus}', formatNumber(elvenDiplomacyBonus(state())));
  if (text.includes('{effectiveClicksR}')) text = text.replaceAll('{effectiveClicksR}', formatNumber(effectiveClicksR(state())));
  return text.includes('{taxSeconds}') ? text.replaceAll('{taxSeconds}', formatNumber(derived().taxSeconds)) : text;
};
const formatCost = (cost, targetId = null) => {
  if (cost.resource === 'coins') return money(cost.value);
  if (cost.resource === 'mana') return `${formatNumber(cost.value)} 精力`;
  if (cost.resource.startsWith('factionCoin.')) {
    const resourceId = cost.resource.slice('factionCoin.'.length);
    const factionId = resourceId === 'target' ? targetId : resourceId;
    const faction = definition(factionId);
    return `${formatNumber(cost.value)} ${faction?.name || factionId}影响力`;
  }
  return `${formatNumber(cost.value)} ${cost.resource}`;
};
const content = kind => graph.arraysByKind.get(kind) || [];
const view = id => game.select('content', { id });
const visible = kind => content(kind).filter(item => view(item.id).status !== 'HIDDEN_SYSTEM');

function notify(text, error = false, kind = '') {
  logs.unshift(text); logs = logs.slice(0, 8);
  $('toast').textContent = text;
  $('toast').classList.toggle('error', error);
  $('toast').classList.toggle('trophy-toast', kind === 'trophy');
  $('toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
  renderLogs();
}
function playCoinSound() {
  const now = performance.now(); if (now - lastCoinSound < 65) return;
  lastCoinSound = now;
  const pool = coinSoundPools[Math.floor(Math.random() * coinSoundPools.length)];
  const audio = pool[pool.index++ % pool.length];
  audio.currentTime = 0; audio.volume = 0.13; audio.playbackRate = 0.94 + Math.random() * 0.24;
  audio.play().catch(() => {});
}
function workFeedback(event, facts = []) {
  playCoinSound();
  const zone = document.querySelector('#workArea .work-zone');
  const button = zone.querySelector('.work-btn');
  const rect = zone.getBoundingClientRect();
  const x = event?.clientX ? event.clientX - rect.left : rect.width / 2;
  const y = event?.clientY ? event.clientY - rect.top : Math.min(150, rect.height * 0.4);
  button.classList.remove('coin-hit'); void button.offsetWidth; button.classList.add('coin-hit');
  setTimeout(() => button.classList.remove('coin-hit'), 180);
  const floater = document.createElement('span'); floater.className = 'coin-float';
  floater.textContent = `+${money(viewModelReward())}`; floater.style.left = `${x}px`; floater.style.top = `${y}px`;
  zone.appendChild(floater); setTimeout(() => floater.remove(), 800);
  showManualFactionCoins(facts, zone, x, y);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let index = 0; index < 5; index++) {
    const particle = document.createElement('img'); particle.className = 'coin-particle';
    particle.src = `assets/images/${Math.random() > 0.25 ? 'coin' : 'cash'}.png`; particle.alt = '';
    particle.style.left = `${x + (Math.random() - 0.5) * 35}px`; particle.style.top = `${y}px`;
    particle.style.setProperty('--dx', `${(Math.random() - 0.5) * 150}px`); particle.style.setProperty('--dy', `${-60 - Math.random() * 90}px`);
    particle.style.setProperty('--spin', `${(Math.random() - 0.5) * 480}deg`);
    zone.appendChild(particle); setTimeout(() => particle.remove(), 750);
  }
}
let lastAutoClickVisual = 0;
function autoWorkFeedback(facts) {
  const now = performance.now();
  if (now - lastAutoClickVisual < 90) return;
  lastAutoClickVisual = now;
  workFeedback(null, facts);
}
function viewModelReward() { return derived().clickReward; }
function formatFactionCoinGain(amount) {
  if (amount < 10 && amount % 1 !== 0) return amount.toFixed(amount < 1 ? 2 : 1).replace(/\.?0+$/, '');
  return formatNumber(amount);
}
function factionCoinGainText(factionId, amount) {
  return `+${formatFactionCoinGain(amount)} ${definition(factionId).name}影响力`;
}
function showManualFactionCoins(facts, zone, x, y) {
  facts.filter(fact => fact.type === 'factionCoins.found' && ['manualClick', 'autoClick'].includes(fact.payload.source)).forEach((fact, index) => {
    const floater = document.createElement('span');
    floater.className = 'faction-coin-float manual-faction-coin-float';
    floater.dataset.fcSource = 'manualClick';
    floater.dataset.faction = fact.payload.factionId;
    floater.textContent = factionCoinGainText(fact.payload.factionId, fact.payload.amount);
    floater.style.left = `${x}px`;
    floater.style.top = `${Math.max(24, y - 26 - index * 20)}px`;
    zone.appendChild(floater);
    setTimeout(() => floater.remove(), 1100);
  });
}
function queueAssistantFactionCoin({ factionId, amount }) {
  assistantFactionCoinGains.set(factionId, (assistantFactionCoinGains.get(factionId) || 0) + amount);
}

/**
 * 共享缓存入账的部门影响力浮字：同批各部门使用同一初始位置，并错开生成时间。
 */
function showAssistantFactionCoins() {
  const factionOrder = new Map(content('faction').map((item, idx) => [item.id, idx]));
  const batch = [...assistantFactionCoinGains.entries()]
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => (factionOrder.get(a) ?? 999) - (factionOrder.get(b) ?? 999));
  assistantFactionCoinGains.clear();
  const container = $('assistantFactionCoinFx');
  if (!container || document.hidden || !batch.length) return;
  batch.forEach(([factionId, amount], index) => {
    setTimeout(() => {
      if (!container.isConnected || document.hidden) return;
      const floater = document.createElement('span');
      floater.className = 'faction-coin-float assistant-faction-coin-floater';
      floater.dataset.fcSource = 'randomCache';
      floater.dataset.faction = factionId;
      floater.textContent = factionCoinGainText(factionId, amount);
      container.appendChild(floater);
      setTimeout(() => floater.remove(), 1200);
    }, index * 100);
  });
}

function showAssistantIncome() {
  const container = $('assistantIncomeFx');
  if (!container || document.hidden) return;
  const amount = derived().assistantProduction;
  if (!amount || amount <= 0) { container.replaceChildren(); return; }
  const floater = document.createElement('span');
  floater.className = 'assistant-income-floater';
  floater.textContent = `+${money(amount)}`;
  container.appendChild(floater);
  setTimeout(() => floater.remove(), 1200);
}

function renderLogs() {
  $('latestLog').textContent = logs[0] || '暂无记录';
  $('eventLogItems').innerHTML = logs.map(item => `<li>${item}</li>`).join('');
}
function setEventLogOpen(open, restoreFocus = false) {
  $('eventLog').hidden = !open; $('logToggle').setAttribute('aria-expanded', String(open));
  if (open) $('logClose').focus({ preventScroll: true });
  else if (restoreFocus) $('logToggle').focus({ preventScroll: true });
}
function buyControls() {
  const current = state().settings.buyAmount;
  return `<div class="buy-controls" aria-label="采购数量">${[1, 10, 'max'].map(value => `<button data-action="buy-amount" data-value="${value}" aria-pressed="${current === value}" class="${current === value ? 'active' : ''}">${String(value).toUpperCase()}</button>`).join('')}</div>`;
}
function buildingCard(item, location) {
  const tooltipId = `building-tooltip-${location}-${item.id}`;
  return `<button type="button" class="card building-card" data-action="purchase" data-building-card data-id="${item.id}" aria-describedby="${tooltipId}">
    <img class="building-icon" src="${item.ui.icon}" alt=""><span class="building-name"><b>${item.name}</b><small data-field="count">× 0</small></span>
    <span class="building-output" data-field="output">本次 +¥ 0 / 秒</span><span class="building-price" data-field="cost"></span>
    <span class="building-buy"><b data-field="quantity"></b><small>点击采购</small></span>
    <span class="building-tooltip" id="${tooltipId}" role="tooltip" aria-hidden="true"><b>${item.name}</b><small data-field="tooltip-count">当前 0 个</small><span class="building-tooltip-row"><span>单个产出</span><strong data-field="unit-output">¥ 0 / 秒</strong></span><span class="building-tooltip-row"><span>当前总产出</span><strong data-field="total-output">¥ 0 / 秒</strong></span>${item.ui.metric === 'hallOfLegends' ? '<span class="building-tooltip-row hall-metrics" data-field="hall-metrics"></span>' : ''}</span></button>`;
}
function updateBuildingCards() {
  document.querySelectorAll('[data-building-card]').forEach(card => {
    const model = view(card.dataset.id);
    if (!model.viewModel) return;
    const count = model.viewModel.count;
    const unitOutput = derived().unitOutputs[card.dataset.id] || 0;
    const totalOutput = derived().outputs[card.dataset.id] || 0;
    card.querySelector('[data-field="count"]').textContent = `× ${formatNumber(count)}`;
    card.querySelector('[data-field="output"]').textContent = `本次 +${money(model.viewModel.purchaseProduction)} / 秒`;
    card.querySelector('[data-field="cost"]').textContent = money(model.costs[0]?.value || 0);
    card.querySelector('[data-field="quantity"]').textContent = `+${model.quantity || 0}`;
    card.querySelector('[data-field="tooltip-count"]').textContent = `当前 ${formatNumber(count)} 个`;
    card.querySelector('[data-field="unit-output"]').textContent = `${money(unitOutput)} / 秒`;
    card.querySelector('[data-field="total-output"]').textContent = `${money(totalOutput)} / 秒`;
    const hallMetrics = card.querySelector('[data-field="hall-metrics"]');
    if (hallMetrics) {
      const current = derived();
      const otherMultiplier = content('upgrade').filter(item => item.buildingId === 'hallOfLegends' && item.trophyCoefficient && state().owned.run[item.id])
        .reduce((multiplier, item) => multiplier * (1 + item.trophyCoefficient * current.originalTrophies), 1);
      const selfMultiplier = current.hallBaseProduction > 0 ? unitOutput / (current.hallBaseProduction * current.globalMult) : 0;
      hallMetrics.textContent = `奖杯 ${formatNumber(current.originalTrophies)} · 每座基础 ${money(current.hallBaseProduction)} · 自身倍率 ×${formatNumber(selfMultiplier)} · 其他设施倍率 ×${formatNumber(otherMultiplier)}`;
    }
    const unavailable = model.status === 'NEED_RESOURCE';
    card.setAttribute('aria-disabled', String(unavailable));
    card.classList.toggle('insufficient', unavailable);
    card.setAttribute('aria-label', `${model.viewModel.name}，当前 ${count} 个，单个每秒产出 ${money(unitOutput)}，当前总产出每秒 ${money(totalOutput)}，价格 ${money(model.costs[0]?.value || 0)}`);
  });
  document.querySelectorAll('[data-action="buy-amount"]').forEach(button => {
    const value = button.dataset.value === 'max' ? 'max' : Number(button.dataset.value);
    button.classList.toggle('active', state().settings.buyAmount === value);
    button.setAttribute('aria-pressed', String(state().settings.buyAmount === value));
  });
}
function renderFacilityRail() {
  const items = visible('building');
  const signature = items.map(item => item.id).join(',');
  if (signature !== facilityStructure) {
    $('facilityRail').innerHTML = `<div class="facility-head"><div><small>常驻设施</small><h2>设施采购</h2></div>${buyControls()}</div><div class="facility-scroll panel-scroll"><div class="card-grid building-grid">${items.map(item => buildingCard(item, 'rail')).join('')}</div></div>`;
    facilityStructure = signature;
  }
  updateBuildingCards();
}
function upgradeAction(item) { return item.interaction === 'royalMarket' ? 'open-royal-market' : 'purchase'; }
function quickUpgradeCard(item) {
  const model = view(item.id);
  const tooltipId = `upgrade-tooltip-rail-${item.id}`;
  const text = description(item);
  const marketEntry = item.interaction === 'royalMarket';
  const cost = marketEntry ? '交换窗口' : model.costs.map(cost => formatCost(cost, item.id)).join(' + ') || '无需工资';
  return `<article class="upgrade-entry quick-upgrade-entry" data-upgrade-card="${item.id}"><button type="button" class="upgrade-icon affordable" data-action="${upgradeAction(item)}" data-id="${item.id}" aria-describedby="${tooltipId}"><img src="${item.ui.icon}" alt=""><span>${item.name}</span><small>${marketEntry ? '打开' : money(model.costs[0]?.value || 0)}</small></button><span class="upgrade-tooltip" id="${tooltipId}" role="tooltip" aria-hidden="true"><b>${item.name}</b><span class="upgrade-tooltip-cost" data-field="cost">${cost}</span><span class="upgrade-tooltip-description">${text}</span><small data-field="hint">${marketEntry ? '点击打开' : '点击购买'}</small></span></article>`;
}
function renderUpgradeRail() {
  const now = performance.now();
  if (now - lastUpgradeRailRender < 500) return;
  if (activeUpgradeTooltip?.closest('#upgradeRail') || upgradeLongPress?.button.closest('#upgradeRail')) return;
  lastUpgradeRailRender = now;
  const candidates = sortedUpgrades(visible('upgrade').filter(item => view(item.id).status === 'PURCHASABLE'));
  const signature = candidates.map(item => `${item.id}:${view(item.id).costs[0]?.value || 0}:${description(item)}`).join('|');
  if (signature === upgradeRailStructure) return;
  upgradeRailStructure = signature;
  $('upgradeRail').innerHTML = candidates.length ? candidates.map(quickUpgradeCard).join('') : '<span class="rail-empty">暂无可购买升级</span>';
}
function workView() {
  return `<div id="skillMount"></div><section class="work-zone">
    <div class="office-window"><div class="window-view"></div></div>
    <button class="work-btn" data-action="work" aria-label="点击工位搬砖"><img class="workstation-img" src="assets/images/workstation-neon.svg" alt="霓虹夜班工作站，点击工位任意位置搬砖"></button>
    <div class="work-caption">今日待办：∞　　距离下班：--:--　　当前职级：R${state().progression.reincarnations}</div></section>`;
}
const QUICK_SKILL_LIMIT = 12;
function quickLimit() { return innerWidth >= 1200 ? QUICK_SKILL_LIMIT : innerWidth >= 901 ? 8 : 4; }
function quickSkillIds(limit = quickLimit()) {
  const available = visible('spell');
  const ids = new Set(available.map(item => item.id));
  const configured = Array.isArray(state().settings.quickSkills) ? state().settings.quickSkills : available.map(item => item.id);
  return configured.filter(id => ids.has(id)).slice(0, limit);
}
function spellUpgrade(item) {
  return item.ui.upgradeId && state().owned.run[item.ui.upgradeId] ? definition(item.ui.upgradeId) : null;
}
function spellIcon(item) {
  return spellUpgrade(item) ? item.ui.upgradedIcon : item.ui.icon;
}
function spellName(item) {
  return spellUpgrade(item)?.name || item.name;
}
function spellDescription(item) {
  const upgrade = spellUpgrade(item);
  return upgrade ? `${description(item)} 升级：${description(upgrade)}` : description(item);
}
function skillButton(item) {
  const tooltipId = `skill-tooltip-${item.id}`;
  return `<button class="skill-btn skill-card" data-skill-card="${item.id}" data-action="cast" data-id="${item.id}" aria-describedby="${tooltipId}"><span class="skill-card-icon"><img src="${spellIcon(item)}" alt=""></span><b>${spellName(item)}</b><small class="skill-card-description">${spellDescription(item)}</small><em></em><span class="upgrade-tooltip skill-tooltip" id="${tooltipId}" role="tooltip" aria-hidden="true"><b>${spellName(item)}</b><span class="upgrade-tooltip-cost" data-skill-tooltip-status></span><span class="upgrade-tooltip-description">${spellDescription(item)}</span></span></button>`;
}
function renderQuickSkills() {
  const available = visible('spell');
  const quick = quickSkillIds().map(definition);
  const signature = `${quickLimit()}|${available.map(item => item.id).join(',')}|${quickSkillIds(QUICK_SKILL_LIMIT).join(',')}|${quick.map(item => `${spellName(item)}|${spellDescription(item)}|${spellIcon(item)}`).join('|')}`;
  if (signature === quickStructure) return;
  quickStructure = signature;
  $('skillMount').innerHTML = available.length ? `<section class="skill-shortcuts" aria-label="快捷技能"><div class="skill-bar-head"><small>快捷技能</small><button data-tab="skills" aria-controls="mainPanel">全部技能（${available.length}）</button></div>${quick.length ? `<div class="skill-bar" style="--quick-count: ${quick.length}">${quick.map(skillButton).join('')}</div>` : '<p class="notice skill-empty">快捷栏已清空，可在全部技能中重新添加。</p>'}</section>` : '<p class="notice skill-notice">选择部门立场或签署条约后解锁技能。</p>';
}
function updateCastButtons() {
  document.querySelectorAll('[data-action="cast"]').forEach(button => {
    const model = view(button.dataset.id);
    if (!model.viewModel) return;
    button.disabled = model.status === 'NEED_RESOURCE';
    button.classList.toggle('active', model.viewModel.active);
    button.classList.toggle('insufficient', button.disabled);
    const status = model.viewModel.active ? `生效中 ${formatNumber(model.viewModel.remaining)} 秒` : `${formatNumber(model.costs[0]?.value || 0)} 精力`;
    const item = definition(button.dataset.id);
    const text = spellDescription(item);
    const small = button.querySelector('small'); if (small) small.textContent = text;
    const em = button.querySelector('em'); if (em) em.textContent = status;
    const tooltipStatus = button.querySelector('[data-skill-tooltip-status]'); if (tooltipStatus) tooltipStatus.textContent = status;
    const tooltipDescription = button.querySelector('.skill-tooltip .upgrade-tooltip-description'); if (tooltipDescription) tooltipDescription.textContent = text;
    const row = button.closest('[data-skill-row]');
    const rowStatus = row?.querySelector('[data-skill-status]'); if (rowStatus) rowStatus.textContent = status;
    const rowDescription = row?.querySelector('.skill-copy p'); if (rowDescription) rowDescription.textContent = text;
    button.setAttribute('aria-label', `${spellName(item)}。${text}，${status}`);
  });
}
function updateQuickSkill(id, mode) {
  const available = visible('spell');
  if (!available.some(item => item.id === id)) return;
  const configured = Array.isArray(state().settings.quickSkills) ? state().settings.quickSkills.filter(item => available.some(spell => spell.id === item)) : available.map(item => item.id);
  const next = configured.filter(item => item !== id);
  if (mode !== 'remove') next.unshift(id);
  game.dispatch({ type: 'setting', key: 'quickSkills', value: [...new Set(next)].slice(0, 6) });
}

function buildingPanel() {
  return `<div class="panel-head"><div><h2>设施采购</h2><p>点击设施卡，按当前数量直接采购。</p></div>${buyControls()}</div><div class="card-grid building-grid">${visible('building').map(item => buildingCard(item, 'panel')).join('')}</div>`;
}
function upgradeCard(item) {
  const status = view(item.id).status;
  const statusClass = ['OWNED', 'SELECTED'].includes(status) ? 'owned' : status === 'NEED_RESOURCE' ? 'insufficient' : '';
  const tooltipId = `upgrade-tooltip-${item.id}`;
  return `<article class="upgrade-entry ${statusClass}" data-upgrade-card="${item.id}"><button type="button" class="upgrade-entry-button" data-action="${upgradeAction(item)}" data-id="${item.id}" aria-describedby="${tooltipId}"><img class="upgrade-entry-icon" src="${item.ui.icon}" alt=""></button><span class="upgrade-tooltip" id="${tooltipId}" role="tooltip" aria-hidden="true"><b>${item.name}</b><span class="upgrade-tooltip-cost" data-field="cost"></span><span class="upgrade-tooltip-description">${description(item)}</span><small data-field="hint"></small></span></article>`;
}
function sortedUpgrades(items) {
  const order = { PURCHASABLE: 0, NEED_RESOURCE: 1, AVAILABLE_UNAFFORDABLE: 1, LOCKED_REQUIREMENT: 2, OWNED: 3, SELECTED: 3 };
  return [...items].sort((left, right) => {
    if (left.interaction === 'royalMarket' || right.interaction === 'royalMarket') {
      if (left === right) return 0;
      return left.interaction === 'royalMarket' ? -1 : 1;
    }
    return (order[view(left.id).status] ?? 4) - (order[view(right.id).status] ?? 4);
  });
}
function collectionEffect(building, items) {
  const context = { state: state(), derived: derived() };
  let productionMultiplier = 1;
  let assistants = 0;
  let baseAdd = 0;
  let prestigePercent = 0;
  for (const item of items) {
    baseAdd += item.baseAdd || 0;
    prestigePercent += item.prestigePercent || 0;
    for (const effect of item.effects) {
      if (effect.when && !evaluateCondition(graph, effect.when, context)) continue;
      if (effect.stat === 'building.production' && effect.operation === 'multiplyPercent') productionMultiplier *= 1 + effect.value.constant / 100;
      if (effect.stat === 'building.production' && effect.operation === 'multiply') productionMultiplier *= effect.value.constant ?? 1;
      if (effect.stat === 'assistants.count' && effect.operation === 'add') assistants += effect.value.constant;
    }
  }
  return `${building.name}产出提高 ${formatNumber((productionMultiplier - 1) * 100)}%${assistants ? `，数字员工 +${formatNumber(assistants)}` : ''}${baseAdd ? `，每座基础 +${formatNumber(baseAdd)}` : ''}${prestigePercent ? `，其他设施协同 +${formatNumber(prestigePercent)}%` : ''}。`;
}
function upgradeCollectionCard(building, items) {
  const expanded = expandedUpgradeCollections.has(building.id);
  const tooltipId = `upgrade-tooltip-collection-${building.id}`;
  const effect = collectionEffect(building, items);
  const icon = building.ui.collectionIcon || `assets/images/content-icons/upgrades/${building.id}-collection.svg`;
  const card = `<article class="upgrade-entry owned upgrade-collection" data-upgrade-card="collection-${building.id}"><button type="button" class="upgrade-entry-button" data-action="toggle-upgrade-collection" data-building-id="${building.id}" aria-describedby="${tooltipId}" aria-expanded="${expanded}" aria-label="${building.name}已购升级合集，共 ${items.length} 项。${effect}"><img class="upgrade-entry-icon" src="${icon}" alt=""></button><span class="upgrade-tooltip" id="${tooltipId}" role="tooltip" aria-hidden="true"><b>${building.name} · 已购升级合集</b><span class="upgrade-tooltip-cost">${items.length} 项已购升级</span><span class="upgrade-tooltip-description">${effect}</span><small data-field="hint">点击查看全部已购升级</small></span></article>`;
  if (!expanded) return card;
  return `${card}<section class="upgrade-collection-detail" aria-label="${building.name}全部已购升级"><h4>${building.name} · ${items.length} 项</h4><div class="upgrade-entry-grid">${items.map(upgradeCard).join('')}</div></section>`;
}
function upgradeSections(items) {
  if (!items.length) return '<p class="notice">增加设施或加入部门后显示升级。</p>';
  const unpurchased = sortedUpgrades(items.filter(item => !['OWNED', 'SELECTED'].includes(view(item.id).status)));
  const purchased = sortedUpgrades(items.filter(item => ['OWNED', 'SELECTED'].includes(view(item.id).status)));
  const groups = content('building').map(building => ({ building, items: purchased.filter(item => item.buildingId === building.id) })).filter(group => group.items.length);
  const cards = [...groups.map(group => upgradeCollectionCard(group.building, group.items)), ...purchased.filter(item => !item.buildingId).map(upgradeCard)];
  const section = (title, cards, owned = false, count = cards.length) => cards.length ? `<section class="upgrade-section ${owned ? 'purchased' : ''}"><h3><span>${title}</span><small>${count}</small></h3><div class="upgrade-entry-grid">${cards.join('')}</div></section>` : '';
  return `${section('未购买升级', unpurchased.map(upgradeCard))}${section('已购买升级', cards, true, purchased.length)}`;
}
function upgradesPanel(category = null) {
  const items = visible('upgrade').filter(item => !category || item.ui.category === category || (category === 'building' && item.ui.category === 'hallBonus'));
  const title = category === 'building' ? '设施升级' : category === 'general' ? '通用升级' : '升级';
  return `<div class="panel-head"><div><h2>${title}</h2><p>点击图标购买升级或打开对应功能，悬停或长按查看详情。</p></div></div>${upgradeSections(items)}`;
}
function factionsPanel() {
  const current = state().selections;
  const items = [
    ...visible('alignment').filter(item => !current.alignment || current.alignment === item.id),
    ...visible('faction').filter(item => !current.faction || current.faction === item.id),
    ...visible('upgrade').filter(item => item.ui.category === 'faction'),
  ];
  return `<div class="panel-head"><div><h2>部门升级</h2><p>选择立场和部门，或购买对应升级。</p></div></div>${upgradeSections(items)}`;
}
let royalMarketReturnFocus = null;
function renderRoyalMarket() {
  if ($('royalMarketDialog').hidden) return;
  const focusedId = document.activeElement?.dataset?.id;
  const market = derived();
  const productionBonus = (market.exchangeMultiplier - 1) * 100;
  const bonusText = productionBonus.toFixed(2).replace(/\.?0+$/, '');
  $('royalMarketSummary').innerHTML = `<span>调拨 ${formatNumber(market.exchangeCount)} 次 · 当前产出加成 +${bonusText}%</span>`;
  $('royalMarketBuyControls').innerHTML = buyControls();
  $('royalMarketRows').innerHTML = content('exchange').map(item => {
    const model = view(item.id);
    const quantity = model.quantity || 0;
    const total = model.costs[0]?.value || 0;
    const disabled = model.status !== 'PURCHASABLE';
    return `<div class="royal-market-row" role="row" data-exchange-card="${item.id}"><span class="royal-market-faction" role="cell"><img class="royal-market-icon" src="${item.ui.icon}" alt=""><span>${item.name}（${formatNumber(model.viewModel.count)}）</span></span><span role="cell">10%</span><span role="cell">${quantity}× ${formatNumber(total)}</span><span role="cell"><button class="royal-market-buy primary" data-action="purchase" data-id="${item.id}" aria-label="${item.name} ${quantity} 次，成本 ${formatNumber(total)} 点影响力" ${disabled ? 'disabled' : ''}>调拨</button></span></div>`;
  }).join('');
  if (focusedId) $('royalMarketRows').querySelector(`[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
}
function refreshRoyalMarket(message = null) {
  if ($('royalMarketDialog').hidden) return;
  const relevant = !message || message.commandType !== 'tick' || message.changedPaths.some(path => /^(royalExchange|resources\.factionCoins|owned|progression|settings\.buyAmount|permanentUnlocks|timers\.spells|stats\.ascension\.factionCoins)/.test(path));
  if (relevant) renderRoyalMarket();
}
function openRoyalMarket() {
  closeUpgradeTooltip();
  closeFactionCoinTooltip();
  royalMarketReturnFocus = document.activeElement;
  $('royalMarketDialog').hidden = false;
  document.body.classList.add('royal-market-open');
  renderRoyalMarket();
  $('royalMarketDialog').querySelector('[data-action="close-royal-market"]').focus({ preventScroll: true });
}
function closeRoyalMarket() {
  if ($('royalMarketDialog').hidden) return;
  $('royalMarketDialog').hidden = true;
  document.body.classList.remove('royal-market-open');
  if (royalMarketReturnFocus?.isConnected) royalMarketReturnFocus.focus({ preventScroll: true });
  royalMarketReturnFocus = null;
}
function skillsPanel() {
  const available = visible('spell');
  const quick = quickSkillIds(QUICK_SKILL_LIMIT);
  return `<div class="panel-head"><div><h2>全部技能</h2><p>设置常用技能，或在这里直接释放。</p></div></div><div class="skill-library">${available.map(item => {
    const index = quick.indexOf(item.id); const isQuick = index >= 0;
    return `<article class="skill-row" data-skill-row="${item.id}"><div class="skill-copy"><h3><img class="inline-icon" src="${spellIcon(item)}" alt="">${spellName(item)}</h3><p>${spellDescription(item)}</p><small class="meta" data-skill-status></small></div><div class="skill-actions"><button class="primary" data-action="cast" data-id="${item.id}">释放</button>${isQuick && index > 0 ? `<button data-action="prioritize-skill" data-id="${item.id}">置顶</button>` : ''}<button data-action="toggle-quick-skill" data-id="${item.id}" aria-pressed="${isQuick}">${isQuick ? '移出快捷栏' : '设为常用'}</button></div></article>`;
  }).join('')}</div>`;
}
const statRow = (label, path, format = 'number') => `<tr><td>${label}</td><td data-stat="${path}" data-format="${format}">0</td></tr>`;
function statsPanel() {
  const rows = scope => `${statRow('时间', `stats.${scope}.time`, 'time')}${statRow('账面产值', `stats.${scope}.coins`, 'money')}${statRow('点击次数', `stats.${scope}.clicks`)}${statRow('施法次数', `stats.${scope}.spellsCast`)}${statRow('部门影响力', `stats.${scope}.factionCoins`)}${statRow('累计建造', `stats.${scope}.buildingsBuilt`)}${statRow('累计离线', `stats.${scope}.offlineTime`, 'time')}${statRow('最长单次离线', `stats.${scope}.offlineTimeMax`, 'time')}`;
  return `<div class="panel-head"><div><h2>职业统计</h2><p>分别查看本轮、本次职业、本次重述与全部历史数据。</p></div></div><section class="subsection"><h3>本轮</h3><table class="stat-table">${rows('run')}</table><h3>本次职业</h3><table class="stat-table">${rows('r')}</table><h3>本次重述</h3><table class="stat-table">${rows('ascension')}</table><h3>全部历史</h3><table class="stat-table">${rows('total')}</table></section>`;
}
function storyForTrophy(trophyId) {
  return content('story').find(story => story.grants.some(action => action.type === 'awardTrophy' && action.id === trophyId));
}
const SPELL_TROPHY_IDS = new Set(['fairyChoir', 'sunBlessing', 'godsRest', 'greedDrive', 'trueNight', 'hellRush']);
function trophyCategory(trophy) {
  if (trophy.id.endsWith('Champion')) return 'champions';
  if (SPELL_TROPHY_IDS.has(trophy.id)) return 'magic';
  if (['building-trophy', 'aggregate-building-trophy'].includes(trophy.trophyType)) return 'facilities';
  if (trophy.trophyType === 'secret-trophy') return 'secrets';
  return 'records';
}
function trophyIconCard(trophy) {
  const unlocked = Boolean(state().permanentUnlocks[trophy.id]);
  const story = storyForTrophy(trophy.id);
  const tooltipId = `trophy-tooltip-${trophy.id}`;
  const name = unlocked ? trophy.name : '未解密奖杯';
  return `<article class="trophy-icon-card ${unlocked ? 'unlocked' : 'locked'}" data-trophy-card="${trophy.id}" data-trophy-id="${trophy.id}"><button type="button" class="trophy-icon-button" data-action="show-trophy" data-id="${trophy.id}" aria-describedby="${tooltipId}" aria-label="${name}"><img src="${trophy.ui.icon}" alt=""></button><span class="trophy-tooltip" id="${tooltipId}" role="tooltip" aria-hidden="true"><b>${name}</b><span>${unlocked ? description(trophy) : '继续游玩以解锁。'}</span><small>${unlocked ? '已解锁' : '未解锁'}</small>${story && state().story.completed[story.id] ? `<button data-action="replay-story" data-id="${story.id}">回看关联剧情</button>` : ''}</span></article>`;
}
function buildingSeriesCard(building) {
  const series = content('trophy').filter(trophy => trophy.trophyType === 'building-trophy' && trophy.id.startsWith(`${building.id}-building-trophy-`))
    .sort((left, right) => Number(left.id.split('-').at(-1)) - Number(right.id.split('-').at(-1)));
  const highest = series.reduce((level, trophy) => state().permanentUnlocks[trophy.id] ? Math.max(level, Number(trophy.id.split('-').at(-1))) : level, 0);
  const next = series[highest];
  const current = state().buildings[building.id] || 0;
  const target = next?.reactions[0].when.all[1].value || 0;
  const progress = next ? Math.min(100, current / target * 100) : 100;
  const status = highest === 22 ? 'maxed' : highest > 0 ? 'unlocked' : 'locked';
  const levelText = highest === 22 ? '22/22 已满级' : highest > 0 ? `最高第 ${highest} 级` : '尚未解锁';
  const tooltipId = `trophy-series-tooltip-${building.id}`;
  return `<article class="trophy-icon-card trophy-series-card ${status}" data-trophy-card="series-${building.id}"><button type="button" class="trophy-icon-button" data-action="show-trophy" data-id="${building.id}" aria-describedby="${tooltipId}" aria-label="${building.name}，奖杯系列 ${highest}/22"><img src="${building.ui.icon}" alt=""><small>${levelText}</small></button><span class="trophy-tooltip" id="${tooltipId}" role="tooltip" aria-hidden="true"><b>${building.name}</b><span>奖杯系列：${highest}/22</span>${next ? `<span>下一等级：第 ${highest + 1} 级</span><span>进度：${formatNumber(current)}/${formatNumber(target)}（${formatNumber(progress)}%）</span>` : '<span>全部 22 级奖杯已解锁</span>'}</span></article>`;
}
function achievementsPanel() {
  const trophies = content('trophy');
  const original = trophies.filter(trophy => trophy.originalTrophy);
  const originalUnlocked = original.filter(trophy => state().permanentUnlocks[trophy.id]).length;
  const categories = [
    ['champions', '部门荣誉'], ['magic', '法术奖杯'], ['facilities', '设施奖杯'], ['secrets', '隐秘奖杯'], ['records', '员工记录'],
  ];
  return `<div class="panel-head"><div><h2>成就</h2><p>奖杯 ${originalUnlocked}/${original.length}</p></div></div>${categories.map(([id, name]) => {
    const items = trophies.filter(trophy => trophyCategory(trophy) === id);
    const unlocked = items.filter(trophy => state().permanentUnlocks[trophy.id]).length;
    const collapsed = collapsedTrophyGroups.has(id);
    const cards = id === 'facilities'
      ? `${content('building').map(buildingSeriesCard).join('')}${items.filter(trophy => trophy.trophyType === 'aggregate-building-trophy').map(trophyIconCard).join('')}`
      : items.map(trophyIconCard).join('');
    return `<section class="trophy-section" data-trophy-group="${id}"><button class="trophy-section-toggle" data-action="toggle-trophy-group" data-group="${id}" aria-expanded="${!collapsed}"><span>${name}（${unlocked}/${items.length}）</span><span aria-hidden="true">${collapsed ? '▼' : '▲'}</span></button>${collapsed ? '' : `<div class="trophy-icon-grid">${cards}</div>`}</section>`;
  }).join('')}`;
}
function reincarnationPowerCard() {
  const power = derived().rPower;
  return `<article class="card"><h3>R${state().progression.reincarnations} 职业增益</h3><p>全局产出 +${formatNumber(power.productionPercent)}% · 时间产出 +${formatNumber(power.timeProductionPercent)}% · 每份期权 +${formatNumber(power.gemPowerAdd)}%</p><p>最大精力 +${formatNumber(power.manaMaxAdd)} · 每秒恢复 +${formatNumber(power.manaRegenAdd)} · 恢复倍率 ×${formatNumber(power.manaRegenMultiplier)}</p><p>数字员工 +${formatNumber(power.assistantsAdd)} · 数字员工产出 +${formatNumber(power.assistantProductionPercent)}% · 离线基础倍率 ×${formatNumber(power.offlineMultiplier)}</p><p>影响力发现率 +${formatNumber(power.fcChanceAdd)} 个百分点 · 概率倍率 ×${formatNumber(power.fcChanceMultiplier)} · 获取倍率 ×${formatNumber(power.factionCoinGainMultiplier)} · 交换加成 +${formatNumber(power.exchangeBonus)}</p>${power.r2 > 0 ? `<p>每秒自动点击 ${formatNumber(power.autoClickRate)} 次。</p>` : ''}</article>`;
}
function morePanel() {
  const completed = Object.keys(state().story.completed).map(definition).filter(Boolean);
  const reincarnation = game.select('reincarnation');
  return `<div class="panel-head"><div><h2>职业与存档</h2><p>管理本地档案，并查看剧情。</p></div></div>
    <section class="subsection announcement-section"><h3>公告</h3><div class="announcement-list">${announcements.map(item => `<button class="announcement-card" data-action="replay-announcement" data-id="${item.id}"><strong>${item.shortTitle}</strong><span>查看完整公告</span></button>`).join('')}</div></section>
    ${reincarnationPowerCard()}
    ${reincarnation.visible ? `<article class="card"><h3>投胎进入 R${reincarnation.nextR}</h3><p>消耗当前全部期权，保留奖杯与历史记录，开启更深层的组织周期。</p><button data-action="reincarnate">投胎</button></article>` : ''}
    <section class="subsection mobile-nav"><h3>职业统计</h3><p>查看本轮、本次职业、本次重述与全部历史数据。</p><button data-tab="stats">查看职业统计</button></section>
    <section class="subsection"><h3>数据管理</h3><div class="action-row"><button data-action="edit-user-id">修改游戏 ID</button><button data-action="save">立即保存</button><button data-action="export">导出存档</button><button data-action="import">导入文件</button><button data-action="import-text">从文本导入</button><button class="danger" data-action="hard-reset">清除全部进度</button></div><textarea id="exportText" placeholder="导出后在此显示 JSON；也可直接粘贴存档文本，然后点击“从文本导入”。"></textarea></section>
    <section class="subsection"><h3>领取奖励</h3><form id="manaPasswordForm" class="action-row" autocomplete="off"><label for="manaPassword">密码</label><input id="manaPassword" type="password" inputmode="numeric" autocomplete="off" placeholder="输入密码" required><button type="submit">确认</button></form><p id="manaPasswordFeedback" role="status"></p><div id="manaRegenEditor" hidden><div class="action-row"><label for="manaRegenInput">每秒恢复</label><input id="manaRegenInput" type="number" min="0" step="0.1" required><button data-action="apply-mana-regen">应用</button></div></div></section>
    <section class="subsection"><h3>剧情回看</h3><div class="action-row">${completed.map(story => `<button data-action="replay-story" data-id="${story.id}">${story.title}</button>`).join('') || '<p class="notice">暂无可回看的剧情。</p>'}</div></section>`;
}
function syncManaEditor() {
  const editor = $('manaRegenEditor');
  if (!editor) return;
  editor.hidden = !manaEditorUnlocked;
  if (manaEditorUnlocked && document.activeElement !== $('manaRegenInput')) $('manaRegenInput').value = derived().manaRegen;
}
function updatePanel() {
  updateBuildingCards(); updateCastButtons();
  document.querySelectorAll('#mainPanel [data-action="purchase"]:not([data-building-card]), #upgradeRail [data-action="purchase"], #mainPanel [data-action="open-royal-market"], #upgradeRail [data-action="open-royal-market"]').forEach(button => {
    const model = view(button.dataset.id);
    const unavailable = ['NEED_RESOURCE', 'OWNED', 'SELECTED', 'LOCKED_REQUIREMENT'].includes(model.status);
    const card = button.closest(tooltipEntrySelector);
    if (card) {
      const item = definition(button.dataset.id);
      const marketEntry = item.interaction === 'royalMarket';
      const cost = marketEntry ? '统筹调拨' : model.costs.map(cost => formatCost(cost, item.id)).join(' + ');
      const hint = marketEntry ? '点击打开' : model.status === 'OWNED' ? '已生效' : model.status === 'SELECTED' ? '已选择' : model.status === 'NEED_RESOURCE' ? '资源不足' : model.status === 'LOCKED_REQUIREMENT' ? '尚未满足条件' : '点击购买';
      const text = description(item);
      button.setAttribute('aria-disabled', String(unavailable));
      button.setAttribute('aria-label', marketEntry ? `${item.name}，${text}${hint}。` : `${item.name}，价格 ${cost || '无'}。${text}${hint}。`);
      const descriptionElement = card.querySelector('.upgrade-tooltip-description');
      if (descriptionElement) descriptionElement.textContent = text;
      card.classList.toggle('owned', ['OWNED', 'SELECTED'].includes(model.status));
      card.classList.toggle('insufficient', model.status === 'NEED_RESOURCE');
      card.classList.toggle('affordable', model.status === 'PURCHASABLE');
      card.querySelector('[data-field="cost"]').textContent = marketEntry ? cost : cost || '无需工资';
      card.querySelector('[data-field="hint"]').textContent = hint;
      return;
    }
    button.disabled = unavailable;
    if (model.status === 'OWNED') button.textContent = '已生效';
    else if (model.status === 'SELECTED') {
      const kind = definition(button.dataset.id).kind;
      button.textContent = kind === 'alignment' ? '当前立场' : kind === 'faction' ? '当前部门' : '当前已选择';
    }
    else if (model.status === 'NEED_RESOURCE') button.textContent = '资源不足';
  });
  document.querySelectorAll('[data-stat]').forEach(cell => {
    const value = cell.dataset.stat.split('.').reduce((object, key) => object?.[key], state()) || 0;
    cell.textContent = cell.dataset.format === 'time' ? formatTime(value) : cell.dataset.format === 'money' ? money(value) : formatNumber(value);
  });
}
function renderPanel() {
  cancelUpgradeLongPress();
  closeUpgradeTooltip();
  if (activeTab === 'work') { $('mainPanel').hidden = true; return; }
  $('mainPanel').classList.toggle('more-dialog', activeTab === 'more' || activeTab === 'achievements');
  $('mainPanel').classList.toggle('skills-dialog', activeTab === 'skills');
  const body = activeTab === 'buildings' ? buildingPanel()
    : activeTab === 'building-upgrades' ? upgradesPanel('building')
      : activeTab === 'misc-upgrades' ? upgradesPanel('general')
        : activeTab === 'upgrades' ? upgradesPanel()
          : activeTab === 'factions' ? factionsPanel() : activeTab === 'skills' ? skillsPanel()
            : activeTab === 'achievements' ? achievementsPanel()
      : activeTab === 'stats' ? statsPanel() : morePanel();
  $('mainPanel').innerHTML = `<div class="panel-return"><button data-action="close-panel" aria-label="返回工位">× 返回工位</button></div>${body}`;
  $('mainPanel').hidden = false; updatePanel(); syncManaEditor();
}
function updateTabStates() {
  document.querySelectorAll('[data-tab]').forEach(button => {
    const active = button.dataset.tab === activeTab;
    button.classList.toggle('active', active); button.setAttribute('aria-expanded', String(active));
  });
}
function openAuxPanel(tab, trigger) {
  panelReturnFocus = trigger || document.activeElement; activeTab = tab; updateTabStates();
  if (matchMedia('(max-width: 900px)').matches && !panelHistory) { history.pushState({ moyuPanel: true }, ''); panelHistory = true; }
  renderPanel(); $('mainPanel').querySelector('[data-action="close-panel"]')?.focus({ preventScroll: true });
}
function closeAuxPanel(fromPopstate = false) {
  activeTab = 'work'; updateTabStates(); $('mainPanel').hidden = true;
  if (!fromPopstate && panelHistory) { panelHistory = false; history.back(); }
  if (panelReturnFocus?.isConnected) panelReturnFocus.focus({ preventScroll: true });
}

function updateRetirement() {
  if (!$('retirementPanel').firstElementChild) $('retirementPanel').innerHTML = `<section class="retirement-card" aria-label="退休结算"><div class="retirement-copy"><div class="retirement-title"><strong>退休</strong><small id="retirementRunCoins"></small></div><div class="retirement-values"><span>本次可结算期权 <b id="pendingGemsValue">0</b></span><span>当前累计期权 <b id="totalGemsValue">0</b></span></div><p class="retirement-feedback" id="retirementFeedback" role="status" hidden></p></div><button class="retirement-btn" id="retirementButton" data-action="abdicate">申请退休（需100M）</button></section>`;
  const retirement = game.select('retirement');
  $('pendingGemsValue').textContent = formatNumber(retirement.earned);
  $('totalGemsValue').textContent = formatNumber(state().resources.gems);
  $('retirementRunCoins').textContent = `本轮产值 ${money(state().stats.run.coins)}${retirement.target > 0 ? ' · 退休目标 ¥100M' : ''}`;
  $('retirementButton').textContent = retirement.eligible ? '退休' : '申请退休（需100M）';
  $('retirementPanel').firstElementChild.classList.toggle('ready', retirement.eligible);
}
function renderTop() {
  const d = derived();
  $('coins').textContent = money(state().resources.coins);
  $('production').textContent = money(d.production);
  $('gems').textContent = formatNumber(state().resources.gems);
  $('mana').textContent = `${formatNumber(state().resources.mana)} / ${formatNumber(d.manaMax)}`;
  $('manaRate').textContent = `+${formatNumber(d.manaRegen)} / 秒`;
  $('manaFill').style.width = `${Math.max(0, Math.min(100, state().resources.mana / d.manaMax * 100))}%`;
  $('manaProgress').setAttribute('aria-valuemax', String(d.manaMax)); $('manaProgress').setAttribute('aria-valuenow', String(state().resources.mana));
  $('fcChance').textContent = `${formatNumber(d.fcChance)}%`;
  const coinFactions = content('faction').filter(item => item.factionCoin?.enabled);
  const factionSignature = coinFactions.map(item => item.id).join('|');
  if ($('factionCoinList').dataset.structure !== factionSignature) {
    closeFactionCoinTooltip();
    $('factionCoinList').dataset.structure = factionSignature;
    // 部门影响力仅展示图标与数值，名字放入可交互悬浮提示中（悬停 / 点击 / 长按触发）
    $('factionCoinList').innerHTML = coinFactions.map(item => `<span class="faction-coin-item" data-faction="${item.id}" tabindex="0" role="button" aria-label="${item.name}影响力" aria-expanded="false"><img src="${item.factionCoin.icon}" alt="${item.name}"><b id="${item.id}FactionCoins">0</b><span class="faction-coin-tooltip" role="tooltip" aria-hidden="true">${item.name}</span></span>`).join('');
  }
  for (const item of coinFactions) $(`${item.id}FactionCoins`).textContent = formatNumber(state().resources.factionCoins[item.id] || 0);
  $('rankText').textContent = `R${state().progression.reincarnations} · 地方分公司`;
  const playerIdentity = `${playerRole()}:<strong>${currentUserId}</strong>`;
  $('playerIdentity').innerHTML = playerIdentity;
  $('workPlayerIdentity').innerHTML = playerIdentity;
  const faction = state().selections.faction ? definition(state().selections.faction) : null;
  $('factionName').textContent = faction ? faction.name : '尚未选择部门';
  $('clickReward').textContent = money(d.clickReward); $('assistants').textContent = formatNumber(d.assistants);
  const factionCoins = game.select('factionCoins');
  $('assistantTooltip').textContent = `每名数字员工每秒产出当前搬砖收入 5% 的工资，当前合计 ${money(d.assistantProduction)} / 秒，不增加搬砖次数。影响力在线期望 ${formatNumber(factionCoins.assistant.expectedPerSecond)} / 秒，实际按随机结果逐枚入账；待领取 ${formatNumber(factionCoins.pending)}。`;
  $('runTime').textContent = formatTime(state().stats.run.time);
  const saveStatus = game.select('saveStatus'); $('saveStatus').textContent = saveStatus.error ? '未保存 · 将自动重试' : saveStatus.dirty ? '有未保存更改' : '本地存档已就绪';
  updateRetirement();
}
function factFeedback(facts, commandType = null) {
  if (commandType === 'tick' && facts.some(fact => fact.type === 'work.clicked' && fact.payload.automatic)) autoWorkFeedback(facts);
  for (const fact of facts) {
    if (fact.type === 'factionCoins.found' && fact.payload.source === 'randomCache' && fact.payload.mode === 'online') queueAssistantFactionCoin(fact.payload);
    if (fact.type === 'building.purchased') {
      playPurchaseSound('building');
      notify(`设施采购完成：${definition(fact.payload.buildingId).name} +${fact.payload.quantity}`);
    }
    else if (fact.type === 'upgrade.purchased') playPurchaseSound('upgrade');
    else if (fact.type === 'faction.joined') notify(`已加入${definition(fact.payload.factionId).name}`);
    else if (fact.type === 'alignment.selected') notify(`已确认${definition(fact.payload.alignmentId).name}`);
    else if (fact.type === 'spell.cast') {
      const name = spellName(definition(fact.payload.spellId));
      notify(fact.payload.free ? `免费追加：${name} ×${formatNumber(fact.payload.times || 1)}` : `已释放：${name}`);
    }
    else if (fact.type === 'greenFingersDiscount.triggered') notify(`全绿预算折扣：${money(fact.payload.earned)}（${formatNumber(fact.payload.seconds)} 秒产出）`);
    else if (fact.type === 'trophy.unlocked') {
      playTrophySound();
      notify(`获得奖杯：${definition(fact.payload.trophyId).name}`, false, 'trophy');
    }
    else if (fact.type === 'abdication.rejected') notify('本轮累计产值尚未达到 ¥100M，暂不能退休', true);
    else if (fact.type === 'abdication.completed') notify(`退休结算完成，获得 ${formatNumber(fact.payload.earned)} 期权`);
    else if (fact.type === 'reincarnation.completed') notify(`已进入 R${fact.payload.reincarnations}`);
    else if (fact.type === 'offline.settled') {
      const pending = fact.payload.factionCoinsPending > 0 ? `，待领取影响力 ${formatNumber(fact.payload.factionCoinsPending)}` : '';
      const discount = fact.payload.greenFingersMultiplier !== 1 ? `，全绿预算折扣 ×${formatNumber(fact.payload.greenFingersMultiplier)}` : '';
      notify(`离线 ${formatTime(fact.payload.seconds)}，结算 ${money(fact.payload.earned)}${discount}${pending}`);
    }
  }
}
function refresh(message = null) {
  if (message?.commandType && message.commandType !== 'tick') lastUpgradeRailRender = 0;
  renderTop(); renderUpgradeRail(); renderQuickSkills();
  const inventoryChanged = !message || message.commandType !== 'tick' || message.changedPaths.some(path => /^(spellSources|selections|settings|buildings)/.test(path));
  if (inventoryChanged) renderFacilityRail();
  updateCastButtons();
  const structural = message?.commandType !== 'tick' || message?.changedPaths.some(path => /^(permanentUnlocks|story|owned|buildings|selections)/.test(path));
  if (activeTab !== 'work' && structural) renderPanel(); else updatePanel();
  syncStories();
  maybeShowAnnouncement();
  refreshRoyalMarket(message);
}
let pendingAlignmentId = null;
function reloadWithSave(raw, { recover = false } = {}) {
  if (recover) saveAdapter.recover(raw); else saveAdapter.import(raw);
  importingSave = true;
  game.stop();
  location.reload();
}
function importSave(raw, errorMessage) {
  try { reloadWithSave(raw); }
  catch (error) {
    if (error.message === 'SAVE_INTEGRITY_MISMATCH') {
      pendingSaveRecovery = raw;
      modal.show({ story: {
        id: 'ui.save-recovery.confirm',
        title: '存档完整性校验失败',
        paragraphs: ['这份存档的签名与内容不一致，可能已损坏或被修改。', '仅在确认来源可信时尝试恢复。原始文本会保留在本机的损坏存档槽位。'],
        choices: [{ id: 'confirm', label: '仍要恢复并导入' }],
        buttonLabel: '取消',
      } });
      return;
    }
    notify(errorMessage, true);
  }
}
const modal = createStoryModal({
  document,
  onClose: ({ id, action, replay }) => {
    if (id.startsWith('ui.announcement.')) {
      try {
        const seen = new Set(JSON.parse(localStorage.getItem('endless-shift-announcements-seen') || '[]'));
        seen.add(id.slice('ui.announcement.'.length));
        localStorage.setItem('endless-shift-announcements-seen', JSON.stringify([...seen]));
      } catch {}
      return;
    }
    if (id === 'ui.alignment.confirm') { pendingAlignmentId = null; return; }
    if (id === 'ui.save-recovery.confirm') { pendingSaveRecovery = null; return; }
    if (id === 'ui.hard-reset.confirm') return;
    if (id === 'ui.retirement.confirm') return;
    if (!replay) game.dispatch({ type: 'story.close', id, skipped: action === 'skip' });
  },
  onChoice: ({ id, choiceId }) => {
    if (id === 'ui.alignment.confirm') {
      const selectedId = pendingAlignmentId;
      pendingAlignmentId = null;
      modal.close();
      if (choiceId === 'confirm') commandResult(game.dispatch({ type: 'purchase', id: selectedId, amount: state().settings.buyAmount }));
      return;
    }
    if (id === 'ui.save-recovery.confirm') {
      const raw = pendingSaveRecovery;
      pendingSaveRecovery = null;
      modal.close();
      if (choiceId === 'confirm') {
        try { reloadWithSave(raw, { recover: true }); }
        catch { notify('恢复失败：存档内容无法读取', true); }
      }
      return;
    }
    if (id === 'ui.hard-reset.confirm') {
      modal.close();
      if (choiceId === 'confirm') {
        resetting = true;
        game.stop();
        saveAdapter.remove();
        location.reload();
      }
      return;
    }
    if (id === 'ui.retirement.confirm') {
      modal.close();
      if (choiceId === 'confirm') commandResult(game.dispatch({ type: 'abdicate' }));
      return;
    }
    const result = game.dispatch({ type: 'story.choice', id, choiceId });
    if (result.ok && definition(id).choices.find(choice => choice.id === choiceId).close !== false) modal.close();
  },
});
function syncStories() {
  if (modal.current?.replay || modal.current?.story.id.startsWith('ui.announcement.')
    || ['ui.alignment.confirm', 'ui.hard-reset.confirm', 'ui.save-recovery.confirm', 'ui.retirement.confirm'].includes(modal.current?.story.id)) return;
  const next = game.select('storyQueue')[0];
  if (next && modal.current?.story.id !== next.id) modal.show({ story: next });
}
let announcements = [];
function maybeShowAnnouncement() {
  if (!announcements.length || modal.isOpen) return;
  let seen = [];
  try {
    const stored = JSON.parse(localStorage.getItem('endless-shift-announcements-seen') || '[]');
    if (Array.isArray(stored)) seen = stored;
  } catch {}
  const announcement = announcements.find(item => !seen.includes(item.id));
  if (!announcement) return;
  modal.show({ story: {
    id: `ui.announcement.${announcement.id}`,
    title: announcement.title,
    paragraphs: announcement.body,
    buttonLabel: announcement.buttonLabel || '知道了，继续游戏',
  } });
}
async function loadAnnouncement() {
  try {
    const response = await fetch('announcement.json', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.announcements)) return;
    announcements = data.announcements.filter(item => item.enabled
      && typeof item.id === 'string' && typeof item.title === 'string'
      && typeof item.shortTitle === 'string' && Array.isArray(item.body));
    maybeShowAnnouncement();
  } catch {}
}
function replayStory(id) {
  const story = definition(id);
  if (story && state().story.completed[id]) modal.show({ story, replay: true });
}
function commandResult(result) {
  if (result?.ok) return true;
  if (result?.reason === 'NEED_RESOURCE') notify('当前资源不足', true);
  else if (result?.error) { console.error(result.error); notify('操作未完成，状态已回滚', true); }
  return false;
}

/**
 * 部门影响力（Faction Coin）名称提示控制：
 * 支持桌面端鼠标悬停、键盘聚焦，以及移动端点击切换与长按滑动预览。
 */
let activeFactionCoinTooltip = null;
let factionCoinLongPress = null;
let suppressedFactionCoinClick = null;
const factionCoinLongPressDelay = 200;
const factionCoinLongPressMoveLimit = 12;

function positionFactionCoinTooltip(item) {
  const tooltip = item.querySelector('.faction-coin-tooltip');
  if (!tooltip) return;
  const rect = item.getBoundingClientRect();
  const width = tooltip.offsetWidth || 72;
  const halfWidth = width / 2;
  const center = Math.max(8 + halfWidth, Math.min(innerWidth - 8 - halfWidth, rect.left + rect.width / 2));
  const above = rect.top >= 44;
  tooltip.style.left = `${Math.round(center)}px`;
  tooltip.style.top = `${Math.round(above ? rect.top - 6 : rect.bottom + 6)}px`;
  tooltip.style.transform = above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
}
function closeFactionCoinTooltip() {
  if (!activeFactionCoinTooltip) return;
  activeFactionCoinTooltip.classList.remove('fc-tooltip-open');
  activeFactionCoinTooltip.setAttribute('aria-expanded', 'false');
  activeFactionCoinTooltip.querySelector('.faction-coin-tooltip')?.setAttribute('aria-hidden', 'true');
  activeFactionCoinTooltip = null;
}
function openFactionCoinTooltip(item) {
  if (!item) return;
  clearUnexpectedSelection();
  if (activeFactionCoinTooltip && activeFactionCoinTooltip !== item) closeFactionCoinTooltip();
  activeFactionCoinTooltip = item;
  item.classList.add('fc-tooltip-open');
  item.setAttribute('aria-expanded', 'true');
  item.querySelector('.faction-coin-tooltip')?.setAttribute('aria-hidden', 'false');
  positionFactionCoinTooltip(item);
}
function cancelFactionCoinLongPress() {
  if (!factionCoinLongPress) return;
  clearTimeout(factionCoinLongPress.timer);
  factionCoinLongPress = null;
}

let activeUpgradeTooltip = null;
let touchUpgradeTooltip = null;
let dismissedUpgradeTooltip = null;
let upgradeLongPress = null;
let suppressedUpgradeClick = null;
const upgradeLongPressDelay = 200;
const upgradeLongPressMoveLimit = 12;
const tooltipEntrySelector = '[data-upgrade-card], [data-building-card], [data-trophy-card], [data-skill-card]';
const tooltipButtonSelector = '[data-upgrade-card] .upgrade-entry-button, [data-building-card], #upgradeRail .upgrade-icon, [data-trophy-card] .trophy-icon-button, [data-skill-card]';
const tooltipElement = entry => entry?._floatingTrophyTooltip || entry?.querySelector('.upgrade-tooltip, .building-tooltip, .trophy-tooltip, .skill-tooltip');
function positionUpgradeTooltip(entry) {
  const rect = entry.getBoundingClientRect();
  const tooltip = tooltipElement(entry);
  const center = Math.max(138, Math.min(innerWidth - 138, rect.left + rect.width / 2));
  const above = rect.top >= 190;
  tooltip.style.left = `${center}px`;
  tooltip.style.top = `${above ? rect.top - 8 : rect.bottom + 8}px`;
  tooltip.style.transform = above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
}
function positionUpgradeTooltipAt(entry, x, y) {
  const tooltip = tooltipElement(entry);
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - width - 8, x - width / 2));
  const preferredTop = y - height - 24;
  const top = preferredTop >= 8 ? preferredTop : y + 24;
  tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(8, Math.min(innerHeight - height - 8, top)))}px)`;
}
function closeUpgradeTooltip() {
  if (!activeUpgradeTooltip) return;
  const entry = activeUpgradeTooltip;
  const tooltip = tooltipElement(entry);
  entry.classList.remove('tooltip-open', 'tooltip-following');
  tooltip?.classList.remove('tooltip-open', 'tooltip-following');
  tooltip?.setAttribute('aria-hidden', 'true');
  if (entry._floatingTrophyTooltip && tooltip.parentElement === document.body) entry.appendChild(tooltip);
  activeUpgradeTooltip = null;
  touchUpgradeTooltip = null;
}
function openUpgradeTooltip(entry, touch = false, x, y) {
  clearUnexpectedSelection();
  if (activeUpgradeTooltip && activeUpgradeTooltip !== entry) closeUpgradeTooltip();
  activeUpgradeTooltip = entry;
  touchUpgradeTooltip = touch ? entry : null;
  const tooltip = tooltipElement(entry);
  const followsPointer = touch || (Number.isFinite(x) && Number.isFinite(y));
  if (entry.matches('[data-trophy-card]')) {
    entry._floatingTrophyTooltip = tooltip;
    document.body.appendChild(tooltip);
  }
  tooltip.classList.add('tooltip-open');
  tooltip.classList.toggle('tooltip-following', followsPointer);
  tooltip.style.transition = followsPointer ? 'none' : '';
  entry.classList.add('tooltip-open');
  entry.classList.toggle('tooltip-following', followsPointer);
  tooltip.setAttribute('aria-hidden', 'false');
  if (followsPointer && !touch) positionUpgradeTooltipAt(entry, x, y);
  else if (touch && upgradeLongPress) positionUpgradeTooltipAt(entry, upgradeLongPress.x, upgradeLongPress.y);
  else positionUpgradeTooltip(entry);
}
function cancelUpgradeLongPress() {
  if (!upgradeLongPress) return;
  clearTimeout(upgradeLongPress.timer);
  upgradeLongPress = null;
}
document.addEventListener('pointerover', event => {
  if (event.pointerType !== 'mouse') return;
  const fcItem = event.target.closest('#factionCoinList .faction-coin-item');
  if (fcItem && (!event.relatedTarget || !fcItem.contains(event.relatedTarget))) {
    openFactionCoinTooltip(fcItem);
  }
  const entry = event.target.closest(tooltipEntrySelector);
  if (!entry || (event.relatedTarget && entry.contains(event.relatedTarget))) return;
  if (entry !== dismissedUpgradeTooltip) openUpgradeTooltip(entry, false, event.clientX, event.clientY);
});
document.addEventListener('pointerout', event => {
  if (event.pointerType !== 'mouse') return;
  const floatingTooltip = event.target.closest('.trophy-tooltip');
  if (floatingTooltip && activeUpgradeTooltip && !activeUpgradeTooltip.contains(event.relatedTarget) && !floatingTooltip.contains(event.relatedTarget)) {
    closeUpgradeTooltip();
    return;
  }
  const fcItem = event.target.closest('#factionCoinList .faction-coin-item');
  if (fcItem && (!event.relatedTarget || !fcItem.contains(event.relatedTarget)) && activeFactionCoinTooltip === fcItem) {
    closeFactionCoinTooltip();
  }
  const entry = event.target.closest(tooltipEntrySelector);
  if (!entry || (event.relatedTarget && entry.contains(event.relatedTarget)) || tooltipElement(entry)?.contains(event.relatedTarget)) return;
  if (activeUpgradeTooltip === entry) closeUpgradeTooltip();
  dismissedUpgradeTooltip = null;
});
document.addEventListener('focusin', event => {
  const fcItem = event.target.closest('#factionCoinList .faction-coin-item');
  if (fcItem && fcItem.matches(':focus-visible')) {
    openFactionCoinTooltip(fcItem);
  }
  const button = event.target.closest(tooltipButtonSelector);
  if (!button || !button.matches(':focus-visible')) return;
  dismissedUpgradeTooltip = null;
  openUpgradeTooltip(button.closest(tooltipEntrySelector));
});
document.addEventListener('focusout', event => {
  const fcItem = event.target.closest('#factionCoinList .faction-coin-item');
  if (fcItem && (!event.relatedTarget || !fcItem.contains(event.relatedTarget)) && activeFactionCoinTooltip === fcItem) {
    closeFactionCoinTooltip();
  }
  const entry = event.target.closest(tooltipEntrySelector);
  if (!entry || (event.relatedTarget && entry.contains(event.relatedTarget))) return;
  if (activeUpgradeTooltip === entry) closeUpgradeTooltip();
  dismissedUpgradeTooltip = null;
});
document.addEventListener('pointerdown', event => {
  suppressedUpgradeClick = null;
  suppressedFactionCoinClick = null;
  if (touchUpgradeTooltip && event.pointerType !== 'mouse') closeUpgradeTooltip();
  cancelUpgradeLongPress();
  cancelFactionCoinLongPress();

  if (!['touch', 'pen'].includes(event.pointerType) || !event.isPrimary) return;

  // 处理移动端部门影响力长按手势
  const fcItem = event.target.closest('#factionCoinList .faction-coin-item');
  if (fcItem) {
    const fcRecord = {
      item: fcItem,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      triggered: false,
      timer: null,
    };
    fcRecord.timer = setTimeout(() => {
      if (factionCoinLongPress !== fcRecord) return;
      fcRecord.triggered = true;
      openFactionCoinTooltip(fcItem);
    }, factionCoinLongPressDelay);
    factionCoinLongPress = fcRecord;
    return;
  }

  const button = event.target.closest(tooltipButtonSelector);
  if (!button) return;
  const record = {
    button, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    x: event.clientX, y: event.clientY, triggered: false, timer: null,
  };
  record.timer = setTimeout(() => {
    if (upgradeLongPress !== record) return;
    record.triggered = true;
    openUpgradeTooltip(button.closest(tooltipEntrySelector), true);
  }, upgradeLongPressDelay);
  upgradeLongPress = record;
});
document.addEventListener('pointermove', event => {
  // 长按部门影响力图标时允许手指滑动切换预览不同部门名字
  const fcPress = factionCoinLongPress;
  if (fcPress && fcPress.pointerId === event.pointerId) {
    if (!fcPress.triggered) {
      if (Math.hypot(event.clientX - fcPress.startX, event.clientY - fcPress.startY) > factionCoinLongPressMoveLimit) {
        cancelFactionCoinLongPress();
      }
    } else {
      event.preventDefault();
      const targetItem = document.elementFromPoint(event.clientX, event.clientY)?.closest('#factionCoinList .faction-coin-item');
      if (targetItem && targetItem !== activeFactionCoinTooltip) {
        openFactionCoinTooltip(targetItem);
      }
    }
  }

  if (event.pointerType === 'mouse' && activeUpgradeTooltip && !touchUpgradeTooltip
    && tooltipElement(activeUpgradeTooltip)?.classList.contains('tooltip-following')) {
    positionUpgradeTooltipAt(activeUpgradeTooltip, event.clientX, event.clientY);
  }

  const press = upgradeLongPress;
  if (!press || press.pointerId !== event.pointerId) return;
  press.x = event.clientX;
  press.y = event.clientY;
  if (!press.triggered) {
    if (Math.hypot(press.x - press.startX, press.y - press.startY) <= upgradeLongPressMoveLimit) return;
    cancelUpgradeLongPress();
    return;
  }
  event.preventDefault();
  const entry = document.elementFromPoint(press.x, press.y)?.closest(tooltipEntrySelector);
  if (entry && entry !== activeUpgradeTooltip) openUpgradeTooltip(entry, true);
  else if (touchUpgradeTooltip) positionUpgradeTooltipAt(touchUpgradeTooltip, press.x, press.y);
});
document.addEventListener('touchmove', event => {
  if ((upgradeLongPress?.triggered || factionCoinLongPress?.triggered) && event.cancelable) event.preventDefault();
}, { passive: false });
document.addEventListener('pointerup', event => {
  const fcPress = factionCoinLongPress;
  if (fcPress && fcPress.pointerId === event.pointerId) {
    if (fcPress.triggered) {
      suppressedFactionCoinClick = { until: performance.now() + 700 };
      closeFactionCoinTooltip();
    }
    cancelFactionCoinLongPress();
  }

  const press = upgradeLongPress;
  if (!press || press.pointerId !== event.pointerId) return;
  if (press.triggered) {
    suppressedUpgradeClick = { until: performance.now() + 700 };
    closeUpgradeTooltip();
  }
  cancelUpgradeLongPress();
});
document.addEventListener('pointercancel', event => {
  if (factionCoinLongPress?.pointerId === event.pointerId) {
    if (factionCoinLongPress.triggered) closeFactionCoinTooltip();
    cancelFactionCoinLongPress();
  }
  if (upgradeLongPress?.pointerId !== event.pointerId) return;
  if (upgradeLongPress.triggered) closeUpgradeTooltip();
  cancelUpgradeLongPress();
});
document.addEventListener('contextmenu', event => {
  const fcItem = event.target.closest('#factionCoinList .faction-coin-item');
  if (fcItem) event.preventDefault();
  const button = event.target.closest(tooltipButtonSelector);
  if (button && (upgradeLongPress?.button === button || touchUpgradeTooltip?.contains(button))) event.preventDefault();
});
document.addEventListener('scroll', event => {
  if (!(event.target instanceof Element) || !event.target.matches('#mainPanel, .facility-scroll, .rail-shortcuts')) return;
  cancelUpgradeLongPress();
  closeUpgradeTooltip();
}, { passive: true, capture: true });

function setAssistantTooltip(open) {
  const summary = $('assistantSummary');
  const tooltip = $('assistantTooltip');
  summary.classList.toggle('assistant-tooltip-open', open);
  summary.setAttribute('aria-expanded', String(open));
  tooltip.setAttribute('aria-hidden', String(!open));
}
$('assistantSummary').addEventListener('click', event => {
  event.stopPropagation();
  setAssistantTooltip($('assistantSummary').getAttribute('aria-expanded') !== 'true');
});
$('assistantSummary').addEventListener('keydown', event => {
  if (['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    setAssistantTooltip($('assistantSummary').getAttribute('aria-expanded') !== 'true');
  } else if (event.key === 'Escape') setAssistantTooltip(false);
});
function setFactionCoinPanel(open) {
  if (!open) closeFactionCoinTooltip();
  $('factionCoinDock').classList.toggle('faction-coin-open', open);
  $('factionCoinToggle').setAttribute('aria-expanded', String(open));
}
document.addEventListener('click', event => {
  const fcItem = event.target.closest('#factionCoinList .faction-coin-item');
  if (fcItem) {
    if (suppressedFactionCoinClick && performance.now() < suppressedFactionCoinClick.until) {
      suppressedFactionCoinClick = null;
      return;
    }
    if (activeFactionCoinTooltip === fcItem) closeFactionCoinTooltip();
    else openFactionCoinTooltip(fcItem);
    return;
  } else if (activeFactionCoinTooltip) {
    closeFactionCoinTooltip();
  }

  if (!event.target.closest('#factionCoinDock') && !event.target.closest('#factionCoinToggle')) setFactionCoinPanel(false);
  const upgradeButton = event.target.closest(tooltipButtonSelector);
  if (upgradeButton && suppressedUpgradeClick && performance.now() < suppressedUpgradeClick.until) {
    event.preventDefault();
    suppressedUpgradeClick = null;
    return;
  }
  if (!event.target.closest('#assistantSummary')) setAssistantTooltip(false);
  if (!event.target.closest('.event-strip') && !$('eventLog').hidden) setEventLogOpen(false);
  if (event.target.closest('#workArea') && activeTab !== 'work') closeAuxPanel();
  const tab = event.target.closest('[data-tab]');
  if (tab) { if (activeTab === tab.dataset.tab) closeAuxPanel(); else openAuxPanel(tab.dataset.tab, tab); return; }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
  const action = button.dataset.action; const id = button.dataset.id;
  if (action === 'start') {
    $('intro').classList.add('hidden');
    commandResult(game.dispatch({ type: 'start' })); return;
  }
  if (action === 'work') {
    const result = game.dispatch({ type: 'work' });
    if (commandResult(result)) workFeedback(event, result.facts);
    return;
  }
  if (action === 'toggle-upgrade-collection') {
    const buildingId = button.dataset.buildingId;
    if (expandedUpgradeCollections.has(buildingId)) expandedUpgradeCollections.delete(buildingId);
    else expandedUpgradeCollections.add(buildingId);
    renderPanel();
    return;
  }
  if (action === 'toggle-trophy-group') {
    const group = button.dataset.group;
    if (collapsedTrophyGroups.has(group)) collapsedTrophyGroups.delete(group);
    else collapsedTrophyGroups.add(group);
    renderPanel();
    return;
  }
  if (action === 'show-trophy') {
    const entry = button.closest('[data-trophy-card]');
    if (activeUpgradeTooltip === entry) closeUpgradeTooltip();
    else openUpgradeTooltip(entry, event.pointerType !== 'mouse');
    return;
  }
  if (action === 'open-royal-market') { openRoyalMarket(); return; }
  if (action === 'close-royal-market') { closeRoyalMarket(); return; }
  if (action === 'purchase') {
    if (definition(id).kind === 'alignment') {
      pendingAlignmentId = id;
      modal.show({
        story: {
          id: 'ui.alignment.confirm',
          title: `确认选择【${definition(id).name}】`,
          paragraphs: ['确认后将无法更改当前立场。'],
          choices: [{ id: 'confirm', label: '确认' }],
          buttonLabel: '取消',
        },
      });
      return;
    }
    commandResult(game.dispatch({ type: 'purchase', id, amount: state().settings.buyAmount }));
    return;
  }
  if (action === 'cast') { commandResult(game.dispatch({ type: 'cast', id })); return; }
  if (action === 'buy-amount') { game.dispatch({ type: 'setting', key: 'buyAmount', value: button.dataset.value === 'max' ? 'max' : Number(button.dataset.value) }); return; }
  if (action === 'toggle-quick-skill') { updateQuickSkill(id, quickSkillIds(QUICK_SKILL_LIMIT).includes(id) ? 'remove' : 'pin'); return; }
  if (action === 'prioritize-skill') { updateQuickSkill(id, 'pin'); return; }
  if (action === 'toggle-faction-coins') { setFactionCoinPanel($('factionCoinToggle').getAttribute('aria-expanded') !== 'true'); return; }
  if (action === 'toggle-log') { setEventLogOpen($('eventLog').hidden); return; }
  if (action === 'close-log') { setEventLogOpen(false, true); return; }
  if (action === 'close-panel') { closeAuxPanel(); return; }
  if (action === 'replay-announcement') {
    const announcement = announcements.find(item => item.id === id);
    if (!announcement) { notify('更新公告暂时无法加载，请稍后重试', true); return; }
    modal.show({ story: {
      id: `ui.announcement.${announcement.id}`,
      title: announcement.title,
      paragraphs: announcement.body,
      buttonLabel: '关闭公告',
    } });
    return;
  }
  if (action === 'abdicate') {
    if (!game.select('retirement').eligible) {
      commandResult(game.dispatch({ type: 'abdicate' }));
      return;
    }
    modal.show({ story: {
      id: 'ui.retirement.confirm',
      title: '确定退休结算吗？',
      paragraphs: ['本轮工资、设施、升级和部门关系将重置，奖杯与剧情保留。'],
      choices: [{ id: 'confirm', label: '确认退休' }],
      buttonLabel: '取消',
    } });
    return;
  }
  if (action === 'reincarnate') { if (confirm('确定投胎吗？当前期权将被清空。')) commandResult(game.dispatch({ type: 'reincarnate' })); return; }
  if (action === 'replay-story') { replayStory(id); return; }
  if (action === 'apply-mana-regen') {
    const value = Number($('manaRegenInput').value);
    if (!Number.isFinite(value) || value < 0) { notify('请输入有效的恢复速度', true); return; }
    if (commandResult(game.dispatch({ type: 'setting', key: 'manaRegenOverride', value }))) notify('精力恢复速度已更新');
    return;
  }
  if (action === 'edit-user-id') {
    promptUserId().then(userId => {
      currentUserId = userId;
      window.tdem?.setUser(userId);
      renderTop();
    });
    return;
  }
  if (action === 'save') { game.save().then(result => notify(result.ok ? '存档已写入本地' : '保存失败，将自动重试', !result.ok)); return; }
  if (action === 'export') { game.save().then(result => {
    if (!result.ok) { notify('导出失败：存档未写入，请重试', true); return; }
    $('exportText').value = saveAdapter.listSlots().main || '';
    $('exportText').select();
    notify('存档已导出，请复制保存');
  }); return; }
  if (action === 'import') { $('importFile').click(); return; }
  if (action === 'import-text') {
    const text = $('exportText').value;
    if (!text.trim()) { notify('请先粘贴存档文本', true); return; }
    importSave(text, '导入失败：文本不是有效的游戏存档');
    return;
  }
  if (action === 'hard-reset') {
    if (resetting) return;
    modal.show({ story: {
      id: 'ui.hard-reset.confirm',
      title: '清除全部进度？',
      paragraphs: ['将删除本机上的全部游戏进度，此操作不能撤销。'],
      choices: [{ id: 'confirm', label: '确认清除全部进度' }],
      buttonLabel: '取消',
    } });
  }
});
$('royalMarketDialog').addEventListener('click', event => {
  if (event.target === $('royalMarketDialog')) closeRoyalMarket();
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'manaPasswordForm') return;
  event.preventDefault();
  const unlocked = await game.unlockDeveloper($('manaPassword').value);
  if (unlocked) {
    manaEditorUnlocked = true;
    const reward = game.dispatch({ type: 'developer.reward' });
    $('manaPasswordFeedback').textContent = reward.ok ? `已获得 ${money(reward.result.amount)} 工资` : '';
    $('manaPasswordFeedback').className = reward.ok ? 'success' : '';
    $('manaPassword').value = '';
    syncManaEditor();
  } else {
    $('manaPasswordFeedback').textContent = '密码不正确';
    $('manaPasswordFeedback').className = 'error';
  }
});
$('importFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  let raw;
  try { raw = await file.text(); }
  catch {
    event.target.value = '';
    notify('导入失败：无法读取所选文件', true);
    return;
  }
  event.target.value = '';
  importSave(raw, '导入失败：文件不是有效的游戏存档');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('royalMarketDialog').hidden) { closeRoyalMarket(); return; }
  if (event.key === 'Escape') {
    if (activeFactionCoinTooltip) { closeFactionCoinTooltip(); return; }
    setFactionCoinPanel(false);
  }
  if (event.key === 'Escape' && !$('eventLog').hidden) { setEventLogOpen(false, true); return; }
  if (event.key === 'Escape' && activeUpgradeTooltip) {
    dismissedUpgradeTooltip = activeUpgradeTooltip;
    closeUpgradeTooltip();
    return;
  }
  if (event.key === 'Escape' && activeTab !== 'work') closeAuxPanel();
  if (event.code === 'Space' && $('intro').classList.contains('hidden') && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    const result = game.dispatch({ type: 'work' });
    if (commandResult(result)) workFeedback(null, result.facts);
  }
});
window.addEventListener('popstate', () => { if (activeTab !== 'work') closeAuxPanel(true); panelHistory = false; });
window.addEventListener('resize', () => {
  cancelFactionCoinLongPress(); closeFactionCoinTooltip();
  cancelUpgradeLongPress(); closeUpgradeTooltip();
  if (game) { quickStructure = ''; renderQuickSkills(); updateCastButtons(); }
});
function settleBackgroundElapsed(force = false) {
  if (backgroundStartedAt === null || !graph) return true;
  const now = timeSource.now();
  if (!force && now < backgroundRetryAfter) return false;
  const seconds = Math.max(0, (now - backgroundStartedAt) / 1000);
  const result = seconds > 0 ? game.dispatch({ type: 'background.settle', seconds }) : { ok: true };
  if (!result.ok) { backgroundRetryAfter = now + 1000; return false; }
  backgroundStartedAt = null; backgroundRetryAfter = 0; lastTick = performance.now();
  return true;
}
window.addEventListener('beforeunload', () => {
  if (resetting || importingSave) return;
  if (backgroundStartedAt !== null && !settleBackgroundElapsed(true)) return;
  game?.save();
});
document.addEventListener('visibilitychange', () => {
  if (!graph || resetting || importingSave) return;
  if (document.hidden) {
    if (backgroundStartedAt === null) { backgroundStartedAt = timeSource.now(); game.save(); }
  } else {
    settleBackgroundElapsed();
    timeSource.refresh();
  }
});

const USER_ID_STORAGE_KEY = 'endless-shift-user-id';
const validUserId = value => {
  const id = String(value ?? '').trim();
  return Array.from(id).length >= 1 && Array.from(id).length <= 16 && /^[\p{L}\p{N}_-]+$/u.test(id);
};
function promptUserId() {
  const gate = $('userIdGate');
  const form = $('userIdForm');
  const input = $('userIdInput');
  const feedback = $('userIdFeedback');
  gate.hidden = false;
  input.value = currentUserId;
  feedback.textContent = '';
  input.focus();
  input.select();
  return new Promise(resolve => {
    const submit = event => {
      event.preventDefault();
      const userId = input.value.trim();
      if (!validUserId(userId)) {
        feedback.textContent = '请输入 1～16 个有效字符，不要包含空格或其他符号。';
        return;
      }
      try { localStorage.setItem(USER_ID_STORAGE_KEY, userId); }
      catch {
        feedback.textContent = '浏览器未能保存游戏 ID，请检查存储权限后重试。';
        return;
      }
      form.removeEventListener('submit', submit);
      gate.hidden = true;
      resolve(userId);
    };
    form.addEventListener('submit', submit);
  });
}
async function requireUserId() {
  const cached = String(localStorage.getItem(USER_ID_STORAGE_KEY) ?? '').trim();
  return validUserId(cached) ? cached : promptUserId();
}

async function bootstrap() {
  currentUserId = await requireUserId();
  window.tdem?.setUser(currentUserId);
  window.tdem?.reportPageView();
  timeSource = await createTrustedTime();
  game = createGameRuntime({
    content: CONTENT,
    saveAdapter,
    mode: 'production',
    clock: { wallNow: timeSource.now, monotonicNow: () => performance.now() },
    isTimeVerified: timeSource.isVerified,
  });
  await game.start();
  await game.save();
  graph = game.graph;
  $('workContent').innerHTML = workView();
  if (state().stats.total.clicks > 0 || Object.keys(state().buildings).length || state().story.pending.length || Object.keys(state().story.completed).length) $('intro').classList.add('hidden');
  game.subscribe(message => { if (message.type === 'commit') factFeedback(message.facts, message.commandType); refresh(message); });
  refresh();
  loadAnnouncement();
  lastTick = performance.now();
  setInterval(() => {
    const now = performance.now(); const delta = (now - lastTick) / 1000; lastTick = now;
    if (document.hidden) return;
    if (backgroundStartedAt !== null) { settleBackgroundElapsed(); return; }
    game.tick(delta);
  }, 200);
  setInterval(showAssistantIncome, 1000);
  setInterval(showAssistantFactionCoins, 1000);
  setInterval(() => timeSource.refresh(), 600000);
  setInterval(() => { if (!resetting && !importingSave && !document.hidden && backgroundStartedAt === null && game.select('saveStatus').dirty) game.save(); }, 15000);
}
bootstrap().catch(error => {
  console.error(error);
  $('intro').classList.remove('hidden');
  document.querySelector('.intro-card').innerHTML = `<h1>档案暂时无法读取</h1><p>你的原存档未被覆盖。请稍后重试，或联系档案管理员恢复记录。</p>`;
});
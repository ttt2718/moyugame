const coinsElement = document.getElementById('coins');
const productionElement = document.getElementById('production');
const countElement = document.getElementById('facilityCount');
const workButton = document.getElementById('workButton');
const facilityButton = document.getElementById('facilityButton');
const facilityAction = document.getElementById('facilityAction');
const demoStatus = document.getElementById('demoStatus');
const coinLayer = document.getElementById('coinLayer');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

let coins = 128;
let facilityCount = 0;

function render() {
  coinsElement.textContent = `¥ ${coins}`;
  productionElement.textContent = `¥ ${facilityCount}`;
  countElement.textContent = String(facilityCount);
  facilityButton.disabled = coins < 15;
  facilityAction.textContent = facilityButton.disabled ? '工资不足' : '点击采购';
  facilityButton.setAttribute('aria-label', `见习工位，当前 ${facilityCount} 个，价格 15 工资，${facilityButton.disabled ? '工资不足' : '点击采购'}`);
}

function replayHit(element) {
  element.classList.remove('is-hit');
  void element.offsetWidth;
  element.classList.add('is-hit');
  setTimeout(() => element.classList.remove('is-hit'), 140);
}

function paperFeedback(text) {
  const floater = document.createElement('span');
  floater.className = 'coin-floater';
  floater.textContent = text;
  coinLayer.appendChild(floater);
  setTimeout(() => floater.remove(), reduceMotion.matches ? 1200 : 800);
  if (reduceMotion.matches) return;
  for (let index = 0; index < 4; index += 1) {
    const particle = document.createElement('span');
    particle.className = 'paper-particle';
    particle.style.setProperty('--dx', `${(Math.random() - .5) * 130}px`);
    particle.style.setProperty('--dy', `${-45 - Math.random() * 65}px`);
    particle.style.setProperty('--spin', `${(Math.random() - .5) * 320}deg`);
    coinLayer.appendChild(particle);
    setTimeout(() => particle.remove(), 720);
  }
}

workButton.addEventListener('click', () => {
  coins += 1;
  replayHit(workButton);
  paperFeedback('+¥1');
  demoStatus.textContent = `搬砖完成，获得 1 工资，当前 ${coins} 工资。`;
  render();
});

facilityButton.addEventListener('click', () => {
  if (coins < 15) return;
  coins -= 15;
  facilityCount += 1;
  replayHit(facilityButton);
  paperFeedback('零件 +1');
  demoStatus.textContent = `见习工位采购完成，当前 ${facilityCount} 个，每秒产出 ${facilityCount} 工资。`;
  render();
});

render();

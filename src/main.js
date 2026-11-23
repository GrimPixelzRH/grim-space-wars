import { ethers } from 'ethers';
import './style.css';

// --- CONFIG ---
const CHAIN_ID = 4663;
const NFT_CONTRACT = '0x1b9fc335100cf5c9fb1ace25e29e155185978e1c';
const ERC721_ABI = [
  'function balanceOf(address owner) view returns (uint256)'
];

const ROBINHOOD_CHAIN = {
  chainId: '0x1237',
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com']
};

// --- DOM ---
const connectBtn = document.getElementById('connectBtn');
const playAgainBtn = document.getElementById('playAgainBtn');
const howToPlayBtn = document.getElementById('howToPlayBtn');
const closeHowToPlay = document.getElementById('closeHowToPlay');
const howToPlayModal = document.getElementById('howToPlayModal');
const statusEl = document.getElementById('status');
const gameContainer = document.getElementById('gameContainer');
const menu = document.getElementById('menu');
const leaderboardContainer = document.getElementById('leaderboardContainer');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const healthFill = document.getElementById('healthFill');
const healthText = document.getElementById('healthText');
const leaderboardEl = document.getElementById('leaderboard');
const nameSection = document.getElementById('nameSection');
const playerNameInput = document.getElementById('playerNameInput');
const setNameBtn = document.getElementById('setNameBtn');

let provider, signer, userAddress;
let playerName = localStorage.getItem('grimPlayerName') || '';
let isConnected = false;

// --- ASSETS ---
const grimImgs = [];
for (let i = 1; i <= 10; i++) {
  const img = new Image();
  img.src = `/grim${i}.png`;
  img.onload = () => { if (gameRunning) draw(); };
  grimImgs.push(img);
}

const asteroidImgs = [];
for (let i = 1; i <= 5; i++) {
  const img = new Image();
  img.src = `/asteroid${i}.png`;
  img.onload = () => { if (gameRunning) draw(); };
  asteroidImgs.push(img);
}

const loveImg = new Image();
loveImg.src = '/love.png';
loveImg.onload = () => { if (gameRunning) draw(); };

const timeStopImg = new Image();
timeStopImg.src = '/timestop.png';
timeStopImg.onload = () => { if (gameRunning) draw(); };

const bgImg = new Image();
bgImg.src = '/bg.png';
bgImg.onload = () => { if (gameRunning) draw(); };

const SIZE_PRESETS = [0.045, 0.065, 0.09, 0.12, 0.15];

// --- CANVAS RESIZE ---
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

window.addEventListener('resize', resizeCanvas);

// --- LEADERBOARD ---
function getLeaderboard() {
  const raw = localStorage.getItem('grimSpaceWarsLeaderboard');
  return raw ? JSON.parse(raw) : [];
}

function saveLeaderboard(list) {
  localStorage.setItem('grimSpaceWarsLeaderboard', JSON.stringify(list));
}

function formatTime(ms) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function addScore(name, score, durationMs) {
  if (!name || score < 100) return;
  const list = getLeaderboard();
  const cleanName = name.trim().toUpperCase().slice(0, 12);

  const existingIndex = list.findIndex(e => e.name === cleanName);
  if (existingIndex >= 0) {
    if (score > list[existingIndex].score) {
      list[existingIndex] = { name: cleanName, score, time: durationMs, timestamp: Date.now() };
    }
  } else {
    list.push({ name: cleanName, score, time: durationMs, timestamp: Date.now() });
  }

  list.sort((a, b) => b.score - a.score);
  const top = list.slice(0, 10);
  saveLeaderboard(top);
  renderLeaderboard();
}

function renderLeaderboard() {
  const list = getLeaderboard();
  leaderboardEl.innerHTML = '';
  if (list.length === 0) {
    leaderboardEl.innerHTML = '<li style="justify-content:center;opacity:0.6">No scores yet</li>';
    return;
  }
  list.forEach((entry, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="rank">${i + 1}.</span>
      <span class="name">${entry.name}</span>
      <span class="score">${entry.score} <small>(${formatTime(entry.time)})</small></span>
    `;
    leaderboardEl.appendChild(li);
  });
}

// --- WALLET HELPERS ---
async function ensureCorrectNetwork() {
  const network = await provider.getNetwork();
  if (Number(network.chainId) === CHAIN_ID) return true;

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ROBINHOOD_CHAIN.chainId }]
    });
    return true;
  } catch (switchError) {
    if (switchError.code === 4902) {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [ROBINHOOD_CHAIN]
        });
        return true;
      } catch (addError) {
        console.error(addError);
        statusEl.textContent = 'Failed to add Robinhood Chain';
        statusEl.className = 'denied';
        return false;
      }
    }
    statusEl.textContent = 'Please switch to Robinhood Chain';
    statusEl.className = 'denied';
    return false;
  }
}

async function checkNFTOwnership() {
  const contract = new ethers.Contract(NFT_CONTRACT, ERC721_ABI, provider);
  const balance = await contract.balanceOf(userAddress);
  return balance > 0n;
}

// --- GAME STATE ---
let gameRunning = false;
let score = 0;
let health = 100;
let mouse = { x: 0, y: 0 };
let player = { x: 0, y: 0, size: 64 };
let stroids = [];
let lastSpawn = 0;
let lastScoreTick = 0;
let freezeUntil = 0;
let lastSpecialSpawn = 0;
let gameStartTime = 0;
const SPECIAL_MIN_DELAY = 10000;
const SPECIAL_COOLDOWN_MIN = 25000;
const SPECIAL_COOLDOWN_MAX = 40000;

function getDifficulty() {
  return Math.floor(score / 2000);
}

function getBaseSize() {
  return Math.min(canvas.width, canvas.height) / (window.devicePixelRatio || 1);
}

function updateHUD() {
  scoreEl.textContent = score;
  healthFill.style.width = `${health}%`;
  healthText.textContent = health;
}

function getCurrentGrim() {
  const level = Math.min(9, Math.floor(score / 1000));
  return grimImgs[level];
}

function hasTypeOnScreen(type) {
  return stroids.some(s => s.type === type);
}

function spawnOneStroid() {
  const now = Date.now();
  const difficulty = getDifficulty();
  const timePlayed = now - gameStartTime;
  const base = getBaseSize();
  const frozen = now < freezeUntil;

  // During freeze only allow love (and rare specials if cooldown allows)
  if (frozen) {
    if (Math.random() > 0.08 || hasTypeOnScreen('love')) return; // very rare love only
  }

  const specialAllowed = timePlayed > SPECIAL_MIN_DELAY &&
                         (now - lastSpecialSpawn) > (SPECIAL_COOLDOWN_MIN + Math.random() * (SPECIAL_COOLDOWN_MAX - SPECIAL_COOLDOWN_MIN));

  const canFreeze = specialAllowed && !hasTypeOnScreen('timestop') && !frozen;
  const canLove = specialAllowed && !hasTypeOnScreen('love');

  const roll = Math.random();
  let type = 'normal';

  if (roll < 0.035 && canFreeze) {
    type = 'timestop';
    lastSpecialSpawn = now;
  } else if (roll < 0.08 && canLove) {
    type = 'love';
    lastSpecialSpawn = now;
  } else if (frozen) {
    return; // no normals during freeze
  }

  const side = Math.floor(Math.random() * 4);
  let x, y, vx, vy;

  let baseSpeed = 1.4 + Math.random() * 2.4;
  if (type === 'love' || type === 'timestop') {
    baseSpeed *= 1.4;
  }
  const speed = baseSpeed * (1 + difficulty * 0.15);

  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);

  if (side === 0) {
    x = Math.random() * w;
    y = -80;
    vx = (Math.random() - 0.5) * speed * 1.5;
    vy = speed * (0.7 + Math.random() * 0.6);
  } else if (side === 1) {
    x = Math.random() * w;
    y = h + 80;
    vx = (Math.random() - 0.5) * speed * 1.5;
    vy = -speed * (0.7 + Math.random() * 0.6);
  } else if (side === 2) {
    x = -80;
    y = Math.random() * h;
    vx = speed * (0.7 + Math.random() * 0.6);
    vy = (Math.random() - 0.5) * speed * 1.5;
  } else {
    x = w + 80;
    y = Math.random() * h;
    vx = -speed * (0.7 + Math.random() * 0.6);
    vy = (Math.random() - 0.5) * speed * 1.5;
  }

  let size, img;
  if (type === 'love') {
    size = base * 0.09;
    img = loveImg;
  } else if (type === 'timestop') {
    size = base * 0.1;
    img = timeStopImg;
  } else {
    const idx = Math.floor(Math.random() * 5);
    size = base * SIZE_PRESETS[idx];
    img = asteroidImgs[idx];
  }

  stroids.push({ x, y, vx, vy, size, type, img });
}

function showMenu() {
  menu.style.display = 'block';
  leaderboardContainer.style.display = 'block';
  gameContainer.style.display = 'none';
}

function hideMenu() {
  menu.style.display = 'none';
  leaderboardContainer.style.display = 'none';
  gameContainer.style.display = 'flex';
}

function resetGame() {
  hideMenu();

  requestAnimationFrame(() => {
    resizeCanvas();

    score = 0;
    health = 100;
    const base = getBaseSize();
    player.size = Math.max(32, base * 0.11);
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    player.x = w / 2 - player.size / 2;
    player.y = h / 2 - player.size / 2;
    mouse.x = w / 2;
    mouse.y = h / 2;

    stroids = [];
    freezeUntil = 0;
    lastSpecialSpawn = 0;
    lastScoreTick = Date.now();
    gameStartTime = Date.now();
    updateHUD();
    gameRunning = true;
    playAgainBtn.style.display = 'none';
    connectBtn.style.display = 'none';
    statusEl.textContent = 'Dodging...';
    statusEl.className = 'holder';

    draw();
  });
}

function gameOver() {
  gameRunning = false;
  const duration = Date.now() - gameStartTime;
  addScore(playerName, score, duration);
  statusEl.textContent = `GAME OVER — SCORE: ${score}`;
  statusEl.className = 'denied';
  playAgainBtn.style.display = 'inline-block';
  connectBtn.style.display = 'none';
  showMenu();
}

function update() {
  if (!gameRunning) return;

  const now = Date.now();
  const frozen = now < freezeUntil;
  const difficulty = getDifficulty();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  if (now - lastScoreTick > 100) {
    score += 2;
    lastScoreTick = now;
    updateHUD();
  }

  player.x = mouse.x - player.size / 2;
  player.y = mouse.y - player.size / 2;
  player.x = Math.max(0, Math.min(w - player.size, player.x));
  player.y = Math.max(0, Math.min(h - player.size, player.y));

  const spawnInterval = Math.max(120, 280 - difficulty * 25);
  if (now - lastSpawn > spawnInterval) {
    const count = frozen ? 1 : (1 + Math.floor(Math.random() * 3));
    for (let k = 0; k < count; k++) spawnOneStroid();
    lastSpawn = now;
  }

  for (let i = stroids.length - 1; i >= 0; i--) {
    const s = stroids[i];

    // Only love moves during freeze. Everything else is fully paused.
    if (!frozen || s.type === 'love') {
      s.x += s.vx;
      s.y += s.vy;
    }

    if (s.x < -120 || s.x > w + 120 || s.y < -120 || s.y > h + 120) {
      stroids.splice(i, 1);
      continue;
    }

    const dx = (player.x + player.size / 2) - (s.x + s.size / 2);
    const dy = (player.y + player.size / 2) - (s.y + s.size / 2);
    const dist = Math.hypot(dx, dy);
    if (dist < (player.size * 0.38 + s.size * 0.38)) {
      if (s.type === 'love') {
        health = Math.min(100, health + 20 + Math.floor(s.size / 4));
        score += 50;
      } else if (s.type === 'timestop') {
        freezeUntil = now + 10000;
        score += 100;
      } else {
        const dmg = Math.floor(s.size / 3.0) + difficulty;
        health -= dmg;
      }
      stroids.splice(i, 1);
      updateHUD();
      if (health <= 0) {
        health = 0;
        updateHUD();
        gameOver();
        return;
      }
    }
  }
}

function draw() {
  if (!gameRunning) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  ctx.imageSmoothingEnabled = false;

  if (bgImg.complete && bgImg.naturalWidth) {
    ctx.drawImage(bgImg, 0, 0, w, h);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  }

  if (Date.now() < freezeUntil) {
    ctx.fillStyle = 'rgba(100, 180, 255, 0.12)';
    ctx.fillRect(0, 0, w, h);
  }

  stroids.forEach(s => {
    if (s.img.complete && s.img.naturalWidth) {
      ctx.drawImage(s.img, s.x, s.y, s.size, s.size);
    } else {
      ctx.fillStyle = s.type === 'love' ? '#ff66aa' : s.type === 'timestop' ? '#66ccff' : '#CCFF00';
      ctx.fillRect(s.x, s.y, s.size, s.size);
    }
  });

  const grim = getCurrentGrim();
  if (grim && grim.complete && grim.naturalWidth) {
    ctx.drawImage(grim, player.x, player.y, player.size, player.size);
  } else {
    ctx.fillStyle = '#CCFF00';
    ctx.fillRect(player.x, player.y, player.size, player.size);
  }
}

function gameLoop() {
  update();
  draw();
  requestAnimationFrame(gameLoop);
}

function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

canvas.addEventListener('mousemove', e => {
  mouse = getCanvasPos(e);
});

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (e.touches[0]) mouse = getCanvasPos(e.touches[0]);
}, { passive: false });

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (e.touches[0]) mouse = getCanvasPos(e.touches[0]);
}, { passive: false });

playAgainBtn.addEventListener('click', () => {
  if (userAddress && playerName && isConnected) {
    resetGame();
  } else {
    statusEl.textContent = 'Please reconnect wallet first';
    statusEl.className = 'denied';
    connectBtn.textContent = 'Connect Wallet';
    connectBtn.style.display = 'inline-block';
    playAgainBtn.style.display = 'none';
  }
});

howToPlayBtn.addEventListener('click', () => {
  howToPlayModal.classList.add('active');
});

closeHowToPlay.addEventListener('click', () => {
  howToPlayModal.classList.remove('active');
});

howToPlayModal.addEventListener('click', (e) => {
  if (e.target === howToPlayModal) {
    howToPlayModal.classList.remove('active');
  }
});

setNameBtn.addEventListener('click', () => {
  const name = playerNameInput.value.trim();
  if (name.length >= 2) {
    playerName = name.toUpperCase().slice(0, 12);
    localStorage.setItem('grimPlayerName', playerName);
    nameSection.style.display = 'none';
    statusEl.textContent = `Name set: ${playerName}`;
    if (isConnected) {
      connectBtn.textContent = 'Start Game';
      connectBtn.style.display = 'inline-block';
    }
  } else {
    statusEl.textContent = 'Name must be at least 2 characters';
    statusEl.className = 'denied';
  }
});

connectBtn.addEventListener('click', async () => {
  if (isConnected) {
    if (!playerName) {
      nameSection.style.display = 'block';
      statusEl.textContent = 'Set your name first';
      return;
    }
    resetGame();
    if (!gameRunning) gameLoop();
    return;
  }

  if (!window.ethereum) {
    statusEl.textContent = 'No wallet detected. Install MetaMask or another injected wallet.';
    statusEl.className = 'denied';
    return;
  }

  try {
    statusEl.textContent = 'Connecting...';
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();

    const onCorrectChain = await ensureCorrectNetwork();
    if (!onCorrectChain) return;

    statusEl.textContent = `Connected: ${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
    statusEl.className = '';

    const isHolder = await checkNFTOwnership();
    if (isHolder) {
      isConnected = true;
      connectBtn.textContent = 'Start Game';
      statusEl.textContent = 'NFT confirmed. Set name if needed, then Start Game.';
      statusEl.className = 'holder';
      if (!playerName) {
        nameSection.style.display = 'block';
      } else {
        connectBtn.style.display = 'inline-block';
      }
    } else {
      isConnected = false;
      statusEl.textContent = 'Access denied. You must hold at least 1 Grim Pixelz NFT.';
      statusEl.className = 'denied';
      connectBtn.textContent = 'Connect Wallet';
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Connection failed or rejected.';
    statusEl.className = 'denied';
    isConnected = false;
  }
});

// Init — always force reconnect on page load / refresh
if (playerName) {
  playerNameInput.value = playerName;
}
connectBtn.textContent = 'Connect Wallet';
connectBtn.style.display = 'inline-block';
showMenu();
renderLeaderboard();
gameLoop();
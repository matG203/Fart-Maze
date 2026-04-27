/* ═══════════════════════════════════════════
   FART MAZE — Client
   ═══════════════════════════════════════════ */

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let myId = null;
let currentCode = null;
let currentMaze = null;
let currentState = null;
let cellSize = 40;
let myIsIt = false;
let myEscaped = false;
let animFrame = null;
let cameraX = 0, cameraY = 0;
let isTouch = false;

// Joystick state
let joystickActive = false;
let joystickOrigin = { x: 0, y: 0 };
let joystickDelta  = { x: 0, y: 0 };

// Keys held
const keys = {};

// ─── Audio (Web Audio API — no files needed) ──────────────────────────────────
let audioCtx = null;

function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playFart() {
  try {
    const ctx = getAudio();
    // Layer of noise bursts for a fart sound
    const bufSize = ctx.sampleRate * 0.6;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufSize, 1.5);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(200, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.4);
    filter.Q.value = 0.8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch(e) {}
}

function playAmbient() {
  try {
    const ctx = getAudio();
    // Low drone
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 55;
    const g = ctx.createGain();
    g.gain.value = 0.04;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();

    // Slow LFO wobble
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.1;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 8;
    lfo.connect(lfoG);
    lfoG.connect(osc.frequency);
    lfo.start();
  } catch(e) {}
}

function playStingSound() {
  try {
    const ctx = getAudio();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } catch(e) {}
}

// ─── Floating particles (horror atmosphere) ───────────────────────────────────
function spawnParticles() {
  for (let i = 0; i < 12; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.animationDuration = (6 + Math.random() * 10) + 's';
    p.style.animationDelay = (Math.random() * 8) + 's';
    p.style.width = p.style.height = (1 + Math.random() * 3) + 'px';
    document.body.appendChild(p);
  }
}
spawnParticles();

// ─── Screens ──────────────────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

function showErr(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ─── Home ─────────────────────────────────────────────────────────────────────
function createRoom() {
  const name = document.getElementById('home-name').value.trim();
  if (!name) return showErr('home-err', 'Enter your name first!');
  socket.emit('createRoom', { name });
}
function joinRoom() {
  const name = document.getElementById('home-name').value.trim();
  const code = document.getElementById('home-code').value.trim().toUpperCase();
  if (!name) return showErr('home-err', 'Enter your name first!');
  if (code.length !== 4) return showErr('home-err', 'Enter a 4-letter code!');
  socket.emit('joinRoom', { code, name });
}
function copyCode() {
  if (currentCode) navigator.clipboard.writeText(currentCode).catch(() => {});
}
function startGame() {
  socket.emit('startGame', { code: currentCode });
}
function playAgain() {
  socket.emit('playAgain', { code: currentCode });
}
function goHome() {
  show('home');
  if (animFrame) cancelAnimationFrame(animFrame);
}

document.getElementById('home-code').addEventListener('input', function() { this.value = this.value.toUpperCase(); });
document.getElementById('home-name').addEventListener('keypress', e => { if (e.key === 'Enter') createRoom(); });
document.getElementById('home-code').addEventListener('keypress', e => { if (e.key === 'Enter') joinRoom(); });

// ─── Lobby Render ─────────────────────────────────────────────────────────────
function renderLobby(data) {
  show('lobby');
  document.getElementById('lobby-code').textContent = data.code;
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  data.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'lobby-chip' + (p.id === data.host ? ' host' : '');
    chip.textContent = p.name;
    list.appendChild(chip);
  });

  const startBtn = document.getElementById('start-btn');
  const hint = document.getElementById('lobby-hint');
  if (data.host === myId) {
    if (data.players.length >= 2) {
      startBtn.classList.remove('hidden');
      hint.textContent = '';
    } else {
      startBtn.classList.add('hidden');
      hint.textContent = 'Waiting for at least 1 more player…';
    }
  } else {
    startBtn.classList.add('hidden');
    hint.textContent = `Waiting for the host to start… (${data.players.length} player${data.players.length !== 1 ? 's' : ''})`;
  }
}

// ─── Canvas & Rendering ───────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Player colours (stable per index)
const PLAYER_COLORS = ['#a78bfa','#f472b6','#34d399','#fbbf24','#60a5fa','#f87171','#a3e635','#fb923c'];

function getPlayerColor(id, players) {
  const idx = players.findIndex(p => p.id === id);
  return PLAYER_COLORS[idx % PLAYER_COLORS.length] || '#fff';
}

function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  if (!currentMaze) return;
  const mazeW = currentMaze[0].length * cellSize;
  const mazeH = currentMaze.length * cellSize;
  const scaleX = wrap.clientWidth / mazeW;
  const scaleY = (wrap.clientHeight) / mazeH;
  const scale = Math.min(scaleX, scaleY, 1);
  canvas.style.transform = `scale(${scale})`;
  canvas.style.transformOrigin = 'top left';
  canvas.width = mazeW;
  canvas.height = mazeH;
}

window.addEventListener('resize', resizeCanvas);

function drawMaze(maze) {
  const cols = maze[0].length;
  const rows = maze.length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (maze[r][c] === 0) {
        // Wall
        ctx.fillStyle = '#0a0a16';
        ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
        // subtle wall texture
        ctx.fillStyle = 'rgba(124,58,237,0.07)';
        ctx.fillRect(c * cellSize + 1, r * cellSize + 1, cellSize - 2, cellSize - 2);
      } else {
        // Floor
        ctx.fillStyle = '#0d0d1f';
        ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
        // subtle grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.02)';
        ctx.strokeRect(c * cellSize, r * cellSize, cellSize, cellSize);
      }
    }
  }
}

function drawExit(exitPos) {
  if (!exitPos) return;
  // Glowing exit
  const grad = ctx.createRadialGradient(exitPos.x, exitPos.y, 0, exitPos.x, exitPos.y, 30);
  grad.addColorStop(0, 'rgba(34,197,94,0.6)');
  grad.addColorStop(1, 'rgba(34,197,94,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(exitPos.x, exitPos.y, 30, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#22c55e';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('EXIT', exitPos.x, exitPos.y);
}

function drawPlayers(players) {
  players.forEach((p, i) => {
    if (p.escaped) return;
    const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
    const r = 12;

    // Glow for chaser
    if (p.isIt) {
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.5);
      grad.addColorStop(0, 'rgba(255,50,50,0.5)');
      grad.addColorStop(1, 'rgba(255,50,50,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.isIt ? '#ff4444' : color;
    ctx.fill();
    ctx.strokeStyle = p.isIt ? '#ff0000' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Emoji label
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.isIt ? '💨' : '😨', p.x, p.y);

    // Name above
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    const nameW = ctx.measureText(p.name).width + 8;
    ctx.fillRect(p.x - nameW/2, p.y - r - 18, nameW, 14);
    ctx.fillStyle = p.isIt ? '#ff8888' : '#ffffff';
    ctx.font = '10px sans-serif';
    ctx.fillText(p.name, p.x, p.y - r - 11);
  });
}

let flickerVal = 1;
let lastFlicker = 0;
function applyFlicker(timestamp) {
  if (timestamp - lastFlicker > 80 + Math.random() * 400) {
    flickerVal = 0.85 + Math.random() * 0.15;
    lastFlicker = timestamp;
  }
  ctx.save();
  ctx.globalAlpha = flickerVal;
}

function render(timestamp) {
  if (!currentMaze || !currentState) { animFrame = requestAnimationFrame(render); return; }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyFlicker(timestamp);

  drawMaze(currentMaze);
  drawExit(currentState.exitPos);
  drawPlayers(currentState.players);

  ctx.restore();

  // Vignette
  const vg = ctx.createRadialGradient(canvas.width/2, canvas.height/2, canvas.width*0.3, canvas.width/2, canvas.height/2, canvas.width*0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  animFrame = requestAnimationFrame(render);
}

// ─── HUD Update ───────────────────────────────────────────────────────────────
function updateHUD(state) {
  const me = state.players.find(p => p.id === myId);
  if (!me) return;

  const roleEl = document.getElementById('hud-role');
  if (me.escaped) {
    roleEl.textContent = '✅ ESCAPED!';
    roleEl.className = 'hud-role escaped';
  } else if (me.isIt) {
    roleEl.textContent = '💨 YOU ARE THE FARTER';
    roleEl.className = 'hud-role is-it';
  } else {
    roleEl.textContent = '😨 RUN!';
    roleEl.className = 'hud-role runner';
  }

  const mins = Math.floor(state.gameTimer / 60);
  const secs = state.gameTimer % 60;
  const timerEl = document.getElementById('hud-timer');
  timerEl.textContent = `${mins}:${String(secs).padStart(2,'0')}`;
  timerEl.className = 'hud-timer' + (state.gameTimer < 30 ? ' urgent' : '');

  const active = state.players.filter(p => !p.escaped);
  const chasers = active.filter(p => p.isIt).length;
  const runners = active.filter(p => !p.isIt).length;
  const escaped = state.players.filter(p => p.escaped).length;
  document.getElementById('hud-status').textContent = `💨 ${chasers}  😨 ${runners}  ✅ ${escaped}`;
}

// ─── Input (Keyboard) ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => { keys[e.key] = true; sendInput(); });
document.addEventListener('keyup',   e => { keys[e.key] = false; sendInput(); });

function sendInput() {
  if (!currentCode) return;
  let dx = 0, dy = 0;
  if (keys['ArrowLeft']  || keys['a'] || keys['A']) dx -= 1;
  if (keys['ArrowRight'] || keys['d'] || keys['D']) dx += 1;
  if (keys['ArrowUp']    || keys['w'] || keys['W']) dy -= 1;
  if (keys['ArrowDown']  || keys['s'] || keys['S']) dy += 1;
  socket.emit('input', { code: currentCode, dx, dy });
}

// ─── Input (Touch Joystick) ───────────────────────────────────────────────────
function setupJoystick() {
  const zone = document.getElementById('joystick-zone');
  const base = document.getElementById('joystick-base');
  const stick = document.getElementById('joystick-stick');
  const maxR = 33;

  zone.style.display = 'block';

  function getPos(e) {
    const t = e.changedTouches ? e.changedTouches[0] : e;
    return { x: t.clientX, y: t.clientY };
  }

  base.addEventListener('touchstart', e => {
    e.preventDefault();
    joystickActive = true;
    const pos = getPos(e);
    const rect = base.getBoundingClientRect();
    joystickOrigin = { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!joystickActive) return;
    e.preventDefault();
    const pos = getPos(e);
    let dx = pos.x - joystickOrigin.x;
    let dy = pos.y - joystickOrigin.y;
    const len = Math.hypot(dx, dy);
    if (len > maxR) { dx = dx/len*maxR; dy = dy/len*maxR; }
    joystickDelta = { x: dx, y: dy };

    stick.style.left = (50 + dx/maxR*50) + '%';
    stick.style.top  = (50 + dy/maxR*50) + '%';

    const ndx = len > 4 ? dx/len : 0;
    const ndy = len > 4 ? dy/len : 0;
    socket.emit('input', { code: currentCode, dx: ndx, dy: ndy });
  }, { passive: false });

  document.addEventListener('touchend', e => {
    joystickActive = false;
    stick.style.left = '50%';
    stick.style.top  = '50%';
    joystickDelta = { x: 0, y: 0 };
    socket.emit('input', { code: currentCode, dx: 0, dy: 0 });
  });
}

// Detect touch device
window.addEventListener('touchstart', () => {
  if (!isTouch) { isTouch = true; setupJoystick(); }
}, { once: true });

// ─── Fart flash notification ──────────────────────────────────────────────────
let fartMsgTimeout = null;
function showFartMsg(msg) {
  const el = document.getElementById('fart-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(fartMsgTimeout);
  fartMsgTimeout = setTimeout(() => el.classList.add('hidden'), 3000);

  const flash = document.getElementById('fart-flash');
  flash.classList.remove('hidden');
  setTimeout(() => flash.classList.add('hidden'), 600);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect', () => { myId = socket.id; });

socket.on('roomCreated', ({ code }) => { currentCode = code; });

socket.on('lobbyState', data => {
  currentCode = data.code;
  renderLobby(data);
});

socket.on('mazeData', ({ maze, cellSize: cs, cols, rows }) => {
  currentMaze = maze;
  cellSize = cs;
  resizeCanvas();
  canvas.width = cols * cs;
  canvas.height = rows * cs;
  playAmbient();
});

socket.on('gameState', state => {
  currentState = state;

  if (state.phase === 'game') {
    const me = state.players.find(p => p.id === myId);
    if (me) { myIsIt = me.isIt; myEscaped = me.escaped; }
    show('game');
    updateHUD(state);
    if (!animFrame) animFrame = requestAnimationFrame(render);
  }
});

socket.on('farted', ({ chaserId, victimId, chaserName, victimName }) => {
  playFart();
  if (victimId === myId) {
    showFartMsg(`💨 You were farted on by ${chaserName}! Now YOU are the farter!`);
    playStingSound();
  } else if (chaserId === myId) {
    showFartMsg(`💨 You farted on ${victimName}!`);
  } else {
    showFartMsg(`💨 ${chaserName} farted on ${victimName}!`);
  }
});

socket.on('playerEscaped', ({ id, name }) => {
  if (id === myId) {
    showFartMsg('✅ YOU ESCAPED! Watch the others...');
  } else {
    showFartMsg(`✅ ${name} escaped!`);
  }
});

socket.on('gameEnded', ({ winners, escaped, caught }) => {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }

  show('end');
  const isRunner = !myIsIt || myEscaped;
  const teamWon = winners === 'runners';

  const meInEscaped = escaped.length > 0;
  const meInCaught = !myEscaped && myIsIt;

  document.getElementById('end-emoji').textContent = teamWon ? '🏃' : '💨';
  document.getElementById('end-title').textContent = teamWon ? 'Runners Win!' : 'Farters Win!';
  document.getElementById('end-body').textContent = teamWon
    ? 'Some survivors made it out of the maze!'
    : 'Nobody escaped. The maze reeked of victory.';

  const lists = document.getElementById('end-lists');
  lists.innerHTML = '';

  if (escaped.length) {
    const g = document.createElement('div');
    g.className = 'end-group';
    g.innerHTML = `<div class="end-group-title">✅ Escaped</div>` +
      escaped.map(n => `<div class="end-name">${n}</div>`).join('');
    lists.appendChild(g);
  }
  if (caught.length) {
    const g = document.createElement('div');
    g.className = 'end-group';
    g.innerHTML = `<div class="end-group-title">💨 Farted On</div>` +
      caught.map(n => `<div class="end-name">${n}</div>`).join('');
    lists.appendChild(g);
  }

  const playAgainBtn = document.getElementById('play-again-btn');
  // Show play again only to host — but we don't track host on end screen easily,
  // so show to everyone and server ignores non-hosts
  playAgainBtn.classList.remove('hidden');
});

socket.on('err', msg => {
  showErr('home-err', msg);
  showErr('lobby-err', msg);
});

socket.on('reconnect', () => {
  if (currentCode) socket.emit('requestState', { code: currentCode });
});

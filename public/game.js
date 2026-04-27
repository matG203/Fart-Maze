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
let isTouch = false;
const keys = {};

// ─── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playFart() {
  try {
    const ctx = getAudio();
    const bufSize = ctx.sampleRate * 0.6;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++)
      data[i] = (Math.random()*2-1) * Math.pow(1-i/bufSize, 1.5);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(200, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(80, ctx.currentTime+0.4);
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.8, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.6);
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    src.start();
  } catch(e) {}
}

function playAmbient() {
  try {
    const ctx = getAudio();
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = 55;
    const g = ctx.createGain(); g.gain.value = 0.04;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.1;
    const lfoG = ctx.createGain(); lfoG.gain.value = 8;
    lfo.connect(lfoG); lfoG.connect(osc.frequency);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); lfo.start();
  } catch(e) {}
}

function playStingSound() {
  try {
    const ctx = getAudio();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime+0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.4);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime+0.4);
  } catch(e) {}
}

// ─── Particles ────────────────────────────────────────────────────────────────
function spawnParticles() {
  for (let i = 0; i < 12; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random()*100 + 'vw';
    p.style.animationDuration = (6+Math.random()*10) + 's';
    p.style.animationDelay = (Math.random()*8) + 's';
    p.style.width = p.style.height = (1+Math.random()*3) + 'px';
    document.body.appendChild(p);
  }
}
spawnParticles();

// ─── Screens ──────────────────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-'+id).classList.add('active');
}
function showErr(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ─── Home ─────────────────────────────────────────────────────────────────────
function createRoom() {
  const name = document.getElementById('home-name').value.trim();
  if (!name) return showErr('home-err','Enter your name first!');
  socket.emit('createRoom', {name});
}
function joinRoom() {
  const name = document.getElementById('home-name').value.trim();
  const code = document.getElementById('home-code').value.trim().toUpperCase();
  if (!name) return showErr('home-err','Enter your name first!');
  if (code.length !== 4) return showErr('home-err','Enter a 4-letter code!');
  socket.emit('joinRoom', {code,name});
}
function copyCode() { if (currentCode) navigator.clipboard.writeText(currentCode).catch(()=>{}); }
function startGame() { socket.emit('startGame', {code:currentCode}); }
function playAgain() { socket.emit('playAgain', {code:currentCode}); }
function goHome() { show('home'); if (animFrame) cancelAnimationFrame(animFrame); }

document.getElementById('home-code').addEventListener('input', function(){ this.value=this.value.toUpperCase(); });
document.getElementById('home-name').addEventListener('keypress', e=>{ if(e.key==='Enter') createRoom(); });
document.getElementById('home-code').addEventListener('keypress', e=>{ if(e.key==='Enter') joinRoom(); });

// ─── Lobby ────────────────────────────────────────────────────────────────────
function renderLobby(data) {
  show('lobby');
  document.getElementById('lobby-code').textContent = data.code;
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  data.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'lobby-chip' + (p.id===data.host ? ' host' : '');
    chip.textContent = p.name;
    list.appendChild(chip);
  });
  const startBtn = document.getElementById('start-btn');
  const hint = document.getElementById('lobby-hint');
  if (data.host === myId) {
    if (data.players.length >= 2) { startBtn.classList.remove('hidden'); hint.textContent=''; }
    else { startBtn.classList.add('hidden'); hint.textContent='Waiting for at least 1 more player…'; }
  } else {
    startBtn.classList.add('hidden');
    hint.textContent=`Waiting for the host to start… (${data.players.length} player${data.players.length!==1?'s':''})`;
  }
}

// ─── Canvas & Viewport ───────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const PLAYER_COLORS = ['#a78bfa','#f472b6','#34d399','#fbbf24','#60a5fa','#f87171','#a3e635','#fb923c'];

let vpW = window.innerWidth;
let vpH = window.innerHeight - 44;

function resizeCanvas() {
  vpW = window.innerWidth;
  vpH = window.innerHeight - 44;
  canvas.width = vpW;
  canvas.height = vpH;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function getCameraOffset(me) {
  if (!me) return {ox:0,oy:0};
  return { ox: Math.round(vpW/2 - me.x), oy: Math.round(vpH/2 - me.y) };
}

// ─── Drawing ──────────────────────────────────────────────────────────────────
function drawMaze(maze, ox, oy) {
  const cols = maze[0].length, rows = maze.length;
  const startC = Math.max(0, Math.floor(-ox/cellSize));
  const endC   = Math.min(cols-1, Math.ceil((vpW-ox)/cellSize));
  const startR = Math.max(0, Math.floor(-oy/cellSize));
  const endR   = Math.min(rows-1, Math.ceil((vpH-oy)/cellSize));

  for (let r = startR; r <= endR; r++) {
    for (let c = startC; c <= endC; c++) {
      const px = c*cellSize+ox, py = r*cellSize+oy;
      if (maze[r][c] === 0) {
        // Wall — dark with slight purple tint
        ctx.fillStyle = '#0c0c1a';
        ctx.fillRect(px, py, cellSize, cellSize);
        ctx.fillStyle = 'rgba(124,58,237,0.08)';
        ctx.fillRect(px+1, py+1, cellSize-2, cellSize-2);
      } else {
        // Floor — visible grey
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(px, py, cellSize, cellSize);
        // Floor grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, cellSize, cellSize);
      }
    }
  }
}

function drawGasClouds(gasClouds, ox, oy) {
  gasClouds.forEach(gas => {
    const gx = gas.x+ox, gy = gas.y+oy;
    const alpha = 0.55 - gas.progress*0.5;
    const radius = 55 + gas.progress*10;
    const grad = ctx.createRadialGradient(gx,gy,0, gx,gy,radius);
    grad.addColorStop(0, `rgba(120,230,80,${alpha})`);
    grad.addColorStop(0.5,`rgba(80,200,40,${alpha*0.6})`);
    grad.addColorStop(1, 'rgba(60,180,30,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(gx, gy, radius, 0, Math.PI*2);
    ctx.fill();

    // Wiggly cloud outline
    ctx.save();
    ctx.globalAlpha = alpha * 0.8;
    ctx.strokeStyle = 'rgba(140,255,80,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(gx, gy, radius*0.6, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();

    // 💨 emoji in center
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha * 2;
    ctx.fillText('💨', gx, gy);
    ctx.globalAlpha = 1;
  });
}

function drawExit(exitPos, ox, oy) {
  if (!exitPos) return;
  const ex = exitPos.x+ox, ey = exitPos.y+oy;
  const grad = ctx.createRadialGradient(ex,ey,0, ex,ey,40);
  grad.addColorStop(0,'rgba(34,197,94,0.8)');
  grad.addColorStop(1,'rgba(34,197,94,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(ex,ey,40,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#22c55e'; ctx.font='bold 14px sans-serif';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('EXIT',ex,ey);
}

function drawPlayers(players, ox, oy) {
  players.forEach((p,i) => {
    if (p.escaped) return;
    const color = PLAYER_COLORS[i%PLAYER_COLORS.length];
    const px = p.x+ox, py = p.y+oy;
    const r = 14;

    // White glow torch (large, soft)
    const torchR = 100;
    const torch = ctx.createRadialGradient(px,py,0, px,py,torchR);
    torch.addColorStop(0,   'rgba(255,255,255,0.22)');
    torch.addColorStop(0.35,'rgba(255,255,255,0.10)');
    torch.addColorStop(0.7, 'rgba(255,255,255,0.03)');
    torch.addColorStop(1,   'rgba(255,255,255,0)');
    ctx.fillStyle = torch;
    ctx.beginPath(); ctx.arc(px,py,torchR,0,Math.PI*2); ctx.fill();

    // Red menace glow for farters
    if (p.isIt) {
      const danger = ctx.createRadialGradient(px,py,0, px,py,65);
      danger.addColorStop(0,'rgba(255,30,30,0.4)');
      danger.addColorStop(1,'rgba(255,30,30,0)');
      ctx.fillStyle = danger;
      ctx.beginPath(); ctx.arc(px,py,65,0,Math.PI*2); ctx.fill();
    }

    // Body
    ctx.beginPath(); ctx.arc(px,py,r,0,Math.PI*2);
    ctx.fillStyle = p.isIt ? '#ff3333' : color;
    ctx.fill();
    ctx.strokeStyle = p.isIt ? '#ff0000' : 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2.5; ctx.stroke();

    // Emoji
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.isIt ? '💨' : '😨', px, py);

    // Name tag
    ctx.font = 'bold 11px sans-serif';
    const nameW = ctx.measureText(p.name).width + 10;
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(px-nameW/2, py-r-18, nameW, 14);
    ctx.fillStyle = p.isIt ? '#ff9999' : '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.name, px, py-r-11);
  });
}

// Darkness layer with torch holes cut out
function drawDarkness(players, ox, oy) {
  // Semi-transparent dark layer — maze is visible underneath
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0,0,vpW,vpH);

  // Cut torch holes
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  players.forEach(p => {
    if (p.escaped) return;
    const px = p.x+ox, py = p.y+oy;
    const grad = ctx.createRadialGradient(px,py,0, px,py,120);
    grad.addColorStop(0,   'rgba(0,0,0,1)');
    grad.addColorStop(0.55,'rgba(0,0,0,0.8)');
    grad.addColorStop(0.85,'rgba(0,0,0,0.3)');
    grad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(px,py,120,0,Math.PI*2); ctx.fill();
  });
  ctx.restore();
}

let flickerVal = 1, lastFlicker = 0;

function render(timestamp) {
  if (!currentMaze || !currentState) { animFrame=requestAnimationFrame(render); return; }

  if (timestamp-lastFlicker > 150+Math.random()*600) {
    flickerVal = 0.9+Math.random()*0.1;
    lastFlicker = timestamp;
  }

  const me = currentState.players.find(p=>p.id===myId);
  const {ox,oy} = getCameraOffset(me);

  ctx.clearRect(0,0,vpW,vpH);

  // 1. Maze (always somewhat visible)
  ctx.save();
  ctx.globalAlpha = flickerVal;
  drawMaze(currentMaze,ox,oy);
  drawGasClouds(currentState.gasClouds||[],ox,oy);
  drawExit(currentState.exitPos,ox,oy);
  drawPlayers(currentState.players,ox,oy);
  ctx.restore();

  // 2. Partial darkness with torch cut-outs
  drawDarkness(currentState.players,ox,oy);

  // 3. Redraw players on top so always visible
  ctx.save();
  ctx.globalAlpha = flickerVal;
  drawPlayers(currentState.players,ox,oy);
  ctx.restore();

  animFrame = requestAnimationFrame(render);
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function updateHUD(state) {
  const me = state.players.find(p=>p.id===myId);
  if (!me) return;

  const roleEl = document.getElementById('hud-role');
  if (me.escaped) { roleEl.textContent='✅ ESCAPED!'; roleEl.className='hud-role escaped'; }
  else if (me.isIt) { roleEl.textContent='💨 YOU ARE THE FARTER'; roleEl.className='hud-role is-it'; }
  else { roleEl.textContent='😨 RUN!'; roleEl.className='hud-role runner'; }

  const mins = Math.floor(state.gameTimer/60);
  const secs = state.gameTimer%60;
  const timerEl = document.getElementById('hud-timer');
  timerEl.textContent = `${mins}:${String(secs).padStart(2,'0')}`;
  timerEl.className = 'hud-timer'+(state.gameTimer<30?' urgent':'');

  const active = state.players.filter(p=>!p.escaped);
  document.getElementById('hud-status').textContent =
    `💨${active.filter(p=>p.isIt).length} 😨${active.filter(p=>!p.isIt).length} ✅${state.players.filter(p=>p.escaped).length}`;

  // Fart button + gauge
  const fartBtn = document.getElementById('fart-btn');
  const fartBtnZone = document.getElementById('fart-btn-zone');
  const fartKeyHint = document.getElementById('fart-key-hint');
  function setGauge(w){const c=w>60?'linear-gradient(90deg,#ff6b6b,#ff3333)':w>30?'linear-gradient(90deg,#fbbf24,#f59e0b)':'linear-gradient(90deg,#64748b,#475569)';['gauge-fill','gauge-fill-desktop'].forEach(id=>{const el=document.getElementById(id);if(el){el.style.width=w+'%';el.style.background=c;}});}
  if (me.isIt && !me.escaped) {
    if (isTouch) { fartBtnZone.style.display='flex'; if(fartKeyHint) fartKeyHint.style.display='none'; }
    else { if(fartKeyHint) fartKeyHint.style.display='block'; fartBtnZone.style.display='none'; }
    fartBtn.disabled = me.gauge < 35;
    setGauge(Math.max(0,Math.min(100,me.gauge)));
  } else {
    fartBtnZone.style.display='none';
    if(fartKeyHint) fartKeyHint.style.display='none';
  }
}

// ─── Fart action ──────────────────────────────────────────────────────────────
function doFart() {
  socket.emit('fart', {code:currentCode});
  playFart();
}

document.getElementById('fart-btn').addEventListener('click', doFart);
document.getElementById('fart-btn').addEventListener('touchstart', e => { e.preventDefault(); doFart(); }, {passive:false});

// ─── Keyboard input ───────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  keys[e.key] = true;
  // Space bar = fart
  if (e.key === ' ' && myIsIt) { e.preventDefault(); doFart(); }
  sendInput();
});
document.addEventListener('keyup', e => { keys[e.key]=false; sendInput(); });

function sendInput() {
  if (!currentCode) return;
  let dx=0,dy=0;
  if (keys['ArrowLeft']||keys['a']||keys['A']) dx-=1;
  if (keys['ArrowRight']||keys['d']||keys['D']) dx+=1;
  if (keys['ArrowUp']||keys['w']||keys['W']) dy-=1;
  if (keys['ArrowDown']||keys['s']||keys['S']) dy+=1;
  socket.emit('input',{code:currentCode,dx,dy});
}

// ─── Touch Joystick ───────────────────────────────────────────────────────────
function setupJoystick() {
  const zone = document.getElementById('joystick-zone');
  const base = document.getElementById('joystick-base');
  const stick = document.getElementById('joystick-stick');
  const maxR = 38;
  zone.style.display = 'block';

  function getTouch(e) {
    const t = e.changedTouches ? e.changedTouches[0] : e;
    return {x:t.clientX, y:t.clientY};
  }

  let originX=0, originY=0, touching=false;

  base.addEventListener('touchstart', e => {
    e.preventDefault();
    touching = true;
    stick.classList.add('active');
    const rect = base.getBoundingClientRect();
    originX = rect.left+rect.width/2;
    originY = rect.top+rect.height/2;
  }, {passive:false});

  document.addEventListener('touchmove', e => {
    if (!touching) return;
    e.preventDefault();
    const pos = getTouch(e);
    let dx = pos.x-originX, dy = pos.y-originY;
    const len = Math.hypot(dx,dy);
    if (len>maxR) { dx=dx/len*maxR; dy=dy/len*maxR; }

    // Move stick visually
    stick.style.left = (50+dx/maxR*50)+'%';
    stick.style.top  = (50+dy/maxR*50)+'%';

    const ndx = len>6 ? dx/len : 0;
    const ndy = len>6 ? dy/len : 0;
    socket.emit('input',{code:currentCode,dx:ndx,dy:ndy});
  }, {passive:false});

  document.addEventListener('touchend', e => {
    // Only stop if no touches remain on the joystick
    touching = false;
    stick.classList.remove('active');
    stick.style.left='50%'; stick.style.top='50%';
    socket.emit('input',{code:currentCode,dx:0,dy:0});
  });
}

window.addEventListener('touchstart', () => {
  if (!isTouch) { isTouch=true; setupJoystick(); }
}, {once:true});

// ─── Fart message ─────────────────────────────────────────────────────────────
let fartMsgTimeout=null;
function showFartMsg(msg) {
  const el = document.getElementById('fart-msg');
  el.textContent=msg; el.classList.remove('hidden');
  clearTimeout(fartMsgTimeout);
  fartMsgTimeout=setTimeout(()=>el.classList.add('hidden'),3000);
  const flash = document.getElementById('fart-flash');
  flash.classList.remove('hidden');
  setTimeout(()=>flash.classList.add('hidden'),600);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect', ()=>{ myId=socket.id; });
socket.on('roomCreated', ({code})=>{ currentCode=code; });

socket.on('lobbyState', data=>{
  currentCode=data.code;
  renderLobby(data);
});

socket.on('mazeData', ({maze,cellSize:cs})=>{
  currentMaze=maze; cellSize=cs;
  resizeCanvas();
  playAmbient();
});

socket.on('gameState', state=>{
  currentState=state;
  if (state.phase==='game') {
    const me=state.players.find(p=>p.id===myId);
    if (me) { myIsIt=me.isIt; myEscaped=me.escaped; }
    show('game');
    updateHUD(state);
    if (!animFrame) animFrame=requestAnimationFrame(render);
  }
});

socket.on('farted', ({chaserId,victimId,chaserName,victimName})=>{
  playFart();
  if (victimId===myId) {
    showFartMsg(`💨 You walked into ${chaserName}'s gas! Now YOU are the farter!`);
    playStingSound();
  } else if (chaserId===myId) {
    showFartMsg(`💨 ${victimName} walked into your gas! They're a farter now!`);
  } else {
    showFartMsg(`💨 ${victimName} got gassed by ${chaserName}!`);
  }
});

socket.on('playerEscaped', ({id,name})=>{
  if (id===myId) showFartMsg('✅ YOU ESCAPED! Watch the others...');
  else showFartMsg(`✅ ${name} escaped!`);
});

socket.on('gameEnded', ({winners,escaped,caught})=>{
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame=null; }
  show('end');
  const teamWon = winners==='runners';
  document.getElementById('end-emoji').textContent = teamWon?'🏃':'💨';
  document.getElementById('end-title').textContent = teamWon?'Runners Win!':'Farters Win!';
  document.getElementById('end-body').textContent = teamWon
    ? 'Some survivors made it out alive!'
    : 'Nobody escaped. The maze reeked of victory.';
  const lists = document.getElementById('end-lists');
  lists.innerHTML='';
  if (escaped.length) {
    const g=document.createElement('div'); g.className='end-group';
    g.innerHTML=`<div class="end-group-title">✅ Escaped</div>`+escaped.map(n=>`<div class="end-name">${n}</div>`).join('');
    lists.appendChild(g);
  }
  if (caught.length) {
    const g=document.createElement('div'); g.className='end-group';
    g.innerHTML=`<div class="end-group-title">💨 Gassed</div>`+caught.map(n=>`<div class="end-name">${n}</div>`).join('');
    lists.appendChild(g);
  }
  document.getElementById('play-again-btn').classList.remove('hidden');
});

socket.on('err', msg=>{ showErr('home-err',msg); showErr('lobby-err',msg); });
socket.on('reconnect', ()=>{ if (currentCode) socket.emit('requestState',{code:currentCode}); });

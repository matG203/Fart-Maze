/* ═══════════════════════════════════════════
   FART MAZE — Client
   ═══════════════════════════════════════════ */

const socket = io();

let myId=null, currentCode=null, currentMaze=null, currentState=null;
let cellSize=40, myIsIt=false, myEscaped=false, animFrame=null, isTouch=false;
const keys={};

// ─── Audio ────────────────────────────────────────────────────────────────────
let audioCtx=null;
function getAudio(){ if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)(); return audioCtx; }

function playFart(){
  try{
    const ctx=getAudio();
    const buf=ctx.createBuffer(1,ctx.sampleRate*0.6,ctx.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,1.5);
    const src=ctx.createBufferSource(); src.buffer=buf;
    const f=ctx.createBiquadFilter(); f.type='bandpass';
    f.frequency.setValueAtTime(200,ctx.currentTime);
    f.frequency.exponentialRampToValueAtTime(80,ctx.currentTime+0.4);
    f.Q.value=0.8;
    const g=ctx.createGain();
    g.gain.setValueAtTime(2,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.6);
    src.connect(f);f.connect(g);g.connect(ctx.destination);src.start();
  }catch(e){}
}

function playAmbient(){
  try{
    const ctx=getAudio();
    const osc=ctx.createOscillator(); osc.type='sine'; osc.frequency.value=55;
    const g=ctx.createGain(); g.gain.value=0.03;
    const lfo=ctx.createOscillator(); lfo.frequency.value=0.08;
    const lg=ctx.createGain(); lg.gain.value=6;
    lfo.connect(lg);lg.connect(osc.frequency);
    osc.connect(g);g.connect(ctx.destination);
    osc.start();lfo.start();
  }catch(e){}
}

function playSting(){
  try{
    const ctx=getAudio();
    const osc=ctx.createOscillator(); osc.type='sawtooth';
    osc.frequency.setValueAtTime(880,ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(110,ctx.currentTime+0.4);
    const g=ctx.createGain();
    g.gain.setValueAtTime(0.3,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.4);
    osc.connect(g);g.connect(ctx.destination);
    osc.start();osc.stop(ctx.currentTime+0.4);
  }catch(e){}
}

function playPing(){
  try{
    const ctx=getAudio();
    const osc=ctx.createOscillator(); osc.type='sine';
    osc.frequency.setValueAtTime(440,ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880,ctx.currentTime+0.15);
    const g=ctx.createGain();
    g.gain.setValueAtTime(0.25,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.25);
    osc.connect(g);g.connect(ctx.destination);
    osc.start();osc.stop(ctx.currentTime+0.25);
  }catch(e){}
}

// ─── Particles ────────────────────────────────────────────────────────────────
(function(){
  for(let i=0;i<10;i++){
    const p=document.createElement('div'); p.className='particle';
    p.style.left=Math.random()*100+'vw';
    p.style.width=p.style.height=(1+Math.random()*3)+'px';
    p.style.animationDuration=(8+Math.random()*12)+'s';
    p.style.animationDelay=(Math.random()*10)+'s';
    document.body.appendChild(p);
  }
})();

// ─── Screens ──────────────────────────────────────────────────────────────────
function show(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); document.getElementById('screen-'+id).classList.add('active'); }
function showErr(id,msg){ const el=document.getElementById(id); el.textContent=msg; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),4000); }

// ─── Home ─────────────────────────────────────────────────────────────────────
function createRoom(){ const n=document.getElementById('home-name').value.trim(); if(!n) return showErr('home-err','Enter your name!'); socket.emit('createRoom',{name:n}); }
function joinRoom(){ const n=document.getElementById('home-name').value.trim(); const c=document.getElementById('home-code').value.trim().toUpperCase(); if(!n) return showErr('home-err','Enter your name!'); if(c.length!==4) return showErr('home-err','Enter a 4-letter code!'); socket.emit('joinRoom',{code:c,name:n}); }
function copyCode(){ if(currentCode) navigator.clipboard.writeText(currentCode).catch(()=>{}); }
function startGame(){ socket.emit('startGame',{code:currentCode}); }
function playAgain(){ socket.emit('playAgain',{code:currentCode}); }
function goHome(){ show('home'); if(animFrame){cancelAnimationFrame(animFrame);animFrame=null;} }

document.getElementById('home-code').addEventListener('input',function(){this.value=this.value.toUpperCase();});
document.getElementById('home-name').addEventListener('keypress',e=>{if(e.key==='Enter')createRoom();});
document.getElementById('home-code').addEventListener('keypress',e=>{if(e.key==='Enter')joinRoom();});

// ─── Lobby ────────────────────────────────────────────────────────────────────
function renderLobby(data){
  show('lobby');
  document.getElementById('lobby-code').textContent=data.code;
  const list=document.getElementById('lobby-players'); list.innerHTML='';
  data.players.forEach(p=>{
    const chip=document.createElement('div');
    chip.className='lobby-chip'+(p.id===data.host?' host':'');
    chip.textContent=p.name; list.appendChild(chip);
  });
  const btn=document.getElementById('start-btn'), hint=document.getElementById('lobby-hint');
  if(data.host===myId){
    if(data.players.length>=2){btn.classList.remove('hidden');hint.textContent='';}
    else{btn.classList.add('hidden');hint.textContent='Need at least 1 more player…';}
  }else{
    btn.classList.add('hidden');
    hint.textContent=`Waiting for host… (${data.players.length} player${data.players.length!==1?'s':''})`;
  }
}

// ─── Canvas ───────────────────────────────────────────────────────────────────
const canvas=document.getElementById('gameCanvas');
const ctx=canvas.getContext('2d');
const PCOLORS=['#c4b5fd','#f9a8d4','#6ee7b7','#fde68a','#93c5fd','#fca5a5','#d9f99d','#fed7aa'];

let vpW=window.innerWidth, vpH=window.innerHeight-44;
function resizeCanvas(){ vpW=window.innerWidth; vpH=window.innerHeight-44; canvas.width=vpW; canvas.height=vpH; }
window.addEventListener('resize',resizeCanvas); resizeCanvas();

function camOffset(me){ if(!me) return{ox:0,oy:0}; return{ox:Math.round(vpW/2-me.x),oy:Math.round(vpH/2-me.y)}; }

// ─── Drawing ──────────────────────────────────────────────────────────────────

// Much lighter maze colours — easy to see without eye strain
const WALL_COLOR  = '#3a3060';   // visible medium-dark purple
const FLOOR_COLOR = '#5a5090';   // noticeably lighter floor — clearly passable
const WALL_SHADE  = '#2a2050';   // darker edge on wall top-left for depth

function drawMaze(maze,ox,oy){
  const cols=maze[0].length, rows=maze.length;
  const sc=Math.max(0,Math.floor(-ox/cellSize));
  const ec=Math.min(cols-1,Math.ceil((vpW-ox)/cellSize));
  const sr=Math.max(0,Math.floor(-oy/cellSize));
  const er=Math.min(rows-1,Math.ceil((vpH-oy)/cellSize));

  for(let r=sr;r<=er;r++){
    for(let c=sc;c<=ec;c++){
      const px=c*cellSize+ox, py=r*cellSize+oy;
      if(maze[r][c]===0){
        // Wall — solid, clearly visible
        ctx.fillStyle=WALL_COLOR;
        ctx.fillRect(px,py,cellSize,cellSize);
        // Top/left darker edge for 3D depth effect
        ctx.fillStyle=WALL_SHADE;
        ctx.fillRect(px,py,cellSize,3);
        ctx.fillRect(px,py,3,cellSize);
        // Slight lighter bottom/right
        ctx.fillStyle='rgba(255,255,255,0.06)';
        ctx.fillRect(px,py+cellSize-3,cellSize,3);
        ctx.fillRect(px+cellSize-3,py,3,cellSize);
      } else {
        // Floor — clearly lighter than walls
        ctx.fillStyle=FLOOR_COLOR;
        ctx.fillRect(px,py,cellSize,cellSize);
        // Subtle tile grid
        ctx.strokeStyle='rgba(255,255,255,0.06)';
        ctx.lineWidth=1;
        ctx.strokeRect(px+0.5,py+0.5,cellSize-1,cellSize-1);
      }
    }
  }
}

function drawKeys(keyList,ox,oy){
  if(!keyList) return;
  keyList.forEach(k=>{
    const kx=k.x+ox, ky=k.y+oy;
    const t=Date.now()*0.003;
    const bob=Math.sin(t+k.id)*4;
    // Glow
    ctx.save();
    ctx.shadowColor='#ffd700';
    ctx.shadowBlur=14;
    ctx.font='20px sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('🗝️',kx,ky+bob);
    ctx.restore();
  });
}

function drawPowerups(powerups,ox,oy){
  if(!powerups) return;
  const PEMOJI={speed:'⚡',shield:'🛡️'};
  powerups.forEach(pw=>{
    const px=pw.x+ox, py=pw.y+oy;
    const pulse=0.7+Math.sin(Date.now()*0.004+pw.id)*0.3;
    ctx.save();
    ctx.globalAlpha=pulse;
    ctx.font='20px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor=pw.type==='speed'?'#fbbf24':'#60a5fa';
    ctx.shadowBlur=16;
    ctx.fillText(PEMOJI[pw.type]||'★',px,py);
    ctx.restore();
  });
}

function drawGas(gasClouds,ox,oy){
  if(!gasClouds) return;
  gasClouds.forEach(g=>{
    const gx=g.x+ox, gy=g.y+oy;
    const alpha=Math.max(0,0.5-(g.progress*0.45));
    const r=52+g.progress*8;
    const grad=ctx.createRadialGradient(gx,gy,0,gx,gy,r);
    grad.addColorStop(0,`rgba(100,210,60,${alpha})`);
    grad.addColorStop(0.5,`rgba(70,180,30,${alpha*0.5})`);
    grad.addColorStop(1,'rgba(50,160,20,0)');
    ctx.fillStyle=grad;
    ctx.beginPath(); ctx.arc(gx,gy,r,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=alpha*1.8;
    ctx.font='16px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('💨',gx,gy);
    ctx.globalAlpha=1;
  });
}

function drawExits(exits,ox,oy){
  if(!exits) return;
  exits.forEach(exit=>{
    const ex=exit.x+ox, ey=exit.y+oy;
    const pulse=0.7+Math.sin(Date.now()*0.004)*0.3;
    const grad=ctx.createRadialGradient(ex,ey,0,ex,ey,40);
    grad.addColorStop(0,`rgba(46,204,113,${0.8*pulse})`);
    grad.addColorStop(1,'rgba(46,204,113,0)');
    ctx.fillStyle=grad;
    ctx.beginPath(); ctx.arc(ex,ey,40,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#2ecc71';
    ctx.font='bold 12px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('EXIT',ex,ey);
  });
}

function drawPlayers(players,ox,oy){
  players.forEach((p,i)=>{
    if(p.escaped) return;

    // If this player is invisible — only draw a very faint shimmer (not their position/emoji)
    // We receive them at their actual position but render them faintly
    const isInvis = p.invisActive;

    const col=PCOLORS[i%PCOLORS.length];
    const px=p.x+ox, py=p.y+oy;
    const r=13;

    // Ghost wall-phase blue shimmer (everyone sees this)
    if(p.ghostActive){
      ctx.save(); ctx.globalAlpha=0.4;
      ctx.strokeStyle='rgba(150,120,255,0.8)'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(px,py,r+8,0,Math.PI*2); ctx.stroke();
      ctx.restore();
    }

    // Invisible — only a very faint outline visible to runners (can barely be seen)
    if(isInvis){
      ctx.save(); ctx.globalAlpha=0.12;
      ctx.beginPath(); ctx.arc(px,py,r,0,Math.PI*2);
      ctx.fillStyle='rgba(100,200,255,0.3)'; ctx.fill();
      ctx.restore();
      return; // don't draw glow/body/name
    }

    // Shield ring
    if(p.activeEffects?.shield){
      ctx.save(); ctx.globalAlpha=0.65;
      ctx.strokeStyle='#60a5fa'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.arc(px,py,r+6,0,Math.PI*2); ctx.stroke();
      ctx.restore();
    }

    // Torch glow — smaller radius, softer
    const torchR=75;
    const torch=ctx.createRadialGradient(px,py,0,px,py,torchR);
    torch.addColorStop(0,'rgba(255,255,255,0.20)');
    torch.addColorStop(0.4,'rgba(255,255,255,0.08)');
    torch.addColorStop(0.8,'rgba(255,255,255,0.02)');
    torch.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=torch; ctx.beginPath(); ctx.arc(px,py,torchR,0,Math.PI*2); ctx.fill();

    // Speed glow
    if(p.activeEffects?.speed){
      const sg=ctx.createRadialGradient(px,py,0,px,py,26);
      sg.addColorStop(0,'rgba(251,191,36,0.35)'); sg.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=sg; ctx.beginPath(); ctx.arc(px,py,26,0,Math.PI*2); ctx.fill();
    }

    // Red glow for farters
    if(p.isIt){
      const dg=ctx.createRadialGradient(px,py,0,px,py,44);
      dg.addColorStop(0,'rgba(255,40,40,0.35)'); dg.addColorStop(1,'rgba(255,40,40,0)');
      ctx.fillStyle=dg; ctx.beginPath(); ctx.arc(px,py,44,0,Math.PI*2); ctx.fill();
    }

    // Body
    ctx.beginPath(); ctx.arc(px,py,r,0,Math.PI*2);
    ctx.fillStyle=p.ghostActive?'rgba(190,160,255,0.7)':p.isIt?'#e74c3c':col;
    ctx.fill();
    ctx.strokeStyle=p.isIt?'#ff6666':'rgba(255,255,255,0.7)';
    ctx.lineWidth=2; ctx.stroke();

    // Emoji
    ctx.font='15px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(p.ghostActive?'👻':p.isIt?'💨':'😨',px,py);

    // Name
    ctx.font='bold 10px sans-serif';
    const nw=ctx.measureText(p.name).width+10;
    ctx.fillStyle='rgba(20,20,40,0.85)';
    ctx.fillRect(px-nw/2,py-r-17,nw,13);
    ctx.fillStyle=p.isIt?'#ff9999':'#ffffff';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(p.name,px,py-r-11);

    // Key indicator above runner who has key
    if(p.hasKey){
      ctx.font='12px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('🗝️',px,py-r-28);
    }
  });
}

// Darkness — lighter overlay so maze is very readable
function drawDarkness(players,ox,oy){
  ctx.fillStyle='rgba(0,0,0,0.30)';
  ctx.fillRect(0,0,vpW,vpH);
  ctx.save();
  ctx.globalCompositeOperation='destination-out';
  players.forEach(p=>{
    if(p.escaped||p.invisActive) return;
    const px=p.x+ox, py=p.y+oy;
    const grad=ctx.createRadialGradient(px,py,0,px,py,100);
    grad.addColorStop(0,'rgba(0,0,0,1)');
    grad.addColorStop(0.5,'rgba(0,0,0,0.75)');
    grad.addColorStop(0.85,'rgba(0,0,0,0.25)');
    grad.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=grad;
    ctx.beginPath(); ctx.arc(px,py,100,0,Math.PI*2); ctx.fill();
  });
  ctx.restore();
}

function render(ts){
  if(!currentMaze||!currentState){animFrame=requestAnimationFrame(render);return;}

  const me=currentState.players.find(p=>p.id===myId);
  const{ox,oy}=camOffset(me);

  ctx.clearRect(0,0,vpW,vpH);

  // Draw maze, objects, players
  drawMaze(currentMaze,ox,oy);
  drawExits(currentState.exits,ox,oy);
  // Keys only visible to runners (server sends empty array to farter)
  drawKeys(currentState.keys,ox,oy);
  drawPowerups(currentState.powerups,ox,oy);
  drawGas(currentState.gasClouds,ox,oy);
  drawPlayers(currentState.players,ox,oy);

  // Lighter darkness overlay
  drawDarkness(currentState.players,ox,oy);

  // Redraw players on top of darkness
  drawPlayers(currentState.players,ox,oy);

  animFrame=requestAnimationFrame(render);
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function setGauge(pct){
  const color=pct>60?'linear-gradient(90deg,#ff7070,#cc2222)':pct>30?'linear-gradient(90deg,#fbbf24,#d97706)':'linear-gradient(90deg,#7070a0,#505080)';
  ['gauge-fill','gauge-fill-desktop'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.style.width=Math.max(0,pct)+'%';el.style.background=color;}
  });
}

function setCooldownBtn(btnId, onCooldown, cdMs, activeLabel, cdLabel){
  const btn=document.getElementById(btnId);
  if(!btn) return;
  btn.disabled=onCooldown;
  const cdSec=Math.ceil(Math.max(0,cdMs/1000));
  btn.title=onCooldown?`${cdLabel}: ${cdSec}s`:activeLabel;
  btn.style.opacity=onCooldown?'0.35':'1';
}

function updateHUD(state){
  const me=state.players.find(p=>p.id===myId);
  if(!me) return;

  const roleEl=document.getElementById('hud-role');
  if(me.escaped){roleEl.textContent='✅ ESCAPED!';roleEl.className='hud-role escaped';}
  else if(me.isIt){
    let label='💨 FARTER';
    if(me.ghostActive) label='👻 GHOST MODE';
    else if(me.invisActive) label='🌫️ INVISIBLE';
    roleEl.textContent=label; roleEl.className='hud-role is-it';
  } else {
    roleEl.textContent=me.hasKey?'🗝️ GOT KEY — FIND EXIT!':'😨 FIND YOUR KEY!';
    roleEl.className='hud-role runner';
  }

  const m=Math.floor(state.gameTimer/60), s=state.gameTimer%60;
  const te=document.getElementById('hud-timer');
  te.textContent=`${m}:${String(s).padStart(2,'0')}`;
  te.className='hud-timer'+(state.gameTimer<30?' urgent':'');

  const active=state.players.filter(p=>!p.escaped);
  document.getElementById('hud-status').textContent=
    `💨${active.filter(p=>p.isIt).length} 😨${active.filter(p=>!p.isIt).length} ✅${state.players.filter(p=>p.escaped).length}`;

  const badges=document.getElementById('hud-effects');
  if(badges){
    badges.innerHTML='';
    if(me.activeEffects?.speed)  badges.innerHTML+='<span class="effect-badge">⚡</span>';
    if(me.activeEffects?.shield) badges.innerHTML+='<span class="effect-badge">🛡️</span>';
  }

  const now=Date.now();
  const fartBtnZone=document.getElementById('fart-btn-zone');
  const fartKeyHint=document.getElementById('fart-key-hint');
  const fartBtn=document.getElementById('fart-btn');

  if(me.isIt&&!me.escaped){
    if(isTouch){fartBtnZone.style.display='flex';if(fartKeyHint)fartKeyHint.style.display='none';}
    else{if(fartKeyHint)fartKeyHint.style.display='block';fartBtnZone.style.display='none';}
    fartBtn.disabled=me.gauge<35;
    setGauge(Math.min(100,me.gauge));
    setCooldownBtn('ghost-btn',now<me.ghostCooldownUntil,me.ghostCooldownUntil-now,'Ghost (pass through walls)','Ghost cooldown');
    setCooldownBtn('invis-btn',now<me.invisCooldownUntil,me.invisCooldownUntil-now,'Go invisible (4s)','Invisible cooldown');
  } else {
    fartBtnZone.style.display='none';
    if(fartKeyHint)fartKeyHint.style.display='none';
  }

  // Key status bar for runners
  const keyStatus=document.getElementById('key-status');
  if(keyStatus){
    if(!me.isIt&&!me.escaped){
      keyStatus.classList.remove('hidden');
      if(me.hasKey){keyStatus.textContent='🗝️ Key collected! Find the EXIT!';keyStatus.className='key-status has-key';}
      else{keyStatus.textContent='🔍 Find your key first!';keyStatus.className='key-status no-key';}
    } else {
      keyStatus.classList.add('hidden');
    }
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function doFart(){ socket.emit('fart',{code:currentCode}); playFart(); }
function doGhost(){ socket.emit('ghost',{code:currentCode}); }
function doInvis(){ socket.emit('invis',{code:currentCode}); }

document.getElementById('fart-btn').addEventListener('click',doFart);
document.getElementById('fart-btn').addEventListener('touchstart',e=>{e.preventDefault();doFart();},{passive:false});
document.getElementById('ghost-btn').addEventListener('click',doGhost);
document.getElementById('ghost-btn').addEventListener('touchstart',e=>{e.preventDefault();doGhost();},{passive:false});
document.getElementById('invis-btn').addEventListener('click',doInvis);
document.getElementById('invis-btn').addEventListener('touchstart',e=>{e.preventDefault();doInvis();},{passive:false});

// ─── Keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown',e=>{
  keys[e.key]=true;
  if(e.key===' '&&myIsIt){e.preventDefault();doFart();}
  if((e.key==='g'||e.key==='G')&&myIsIt) doGhost();
  if((e.key==='f'||e.key==='F')&&myIsIt) doInvis();
  sendInput();
});
document.addEventListener('keyup',e=>{keys[e.key]=false;sendInput();});

function sendInput(){
  if(!currentCode) return;
  let dx=0,dy=0;
  if(keys['ArrowLeft']||keys['a']||keys['A'])  dx-=1;
  if(keys['ArrowRight']||keys['d']||keys['D']) dx+=1;
  if(keys['ArrowUp']||keys['w']||keys['W'])    dy-=1;
  if(keys['ArrowDown']||keys['s']||keys['S'])  dy+=1;
  socket.emit('input',{code:currentCode,dx,dy});
}

// ─── Joystick ─────────────────────────────────────────────────────────────────
function setupJoystick(){
  const zone=document.getElementById('joystick-zone');
  const base=document.getElementById('joystick-base');
  const stick=document.getElementById('joystick-stick');
  const maxR=38;
  zone.style.display='block';
  let touching=false,originX=0,originY=0;

  base.addEventListener('touchstart',e=>{
    e.preventDefault();touching=true;stick.classList.add('active');
    const rect=base.getBoundingClientRect();
    originX=rect.left+rect.width/2;originY=rect.top+rect.height/2;
  },{passive:false});

  document.addEventListener('touchmove',e=>{
    if(!touching) return; e.preventDefault();
    const t=e.changedTouches[0];
    let dx=t.clientX-originX,dy=t.clientY-originY;
    const len=Math.hypot(dx,dy);
    if(len>maxR){dx=dx/len*maxR;dy=dy/len*maxR;}
    stick.style.left=(50+dx/maxR*50)+'%';
    stick.style.top=(50+dy/maxR*50)+'%';
    socket.emit('input',{code:currentCode,dx:len>6?dx/len:0,dy:len>6?dy/len:0});
  },{passive:false});

  document.addEventListener('touchend',()=>{
    touching=false;stick.classList.remove('active');
    stick.style.left='50%';stick.style.top='50%';
    socket.emit('input',{code:currentCode,dx:0,dy:0});
  });
}

window.addEventListener('touchstart',()=>{ if(!isTouch){isTouch=true;setupJoystick();} },{once:true});

// ─── Fart message ─────────────────────────────────────────────────────────────
let msgTimer=null;
function showMsg(msg,borderColor='#2ecc71'){
  const el=document.getElementById('fart-msg');
  el.textContent=msg; el.classList.remove('hidden');
  el.style.borderColor=borderColor;
  clearTimeout(msgTimer);
  msgTimer=setTimeout(()=>el.classList.add('hidden'),3000);
  const flash=document.getElementById('fart-flash');
  flash.classList.remove('hidden');
  setTimeout(()=>flash.classList.add('hidden'),500);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect',()=>{myId=socket.id;});
socket.on('roomCreated',({code})=>{currentCode=code;});

socket.on('lobbyState',data=>{
  currentCode=data.code; renderLobby(data);
});

socket.on('mazeData',({maze,cellSize:cs})=>{
  currentMaze=maze; cellSize=cs; resizeCanvas(); playAmbient();
});

socket.on('gameState',state=>{
  currentState=state;
  if(state.phase==='game'){
    const me=state.players.find(p=>p.id===myId);
    if(me){myIsIt=me.isIt;myEscaped=me.escaped;}
    show('game'); updateHUD(state);
    if(!animFrame) animFrame=requestAnimationFrame(render);
  }
});

socket.on('farted',({chaserId,victimId,chaserName,victimName})=>{
  playFart();
  if(victimId===myId){showMsg(`💨 Caught in ${chaserName}'s gas! You're the farter now!`,'#e74c3c');playSting();}
  else if(chaserId===myId){showMsg(`💨 ${victimName} walked into your gas!`);}
  else{showMsg(`💨 ${victimName} got gassed by ${chaserName}!`);}
});

socket.on('keyCollected',({playerId,playerName})=>{
  playPing();
  if(playerId===myId) showMsg('🗝️ Key collected! Find the EXIT!','#f1c40f');
  else showMsg(`🗝️ ${playerName} found their key!`,'#f1c40f');
});

socket.on('playerEscaped',({id,name})=>{
  playPing();
  if(id===myId) showMsg('✅ YOU ESCAPED!','#2ecc71');
  else showMsg(`✅ ${name} escaped!`,'#2ecc71');
});

socket.on('powerupCollected',({playerId,playerName,type})=>{
  playPing();
  const labels={speed:'⚡ Speed boost',shield:'🛡️ Shield'};
  if(playerId===myId) showMsg(`${labels[type]||type} activated!`,'#a78bfa');
  else showMsg(`${playerName} grabbed ${labels[type]||type}!`,'#a78bfa');
});

socket.on('gameEnded',({winners,escaped,caught})=>{
  if(animFrame){cancelAnimationFrame(animFrame);animFrame=null;}
  show('end');
  const teamWon=winners==='runners';
  document.getElementById('end-emoji').textContent=teamWon?'🏃':'💨';
  document.getElementById('end-title').textContent=teamWon?'Runners Win!':'Farter Wins!';
  document.getElementById('end-body').textContent=teamWon?'Some survivors escaped with their keys!':'Nobody got out. The maze reeked of victory.';
  const lists=document.getElementById('end-lists'); lists.innerHTML='';
  if(escaped.length){
    const g=document.createElement('div');g.className='end-group';
    g.innerHTML=`<div class="end-group-title">✅ Escaped</div>`+escaped.map(n=>`<div class="end-name">${n}</div>`).join('');
    lists.appendChild(g);
  }
  if(caught.length){
    const g=document.createElement('div');g.className='end-group';
    g.innerHTML=`<div class="end-group-title">💨 Gassed</div>`+caught.map(n=>`<div class="end-name">${n}</div>`).join('');
    lists.appendChild(g);
  }
  document.getElementById('play-again-btn').classList.remove('hidden');
});

socket.on('err',msg=>{showErr('home-err',msg);showErr('lobby-err',msg);});
socket.on('reconnect',()=>{if(currentCode)socket.emit('requestState',{code:currentCode});});

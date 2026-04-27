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
    src.connect(f); f.connect(g); g.connect(ctx.destination); src.start();
  }catch(e){}
}

function playAmbient(){
  try{
    const ctx=getAudio();
    const osc=ctx.createOscillator(); osc.type='sine'; osc.frequency.value=55;
    const g=ctx.createGain(); g.gain.value=0.04;
    const lfo=ctx.createOscillator(); lfo.frequency.value=0.1;
    const lg=ctx.createGain(); lg.gain.value=8;
    lfo.connect(lg); lg.connect(osc.frequency);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); lfo.start();
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
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime+0.4);
  }catch(e){}
}

function playPowerupSound(){
  try{
    const ctx=getAudio();
    const osc=ctx.createOscillator(); osc.type='sine';
    osc.frequency.setValueAtTime(440,ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880,ctx.currentTime+0.2);
    const g=ctx.createGain();
    g.gain.setValueAtTime(0.3,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.3);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime+0.3);
  }catch(e){}
}

// ─── Particles ────────────────────────────────────────────────────────────────
(function spawnParticles(){
  for(let i=0;i<12;i++){
    const p=document.createElement('div'); p.className='particle';
    p.style.left=Math.random()*100+'vw';
    p.style.width=p.style.height=(1+Math.random()*3)+'px';
    p.style.animationDuration=(6+Math.random()*10)+'s';
    p.style.animationDelay=(Math.random()*8)+'s';
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

// Maze colours — much lighter so they're clearly visible
const WALL_COLOR  = '#1e1e38';   // dark but clearly visible walls
const FLOOR_COLOR = '#2e2e50';   // noticeably lighter floor
const WALL_EDGE   = 'rgba(160,130,255,0.15)'; // soft purple wall highlight

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
        ctx.fillStyle=WALL_COLOR;
        ctx.fillRect(px,py,cellSize,cellSize);
        // Bright inner edge so walls feel solid
        ctx.fillStyle=WALL_EDGE;
        ctx.fillRect(px+1,py+1,cellSize-2,cellSize-2);
      } else {
        ctx.fillStyle=FLOOR_COLOR;
        ctx.fillRect(px,py,cellSize,cellSize);
        // Subtle grid
        ctx.strokeStyle='rgba(255,255,255,0.04)';
        ctx.lineWidth=1;
        ctx.strokeRect(px,py,cellSize,cellSize);
      }
    }
  }
}

const POWERUP_EMOJI={speed:'⚡',shield:'🛡️',reveal:'👁️'};
const POWERUP_COLOR={speed:'#fbbf24',shield:'#60a5fa',reveal:'#f472b6'};

function drawPowerups(powerups,ox,oy){
  powerups.forEach(pw=>{
    const px=pw.x+ox, py=pw.y+oy;
    const col=POWERUP_COLOR[pw.type]||'#fff';
    // Pulsing glow
    const pulse=0.6+Math.sin(Date.now()*0.005)*0.4;
    const grad=ctx.createRadialGradient(px,py,0,px,py,28);
    grad.addColorStop(0,col.replace(')',`,${0.5*pulse})`).replace('rgb','rgba')||`rgba(255,255,255,${0.5*pulse})`);
    grad.addColorStop(1,'rgba(0,0,0,0)');
    // Simple glow circle
    ctx.save();
    ctx.globalAlpha=pulse;
    ctx.fillStyle=col;
    ctx.beginPath(); ctx.arc(px,py,18,0,Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.font='18px sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(POWERUP_EMOJI[pw.type]||'★',px,py);
  });
}

function drawGas(gasClouds,ox,oy){
  gasClouds.forEach(g=>{
    const gx=g.x+ox, gy=g.y+oy;
    const alpha=Math.max(0, 0.55-(g.progress*0.5));
    const r=55+g.progress*10;
    const grad=ctx.createRadialGradient(gx,gy,0,gx,gy,r);
    grad.addColorStop(0,`rgba(110,220,70,${alpha})`);
    grad.addColorStop(0.5,`rgba(80,190,40,${alpha*0.5})`);
    grad.addColorStop(1,'rgba(60,170,30,0)');
    ctx.fillStyle=grad;
    ctx.beginPath(); ctx.arc(gx,gy,r,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=alpha*1.5;
    ctx.font='18px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('💨',gx,gy);
    ctx.globalAlpha=1;
  });
}

function drawExits(exits,ox,oy){
  if(!exits) return;
  exits.forEach(exit=>{
    const ex=exit.x+ox, ey=exit.y+oy;
    const pulse=0.7+Math.sin(Date.now()*0.004)*0.3;
    const grad=ctx.createRadialGradient(ex,ey,0,ex,ey,44);
    grad.addColorStop(0,`rgba(34,197,94,${0.85*pulse})`);
    grad.addColorStop(1,'rgba(34,197,94,0)');
    ctx.fillStyle=grad;
    ctx.beginPath(); ctx.arc(ex,ey,44,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#22c55e';
    ctx.font='bold 13px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('EXIT',ex,ey);
  });
}

function drawPlayers(players,ox,oy){
  players.forEach((p,i)=>{
    if(p.escaped) return;
    const col=PCOLORS[i%PCOLORS.length];
    const px=p.x+ox, py=p.y+oy;
    const r=14;

    // Ghost effect — semi-transparent blue tinge
    if(p.ghostActive){
      ctx.save(); ctx.globalAlpha=0.55;
      const gg=ctx.createRadialGradient(px,py,0,px,py,55);
      gg.addColorStop(0,'rgba(150,120,255,0.6)'); gg.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=gg; ctx.beginPath(); ctx.arc(px,py,55,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }

    // Shield ring
    if(p.activeEffects?.shield){
      ctx.save(); ctx.globalAlpha=0.7;
      ctx.strokeStyle='#60a5fa'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.arc(px,py,r+6,0,Math.PI*2); ctx.stroke();
      ctx.restore();
    }

    // Torch glow — bigger and brighter so maze is visible
    const torchR=110;
    const torch=ctx.createRadialGradient(px,py,0,px,py,torchR);
    torch.addColorStop(0,'rgba(255,255,255,0.28)');
    torch.addColorStop(0.3,'rgba(255,255,255,0.14)');
    torch.addColorStop(0.65,'rgba(255,255,255,0.05)');
    torch.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=torch; ctx.beginPath(); ctx.arc(px,py,torchR,0,Math.PI*2); ctx.fill();

    // Speed trail
    if(p.activeEffects?.speed){
      const sg=ctx.createRadialGradient(px,py,0,px,py,30);
      sg.addColorStop(0,'rgba(251,191,36,0.3)'); sg.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=sg; ctx.beginPath(); ctx.arc(px,py,30,0,Math.PI*2); ctx.fill();
    }

    // Red danger glow for farters
    if(p.isIt){
      const dg=ctx.createRadialGradient(px,py,0,px,py,60);
      dg.addColorStop(0,'rgba(255,30,30,0.45)'); dg.addColorStop(1,'rgba(255,30,30,0)');
      ctx.fillStyle=dg; ctx.beginPath(); ctx.arc(px,py,60,0,Math.PI*2); ctx.fill();
    }

    // Body
    ctx.beginPath(); ctx.arc(px,py,r,0,Math.PI*2);
    ctx.fillStyle=p.ghostActive?'rgba(180,150,255,0.6)':p.isIt?'#ff3333':col;
    ctx.fill();
    ctx.strokeStyle=p.isIt?'#ff0000':'rgba(255,255,255,0.6)';
    ctx.lineWidth=2.5; ctx.stroke();

    // Emoji
    ctx.font='16px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(p.ghostActive?'👻':p.isIt?'💨':'😨',px,py);

    // Name tag
    ctx.font='bold 11px sans-serif';
    const nw=ctx.measureText(p.name).width+10;
    ctx.fillStyle='rgba(0,0,0,0.85)';
    ctx.fillRect(px-nw/2,py-r-18,nw,14);
    ctx.fillStyle=p.isIt?'#ff9999':'#ffffff';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(p.name,px,py-r-11);
  });
}

// Darkness — less opaque so maze is visible even away from torch
function drawDarkness(players,ox,oy){
  ctx.fillStyle='rgba(0,0,0,0.45)';
  ctx.fillRect(0,0,vpW,vpH);
  ctx.save();
  ctx.globalCompositeOperation='destination-out';
  players.forEach(p=>{
    if(p.escaped) return;
    const px=p.x+ox, py=p.y+oy;
    const grad=ctx.createRadialGradient(px,py,0,px,py,130);
    grad.addColorStop(0,'rgba(0,0,0,1)');
    grad.addColorStop(0.5,'rgba(0,0,0,0.85)');
    grad.addColorStop(0.8,'rgba(0,0,0,0.4)');
    grad.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=grad;
    ctx.beginPath(); ctx.arc(px,py,130,0,Math.PI*2); ctx.fill();
  });
  ctx.restore();
}

let flickerVal=1, lastFlicker=0;

function render(ts){
  if(!currentMaze||!currentState){animFrame=requestAnimationFrame(render);return;}
  if(ts-lastFlicker>200+Math.random()*700){flickerVal=0.92+Math.random()*0.08;lastFlicker=ts;}

  const me=currentState.players.find(p=>p.id===myId);
  const{ox,oy}=camOffset(me);

  ctx.clearRect(0,0,vpW,vpH);

  ctx.save(); ctx.globalAlpha=flickerVal;
  drawMaze(currentMaze,ox,oy);
  drawExits(currentState.exits,ox,oy);
  drawPowerups(currentState.powerups||[],ox,oy);
  drawGas(currentState.gasClouds||[],ox,oy);
  drawPlayers(currentState.players,ox,oy);
  ctx.restore();

  drawDarkness(currentState.players,ox,oy);

  // Redraw players on top so always visible
  ctx.save(); ctx.globalAlpha=flickerVal;
  drawPlayers(currentState.players,ox,oy);
  ctx.restore();

  animFrame=requestAnimationFrame(render);
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function setGauge(pct){
  const color=pct>60?'linear-gradient(90deg,#ff6b6b,#ff3333)':pct>30?'linear-gradient(90deg,#fbbf24,#f59e0b)':'linear-gradient(90deg,#64748b,#475569)';
  ['gauge-fill','gauge-fill-desktop'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.style.width=Math.max(0,pct)+'%';el.style.background=color;}
  });
}

function updateHUD(state){
  const me=state.players.find(p=>p.id===myId);
  if(!me) return;

  const roleEl=document.getElementById('hud-role');
  if(me.escaped){roleEl.textContent='✅ ESCAPED!';roleEl.className='hud-role escaped';}
  else if(me.isIt){roleEl.textContent=me.ghostActive?'👻 GHOST MODE':'💨 YOU ARE THE FARTER';roleEl.className='hud-role is-it';}
  else{roleEl.textContent='😨 RUN!';roleEl.className='hud-role runner';}

  const m=Math.floor(state.gameTimer/60), s=state.gameTimer%60;
  const te=document.getElementById('hud-timer');
  te.textContent=`${m}:${String(s).padStart(2,'0')}`;
  te.className='hud-timer'+(state.gameTimer<30?' urgent':'');

  const active=state.players.filter(p=>!p.escaped);
  document.getElementById('hud-status').textContent=
    `💨${active.filter(p=>p.isIt).length} 😨${active.filter(p=>!p.isIt).length} ✅${state.players.filter(p=>p.escaped).length}`;

  const fartBtnZone=document.getElementById('fart-btn-zone');
  const fartKeyHint=document.getElementById('fart-key-hint');
  const fartBtn=document.getElementById('fart-btn');
  const ghostBtn=document.getElementById('ghost-btn');

  if(me.isIt&&!me.escaped){
    if(isTouch){fartBtnZone.style.display='flex';if(fartKeyHint)fartKeyHint.style.display='none';}
    else{if(fartKeyHint)fartKeyHint.style.display='block';fartBtnZone.style.display='none';}

    fartBtn.disabled=me.gauge<35;
    setGauge(Math.min(100,me.gauge));

    // Ghost button cooldown
    if(ghostBtn){
      const onCooldown=me.ghostCooldownUntil>Date.now();
      ghostBtn.disabled=onCooldown||me.ghostActive;
      const cdSec=Math.ceil(Math.max(0,(me.ghostCooldownUntil-Date.now())/1000));
      ghostBtn.title=onCooldown?`Ghost: ${cdSec}s`:'Ghost mode (pass through walls)';
      ghostBtn.style.opacity=onCooldown?'0.35':'1';
    }
  } else {
    fartBtnZone.style.display='none';
    if(fartKeyHint)fartKeyHint.style.display='none';
  }

  // Active effect badges on HUD
  const badges=document.getElementById('hud-effects');
  if(badges){
    badges.innerHTML='';
    if(me.activeEffects?.speed)  badges.innerHTML+='<span class="effect-badge">⚡</span>';
    if(me.activeEffects?.shield) badges.innerHTML+='<span class="effect-badge">🛡️</span>';
    if(me.activeEffects?.reveal) badges.innerHTML+='<span class="effect-badge">👁️</span>';
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function doFart(){ socket.emit('fart',{code:currentCode}); playFart(); }
function doGhost(){ socket.emit('ghost',{code:currentCode}); }

document.getElementById('fart-btn').addEventListener('click',doFart);
document.getElementById('fart-btn').addEventListener('touchstart',e=>{e.preventDefault();doFart();},{passive:false});
document.getElementById('ghost-btn').addEventListener('click',doGhost);
document.getElementById('ghost-btn').addEventListener('touchstart',e=>{e.preventDefault();doGhost();},{passive:false});

// ─── Keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown',e=>{
  keys[e.key]=true;
  if(e.key===' '&&myIsIt){e.preventDefault();doFart();}
  if((e.key==='g'||e.key==='G')&&myIsIt){doGhost();}
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

  let touching=false, originX=0, originY=0;

  base.addEventListener('touchstart',e=>{
    e.preventDefault(); touching=true; stick.classList.add('active');
    const rect=base.getBoundingClientRect();
    originX=rect.left+rect.width/2; originY=rect.top+rect.height/2;
  },{passive:false});

  document.addEventListener('touchmove',e=>{
    if(!touching) return; e.preventDefault();
    const t=e.changedTouches[0];
    let dx=t.clientX-originX, dy=t.clientY-originY;
    const len=Math.hypot(dx,dy);
    if(len>maxR){dx=dx/len*maxR;dy=dy/len*maxR;}
    stick.style.left=(50+dx/maxR*50)+'%';
    stick.style.top=(50+dy/maxR*50)+'%';
    const ndx=len>6?dx/len:0, ndy=len>6?dy/len:0;
    socket.emit('input',{code:currentCode,dx:ndx,dy:ndy});
  },{passive:false});

  document.addEventListener('touchend',()=>{
    touching=false; stick.classList.remove('active');
    stick.style.left='50%'; stick.style.top='50%';
    socket.emit('input',{code:currentCode,dx:0,dy:0});
  });
}

window.addEventListener('touchstart',()=>{ if(!isTouch){isTouch=true;setupJoystick();} },{once:true});

// ─── Fart message ─────────────────────────────────────────────────────────────
let fartMsgTimer=null;
function showMsg(msg){
  const el=document.getElementById('fart-msg');
  el.textContent=msg; el.classList.remove('hidden');
  clearTimeout(fartMsgTimer);
  fartMsgTimer=setTimeout(()=>el.classList.add('hidden'),3000);
  const flash=document.getElementById('fart-flash');
  flash.classList.remove('hidden');
  setTimeout(()=>flash.classList.add('hidden'),600);
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
  if(victimId===myId){showMsg(`💨 You walked into ${chaserName}'s gas! Now YOU are the farter!`);playSting();}
  else if(chaserId===myId){showMsg(`💨 ${victimName} walked into your gas!`);}
  else{showMsg(`💨 ${victimName} got gassed by ${chaserName}!`);}
});

socket.on('playerEscaped',({id,name})=>{
  if(id===myId) showMsg('✅ YOU ESCAPED!');
  else showMsg(`✅ ${name} escaped!`);
});

socket.on('powerupCollected',({playerId,playerName,type})=>{
  playPowerupSound();
  const labels={speed:'⚡ Speed boost',shield:'🛡️ Shield',reveal:'👁️ Reveal'};
  if(playerId===myId) showMsg(`${labels[type]||type} activated!`);
  else showMsg(`${playerName} grabbed ${labels[type]||type}!`);
});

socket.on('gameEnded',({winners,escaped,caught})=>{
  if(animFrame){cancelAnimationFrame(animFrame);animFrame=null;}
  show('end');
  const teamWon=winners==='runners';
  document.getElementById('end-emoji').textContent=teamWon?'🏃':'💨';
  document.getElementById('end-title').textContent=teamWon?'Runners Win!':'Farters Win!';
  document.getElementById('end-body').textContent=teamWon?'Some survivors made it out alive!':'Nobody escaped. The maze reeked of victory.';
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

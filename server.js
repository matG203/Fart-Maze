const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const MAZE_COLS = 41;          // bigger map (must be odd)
const MAZE_ROWS = 41;
const CELL_SIZE = 40;
const RUNNER_SPEED  = 3;
const FARTER_SPEED  = 5;
const TICK_MS       = 50;
const ESCAPE_RADIUS = 32;
const MAX_PLAYERS   = 8;
const MIN_PLAYERS   = 2;
const GAME_DURATION = 240;     // 4 mins for bigger map

// Gas
const GAS_DURATION   = 5000;
const GAS_TAG_RADIUS = 50;
const GAUGE_MAX      = 100;
const GAUGE_COST     = 35;
const GAUGE_REGEN    = 7;

// Ghost (wall phase) — 2 seconds, 15s cooldown
const GHOST_DURATION = 2000;
const GHOST_COOLDOWN = 15000;

// Ghost invisibility — farter can go invisible on cooldown
const INVIS_DURATION = 4000;
const INVIS_COOLDOWN = 20000;

// Keys — each runner needs their own key before escaping
const KEY_COLLECT_RADIUS = 24;

// Powerups
const POWERUP_TYPES  = ['speed', 'shield'];
const POWERUP_LIFE   = 15000;
const POWERUP_EFFECT = 8000;
const POWERUP_SPAWN_S = 20;
const MAX_POWERUPS   = 5;

// ─── Maze ─────────────────────────────────────────────────────────────────────
function generateMaze(cols, rows) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(0));
  function carve(x, y) {
    grid[y][x] = 1;
    const dirs = shuffle([[0,-2],[0,2],[-2,0],[2,0]]);
    for (const [dx,dy] of dirs) {
      const nx=x+dx, ny=y+dy;
      if (nx>0&&ny>0&&nx<cols-1&&ny<rows-1&&grid[ny][nx]===0) {
        grid[y+dy/2][x+dx/2]=1;
        carve(nx,ny);
      }
    }
  }
  carve(1,1);
  const cx=Math.floor(cols/2), cy=Math.floor(rows/2);
  for (let dy=-1;dy<=1;dy++)
    for (let dx=-1;dx<=1;dx++)
      grid[cy+dy][cx+dx]=1;
  // Exits — clear corridors to edges
  grid[1][1]=1; grid[0][1]=1;
  grid[rows-2][cols-2]=1; grid[rows-1][cols-2]=1;
  return grid;
}

function shuffle(arr) {
  for (let i=arr.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

function getOpenCells(maze, excludeCenter=true) {
  const cx=Math.floor(MAZE_COLS/2), cy=Math.floor(MAZE_ROWS/2);
  const cells=[];
  for (let r=1;r<MAZE_ROWS-1;r++)
    for (let c=1;c<MAZE_COLS-1;c++)
      if (maze[r][c]===1) {
        if (excludeCenter && Math.abs(c-cx)+Math.abs(r-cy)<8) continue;
        cells.push({c,r});
      }
  return cells;
}

function getSpawnPoints(maze, count) {
  const cells = getOpenCells(maze);
  shuffle(cells);
  return cells.slice(0,count).map(({c,r})=>({
    x:c*CELL_SIZE+CELL_SIZE/2, y:r*CELL_SIZE+CELL_SIZE/2
  }));
}

function cellToPixel(col,row) {
  return {x:col*CELL_SIZE+CELL_SIZE/2, y:row*CELL_SIZE+CELL_SIZE/2};
}

function getExits() {
  return [
    cellToPixel(1,0),
    cellToPixel(MAZE_COLS-2, MAZE_ROWS-1)
  ];
}

function isWall(maze, px, py, radius=11) {
  const pts=[[px-radius,py-radius],[px+radius,py-radius],[px-radius,py+radius],[px+radius,py+radius]];
  for (const [x,y] of pts) {
    const col=Math.floor(x/CELL_SIZE), row=Math.floor(y/CELL_SIZE);
    if (row<0||row>=MAZE_ROWS||col<0||col>=MAZE_COLS) return true;
    if (maze[row][col]===0) return true;
  }
  return false;
}

function dist(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms={};
let powerupId=0, keyId=0;

function genCode() {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c='';
  for(let i=0;i<4;i++) c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}

function makePlayer(id,name) {
  return {
    id,name,x:0,y:0,dx:0,dy:0,
    isIt:false,escaped:false,alive:true,
    gauge:GAUGE_MAX,
    ghostActive:false,ghostUntil:0,ghostCooldownUntil:0,
    invisActive:false,invisUntil:0,invisCooldownUntil:0,
    hasKey:false,
    activeEffects:{}
  };
}

function createRoom(hostId,hostName) {
  let code;
  do { code=genCode(); } while(rooms[code]);
  rooms[code]={
    code,host:hostId,phase:'lobby',
    players:{[hostId]:makePlayer(hostId,hostName)},
    maze:null,gameTimer:GAME_DURATION,
    tickInterval:null,exits:[],
    gasClouds:[],powerups:[],keys:[],
    powerupSpawnCounter:0
  };
  return rooms[code];
}

// ─── Key spawning ─────────────────────────────────────────────────────────────
function spawnKeys(maze, count) {
  const cells=getOpenCells(maze);
  shuffle(cells);
  return cells.slice(0,count).map(({c,r})=>({
    id:++keyId,
    x:c*CELL_SIZE+CELL_SIZE/2,
    y:r*CELL_SIZE+CELL_SIZE/2,
    collected:false
  }));
}

function spawnPowerup(maze) {
  const cells=getOpenCells(maze,false);
  shuffle(cells);
  const cell=cells[0]; if(!cell) return null;
  return {
    id:++powerupId,
    type:POWERUP_TYPES[Math.floor(Math.random()*POWERUP_TYPES.length)],
    x:cell.c*CELL_SIZE+CELL_SIZE/2,
    y:cell.r*CELL_SIZE+CELL_SIZE/2,
    expiresAt:Date.now()+POWERUP_LIFE
  };
}

// ─── Game ─────────────────────────────────────────────────────────────────────
function startGame(room) {
  room.phase='game';
  room.gasClouds=[]; room.powerups=[]; room.powerupSpawnCounter=0;
  room.exits=getExits();

  const playerIds=Object.keys(room.players);
  shuffle(playerIds);

  const center=cellToPixel(Math.floor(MAZE_COLS/2),Math.floor(MAZE_ROWS/2));
  const spawns=getSpawnPoints(room.maze, playerIds.length-1);
  const runnerCount=playerIds.length-1;

  // One key per runner, spread around map
  room.keys=spawnKeys(room.maze, runnerCount);

  playerIds.forEach((id,i)=>{
    const p=room.players[id];
    p.isIt=i===0;
    p.escaped=false;p.alive=true;p.dx=0;p.dy=0;
    p.gauge=GAUGE_MAX;
    p.ghostActive=false;p.ghostUntil=0;p.ghostCooldownUntil=0;
    p.invisActive=false;p.invisUntil=0;p.invisCooldownUntil=0;
    p.hasKey=false;
    p.activeEffects={};
    p.x=i===0?center.x:(spawns[i-1]||center).x;
    p.y=i===0?center.y:(spawns[i-1]||center).y;
  });

  room.gameTimer=GAME_DURATION;
  startTick(room);
  broadcastGameState(room);
}

function startTick(room) {
  let secondCounter=0;
  room.tickInterval=setInterval(()=>{
    if(room.phase!=='game'){clearInterval(room.tickInterval);return;}
    const now=Date.now();
    const players=Object.values(room.players);

    // Expire ghost/invis
    players.forEach(p=>{
      if(p.ghostActive&&now>p.ghostUntil) p.ghostActive=false;
      if(p.invisActive&&now>p.invisUntil) p.invisActive=false;
    });

    // Expire effects
    players.forEach(p=>{
      Object.keys(p.activeEffects).forEach(k=>{
        if(now>p.activeEffects[k]) delete p.activeEffects[k];
      });
    });

    // Move
    players.forEach(p=>{
      if(!p.alive||p.escaped) return;
      const speed=p.isIt
        ?FARTER_SPEED*(p.activeEffects.speed?1.5:1)
        :RUNNER_SPEED*(p.activeEffects.speed?1.5:1);
      const nx=p.x+p.dx*speed;
      const ny=p.y+p.dy*speed;
      if(p.ghostActive){
        const minX=CELL_SIZE/2,maxX=(MAZE_COLS-0.5)*CELL_SIZE;
        const minY=CELL_SIZE/2,maxY=(MAZE_ROWS-0.5)*CELL_SIZE;
        p.x=Math.max(minX,Math.min(maxX,nx));
        p.y=Math.max(minY,Math.min(maxY,ny));
      } else {
        if(!isWall(room.maze,nx,p.y)) p.x=nx;
        if(!isWall(room.maze,p.x,ny)) p.y=ny;
      }
    });

    // Expire gas
    room.gasClouds=room.gasClouds.filter(g=>now<g.expiresAt);

    // Gas tagging (shield blocks)
    players.filter(p=>!p.isIt&&!p.escaped&&p.alive).forEach(runner=>{
      if(runner.activeEffects.shield) return;
      for(const gas of room.gasClouds){
        if(dist(runner,gas)<GAS_TAG_RADIUS){
          runner.isIt=true; runner.gauge=GAUGE_MAX; runner.hasKey=false;
          io.to(room.code).emit('farted',{
            chaserId:gas.ownerId,victimId:runner.id,
            chaserName:gas.ownerName,victimName:runner.name
          });
          break;
        }
      }
    });

    // Gauge regen
    players.filter(p=>p.isIt&&!p.escaped).forEach(p=>{
      p.gauge=Math.min(GAUGE_MAX,p.gauge+GAUGE_REGEN*(TICK_MS/1000));
    });

    // Key collection (only runners without keys, ghost CANNOT see/collect keys)
    players.filter(p=>!p.isIt&&!p.escaped&&p.alive&&!p.hasKey).forEach(runner=>{
      for(const key of room.keys){
        if(!key.collected&&dist(runner,key)<KEY_COLLECT_RADIUS){
          key.collected=true;
          runner.hasKey=true;
          io.to(room.code).emit('keyCollected',{
            playerId:runner.id, playerName:runner.name
          });
          break;
        }
      }
    });

    // Powerup collection
    room.powerups=room.powerups.filter(pw=>now<pw.expiresAt);
    players.filter(p=>!p.escaped&&p.alive).forEach(player=>{
      room.powerups=room.powerups.filter(pw=>{
        if(dist(player,pw)<22){
          if(pw.type==='speed')  player.activeEffects.speed=now+POWERUP_EFFECT;
          if(pw.type==='shield') player.activeEffects.shield=now+POWERUP_EFFECT;
          io.to(room.code).emit('powerupCollected',{
            playerId:player.id,playerName:player.name,type:pw.type
          });
          return false;
        }
        return true;
      });
    });

    // Timer + powerup spawning
    secondCounter+=TICK_MS;
    if(secondCounter>=1000){
      secondCounter=0;
      room.gameTimer=Math.max(0,room.gameTimer-1);
      room.powerupSpawnCounter++;
      if(room.powerupSpawnCounter>=POWERUP_SPAWN_S&&room.powerups.length<MAX_POWERUPS){
        room.powerupSpawnCounter=0;
        const pw=spawnPowerup(room.maze);
        if(pw) room.powerups.push(pw);
      }
    }

    // Escapes — runner needs their key
    players.forEach(p=>{
      if(!p.isIt&&!p.escaped&&p.alive&&p.hasKey){
        for(const exit of room.exits){
          if(dist(p,exit)<ESCAPE_RADIUS){
            p.escaped=true;
            io.to(room.code).emit('playerEscaped',{id:p.id,name:p.name});
            break;
          }
        }
      }
    });

    // End check
    const activeRunners=players.filter(p=>!p.isIt&&!p.escaped&&p.alive);
    const escapedList=players.filter(p=>p.escaped);
    if((activeRunners.length===0&&escapedList.length===0)||room.gameTimer<=0){
      endGame(room,escapedList.length>0||room.gameTimer<=0?'runners':'chasers');
      return;
    }

    broadcastGameState(room);
  },TICK_MS);
}

function endGame(room,winners){
  room.phase='ended';
  if(room.tickInterval) clearInterval(room.tickInterval);
  const escaped=Object.values(room.players).filter(p=>p.escaped).map(p=>p.name);
  const caught=Object.values(room.players).filter(p=>p.isIt&&!p.escaped).map(p=>p.name);
  io.to(room.code).emit('gameEnded',{winners,escaped,caught});
}

function broadcastGameState(room){
  const now=Date.now();
  // Send keys differently per player — ghost cannot see uncollected keys
  const baseState={
    phase:room.phase,code:room.code,host:room.host,
    gameTimer:room.gameTimer,exits:room.exits,
    gasClouds:room.gasClouds.map(g=>({x:g.x,y:g.y,progress:1-(g.expiresAt-now)/GAS_DURATION})),
    powerups:room.powerups.map(pw=>({id:pw.id,type:pw.type,x:pw.x,y:pw.y})),
    players:Object.values(room.players).map(p=>({
      id:p.id,name:p.name,
      x:Math.round(p.x),y:Math.round(p.y),
      isIt:p.isIt,escaped:p.escaped,alive:p.alive,
      gauge:Math.round(p.gauge),
      ghostActive:p.ghostActive,
      ghostCooldownUntil:p.ghostCooldownUntil,
      invisActive:p.invisActive,
      invisCooldownUntil:p.invisCooldownUntil,
      hasKey:p.hasKey,
      activeEffects:{
        speed:!!(p.activeEffects.speed&&p.activeEffects.speed>now),
        shield:!!(p.activeEffects.shield&&p.activeEffects.shield>now)
      }
    }))
  };

  // Each player gets personalised key list
  Object.values(room.players).forEach(p=>{
    const sock=io.sockets.sockets.get(p.id);
    if(!sock) return;
    const keys=p.isIt
      ? [] // ghost cannot see keys at all
      : room.keys.filter(k=>!k.collected).map(k=>({id:k.id,x:k.x,y:k.y}));
    sock.emit('gameState',{...baseState,keys,myHasKey:p.hasKey});
  });
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection',socket=>{

  socket.on('createRoom',({name})=>{
    if(!name?.trim()) return socket.emit('err','Name required');
    const room=createRoom(socket.id,name.trim().slice(0,20));
    socket.join(room.code);
    socket.emit('roomCreated',{code:room.code});
    socket.emit('lobbyState',getLobbyState(room));
  });

  socket.on('joinRoom',({code,name})=>{
    const room=rooms[code?.toUpperCase()];
    if(!room) return socket.emit('err','Room not found');
    if(room.phase!=='lobby') return socket.emit('err','Game already started');
    if(Object.keys(room.players).length>=MAX_PLAYERS) return socket.emit('err','Room is full');
    if(!name?.trim()) return socket.emit('err','Name required');
    room.players[socket.id]=makePlayer(socket.id,name.trim().slice(0,20));
    socket.join(code.toUpperCase());
    io.to(room.code).emit('lobbyState',getLobbyState(room));
  });

  socket.on('startGame',({code})=>{
    const room=rooms[code];
    if(!room) return socket.emit('err','Room not found');
    if(room.host!==socket.id) return socket.emit('err','Only host can start');
    if(room.phase!=='lobby') return socket.emit('err','Already started');
    if(Object.keys(room.players).length<MIN_PLAYERS) return socket.emit('err',`Need at least ${MIN_PLAYERS} players`);
    room.maze=generateMaze(MAZE_COLS,MAZE_ROWS);
    io.to(room.code).emit('mazeData',{maze:room.maze,cellSize:CELL_SIZE,cols:MAZE_COLS,rows:MAZE_ROWS});
    setTimeout(()=>startGame(room),500);
  });

  socket.on('input',({code,dx,dy})=>{
    const room=rooms[code];
    if(!room||room.phase!=='game') return;
    const p=room.players[socket.id];
    if(!p||p.escaped) return;
    const len=Math.hypot(dx,dy);
    p.dx=len>0?dx/len:0; p.dy=len>0?dy/len:0;
  });

  socket.on('fart',({code})=>{
    const room=rooms[code];
    if(!room||room.phase!=='game') return;
    const p=room.players[socket.id];
    if(!p||!p.isIt||p.escaped||p.gauge<GAUGE_COST) return;
    p.gauge-=GAUGE_COST;
    room.gasClouds.push({x:p.x,y:p.y,ownerId:p.id,ownerName:p.name,expiresAt:Date.now()+GAS_DURATION});
    broadcastGameState(room);
  });

  socket.on('ghost',({code})=>{
    const room=rooms[code];
    if(!room||room.phase!=='game') return;
    const p=room.players[socket.id];
    if(!p||!p.isIt||p.escaped) return;
    const now=Date.now();
    if(now<p.ghostCooldownUntil) return;
    p.ghostActive=true;
    p.ghostUntil=now+GHOST_DURATION;
    p.ghostCooldownUntil=now+GHOST_COOLDOWN;
    broadcastGameState(room);
  });

  socket.on('invis',({code})=>{
    const room=rooms[code];
    if(!room||room.phase!=='game') return;
    const p=room.players[socket.id];
    if(!p||!p.isIt||p.escaped) return;
    const now=Date.now();
    if(now<p.invisCooldownUntil) return;
    p.invisActive=true;
    p.invisUntil=now+INVIS_DURATION;
    p.invisCooldownUntil=now+INVIS_COOLDOWN;
    broadcastGameState(room);
  });

  socket.on('playAgain',({code})=>{
    const room=rooms[code];
    if(!room||room.host!==socket.id) return;
    room.phase='lobby'; room.gasClouds=[]; room.powerups=[]; room.keys=[];
    Object.values(room.players).forEach(p=>{
      p.isIt=false;p.escaped=false;p.alive=true;p.dx=0;p.dy=0;
      p.gauge=GAUGE_MAX;p.ghostActive=false;p.ghostUntil=0;p.ghostCooldownUntil=0;
      p.invisActive=false;p.invisUntil=0;p.invisCooldownUntil=0;
      p.hasKey=false;p.activeEffects={};
    });
    room.maze=null;
    io.to(room.code).emit('lobbyState',getLobbyState(room));
  });

  socket.on('disconnect',()=>{
    for(const [code,room] of Object.entries(rooms)){
      if(!room.players[socket.id]) continue;
      delete room.players[socket.id];
      if(Object.keys(room.players).length===0){
        if(room.tickInterval) clearInterval(room.tickInterval);
        delete rooms[code];
      } else {
        if(room.host===socket.id) room.host=Object.keys(room.players)[0];
        if(room.phase==='lobby') io.to(room.code).emit('lobbyState',getLobbyState(room));
      }
      break;
    }
  });
});

function getLobbyState(room){
  return{code:room.code,host:room.host,players:Object.values(room.players).map(p=>({id:p.id,name:p.name}))};
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Fart Maze running on http://localhost:${PORT}`));

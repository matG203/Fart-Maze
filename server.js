const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const MAZE_COLS = 31;
const MAZE_ROWS = 31;
const CELL_SIZE = 40;
const RUNNER_SPEED  = 3;
const FARTER_SPEED  = 5;       // farters are noticeably faster
const TICK_MS       = 50;
const ESCAPE_RADIUS = 32;
const MAX_PLAYERS   = 8;
const MIN_PLAYERS   = 2;
const GAME_DURATION = 180;

// Gas
const GAS_DURATION   = 5000;
const GAS_TAG_RADIUS = 50;
const GAUGE_MAX      = 100;
const GAUGE_COST     = 35;
const GAUGE_REGEN    = 7;

// Ghost (wall phase)
const GHOST_DURATION  = 4000;
const GHOST_COOLDOWN  = 15000;

// Powerups
const POWERUP_TYPES    = ['speed','shield','reveal'];
const POWERUP_LIFE     = 12000;  // ms before it despawns if uncollected
const POWERUP_EFFECT   = 8000;   // ms the effect lasts on player
const POWERUP_SPAWN_S  = 18;     // seconds between spawns
const MAX_POWERUPS     = 4;

// ─── Maze Generation ──────────────────────────────────────────────────────────
function generateMaze(cols, rows) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(0));

  function carve(x, y) {
    grid[y][x] = 1;
    const dirs = shuffle([[0,-2],[0,2],[-2,0],[2,0]]);
    for (const [dx, dy] of dirs) {
      const nx = x+dx, ny = y+dy;
      if (nx>0 && ny>0 && nx<cols-1 && ny<rows-1 && grid[ny][nx]===0) {
        grid[y+dy/2][x+dx/2] = 1;
        carve(nx, ny);
      }
    }
  }
  carve(1, 1);

  // Open centre room
  const cx = Math.floor(cols/2), cy = Math.floor(rows/2);
  for (let dy=-1; dy<=1; dy++)
    for (let dx=-1; dx<=1; dx++)
      grid[cy+dy][cx+dx] = 1;

  // ── Exits: carve clear corridors to ACTUAL open edges ──
  // Top exit: carve from row 1 all the way to row 0
  grid[1][1] = 1;
  grid[0][1] = 1;

  // Bottom exit: carve from row rows-2 to rows-1
  grid[rows-2][cols-2] = 1;
  grid[rows-1][cols-2] = 1;

  return grid;
}

function shuffle(arr) {
  for (let i=arr.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

function getSpawnPoints(maze, count) {
  const cx = Math.floor(MAZE_COLS/2), cy = Math.floor(MAZE_ROWS/2);
  const cells = [];
  for (let r=1; r<MAZE_ROWS-1; r++)
    for (let c=1; c<MAZE_COLS-1; c++)
      if (maze[r][c]===1 && Math.abs(c-cx)+Math.abs(r-cy)>8)
        cells.push({c,r});
  shuffle(cells);
  return cells.slice(0,count).map(({c,r})=>({
    x: c*CELL_SIZE+CELL_SIZE/2,
    y: r*CELL_SIZE+CELL_SIZE/2
  }));
}

function cellToPixel(col, row) {
  return { x: col*CELL_SIZE+CELL_SIZE/2, y: row*CELL_SIZE+CELL_SIZE/2 };
}

// Exit positions (pixel centres)
function getExitPositions() {
  return [
    cellToPixel(1, 0),           // top
    cellToPixel(MAZE_COLS-2, MAZE_ROWS-1)  // bottom
  ];
}

function isWall(maze, px, py, radius=11) {
  const pts = [
    [px-radius, py-radius],[px+radius, py-radius],
    [px-radius, py+radius],[px+radius, py+radius]
  ];
  for (const [x,y] of pts) {
    const col = Math.floor(x/CELL_SIZE);
    const row = Math.floor(y/CELL_SIZE);
    if (row<0||row>=MAZE_ROWS||col<0||col>=MAZE_COLS) return true;
    if (maze[row][col]===0) return true;
  }
  return false;
}

function dist(a,b) { return Math.hypot(a.x-b.x, a.y-b.y); }

// ─── Powerup spawning ─────────────────────────────────────────────────────────
let powerupIdCounter = 0;

function spawnPowerup(maze) {
  const cells = [];
  for (let r=1; r<MAZE_ROWS-1; r++)
    for (let c=1; c<MAZE_COLS-1; c++)
      if (maze[r][c]===1) cells.push({c,r});
  shuffle(cells);
  const cell = cells[0];
  if (!cell) return null;
  return {
    id: ++powerupIdCounter,
    type: POWERUP_TYPES[Math.floor(Math.random()*POWERUP_TYPES.length)],
    x: cell.c*CELL_SIZE+CELL_SIZE/2,
    y: cell.r*CELL_SIZE+CELL_SIZE/2,
    expiresAt: Date.now()+POWERUP_LIFE
  };
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c='';
  for (let i=0;i<4;i++) c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}

function makePlayer(id, name) {
  return {
    id, name, x:0, y:0, dx:0, dy:0,
    isIt:false, escaped:false, alive:true,
    gauge:GAUGE_MAX,
    ghostActive:false, ghostUntil:0, ghostCooldownUntil:0,
    activeEffects:{}   // { speed, shield, reveal } -> expiresAt
  };
}

function createRoom(hostId, hostName) {
  let code;
  do { code=genCode(); } while (rooms[code]);
  rooms[code] = {
    code, host:hostId, phase:'lobby',
    players:{ [hostId]:makePlayer(hostId,hostName) },
    maze:null, gameTimer:GAME_DURATION,
    tickInterval:null, exits:[],
    gasClouds:[], powerups:[],
    powerupSpawnCounter:0
  };
  return rooms[code];
}

// ─── Game ─────────────────────────────────────────────────────────────────────
function startGame(room) {
  room.phase = 'game';
  room.gasClouds = [];
  room.powerups = [];
  room.powerupSpawnCounter = 0;
  room.exits = getExitPositions();

  const playerIds = Object.keys(room.players);
  shuffle(playerIds);

  const center = cellToPixel(Math.floor(MAZE_COLS/2), Math.floor(MAZE_ROWS/2));
  const spawns = getSpawnPoints(room.maze, playerIds.length-1);

  playerIds.forEach((id,i) => {
    const p = room.players[id];
    p.isIt = i===0;
    p.escaped=false; p.alive=true; p.dx=0; p.dy=0;
    p.gauge=GAUGE_MAX;
    p.ghostActive=false; p.ghostUntil=0; p.ghostCooldownUntil=0;
    p.activeEffects={};
    p.x = i===0 ? center.x : (spawns[i-1]||center).x;
    p.y = i===0 ? center.y : (spawns[i-1]||center).y;
  });

  room.gameTimer = GAME_DURATION;
  startTick(room);
  broadcastGameState(room);
}

function startTick(room) {
  let secondCounter = 0;
  room.tickInterval = setInterval(() => {
    if (room.phase !== 'game') { clearInterval(room.tickInterval); return; }
    const now = Date.now();
    const players = Object.values(room.players);

    // ── Expire ghost ──
    players.forEach(p => {
      if (p.ghostActive && now > p.ghostUntil) p.ghostActive = false;
    });

    // ── Expire active effects ──
    players.forEach(p => {
      Object.keys(p.activeEffects).forEach(k => {
        if (now > p.activeEffects[k]) delete p.activeEffects[k];
      });
    });

    // ── Move ──
    players.forEach(p => {
      if (!p.alive || p.escaped) return;
      const speed = p.isIt
        ? FARTER_SPEED * (p.activeEffects.speed ? 1.5 : 1)
        : RUNNER_SPEED * (p.activeEffects.speed ? 1.5 : 1);
      const nx = p.x + p.dx*speed;
      const ny = p.y + p.dy*speed;

      if (p.ghostActive) {
        // Ghost mode — pass through walls but clamp to maze bounds
        const minX = CELL_SIZE/2, maxX = (MAZE_COLS-0.5)*CELL_SIZE;
        const minY = CELL_SIZE/2, maxY = (MAZE_ROWS-0.5)*CELL_SIZE;
        p.x = Math.max(minX, Math.min(maxX, nx));
        p.y = Math.max(minY, Math.min(maxY, ny));
      } else {
        if (!isWall(room.maze, nx, p.y)) p.x = nx;
        if (!isWall(room.maze, p.x, ny)) p.y = ny;
      }
    });

    // ── Expire gas ──
    room.gasClouds = room.gasClouds.filter(g => now < g.expiresAt);

    // ── Gas tagging (shield protects) ──
    players.filter(p => !p.isIt && !p.escaped && p.alive).forEach(runner => {
      if (runner.activeEffects.shield) return;
      for (const gas of room.gasClouds) {
        if (dist(runner,gas) < GAS_TAG_RADIUS) {
          runner.isIt = true;
          runner.gauge = GAUGE_MAX;
          io.to(room.code).emit('farted', {
            chaserId:gas.ownerId, victimId:runner.id,
            chaserName:gas.ownerName, victimName:runner.name
          });
          break;
        }
      }
    });

    // ── Gauge regen ──
    players.filter(p => p.isIt && !p.escaped).forEach(p => {
      p.gauge = Math.min(GAUGE_MAX, p.gauge + GAUGE_REGEN*(TICK_MS/1000));
    });

    // ── Collect powerups ──
    room.powerups = room.powerups.filter(pw => now < pw.expiresAt); // expire uncollected
    players.filter(p => !p.escaped && p.alive).forEach(player => {
      room.powerups = room.powerups.filter(pw => {
        if (dist(player, pw) < 22) {
          applyPowerup(player, pw, now);
          io.to(room.code).emit('powerupCollected', {
            playerId:player.id, playerName:player.name, type:pw.type
          });
          return false; // remove from map
        }
        return true;
      });
    });

    // ── Spawn powerups ──
    secondCounter += TICK_MS;
    if (secondCounter >= 1000) {
      secondCounter = 0;
      room.gameTimer = Math.max(0, room.gameTimer-1);
      room.powerupSpawnCounter++;
      if (room.powerupSpawnCounter >= POWERUP_SPAWN_S && room.powerups.length < MAX_POWERUPS) {
        room.powerupSpawnCounter = 0;
        const pw = spawnPowerup(room.maze);
        if (pw) room.powerups.push(pw);
      }
    }

    // ── Check escapes (any exit) ──
    players.forEach(p => {
      if (!p.isIt && !p.escaped && p.alive) {
        for (const exit of room.exits) {
          if (dist(p, exit) < ESCAPE_RADIUS) {
            p.escaped = true;
            io.to(room.code).emit('playerEscaped', {id:p.id, name:p.name});
            break;
          }
        }
      }
    });

    // ── End check ──
    const activeRunners = players.filter(p=>!p.isIt&&!p.escaped&&p.alive);
    const escapedList   = players.filter(p=>p.escaped);
    if ((activeRunners.length===0 && escapedList.length===0) || room.gameTimer<=0) {
      endGame(room, escapedList.length>0||room.gameTimer<=0 ? 'runners' : 'chasers');
      return;
    }

    broadcastGameState(room);
  }, TICK_MS);
}

function applyPowerup(player, pw, now) {
  switch(pw.type) {
    case 'speed':  player.activeEffects.speed  = now+POWERUP_EFFECT; break;
    case 'shield': player.activeEffects.shield = now+POWERUP_EFFECT; break;
    case 'reveal': player.activeEffects.reveal = now+POWERUP_EFFECT; break;
  }
}

function endGame(room, winners) {
  room.phase = 'ended';
  if (room.tickInterval) clearInterval(room.tickInterval);
  const escaped = Object.values(room.players).filter(p=>p.escaped).map(p=>p.name);
  const caught  = Object.values(room.players).filter(p=>p.isIt&&!p.escaped).map(p=>p.name);
  io.to(room.code).emit('gameEnded', {winners,escaped,caught});
}

function broadcastGameState(room) {
  const now = Date.now();
  io.to(room.code).emit('gameState', {
    phase:room.phase, code:room.code, host:room.host,
    gameTimer:room.gameTimer,
    exits:room.exits,
    gasClouds:room.gasClouds.map(g=>({
      x:g.x, y:g.y, progress:1-(g.expiresAt-now)/GAS_DURATION
    })),
    powerups:room.powerups.map(pw=>({
      id:pw.id, type:pw.type, x:pw.x, y:pw.y,
      progress:(now-( pw.expiresAt-POWERUP_LIFE))/POWERUP_LIFE
    })),
    players:Object.values(room.players).map(p=>({
      id:p.id, name:p.name,
      x:Math.round(p.x), y:Math.round(p.y),
      isIt:p.isIt, escaped:p.escaped, alive:p.alive,
      gauge:Math.round(p.gauge),
      ghostActive:p.ghostActive,
      ghostCooldownUntil:p.ghostCooldownUntil,
      activeEffects: {
        speed:  !!(p.activeEffects.speed  && p.activeEffects.speed  > now),
        shield: !!(p.activeEffects.shield && p.activeEffects.shield > now),
        reveal: !!(p.activeEffects.reveal && p.activeEffects.reveal > now)
      }
    }))
  });
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('createRoom', ({name}) => {
    if (!name?.trim()) return socket.emit('err','Name required');
    const room = createRoom(socket.id, name.trim().slice(0,20));
    socket.join(room.code);
    socket.emit('roomCreated', {code:room.code});
    socket.emit('lobbyState', getLobbyState(room));
  });

  socket.on('joinRoom', ({code,name}) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit('err','Room not found');
    if (room.phase!=='lobby') return socket.emit('err','Game already started');
    if (Object.keys(room.players).length>=MAX_PLAYERS) return socket.emit('err','Room is full');
    if (!name?.trim()) return socket.emit('err','Name required');
    room.players[socket.id] = makePlayer(socket.id, name.trim().slice(0,20));
    socket.join(code.toUpperCase());
    io.to(room.code).emit('lobbyState', getLobbyState(room));
  });

  socket.on('startGame', ({code}) => {
    const room = rooms[code];
    if (!room) return socket.emit('err','Room not found');
    if (room.host!==socket.id) return socket.emit('err','Only host can start');
    if (room.phase!=='lobby') return socket.emit('err','Already started');
    if (Object.keys(room.players).length<MIN_PLAYERS) return socket.emit('err',`Need at least ${MIN_PLAYERS} players`);
    room.maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    io.to(room.code).emit('mazeData', {maze:room.maze, cellSize:CELL_SIZE, cols:MAZE_COLS, rows:MAZE_ROWS});
    setTimeout(() => startGame(room), 500);
  });

  socket.on('input', ({code,dx,dy}) => {
    const room = rooms[code];
    if (!room||room.phase!=='game') return;
    const p = room.players[socket.id];
    if (!p||p.escaped) return;
    const len = Math.hypot(dx,dy);
    p.dx = len>0 ? dx/len : 0;
    p.dy = len>0 ? dy/len : 0;
  });

  socket.on('fart', ({code}) => {
    const room = rooms[code];
    if (!room||room.phase!=='game') return;
    const p = room.players[socket.id];
    if (!p||!p.isIt||p.escaped) return;
    if (p.gauge < GAUGE_COST) return;
    p.gauge -= GAUGE_COST;
    room.gasClouds.push({
      x:p.x, y:p.y, ownerId:p.id, ownerName:p.name,
      expiresAt:Date.now()+GAS_DURATION
    });
    broadcastGameState(room);
  });

  socket.on('ghost', ({code}) => {
    const room = rooms[code];
    if (!room||room.phase!=='game') return;
    const p = room.players[socket.id];
    if (!p||!p.isIt||p.escaped) return;
    const now = Date.now();
    if (now < p.ghostCooldownUntil) return; // on cooldown
    p.ghostActive = true;
    p.ghostUntil = now+GHOST_DURATION;
    p.ghostCooldownUntil = now+GHOST_COOLDOWN;
    broadcastGameState(room);
  });

  socket.on('playAgain', ({code}) => {
    const room = rooms[code];
    if (!room||room.host!==socket.id) return;
    room.phase='lobby'; room.gasClouds=[]; room.powerups=[];
    Object.values(room.players).forEach(p=>{
      p.isIt=false; p.escaped=false; p.alive=true; p.dx=0; p.dy=0;
      p.gauge=GAUGE_MAX; p.ghostActive=false; p.ghostUntil=0;
      p.ghostCooldownUntil=0; p.activeEffects={};
    });
    room.maze=null;
    io.to(room.code).emit('lobbyState', getLobbyState(room));
  });

  socket.on('disconnect', () => {
    for (const [code,room] of Object.entries(rooms)) {
      if (!room.players[socket.id]) continue;
      delete room.players[socket.id];
      if (Object.keys(room.players).length===0) {
        if (room.tickInterval) clearInterval(room.tickInterval);
        delete rooms[code];
      } else {
        if (room.host===socket.id) room.host=Object.keys(room.players)[0];
        if (room.phase==='lobby') io.to(room.code).emit('lobbyState',getLobbyState(room));
      }
      break;
    }
  });
});

function getLobbyState(room) {
  return { code:room.code, host:room.host, players:Object.values(room.players).map(p=>({id:p.id,name:p.name})) };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Fart Maze running on http://localhost:${PORT}`));

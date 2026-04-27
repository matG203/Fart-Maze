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
const PLAYER_SPEED = 3;
const TICK_MS = 50;
const ESCAPE_ZONE_RADIUS = 30;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const GAME_DURATION = 180;
const GAS_DURATION = 5000;
const GAS_TAG_RADIUS = 48;
const GAUGE_MAX = 100;
const GAUGE_COST = 35;
const GAUGE_REGEN = 6;

// ─── Maze Generation ──────────────────────────────────────────────────────────
function generateMaze(cols, rows) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(0));
  function carve(x, y) {
    const dirs = shuffle([[0,-2],[0,2],[-2,0],[2,0]]);
    grid[y][x] = 1;
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && grid[ny][nx] === 0) {
        grid[y+dy/2][x+dx/2] = 1;
        carve(nx, ny);
      }
    }
  }
  carve(1, 1);
  const cx = Math.floor(cols/2), cy = Math.floor(rows/2);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      grid[cy+dy][cx+dx] = 1;
  grid[0][1] = 1;
  grid[rows-1][cols-2] = 1;
  return grid;
}

function shuffle(arr) {
  for (let i = arr.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

function getSpawnPoints(maze, cols, rows, count) {
  const cx = Math.floor(cols/2), cy = Math.floor(rows/2);
  const cells = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (maze[r][c] === 1 && Math.abs(c-cx)+Math.abs(r-cy) > 8)
        cells.push({c,r});
  shuffle(cells);
  return cells.slice(0,count).map(({c,r}) => ({
    x: c*CELL_SIZE + CELL_SIZE/2, y: r*CELL_SIZE + CELL_SIZE/2
  }));
}

function cellToPixel(col, row) {
  return { x: col*CELL_SIZE+CELL_SIZE/2, y: row*CELL_SIZE+CELL_SIZE/2 };
}

function isWall(maze, px, py, radius=11) {
  const pts = [[px-radius,py-radius],[px+radius,py-radius],[px-radius,py+radius],[px+radius,py+radius]];
  for (const [x,y] of pts) {
    const col = Math.floor(x/CELL_SIZE), row = Math.floor(y/CELL_SIZE);
    if (row<0||row>=MAZE_ROWS||col<0||col>=MAZE_COLS) return true;
    if (maze[row][col]===0) return true;
  }
  return false;
}

function dist(a,b) { return Math.hypot(a.x-b.x, a.y-b.y); }

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c='';
  for (let i=0;i<4;i++) c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}

function makePlayer(id, name) {
  return { id, name, x:0, y:0, dx:0, dy:0, isIt:false, escaped:false, alive:true, gauge:GAUGE_MAX };
}

function createRoom(hostId, hostName) {
  let code;
  do { code=genCode(); } while (rooms[code]);
  rooms[code] = {
    code, host:hostId, phase:'lobby',
    players:{ [hostId]: makePlayer(hostId,hostName) },
    maze:null, gameTimer:GAME_DURATION,
    tickInterval:null, exitPos:null, gasClouds:[]
  };
  return rooms[code];
}

// ─── Game ─────────────────────────────────────────────────────────────────────
function startGame(room) {
  room.phase = 'game';
  room.gasClouds = [];
  room.exitPos = cellToPixel(MAZE_COLS-2, MAZE_ROWS-1);

  const playerIds = Object.keys(room.players);
  shuffle(playerIds);

  const center = cellToPixel(Math.floor(MAZE_COLS/2), Math.floor(MAZE_ROWS/2));
  const spawns = getSpawnPoints(room.maze, MAZE_COLS, MAZE_ROWS, playerIds.length-1);

  playerIds.forEach((id,i) => {
    const p = room.players[id];
    p.isIt = i===0;
    p.escaped=false; p.alive=true; p.dx=0; p.dy=0; p.gauge=GAUGE_MAX;
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

    // Move
    players.forEach(p => {
      if (!p.alive || p.escaped) return;
      const nx = p.x + p.dx*PLAYER_SPEED;
      const ny = p.y + p.dy*PLAYER_SPEED;
      if (!isWall(room.maze, nx, p.y)) p.x = nx;
      if (!isWall(room.maze, p.x, ny)) p.y = ny;
    });

    // Expire gas
    room.gasClouds = room.gasClouds.filter(g => now < g.expiresAt);

    // Gas tagging
    players.filter(p => !p.isIt && !p.escaped && p.alive).forEach(runner => {
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

    // Gauge regen
    players.filter(p => p.isIt && !p.escaped).forEach(p => {
      p.gauge = Math.min(GAUGE_MAX, p.gauge + GAUGE_REGEN*(TICK_MS/1000));
    });

    // Escapes
    players.forEach(p => {
      if (!p.isIt && !p.escaped && p.alive && dist(p,room.exitPos)<ESCAPE_ZONE_RADIUS) {
        p.escaped = true;
        io.to(room.code).emit('playerEscaped', {id:p.id, name:p.name});
      }
    });

    // Timer
    secondCounter += TICK_MS;
    if (secondCounter >= 1000) { secondCounter=0; room.gameTimer=Math.max(0,room.gameTimer-1); }

    // End check
    const activeRunners = players.filter(p=>!p.isIt&&!p.escaped&&p.alive);
    const escaped = players.filter(p=>p.escaped);
    if (activeRunners.length===0&&escaped.length===0 || room.gameTimer<=0) {
      endGame(room, escaped.length>0||room.gameTimer<=0 ? 'runners' : 'chasers');
      return;
    }

    broadcastGameState(room);
  }, TICK_MS);
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
    gameTimer:room.gameTimer, exitPos:room.exitPos,
    gasClouds:room.gasClouds.map(g=>({
      x:g.x, y:g.y, progress:1-(g.expiresAt-now)/GAS_DURATION
    })),
    players:Object.values(room.players).map(p=>({
      id:p.id, name:p.name,
      x:Math.round(p.x), y:Math.round(p.y),
      isIt:p.isIt, escaped:p.escaped, alive:p.alive,
      gauge:Math.round(p.gauge)
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
    const player = room.players[socket.id];
    if (!player||player.escaped) return;
    const len = Math.hypot(dx,dy);
    player.dx = len>0 ? dx/len : 0;
    player.dy = len>0 ? dy/len : 0;
  });

  socket.on('fart', ({code}) => {
    const room = rooms[code];
    if (!room||room.phase!=='game') return;
    const player = room.players[socket.id];
    if (!player||!player.isIt||player.escaped) return;
    if (player.gauge < GAUGE_COST) return;
    player.gauge -= GAUGE_COST;
    room.gasClouds.push({
      x:player.x, y:player.y,
      ownerId:player.id, ownerName:player.name,
      expiresAt:Date.now()+GAS_DURATION
    });
    broadcastGameState(room);
  });

  socket.on('playAgain', ({code}) => {
    const room = rooms[code];
    if (!room||room.host!==socket.id) return;
    room.phase='lobby'; room.gasClouds=[];
    Object.values(room.players).forEach(p=>{
      p.isIt=false; p.escaped=false; p.alive=true; p.dx=0; p.dy=0; p.gauge=GAUGE_MAX;
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
        if (room.phase==='lobby') io.to(room.code).emit('lobbyState', getLobbyState(room));
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

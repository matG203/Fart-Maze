const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const MAZE_COLS = 21;          // must be odd
const MAZE_ROWS = 21;          // must be odd
const CELL_SIZE = 40;          // pixels per cell
const PLAYER_SPEED = 3;        // pixels per tick
const TICK_MS = 50;            // server tick rate (20/s)
const TAG_RADIUS = 18;         // pixels — how close to fart-tag someone
const ESCAPE_ZONE_RADIUS = 30; // pixels around exit
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const GAME_DURATION = 180;     // 3 minutes in seconds

// ─── Maze Generation (recursive backtracker) ─────────────────────────────────
function generateMaze(cols, rows) {
  // Grid of cells: 0 = wall, 1 = passage
  const grid = Array.from({ length: rows }, () => Array(cols).fill(0));

  function carve(x, y) {
    const dirs = shuffle([[0,-2],[0,2],[-2,0],[2,0]]);
    grid[y][x] = 1;
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && grid[ny][nx] === 0) {
        grid[y + dy/2][x + dx/2] = 1;
        carve(nx, ny);
      }
    }
  }

  carve(1, 1);

  // Carve the center room (3x3) for the chaser start
  const cx = Math.floor(cols / 2);
  const cy = Math.floor(rows / 2);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      grid[cy+dy][cx+dx] = 1;

  // Carve exits at edges
  grid[0][1] = 1;                    // top exit
  grid[rows-1][cols-2] = 1;          // bottom exit

  return grid;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Find all open cells away from center
function getSpawnPoints(maze, count) {
  const cx = Math.floor(MAZE_COLS / 2);
  const cy = Math.floor(MAZE_ROWS / 2);
  const cells = [];
  for (let r = 0; r < MAZE_ROWS; r++) {
    for (let c = 0; c < MAZE_COLS; c++) {
      if (maze[r][c] === 1) {
        const dist = Math.abs(c - cx) + Math.abs(r - cy);
        if (dist > 6) cells.push({ c, r });
      }
    }
  }
  shuffle(cells);
  return cells.slice(0, count).map(({ c, r }) => ({
    x: c * CELL_SIZE + CELL_SIZE / 2,
    y: r * CELL_SIZE + CELL_SIZE / 2
  }));
}

function cellToPixel(col, row) {
  return { x: col * CELL_SIZE + CELL_SIZE / 2, y: row * CELL_SIZE + CELL_SIZE / 2 };
}

// ─── Collision ────────────────────────────────────────────────────────────────
function isWall(maze, px, py, radius = 10) {
  // Check corners of the player bounding box
  const r = radius;
  const points = [
    [px - r, py - r], [px + r, py - r],
    [px - r, py + r], [px + r, py + r]
  ];
  for (const [x, y] of points) {
    const col = Math.floor(x / CELL_SIZE);
    const row = Math.floor(y / CELL_SIZE);
    if (row < 0 || row >= MAZE_ROWS || col < 0 || col >= MAZE_COLS) return true;
    if (maze[row][col] === 0) return true;
  }
  return false;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ─── Room Storage ─────────────────────────────────────────────────────────────
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function createRoom(hostId, hostName) {
  let code;
  do { code = genCode(); } while (rooms[code]);
  rooms[code] = {
    code, host: hostId,
    phase: 'lobby',   // lobby | game | ended
    players: {
      [hostId]: { id: hostId, name: hostName, x: 0, y: 0, dx: 0, dy: 0, isIt: false, escaped: false, alive: true }
    },
    maze: null,
    gameTimer: GAME_DURATION,
    tickInterval: null,
    exitPos: null
  };
  return rooms[code];
}

// ─── Game Logic ───────────────────────────────────────────────────────────────
function startGame(room) {
  room.phase = 'game';
  room.maze = generateMaze(MAZE_COLS, MAZE_ROWS);

  // Exit position (bottom passage)
  room.exitPos = cellToPixel(MAZE_COLS - 2, MAZE_ROWS - 1);

  const playerIds = Object.keys(room.players);
  shuffle(playerIds);

  // First player is the chaser (starts in center)
  const cx = Math.floor(MAZE_COLS / 2);
  const cy = Math.floor(MAZE_ROWS / 2);
  const center = cellToPixel(cx, cy);

  const spawnPoints = getSpawnPoints(room.maze, playerIds.length - 1);

  playerIds.forEach((id, i) => {
    const p = room.players[id];
    p.isIt = i === 0;
    p.escaped = false;
    p.alive = true;
    p.dx = 0; p.dy = 0;
    if (i === 0) {
      p.x = center.x; p.y = center.y;
    } else {
      const sp = spawnPoints[i - 1] || center;
      p.x = sp.x; p.y = sp.y;
    }
  });

  room.gameTimer = GAME_DURATION;
  startTick(room);
  broadcastGameState(room);
}

function startTick(room) {
  let secondCounter = 0;
  room.tickInterval = setInterval(() => {
    if (room.phase !== 'game') { clearInterval(room.tickInterval); return; }

    const maze = room.maze;
    const players = Object.values(room.players);

    // Move players
    players.forEach(p => {
      if (!p.alive || p.escaped) return;
      let nx = p.x + p.dx * PLAYER_SPEED;
      let ny = p.y + p.dy * PLAYER_SPEED;
      // Try X movement
      if (!isWall(maze, nx, p.y)) p.x = nx;
      // Try Y movement
      if (!isWall(maze, p.x, ny)) p.y = ny;
    });

    // Check tagging
    const chasers = players.filter(p => p.isIt && !p.escaped && p.alive);
    const runners = players.filter(p => !p.isIt && !p.escaped && p.alive);

    chasers.forEach(chaser => {
      runners.forEach(runner => {
        if (dist(chaser, runner) < TAG_RADIUS) {
          runner.isIt = true;
          io.to(room.code).emit('farted', {
            chaserId: chaser.id,
            victimId: runner.id,
            chaserName: chaser.name,
            victimName: runner.name
          });
        }
      });
    });

    // Check escapes
    players.forEach(p => {
      if (!p.isIt && !p.escaped && p.alive) {
        if (dist(p, room.exitPos) < ESCAPE_ZONE_RADIUS) {
          p.escaped = true;
          io.to(room.code).emit('playerEscaped', { id: p.id, name: p.name });
        }
      }
    });

    // Timer
    secondCounter += TICK_MS;
    if (secondCounter >= 1000) {
      secondCounter = 0;
      room.gameTimer = Math.max(0, room.gameTimer - 1);
    }

    // Check end conditions
    const activeRunners = players.filter(p => !p.isIt && !p.escaped && p.alive);
    const escapedRunners = players.filter(p => p.escaped);
    const allCaught = activeRunners.length === 0 && escapedRunners.length === 0;
    const timeUp = room.gameTimer <= 0;

    if (allCaught || timeUp) {
      endGame(room, escapedRunners.length > 0 || timeUp ? 'runners' : 'chasers');
      return;
    }

    broadcastGameState(room);
  }, TICK_MS);
}

function endGame(room, winners) {
  room.phase = 'ended';
  if (room.tickInterval) clearInterval(room.tickInterval);
  const escaped = Object.values(room.players).filter(p => p.escaped).map(p => p.name);
  const caught = Object.values(room.players).filter(p => p.isIt && !p.escaped).map(p => p.name);
  io.to(room.code).emit('gameEnded', { winners, escaped, caught });
}

function broadcastGameState(room) {
  const state = {
    phase: room.phase,
    code: room.code,
    host: room.host,
    gameTimer: room.gameTimer,
    exitPos: room.exitPos,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name,
      x: Math.round(p.x), y: Math.round(p.y),
      isIt: p.isIt, escaped: p.escaped, alive: p.alive
    }))
  };
  // Send maze only once at start (it's big)
  io.to(room.code).emit('gameState', state);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('createRoom', ({ name }) => {
    if (!name?.trim()) return socket.emit('err', 'Name required');
    const room = createRoom(socket.id, name.trim().slice(0, 20));
    socket.join(room.code);
    socket.emit('roomCreated', { code: room.code });
    socket.emit('lobbyState', getLobbyState(room));
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit('err', 'Room not found');
    if (room.phase !== 'lobby') return socket.emit('err', 'Game already started');
    if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('err', 'Room is full');
    if (!name?.trim()) return socket.emit('err', 'Name required');

    room.players[socket.id] = {
      id: socket.id, name: name.trim().slice(0, 20),
      x: 0, y: 0, dx: 0, dy: 0, isIt: false, escaped: false, alive: true
    };
    socket.join(code.toUpperCase());
    io.to(room.code).emit('lobbyState', getLobbyState(room));
  });

  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('err', 'Room not found');
    if (room.host !== socket.id) return socket.emit('err', 'Only host can start');
    if (room.phase !== 'lobby') return socket.emit('err', 'Already started');
    if (Object.keys(room.players).length < MIN_PLAYERS) return socket.emit('err', `Need at least ${MIN_PLAYERS} players`);

    // Send maze before starting
    const maze = generateMaze(MAZE_COLS, MAZE_ROWS);
    room.maze = maze;
    io.to(room.code).emit('mazeData', { maze, cellSize: CELL_SIZE, cols: MAZE_COLS, rows: MAZE_ROWS });

    setTimeout(() => startGame(room), 500);
  });

  socket.on('input', ({ code, dx, dy }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'game') return;
    const player = room.players[socket.id];
    if (!player || player.escaped) return;
    // Normalise diagonal movement
    const len = Math.hypot(dx, dy);
    player.dx = len > 0 ? dx / len : 0;
    player.dy = len > 0 ? dy / len : 0;
  });

  socket.on('playAgain', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.phase = 'lobby';
    Object.values(room.players).forEach(p => {
      p.isIt = false; p.escaped = false; p.alive = true; p.dx = 0; p.dy = 0;
    });
    room.maze = null;
    io.to(room.code).emit('lobbyState', getLobbyState(room));
  });

  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (!room.players[socket.id]) continue;
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) {
        if (room.tickInterval) clearInterval(room.tickInterval);
        delete rooms[code];
      } else {
        if (room.host === socket.id) room.host = Object.keys(room.players)[0];
        if (room.phase === 'lobby') io.to(room.code).emit('lobbyState', getLobbyState(room));
      }
      break;
    }
  });
});

function getLobbyState(room) {
  return {
    code: room.code,
    host: room.host,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name }))
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Fart Maze running on http://localhost:${PORT}`));

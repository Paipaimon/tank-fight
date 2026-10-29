'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const ROOT = __dirname;
const C = require('./config.js'), N = C.network;
const COLORS = ['#c1dd67', '#70c5e5', '#e3b66c', '#be9ee8'];
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/game.js', ['game.js', 'text/javascript; charset=utf-8']],
  ['/engine.js', ['engine.js', 'text/javascript; charset=utf-8']],
  ['/network.js', ['network.js', 'text/javascript; charset=utf-8']],
  ['/touch.js', ['touch.js', 'text/javascript; charset=utf-8']],
  ['/config.js', ['config.js', 'text/javascript; charset=utf-8']],
]);

/** All gameplay is simulated here; clients only send controls. */
function createGameServer(options = {}) {
  const engine = options.engine || require('./engine.js');
  const rooms = new Map();
  const disconnectGraceMs = options.disconnectGraceMs ?? N.disconnectGraceMs;
  const roomLifetimeMs = options.roomLifetimeMs ?? N.roomLifetimeMs;
  const inputTimeoutMs = options.inputTimeoutMs ?? N.inputTimeoutMs;
  const maxRooms = options.maxRooms ?? N.maxRooms;
  let simulationTimer;
  let broadcastTimer;

  function json(res, status, value) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(value == null ? undefined : JSON.stringify(value));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        req.resume();
        return reject(Object.assign(new Error('请使用 JSON 请求。'), {status: 415}));
      }
      let data = '';
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > N.bodyLimit) {
          reject(Object.assign(new Error('请求内容过长。'), {status: 413}));
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        if (size > 2048) return;
        try {
          const parsed = JSON.parse(data);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          resolve(parsed);
        } catch {
          reject(Object.assign(new Error('JSON 格式不正确。'), {status: 400}));
        }
      });
      req.on('error', reject);
    });
  }

  function cleanName(value) {
    const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    return Array.from(name || '坦克指挥官').slice(0, C.nameLength).join('');
  }

  function addPlayer(room, name, vehicle) {
    if (room.players.size >= C.maxPlayers) throw Object.assign(new Error('房间已满，最多支持 4 位玩家。'), {status: 409});
    const id = crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    const usedColors = new Set([...room.players.values()].map(p => p.color));
    const color = COLORS.find(c => !usedColors.has(c)) || COLORS[0];
    const player = {id, token, name: cleanName(name), color, stream: null,
      disconnectedAt: Date.now(), lastInputAt: 0, lastInputSeq: -1, terrainRevision: -1, protocol: 1,
      input: {x: 0, y: 0, angle: 0, shoot: false}};
    const tank = engine.addPlayer(room.game, {id, name: player.name, color, vehicle});
    player.vehicle = tank.vehicle;
    room.players.set(id, player);
    room.lastOccupiedAt = Date.now();
    return {roomCode: room.code, playerId: id, token};
  }

  function authenticate(room, id, token) {
    const player = typeof id === 'string' && room.players.get(id);
    if (!player || typeof token !== 'string' || token !== player.token) {
      throw Object.assign(new Error('玩家身份已失效，请重新加入房间。'), {status: 403});
    }
    return player;
  }

  function removePlayer(room, player) {
    room.players.delete(player.id);
    engine.removePlayer(room.game, player.id);
    if (player.stream) player.stream.end();
    room.lastOccupiedAt = Date.now();
  }

  function snapshot(room, optimized = false) {
    const state = engine.snapshot(room.game, {walls: !optimized});
    if (optimized) state.events = state.events.filter(e => Number(e.id.slice(2)) > room.lastEventSerial);
    return {...state, protocol: optimized ? 2 : 1, frame: room.frame,
      roomCode: room.code,
      onlineCount: room.players.size,
      acks: Object.fromEntries([...room.players.values()].map(p => [p.id,p.appliedSeq ?? -1])),
      players: [...room.players.values()].map(({id, name, color, vehicle}) => ({id, name, color, vehicle}))};
  }

  const encode = state => `data: ${JSON.stringify(state, (key, value) => typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * N.precision) / N.precision : value)}\n\n`;

  function writeFrame(room) {
    if (![...room.players.values()].some(p => p.stream)) return;
    room.frame++;
    const state = snapshot(room, true);
    // Serialize once per room. Terrain only travels when joining or when a wall changes.
    const delta = encode(state);
    let full, legacy, modern, patched;
    const previous = room.terrain;
    let patch;
    if (previous && previous.round === room.game.round && previous.revision !== room.game.terrainRevision) {
      const current = new Map(room.game.walls.map(w => [w.id,w]));
      patch = {base: previous.revision, removed: [...previous.walls.keys()].filter(id => !current.has(id)),
        upserts: room.game.walls.filter(w => !previous.walls.has(w.id) || previous.walls.get(w.id).hp !== w.hp)};
    }
    for (const player of room.players.values()) {
      if (!player.stream) continue;
      if (player.stream.writableLength > 0) {
        player.blockedAt ||= Date.now();
        if (Date.now() - player.blockedAt > N.slowClientMs) player.stream.destroy();
        continue;
      }
      player.blockedAt = 0;
      if (player.protocol === 1) {
        legacy ||= encode(snapshot(room)); player.stream.write(legacy); continue;
      }
      if (player.terrainRevision !== room.game.terrainRevision) {
        if (player.protocol === 3 && patch && player.terrainRevision === patch.base) {
          patched ||= encode({...state,protocol:3,terrainPatch:patch}); player.stream.write(patched);
        } else {
          full ||= encode({...state,walls:room.game.walls}); player.stream.write(full);
        }
        player.terrainRevision = room.game.terrainRevision;
      } else if (player.protocol === 3) {
        modern ||= encode({...state,protocol:3}); player.stream.write(modern);
      } else player.stream.write(delta);
    }
    if (!previous || previous.revision !== room.game.terrainRevision) room.terrain = {
      round:room.game.round,revision:room.game.terrainRevision,
      walls:new Map(room.game.walls.map(w => [w.id,{...w}]))
    };
    room.lastEventSerial = Number(room.game.events.at(-1)?.id.slice(2)) || room.lastEventSerial;
  }

  const server = http.createServer(async (req, res) => {
    // Players authenticate with room tokens, not browser cookies. Allow the
    // frontend to run on another domain and permit JSON request preflights.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, {ok: true});

      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readBody(req);
        if (rooms.size >= maxRooms) return json(res, 503, {error: '服务器房间已满，请稍后再试。'});
        let code;
        do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
        const room = {code, game: engine.createGame({seed: crypto.randomInt(1, 2147483647), multiplayer: true}),
          players: new Map(), lastOccupiedAt: Date.now(), frame: 0, lastEventSerial: 0};
        rooms.set(code, room);
        return json(res, 201, addPlayer(room, body.name, body.vehicle));
      }

      const match = /^\/api\/rooms\/([a-zA-Z0-9]{6})\/(join|events|input|leave)$/.exec(url.pathname);
      if (match) {
        const room = rooms.get(match[1].toUpperCase());
        if (!room) return json(res, 404, {error: '找不到这个房间，请检查房间码。'});
        const action = match[2];
        if (req.method === 'GET' && action === 'events') {
          const player = authenticate(room, url.searchParams.get('playerId'), url.searchParams.get('token'));
          if (player.stream) player.stream.end();
          player.stream = res;
          player.disconnectedAt = null;
          player.protocol = ['2','3'].includes(url.searchParams.get('v')) ? Number(url.searchParams.get('v')) : 1;
          player.terrainRevision = room.game.terrainRevision;
          player.blockedAt = 0;
          req.socket.setNoDelay(true);
          res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
            'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff'});
          res.write(`retry: ${N.sseRetryMs}\n\n`);
          res.write(encode({...snapshot(room, player.protocol >= 2), walls: room.game.walls}));
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, N.heartbeatMs);
          heartbeat.unref();
          res.on('close', () => {
            clearInterval(heartbeat);
            if (player.stream === res) {
              player.stream = null;
              player.disconnectedAt = Date.now();
              player.input = {...player.input, x: 0, y: 0, shoot: false};
              engine.setInput(room.game, player.id, player.input);
            }
          });
          return;
        }
        if (req.method !== 'POST' || action === 'events') return json(res, 405, {error: '请求方法不支持。'});
        const body = await readBody(req);
        if (action === 'join') return json(res, 201, addPlayer(room, body.name, body.vehicle));
        const player = authenticate(room, body.playerId, body.token);
        if (action === 'leave') {
          removePlayer(room, player);
          return json(res, 204);
        }
        if (body.round !== undefined && body.round !== room.game.round) return json(res, 204);
        const input = body.input;
        if (!input || typeof input !== 'object' || !Number.isFinite(input.x) ||
          !Number.isFinite(input.y) || !Number.isFinite(input.angle) || typeof input.shoot !== 'boolean') {
          return json(res, 400, {error: '控制输入格式不正确。'});
        }
        if (body.seq !== undefined) {
          if (!Number.isSafeInteger(body.seq) || body.seq < 0) return json(res, 400, {error: '操作序号无效。'});
          if (body.seq <= player.lastInputSeq) return json(res, 204);
          player.lastInputSeq = body.seq;
        }
        player.input = {x: Math.max(-1, Math.min(1, input.x)), y: Math.max(-1, Math.min(1, input.y)),
          angle: input.angle % (Math.PI * 2), shoot: input.shoot};
        player.lastInputAt = Date.now();
        engine.setInput(room.game, player.id, player.input);
        return json(res, 204);
      }

      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const file = STATIC_FILES.get(url.pathname);
      if (!file || !['GET', 'HEAD'].includes(req.method)) return json(res, 404, {error: '页面不存在。'});
      fs.stat(path.join(ROOT, file[0]), (error, stat) => {
        if (error || !stat.isFile()) return json(res, 404, {error: '页面尚未就绪。'});
        res.writeHead(200, {'Content-Type': file[1], 'Content-Length': stat.size,
          'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'});
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(path.join(ROOT, file[0]));
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      });
    } catch (error) {
      if (!error.status) console.error('Request error:', error.message);
      json(res, error.status || 500, {error: error.status ? error.message : '服务器暂时无法处理请求。'});
    }
  });

  server.on('connection', socket => socket.setNoDelay(true));
  server.on('listening', () => {
    let previousTick = performance.now(), accumulator = 0;
    simulationTimer = setInterval(() => {
      const tickNow = performance.now();
      accumulator += Math.min(N.maxCatchupSeconds, (tickNow - previousTick) / 1000); previousTick = tickNow;
      const steps = Math.min(N.maxCatchupSteps, Math.floor(accumulator * N.simulationHz)); accumulator -= steps / N.simulationHz;
      const now = Date.now();
      for (const [code, room] of rooms) {
        for (const player of room.players.values()) {
          if (!player.stream && now - player.disconnectedAt > disconnectGraceMs) {
            removePlayer(room, player);
          } else if (now - player.lastInputAt > inputTimeoutMs && (player.input.x || player.input.y || player.input.shoot)) {
            player.input = {...player.input, x: 0, y: 0, shoot: false};
            engine.setInput(room.game, player.id, player.input);
          }
        }
        if (room.players.size) {
          for (let tick = 0; tick < steps; tick++) {
            const round = room.game.round;
            engine.step(room.game, 1 / N.simulationHz);
            for (const player of room.players.values()) {
              if (round !== room.game.round) player.input = {x:0,y:0,angle:-Math.PI/2,shoot:false};
              player.appliedSeq = player.lastInputSeq;
            }
          }
          room.lastOccupiedAt = now;
        } else if (now - room.lastOccupiedAt > roomLifetimeMs) rooms.delete(code);
      }
    }, 1000 / N.simulationHz);
    broadcastTimer = setInterval(() => { for (const room of rooms.values()) writeFrame(room); }, 1000 / N.broadcastHz);
    simulationTimer.unref();
    broadcastTimer.unref();
  });
  server.on('close', () => { clearInterval(simulationTimer); clearInterval(broadcastTimer); });
  server.shutdown = callback => {
    clearInterval(simulationTimer);
    clearInterval(broadcastTimer);
    for (const room of rooms.values()) for (const player of room.players.values()) player.stream?.end();
    server.close(callback);
    server.closeAllConnections();
  };
  server.requestTimeout = N.serverRequestTimeoutMs;
  server.headersTimeout = N.serverRequestTimeoutMs;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || C.port;
  const server = createGameServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n  TANK FIELD · 装甲前线\n  本机打开：http://localhost:${port}\n`);
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const item of entries || []) {
        if (item.family === 'IPv4' && !item.internal) console.log(`  局域网好友打开：http://${item.address}:${port}`);
      }
    }
    console.log('\n  创建房间后，把六位房间码发给好友。按 Ctrl+C 关闭服务。\n');
  });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请更换 PORT 或关闭旧服务。` : error.message);
    process.exitCode = 1;
  });
  process.on('SIGINT', () => server.shutdown(() => process.exit(0)));
  process.on('SIGTERM', () => server.shutdown(() => process.exit(0)));
}

module.exports = {createGameServer};

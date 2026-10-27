(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TankEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const WIDTH = 1280, HEIGHT = 800, TILE = 40, RADIUS = 16;
  const COLORS = ['#d4e383', '#75cfcd', '#e7b377', '#b3a1e7'];
  const TYPES = ['repair', 'shield', 'rapid', 'spread', 'speed'];
  const THEMES = ['遗落前哨', '沙丘防线', '静默林地', '钢铁废墟', '河谷要塞'];
  const VEHICLES = Object.freeze({
    vanguard: Object.freeze({ id: 'vanguard', name: '先锋', label: '均衡主战', code: 'VANGUARD / M01', hp: 100, speed: 175, damage: 25, reload: 0.29, bulletSpeed: 620, barrels: 1, color: '#d3ee89', description: '装甲、机动与火力的可靠平衡。' }),
    scout: Object.freeze({ id: 'scout', name: '游隼', label: '轻型侦察', code: 'FALCON / L02', hp: 75, speed: 235, damage: 18, reload: 0.22, bulletSpeed: 720, barrels: 1, color: '#85d5e7', description: '高速游走，快速连射，适合侧翼突袭。' }),
    heavy: Object.freeze({ id: 'heavy', name: '堡垒', label: '重装坦克', code: 'BASTION / H03', hp: 170, speed: 125, damage: 45, reload: 0.60, bulletSpeed: 540, barrels: 1, color: '#e9bd7f', description: '厚重装甲与大口径重炮，稳步推进。' }),
    striker: Object.freeze({ id: 'striker', name: '雷鸣', label: '散射突击', code: 'THUNDER / S04', hp: 90, speed: 160, damage: 15, reload: 0.47, bulletSpeed: 590, barrels: 3, color: '#c2a6ed', description: '自带三联散射，近距离压制成群敌军。' })
  });
  function vehicle(id) { return Object.hasOwn(VEHICLES, id) ? VEHICLES[id] : VEHICLES.vanguard; }
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

  function random(seed) {
    let state = seed >>> 0;
    return function () {
      state += 0x6D2B79F5;
      let n = state;
      n = Math.imul(n ^ n >>> 15, n | 1);
      n ^= n + Math.imul(n ^ n >>> 7, n | 61);
      return ((n ^ n >>> 14) >>> 0) / 4294967296;
    };
  }
  function id(game, prefix) { return prefix + (++game._serial); }
  function event(game, type, data) {
    game.events.push(Object.assign({ id: id(game, 'ev'), time: game.time, type }, data));
    if (game.events.length > 40) game.events.splice(0, game.events.length - 40);
  }
  function effect(game, x, y, type, color, life = 0.4) {
    game.effects.push({ id: id(game, 'fx'), x, y, type, color, life, maxLife: life });
  }
  function circleRect(x, y, radius, wall) {
    return (x - clamp(x, wall.x, wall.x + wall.w)) ** 2 +
      (y - clamp(y, wall.y, wall.y + wall.h)) ** 2 < radius ** 2;
  }
  function blocked(game, x, y, radius = RADIUS) {
    if (x < radius || y < radius || x > WIDTH - radius || y > HEIGHT - radius) return true;
    return nearbyWalls(game, x, y, radius).some(w => w.type !== 'bush' && circleRect(x, y, radius, w));
  }
  function occupied(game, x, y, except) {
    return blocked(game, x, y) || game.tanks.some(t => t.id !== except?.id && t.alive && (t.x - x) ** 2 + (t.y - y) ** 2 < (RADIUS * 1.8) ** 2);
  }
  function indexWalls(game) {
    game._wallBuckets = Array.from({ length: 640 }, () => []);
    for (const wall of game.walls) {
      for (let y = Math.max(0, Math.floor(wall.y / TILE)); y <= Math.min(19, Math.floor((wall.y + wall.h - .001) / TILE)); y++)
        for (let x = Math.max(0, Math.floor(wall.x / TILE)); x <= Math.min(31, Math.floor((wall.x + wall.w - .001) / TILE)); x++) game._wallBuckets[y * 32 + x].push(wall);
    }
    game._indexedWalls = game.walls; game._indexedWallCount = game.walls.length;
  }
  function nearbyWalls(game, x, y, radius) {
    if (game._indexedWalls !== game.walls || game._indexedWallCount !== game.walls.length) indexWalls(game);
    const result = [];
    for (let row = Math.max(0, Math.floor((y - radius) / TILE)); row <= Math.min(19, Math.floor((y + radius) / TILE)); row++)
      for (let col = Math.max(0, Math.floor((x - radius) / TILE)); col <= Math.min(31, Math.floor((x + radius) / TILE)); col++)
        for (const wall of game._wallBuckets[row * 32 + col]) if (!result.includes(wall)) result.push(wall);
    return result;
  }
  // Shared by server physics and browser prediction; prediction never resolves damage.
  function movePlayer(game, tank, input, dt) {
    if (!tank.alive || game.phase !== 'playing') return tank;
    let x = clamp(finite(input.x), -1, 1), y = clamp(finite(input.y), -1, 1);
    const length = Math.max(1, Math.hypot(x, y)); x /= length; y /= length;
    const speed = vehicle(tank.vehicle).speed * (tank.buffs.speed > game.time ? 260 / 175 : 1);
    const steps = Math.max(1, Math.ceil(clamp(dt, 0, .2) * 60));
    const dx = x * speed * clamp(dt, 0, .2) / steps, dy = y * speed * clamp(dt, 0, .2) / steps;
    if (x || y) tank.bodyAngle = Math.atan2(y, x);
    for (let i = 0; i < steps; i++) {
      if (!occupied(game, tank.x + dx, tank.y, tank)) tank.x += dx;
      if (!occupied(game, tank.x, tank.y + dy, tank)) tank.y += dy;
    }
    tank.angle = finite(input.angle, tank.angle);
    return tank;
  }
  function blankBuffs() { return { shield: 0, rapid: 0, spread: 0, speed: 0 }; }
  function refreshGrid(game) {
    game._grid = new Uint8Array(32 * 20);
    for (const w of game.walls) {
      if (w.type === 'bush') continue;
      const x = Math.floor(w.x / TILE), y = Math.floor(w.y / TILE);
      if (x >= 0 && x < 32 && y >= 0 && y < 20) game._grid[y * 32 + x] = 1;
    }
    game._gridRevision++;
    indexWalls(game);
  }
  function reachable(game, start = { x: 220, y: 700 }) {
    const seen = new Set(), queue = [Math.floor(start.y / TILE) * 32 + Math.floor(start.x / TILE)];
    seen.add(queue[0]);
    for (let i = 0; i < queue.length; i++) {
      const cell = queue[i], x = cell % 32, y = Math.floor(cell / 32);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, next = ny * 32 + nx;
        if (nx < 1 || nx > 30 || ny < 1 || ny > 18 || game._grid[next] || seen.has(next)) continue;
        seen.add(next); queue.push(next);
      }
    }
    return queue;
  }
  function freePosition(game, zone = 'any') {
    const cells = reachable(game).filter(cell => {
      const y = Math.floor(cell / 32);
      return zone === 'top' ? y <= 3 : zone === 'bottom' ? y >= 16 : y > 3 && y < 16;
    });
    for (let i = 0; i < 120; i++) {
      const cell = cells[Math.floor(game._rng() * cells.length)];
      if (cell === undefined) break;
      const pos = { x: (cell % 32) * TILE + TILE / 2, y: Math.floor(cell / 32) * TILE + TILE / 2 };
      if (!occupied(game, pos.x, pos.y) && !game.pickups.some(p => dist2(p, pos) < 1600)) return pos;
    }
    return { x: zone === 'top' ? 620 : 220, y: zone === 'top' ? 100 : 700 };
  }
  function pickup(game, type, position) {
    const pos = position || freePosition(game);
    game.pickups.push({ id: id(game, 'item'), x: pos.x, y: pos.y, type: type || TYPES[Math.floor(game._rng() * TYPES.length)] });
  }
  function spawnTank(game, options) {
    return Object.assign({ id: id(game, 'tank'), name: '突击兵', x: 0, y: 0, angle: -Math.PI / 2, bodyAngle: -Math.PI / 2,
      hp: 100, maxHp: 100, team: 'player', color: COLORS[0], kills: 0, deaths: 0, alive: true, vx: 0, vy: 0,
      respawnAt: 0, buffs: blankBuffs(), invulnerableUntil: game.time + 2,
      _cooldown: 0, _path: [], _repathAt: 0, _pathRevision: -1 }, options);
  }
  function makeWave(game) {
    game.mapName = THEMES[(game.wave - 1) % THEMES.length];
    game.mapSeed = (game.seed + Math.imul(game.wave, 2654435761)) >>> 0;
    game.terrainRevision++;
    game._rng = random(game.mapSeed);
    game.walls = []; game.bullets = []; game.pickups = []; game.effects = [];
    game.phase = 'playing'; game.nextWaveAt = 0;
    const protectedCell = (x, y) => y <= 3 || y >= 16 || y === 9 || y === 10 || x === 5 || x === 6 || x === 15 || x === 16 || x === 25 || x === 26;
    const types = ['brick', 'brick', 'steel', 'water', 'bush'];
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 32; x++) {
        const border = x === 0 || y === 0 || x === 31 || y === 19;
        if (!border) continue;
        game.walls.push({ id: id(game, 'wall'), x: x * TILE, y: y * TILE, w: TILE, h: TILE, type: 'steel', hp: 999 });
      }
    }
    const used = new Set();
    for (let cluster = 0; cluster < 40; cluster++) {
      const sx = 2 + Math.floor(game._rng() * 27), sy = 4 + Math.floor(game._rng() * 11);
      const cw = 1 + Math.floor(game._rng() * 3), ch = 1 + Math.floor(game._rng() * 3);
      const type = types[Math.floor(game._rng() * types.length)];
      for (let y = sy; y < Math.min(sy + ch, 16); y++) for (let x = sx; x < Math.min(sx + cw, 30); x++) {
        if (protectedCell(x, y) || used.has(y * 32 + x)) continue;
        used.add(y * 32 + x);
        game.walls.push({ id: id(game, 'wall'), x: x * TILE, y: y * TILE, w: TILE, h: TILE, type, hp: type === 'brick' ? 60 : 999 });
      }
    }
    refreshGrid(game);
    game.tanks = game.tanks.filter(t => t.team === 'player');
    game.tanks.forEach((tank, index) => {
      tank.x = [220, 500, 820, 1100][index % 4]; tank.y = 700;
      tank.alive = true; tank.hp = tank.maxHp; tank.buffs = blankBuffs(); tank.invulnerableUntil = game.time + 3;
      tank.angle = tank.bodyAngle = -Math.PI / 2; tank._cooldown = 0; tank.respawnAt = 0;
      tank.vx = tank.vy = 0;
    });
    const enemyCount = Math.min(4 + Math.floor(game.wave * 0.8) + Math.max(0, game.tanks.length - 1) * 2, 16);
    for (let i = 0; i < enemyCount; i++) {
      const pos = freePosition(game, 'top');
      const hp = Math.min(50 + Math.floor((game.wave - 1) / 3) * 10, 110);
      game.tanks.push(spawnTank(game, { ...pos, id: id(game, 'enemy'), name: i % 3 === 0 ? '重装守卫' : '巡逻坦克', team: 'enemy',
        color: i % 3 === 0 ? '#da9b6b' : '#d97d6a', hp, maxHp: hp, angle: Math.PI / 2, bodyAngle: Math.PI / 2,
        invulnerableUntil: 0, _cooldown: 1 + game._rng() * 2 }));
    }
    TYPES.forEach(type => pickup(game, type));
    game._nextPickupAt = game.time + 12;
    event(game, 'wave', { wave: game.wave, mapName: game.mapName });
  }
  function createGame(options = {}) {
    const seed = Number.isFinite(options.seed) ? options.seed >>> 0 : Math.floor(Math.random() * 4294967296);
    const game = { width: WIDTH, height: HEIGHT, tileSize: TILE, seed, mapSeed: seed, mapName: '', time: 0, wave: 1,
      phase: 'playing', nextWaveAt: 0, terrainRevision: 0, tanks: [], walls: [], bullets: [], pickups: [], effects: [], events: [],
      difficulty: clamp(finite(options.difficulty, 1), 0.5, 2), _serial: 0, _inputs: Object.create(null),
      _rng: random(seed), _grid: null, _gridRevision: 0, _nextPickupAt: 12 };
    makeWave(game);
    return game;
  }
  function addPlayer(game, options = {}) {
    const playerId = String(options.id || id(game, 'player'));
    const existing = game.tanks.find(t => t.id === playerId);
    if (existing) return existing;
    const players = game.tanks.filter(t => t.team === 'player');
    if (players.length >= 4) return null;
    const index = players.length;
    let pos = { x: [220, 500, 820, 1100][index], y: 700 };
    if (occupied(game, pos.x, pos.y)) pos = freePosition(game, 'bottom');
    const selected = vehicle(options.vehicle);
    const tank = spawnTank(game, { ...pos, id: playerId, name: String(options.name || '指挥官').slice(0, 16), color: options.color || COLORS[index], vehicle: selected.id, hp: selected.hp, maxHp: selected.hp });
    game.tanks.push(tank); game._inputs[playerId] = { x: 0, y: 0, angle: -Math.PI / 2, shoot: false };
    return tank;
  }
  function removePlayer(game, playerId) {
    game.tanks = game.tanks.filter(t => t.id !== playerId);
    delete game._inputs[playerId];
    game.bullets = game.bullets.filter(b => b.ownerId !== playerId);
  }
  function setInput(game, playerId, input = {}) {
    if (!Object.prototype.hasOwnProperty.call(game._inputs, playerId)) return;
    let x = clamp(finite(input.x), -1, 1), y = clamp(finite(input.y), -1, 1);
    const length = Math.hypot(x, y);
    if (length > 1) { x /= length; y /= length; }
    game._inputs[playerId] = { x, y, angle: finite(input.angle, game._inputs[playerId].angle), shoot: input.shoot === true };
  }
  function pathTo(game, tank, target) {
    const sx = clamp(Math.floor(tank.x / TILE), 1, 30), sy = clamp(Math.floor(tank.y / TILE), 1, 18);
    const tx = clamp(Math.floor(target.x / TILE), 1, 30), ty = clamp(Math.floor(target.y / TILE), 1, 18);
    const start = sy * 32 + sx, goal = ty * 32 + tx, queue = [start];
    const previous = new Int32Array(640).fill(-1); previous[start] = start;
    for (let i = 0; i < queue.length && previous[goal] === -1; i++) {
      const current = queue[i], x = current % 32, y = Math.floor(current / 32);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, next = ny * 32 + nx;
        if (nx < 1 || nx > 30 || ny < 1 || ny > 18 || game._grid[next] || previous[next] !== -1) continue;
        previous[next] = current; queue.push(next);
      }
    }
    if (previous[goal] === -1) return [];
    const path = [];
    for (let cell = goal; cell !== start; cell = previous[cell]) path.push({ x: cell % 32 * TILE + 20, y: Math.floor(cell / 32) * TILE + 20 });
    return path.reverse();
  }
  function clearShot(game, a, b) {
    const length = Math.hypot(b.x - a.x, b.y - a.y), count = Math.ceil(length / 18);
    for (let i = 1; i < count; i++) {
      const x = a.x + (b.x - a.x) * i / count, y = a.y + (b.y - a.y) * i / count;
      if (nearbyWalls(game, x, y, 0).some(w => (w.type === 'steel' || w.type === 'brick') && x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h)) return false;
    }
    return true;
  }
  function enemyInput(game, tank) {
    const targets = game.tanks.filter(t => t.team === 'player' && t.alive);
    if (!targets.length) return { x: 0, y: 0, angle: tank.angle, shoot: false };
    targets.sort((a, b) => dist2(tank, a) - dist2(tank, b));
    const target = targets[0], distance = Math.sqrt(dist2(tank, target));
    const angle = Math.atan2(target.y - tank.y, target.x - tank.x);
    if (game.time >= (tank._sightAt || 0) || tank._sightTarget !== target.id || tank._sightRevision !== game._gridRevision) {
      tank._sight = clearShot(game, tank, target); tank._sightAt = game.time + .1;
      tank._sightTarget = target.id; tank._sightRevision = game._gridRevision;
    }
    const sight = tank._sight;
    let x = 0, y = 0;
    if (distance > 230 || !sight) {
      if (tank._repathAt <= game.time || tank._pathRevision !== game._gridRevision) {
        tank._path = pathTo(game, tank, target); tank._repathAt = game.time + 0.6 + game._rng() * 0.3;
        tank._pathRevision = game._gridRevision;
      }
      while (tank._path.length && dist2(tank, tank._path[0]) < 36) tank._path.shift();
      const waypoint = tank._path[0] || target;
      x = waypoint.x - tank.x; y = waypoint.y - tank.y;
      const length = Math.hypot(x, y); if (length) { x /= length; y /= length; }
    }
    return { x, y, angle, shoot: sight && distance < 650 };
  }
  function fire(game, tank) {
    if (tank._cooldown > 0) return;
    const player = tank.team === 'player';
    const spec = vehicle(tank.vehicle);
    tank._cooldown = player ? spec.reload * (tank.buffs.rapid > game.time ? 0.35 : 1) : Math.max(0.7, 1.7 - game.wave * 0.045) / game.difficulty;
    const offsets = player && spec.barrels === 3 ? (tank.buffs.spread > game.time ? [-.28, -.14, 0, .14, .28] : [-.14, 0, .14]) : tank.buffs.spread > game.time ? [-0.19, 0, 0.19] : [0];
    for (const offset of offsets) {
      const angle = tank.angle + offset + (player ? 0 : (game._rng() - 0.5) * 0.08), speed = player ? spec.bulletSpeed : 290;
      game.bullets.push({ id: id(game, 'bullet'), x: tank.x + Math.cos(angle) * 22, y: tank.y + Math.sin(angle) * 22,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, ownerId: tank.id, team: tank.team,
        damage: player ? spec.damage : 14, life: 2.4, color: player ? '#eff3b0' : '#eeaa82' });
    }
    effect(game, tank.x + Math.cos(tank.angle) * 27, tank.y + Math.sin(tank.angle) * 27, 'muzzle', '#ffdfa0', 0.11);
    event(game, 'shot', { tankId: tank.id, x: tank.x, y: tank.y, team: tank.team });
  }
  function damage(game, tank, bullet) {
    if (tank.invulnerableUntil > game.time || tank.buffs.shield > game.time) {
      effect(game, bullet.x, bullet.y, 'shield', '#78d4d3', 0.2); return;
    }
    tank.hp = Math.max(0, tank.hp - bullet.damage);
    effect(game, tank.x, tank.y, 'hit', '#f2c192', 0.2);
    event(game, 'hit', { tankId: tank.id, hp: tank.hp });
    if (tank.hp > 0) return;
    tank.alive = false; tank.deaths++; tank.respawnAt = 0;
    tank.vx = tank.vy = 0;
    const killer = game.tanks.find(t => t.id === bullet.ownerId);
    if (killer) killer.kills++;
    effect(game, tank.x, tank.y, 'explosion', tank.color, 0.8);
    event(game, 'kill', { tankId: tank.id, killerId: bullet.ownerId, name: tank.name, killerName: killer ? killer.name : '', team: tank.team, x: tank.x, y: tank.y });
    if (tank.team === 'enemy' && game._rng() < 0.48 && game.pickups.length < 12) pickup(game, undefined, { x: tank.x, y: tank.y });
  }
  function moveBullets(game, dt) {
    let wallChanged = false;
    for (const bullet of game.bullets) {
      bullet.life -= dt;
      const steps = Math.max(1, Math.ceil(Math.hypot(bullet.vx, bullet.vy) * dt / 5));
      for (let i = 0; i < steps && bullet.life > 0; i++) {
        bullet.x += bullet.vx * dt / steps; bullet.y += bullet.vy * dt / steps;
        if (bullet.x < 0 || bullet.y < 0 || bullet.x > WIDTH || bullet.y > HEIGHT) { bullet.life = 0; break; }
        const wall = nearbyWalls(game, bullet.x, bullet.y, 3).find(w => (w.type === 'brick' || w.type === 'steel') && circleRect(bullet.x, bullet.y, 3, w));
        if (wall) {
          bullet.life = 0; effect(game, bullet.x, bullet.y, 'spark', wall.type === 'brick' ? '#b3a28b' : '#e3cfaa', 0.3);
          if (wall.type === 'brick') { wall.hp -= bullet.damage; game.terrainRevision++; if (wall.hp <= 0) { game.walls.splice(game.walls.indexOf(wall), 1); wallChanged = true; } }
          break;
        }
        const tank = game.tanks.find(t => t.alive && t.team !== bullet.team && (t.x - bullet.x) ** 2 + (t.y - bullet.y) ** 2 < 19 ** 2);
        if (tank) { damage(game, tank, bullet); bullet.life = 0; }
      }
    }
    game.bullets = game.bullets.filter(b => b.life > 0);
    if (wallChanged) refreshGrid(game);
  }
  function collect(game, tank) {
    for (let i = game.pickups.length - 1; i >= 0; i--) {
      const item = game.pickups[i]; if (dist2(item, tank) > 30 ** 2) continue;
      if (item.type === 'repair') tank.hp = Math.min(tank.maxHp, tank.hp + 40);
      else tank.buffs[item.type] = game.time + 5;
      event(game, 'pickup', { tankId: tank.id, pickupType: item.type, x: item.x, y: item.y });
      effect(game, item.x, item.y, 'pickup', '#d4e383', 0.6); game.pickups.splice(i, 1);
    }
  }
  function tick(game, dt) {
    game.time += dt;
    for (const fx of game.effects) fx.life -= dt;
    game.effects = game.effects.filter(fx => fx.life > 0).slice(-100);
    if (game.phase === 'transition' || game.phase === 'retry') {
      if (game.time >= game.nextWaveAt) { if (game.phase === 'transition') game.wave++; makeWave(game); }
      return;
    }
    for (const tank of game.tanks) {
      if (!tank.alive) {
        continue;
      }
      const input = tank.team === 'enemy' ? enemyInput(game, tank) : game._inputs[tank.id];
      if (!input) continue;
      tank.angle = input.angle; tank._cooldown -= dt;
      const oldX = tank.x, oldY = tank.y;
      const speed = tank.team === 'player' ? vehicle(tank.vehicle).speed * (tank.buffs.speed > game.time ? 260 / 175 : 1) : Math.min(72 + game.wave * 2, 110) * game.difficulty;
      const dx = input.x * speed * dt, dy = input.y * speed * dt;
      if (dx || dy) {
        tank.bodyAngle = Math.atan2(dy, dx);
        if (!occupied(game, tank.x + dx, tank.y, tank)) tank.x += dx;
        if (!occupied(game, tank.x, tank.y + dy, tank)) tank.y += dy;
      }
      tank.vx = dt ? (tank.x - oldX) / dt : 0; tank.vy = dt ? (tank.y - oldY) / dt : 0;
      if (input.shoot) fire(game, tank);
      if (tank.team === 'player') collect(game, tank);
    }
    moveBullets(game, dt);
    if (game.time >= game._nextPickupAt) {
      game._nextPickupAt = game.time + 12;
      if (game.pickups.length < 10) pickup(game);
    }
    const players = game.tanks.filter(t => t.team === 'player');
    if (players.length && !players.some(t => t.alive)) {
      game.phase = 'retry'; game.nextWaveAt = game.time + 3; game.bullets = [];
      event(game, 'defeat', {wave: game.wave});
    } else if (players.length && !game.tanks.some(t => t.team === 'enemy' && t.alive)) {
      game.phase = 'transition'; game.nextWaveAt = game.time + 3; game.bullets = [];
      event(game, 'clear', { wave: game.wave });
    }
  }
  function step(game, delta) {
    const dt = clamp(finite(delta), 0, 0.25);
    const count = Math.max(1, Math.ceil(dt / (1 / 60)));
    for (let i = 0; i < count; i++) tick(game, dt / count);
    return game;
  }
  function snapshot(game, options = {}) {
    const result = {};
    for (const [key, value] of Object.entries(game)) if (!key.startsWith('_')) {
      if (key === 'walls' && options.walls === false) continue;
      result[key] = Array.isArray(value) ? value.map(item => {
        const clean = {}; for (const [k, v] of Object.entries(item)) if (!k.startsWith('_')) clean[k] = v && typeof v === 'object' ? { ...v } : v;
        return clean;
      }) : value;
    }
    return result;
  }
  return { createGame, addPlayer, removePlayer, setInput, step, snapshot, movePlayer, vehicle, VEHICLES, WIDTH, HEIGHT, TILE, RADIUS, COLORS, PICKUP_TYPES: TYPES };
});

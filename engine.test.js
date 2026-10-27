'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./engine.js');
const advance = (game, seconds) => { for (let t = 0; t < seconds - 1e-8; t += 1 / 60) E.step(game, 1 / 60); };
function arena() {
  const game = E.createGame({ seed: 123 });
  const player = E.addPlayer(game, { id: 'p1', name: 'Player' });
  game.walls = []; player.x = 500; player.y = 500;
  for (const tank of game.tanks) if (tank.team === 'enemy') { tank.x = 1100; tank.y = 100; tank._cooldown = 999; }
  return { game, player };
}
test('seeded maps repeat and every initial pickup can be reached from spawn', () => {
  for (let seed = 0; seed < 20; seed++) {
    const a = E.createGame({ seed }), b = E.createGame({ seed });
    assert.deepEqual(a.walls, b.walls);
    const blocked = new Set(a.walls.filter(w => w.type !== 'bush').map(w => w.y / 40 * 32 + w.x / 40));
    const seen = new Set([17 * 32 + 5]), queue = [...seen];
    for (let i = 0; i < queue.length; i++) {
      const cell = queue[i], x = cell % 32, y = Math.floor(cell / 32);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, next = ny * 32 + nx;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 19 || seen.has(next) || blocked.has(next)) continue;
        seen.add(next); queue.push(next);
      }
    }
    for (const item of a.pickups) assert.ok(seen.has(Math.floor(item.y / 40) * 32 + Math.floor(item.x / 40)));
    for (const enemy of a.tanks) assert.ok(seen.has(Math.floor(enemy.y / 40) * 32 + Math.floor(enemy.x / 40)));
  }
});
test('diagonal speed is normalized, invalid inputs sanitized, and walls block tanks', () => {
  const { game, player } = arena();
  E.setInput(game, player.id, { x: 1, y: 1, angle: 0, shoot: false });
  advance(game, 0.5);
  assert.ok(Math.abs(Math.hypot(player.x - 500, player.y - 500) - 87.5) < 0.1);
  game.walls = [{ id: 'wall', x: 600, y: 400, w: 40, h: 300, type: 'steel', hp: 999 }];
  player.x = 570; player.y = 500;
  E.setInput(game, player.id, { x: 100, y: NaN, angle: Infinity });
  advance(game, 1);
  assert.ok(player.x <= 584 && player.x >= 580); assert.equal(player.y, 500); assert.ok(Number.isFinite(player.angle));
});
test('bullets damage enemies and bricks without harming teammates', () => {
  const { game, player } = arena();
  const ally = E.addPlayer(game, { id: 'p2' }); ally.x = 560; ally.y = 500;
  const enemy = game.tanks.find(t => t.team === 'enemy'); enemy.x = 650; enemy.y = 500; enemy.hp = 50;
  enemy._path = []; enemy._repathAt = 999;
  E.setInput(game, player.id, { angle: 0, shoot: true }); advance(game, 0.7);
  assert.equal(ally.hp, 100); assert.equal(enemy.alive, false); assert.equal(player.kills, 1);
  game.walls = [{ id: 'brick', x: 600, y: 480, w: 40, h: 40, type: 'brick', hp: 60 }];
  advance(game, 1.1); assert.equal(game.walls.length, 0);
});
test('pickups heal, apply timed effects, and are removed once collected', () => {
  const { game, player } = arena(); player.hp = 30;
  game.pickups = [{ id: 'repair', x: player.x, y: player.y, type: 'repair' }, { id: 'speed', x: player.x, y: player.y, type: 'speed' }];
  E.step(game, 1 / 60);
  assert.equal(player.hp, 70); assert.equal(game.pickups.length, 0); assert.ok(player.buffs.speed > game.time + 4);
  advance(game, 5.1); assert.ok(player.buffs.speed < game.time);
});
test('clear transitions into a new random wave while retaining player identity and kills', () => {
  const { game, player } = arena(); player.kills = 9;
  const seed = game.mapSeed;
  game.tanks.filter(t => t.team === 'enemy').forEach(t => { t.alive = false; });
  E.step(game, 1 / 60); assert.equal(game.phase, 'transition');
  advance(game, 3.1);
  assert.equal(game.wave, 2); assert.equal(game.phase, 'playing'); assert.notEqual(game.mapSeed, seed);
  assert.equal(game.tanks.find(t => t.id === player.id).kills, 9); assert.ok(game.tanks.some(t => t.team === 'enemy' && t.alive));
});
test('a solo wipe restarts the current sector and snapshots contain no private simulation state', () => {
  const { game, player } = arena(); player.alive = false; player.hp = 0; player.respawnAt = 0.1;
  advance(game, 3.2); assert.equal(game.wave, 1); assert.equal(player.alive, true); assert.equal(player.hp, 100); assert.ok(player.invulnerableUntil > game.time);
  const snap = E.snapshot(game), json = JSON.stringify(snap);
  assert.ok(!json.includes('_inputs')); assert.ok(!json.includes('_path')); assert.ok(!json.includes('_rng'));
  snap.tanks.find(t => t.id === player.id).buffs.shield = 100;
  assert.equal(player.buffs.shield, 0);
  E.removePlayer(game, player.id); assert.ok(!game.tanks.some(t => t.id === player.id));
});

test('four vehicles have distinct authoritative armor, speed and weapons', () => {
  for (const spec of Object.values(E.VEHICLES)) {
    const game = E.createGame({seed: 5}); game.walls = []; game.tanks = [];
    const player = E.addPlayer(game, {id: 'driver', vehicle: spec.id});
    player.x = 500; player.y = 500;
    // A distant opponent keeps the arena active without interfering with the shot.
    game.tanks.push({id: 'dummy', team: 'enemy', alive: true, hp: 999, x: 1100, y: 100, buffs: {}, _cooldown: 999, _path: [], _repathAt: 999});
    assert.equal(player.maxHp, spec.hp);
    E.setInput(game, player.id, {x: 1, y: 0, angle: 0, shoot: true});
    E.step(game, 1 / 60);
    assert.ok(Math.abs(player.x - 500 - spec.speed / 60) < .001);
    assert.equal(game.bullets.length, spec.barrels);
    assert.ok(game.bullets.every(b => b.damage === spec.damage && Math.abs(Math.hypot(b.vx, b.vy) - spec.bulletSpeed) < .001));
    const cooldown = player._cooldown;
    assert.ok(Math.abs(cooldown - spec.reload) < .001);
    player.alive = false; player.respawnAt = game.time; player.hp = 0;
    E.step(game, 1 / 60);assert.equal(game.phase,'retry');advance(game,3.1);assert.equal(player.hp,spec.hp);assert.equal(player.vehicle,spec.id);
    game.tanks.filter(t => t.team === 'enemy').forEach(t => t.alive = false);
    E.step(game, 1 / 60); advance(game, 3.1);
    assert.equal(player.vehicle, spec.id); assert.equal(player.hp, spec.hp);
  }
  assert.equal(E.vehicle('__proto__').id, 'vanguard');
});

test('client movement and server movement use the same speed, diagonal normalization and collisions', () => {
  for (const spec of Object.values(E.VEHICLES)) {
    const game = E.createGame({seed: 19}); game.tanks = [];
    const player = E.addPlayer(game, {id: 'driver', vehicle: spec.id});
    player.x = 220; player.y = 700; player.buffs.speed = 10;
    const ghost = {...player, buffs: {...player.buffs}};
    const input = {x: 1, y: -1, angle: 1, shoot: false};
    E.setInput(game, player.id, input);
    // Prevent auto advancement while leaving movement physics intact.
    game.tanks.push({id:'dummy',team:'enemy',alive:true,hp:99,x:1000,y:100,buffs:{},_cooldown:999,_path:[],_repathAt:999});
    for (let i = 0; i < 30; i++) {E.movePlayer(game, ghost, input, 1 / 60); E.step(game, 1 / 60);}
    assert.ok(Math.hypot(ghost.x-player.x,ghost.y-player.y)<.001, spec.id);
  }
});

test('downed teammates wait, a full wipe retries the same map and vehicle loadouts survive the retry',()=>{
  const {game,player}=arena();const ally=E.addPlayer(game,{id:'p2',vehicle:'heavy'});
  const seed=game.mapSeed, wave=game.wave;
  player.alive=false;player.hp=0;advance(game,4);
  assert.equal(player.alive,false);assert.equal(game.phase,'playing');
  ally.alive=false;ally.hp=0;E.step(game,1/60);
  assert.equal(game.phase,'retry');const retryAt=game.nextWaveAt;
  advance(game,2.8);assert.equal(player.alive,false);assert.equal(ally.alive,false);
  advance(game,.3);assert.ok(game.time>=retryAt);assert.equal(game.wave,wave);assert.equal(game.mapSeed,seed);
  assert.equal(player.alive,true);assert.equal(ally.alive,true);assert.equal(ally.hp,170);assert.equal(ally.vehicle,'heavy');
  assert.ok(game.tanks.some(t=>t.team==='enemy'&&t.alive));assert.equal(game.pickups.length,5);
});

test('all timed pickups last exactly five seconds and repair remains immediate',()=>{
  const {game,player}=arena();player.hp=20;
  for(const type of E.PICKUP_TYPES)game.pickups.push({id:type,x:player.x,y:player.y,type});
  E.step(game,1/60);assert.equal(player.hp,60);
  for(const expiry of Object.values(player.buffs))assert.ok(Math.abs(expiry-game.time-5)<.0001);
  advance(game,4.9);for(const expiry of Object.values(player.buffs))assert.ok(expiry>game.time);
  advance(game,.2);for(const expiry of Object.values(player.buffs))assert.ok(expiry<game.time);
});

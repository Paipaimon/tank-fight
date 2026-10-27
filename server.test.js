'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {createGameServer} = require('./server.js');

async function fixture(t, options = {}) {
  const server = createGameServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.shutdown(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body) {
    const response = await fetch(`${base}${route}`, {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, body: response.status === 204 ? null : await response.json()};
  }
  return {base, post};
}

function stream(base, credentials, version = 1, origin) {
  const params = new URLSearchParams({playerId: credentials.playerId, token: credentials.token});
  params.set('v', String(version));
  const frames = [];
  let buffer = '';
  let response;
  let failure;
  const listeners = new Set();
  const request = http.get(`${base}/api/rooms/${credentials.roomCode}/events?${params}`, {headers: origin ? {Origin: origin} : {}}, res => {
    response = res;
    res.setEncoding('utf8');
    res.on('data', text => {
      buffer += text;
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const value = JSON.parse(line.slice(6));
          frames.push(value);
          if (frames.length > 100) frames.shift();
          for (const listener of listeners) listener(value);
        }
      }
    });
    res.on('error', error => { failure = error; });
  });
  request.on('error', error => { failure = error; });
  return {
    frames,
    get headers() { return response?.headers; },
    close() { response?.destroy(); request.destroy(); },
    wait(predicate = () => true, timeout = 2500) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(failure || new Error('Timed out waiting for SSE frame.'));
        }, timeout);
        function listener(value) {
          if (predicate(value)) { clearTimeout(timer); listeners.delete(listener); resolve(value); }
        }
        listeners.add(listener);
      });
    },
  };
}

test('two real HTTP clients share one simulation and cannot control each other', async t => {
  const {base, post} = await fixture(t);
  const created = await post('/api/rooms', {name: 'Alpha'});
  assert.equal(created.status, 201);
  const a = created.body;
  const joined = await post(`/api/rooms/${a.roomCode}/join`, {name: 'Bravo'});
  assert.equal(joined.status, 201);
  const b = joined.body;
  assert.notEqual(a.token, b.token);
  const sa = stream(base, a);
  const sb = stream(base, b);
  t.after(() => { sa.close(); sb.close(); });
  const [firstA, firstB] = await Promise.all([sa.wait(s => s.onlineCount === 2), sb.wait(s => s.onlineCount === 2)]);
  assert.equal(firstA.seed, firstB.seed);
  assert.equal(firstA.roomCode, firstB.roomCode);
  assert.deepEqual(firstA.players.map(p => p.id).sort(), [a.playerId, b.playerId].sort());
  assert.equal(firstA.tanks.filter(p => p.team === 'player').length, 2);
  assert.ok(!JSON.stringify(firstA).includes(a.token), 'credentials must not appear in broadcast snapshots');
  assert.ok(!JSON.stringify(firstA).includes(b.token));
  const forbidden = await post(`/api/rooms/${a.roomCode}/input`, {playerId: b.playerId, token: a.token,
    input: {x: 1, y: 0, angle: 0.91, shoot: true}});
  assert.equal(forbidden.status, 403);
  const valid = await post(`/api/rooms/${a.roomCode}/input`, {...a,
    input: {x: 0, y: 0, angle: 0.91, shoot: true}});
  assert.equal(valid.status, 204);
  const aimed = await sb.wait(s => s.time > firstB.time &&
    Math.abs(s.tanks.find(p => p.id === a.playerId).angle - 0.91) < 0.001);
  assert.equal(aimed.tanks.find(p => p.id === b.playerId).name, 'Bravo');
  const left = await post(`/api/rooms/${a.roomCode}/leave`, b);
  assert.equal(left.status, 204);
  const afterLeave = await sa.wait(s => s.time >= aimed.time && s.onlineCount === 1);
  assert.equal(afterLeave.tanks.some(p => p.id === b.playerId), false);
});

test('room capacity, input validation, cross-origin creation and file allowlist', async t => {
  const {base, post} = await fixture(t);
  const owner = (await post('/api/rooms', {name: '主人'})).body;
  for (let i = 0; i < 3; i++) assert.equal((await post(`/api/rooms/${owner.roomCode}/join`, {name: `P${i}`})).status, 201);
  assert.equal((await post(`/api/rooms/${owner.roomCode}/join`, {name: '第五人'})).status, 409);
  assert.equal((await post('/api/rooms/000000/join', {name: 'Missing'})).status, 404);
  assert.equal((await post(`/api/rooms/${owner.roomCode}/input`, {...owner,
    input: {x: null, y: 0, angle: 0, shoot: true}})).status, 400);
  assert.equal((await post(`/api/rooms/${owner.roomCode}/input`, {...owner,
    input: {x: 1, y: 0, angle: 0, shoot: 'yes'}})).status, 400);
  assert.equal((await fetch(`${base}/api/rooms`, {method: 'POST', body: '{}'})).status, 415);
  assert.equal((await post('/api/rooms', {name: 'x'.repeat(3000)})).status, 413);
  assert.equal((await fetch(`${base}/api/rooms`, {method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: 'https://example.invalid'}, body: '{}'})).status, 201);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/server.js`)).status, 404);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {ok: true});
});

test('CORS permits JSON preflight, cross-origin room actions and SSE while retaining token authentication', async t => {
  const {base} = await fixture(t);
  const origin = 'https://play.example.com';
  const preflight = await fetch(`${base}/api/rooms`, {method:'OPTIONS',headers:{
    Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'
  }});
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),'*');
  assert.match(preflight.headers.get('access-control-allow-methods'),/POST/);
  assert.match(preflight.headers.get('access-control-allow-headers'),/content-type/i);
  assert.equal(preflight.headers.get('access-control-allow-credentials'),null);
  assert.equal(await preflight.text(),'');
  async function crossPost(route,body,source=origin) {
    const response=await fetch(base+route,{method:'POST',headers:{Origin:source,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.headers.get('access-control-allow-origin'),'*');
    return response;
  }
  const created=await crossPost('/api/rooms',{name:'Remote commander'});
  assert.equal(created.status,201);const owner=await created.json();
  const joined=await crossPost(`/api/rooms/${owner.roomCode}/join`,{name:'Local HTML'},'null');
  assert.equal(joined.status,201);const ally=await joined.json();
  const live=stream(base,owner,2,origin);t.after(()=>live.close());
  await live.wait(s=>s.onlineCount===2);
  assert.equal(live.headers['access-control-allow-origin'],'*');
  assert.match(live.headers['content-type'],/text\/event-stream/);
  assert.equal((await crossPost(`/api/rooms/${owner.roomCode}/input`,{...owner,input:{x:0,y:0,angle:.4,shoot:false}})).status,204);
  assert.equal((await crossPost(`/api/rooms/${owner.roomCode}/input`,{...owner,token:'wrong',input:{x:0,y:0,angle:0,shoot:false}})).status,403);
  assert.equal((await crossPost(`/api/rooms/${owner.roomCode}/input`,{...owner,input:{x:null,y:0,angle:0,shoot:false}})).status,400);
  assert.equal((await crossPost(`/api/rooms/${owner.roomCode}/leave`,ally)).status,204);
  const config=await fetch(`${base}/config.js`,{headers:{Origin:origin}});
  assert.equal(config.status,200);assert.match(await config.text(),/TANK_SERVER_URL/);
});

test('lost inputs stop firing and disconnected players and empty rooms expire', async t => {
  const actualEngine = require('./engine.js');
  const inputs = [];
  const engine = {...actualEngine, setInput(game, id, input) {
    inputs.push({id, input: {...input}});
    return actualEngine.setInput(game, id, input);
  }};
  const {base, post} = await fixture(t, {engine, inputTimeoutMs: 80, disconnectGraceMs: 180, roomLifetimeMs: 120});
  const owner = (await post('/api/rooms', {name: 'Timeout'})).body;
  const live = stream(base, owner);
  t.after(() => live.close());
  await live.wait();
  await post(`/api/rooms/${owner.roomCode}/input`, {...owner, input: {x: 1, y: 0, angle: 1, shoot: true}});
  await new Promise(resolve => setTimeout(resolve, 150));
  const last = inputs.filter(i => i.id === owner.playerId).at(-1).input;
  assert.equal(last.x, 0);
  assert.equal(last.shoot, false);
  live.close();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await post(`/api/rooms/${owner.roomCode}/input`, {...owner,
    input: {x: 0, y: 0, angle: 0, shoot: false}})).status, 403);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal((await post(`/api/rooms/${owner.roomCode}/join`, {name: 'Late'})).status, 404);
});

test('optimized streams omit unchanged terrain, resync on reconnect and synchronize selected vehicles', async t => {
  const {base,post}=await fixture(t);
  const a=(await post('/api/rooms',{name:'Heavy',vehicle:'heavy'})).body;
  const b=(await post(`/api/rooms/${a.roomCode}/join`,{name:'Striker',vehicle:'striker'})).body;
  const live=stream(base,a,2);t.after(()=>live.close());
  const full=await live.wait(s=>Array.isArray(s.walls));
  assert.equal(full.tanks.find(v=>v.id===a.playerId).maxHp,170);
  assert.equal(full.tanks.find(v=>v.id===b.playerId).vehicle,'striker');
  const delta=await live.wait(s=>s.frame>full.frame&&!s.walls);
  const fullBytes=Buffer.byteLength(JSON.stringify(full)), deltaBytes=Buffer.byteLength(JSON.stringify(delta));
  assert.ok(deltaBytes<fullBytes*.35, `full=${fullBytes} delta=${deltaBytes}`);
  t.diagnostic(`initial snapshot ${fullBytes} bytes; unchanged-terrain update ${deltaBytes} bytes; reduction ${Math.round((1-deltaBytes/fullBytes)*100)}%`);
  live.close();const reconnected=stream(base,a,2);t.after(()=>reconnected.close());
  assert.ok((await reconnected.wait()).walls.length>0);
  await post(`/api/rooms/${a.roomCode}/input`,{...a,seq:5,input:{x:0,y:0,angle:.8,shoot:false}});
  await post(`/api/rooms/${a.roomCode}/input`,{...a,seq:4,input:{x:1,y:0,angle:-1,shoot:true}});
  const fresh=await reconnected.wait(s=>s.frame>delta.frame&&Math.abs(s.tanks.find(v=>v.id===a.playerId).angle-.8)<.001);
  assert.equal(fresh.tanks.find(v=>v.id===a.playerId).vx,0,'older input must not overwrite newer control');
});

test('damaged terrain is resent to optimized clients and new clients receive current terrain',async t=>{
  const E=require('./engine.js');
  const engine={...E,createGame(options){const game=E.createGame(options);game.walls=[{id:'test-brick',x:280,y:680,w:40,h:40,type:'brick',hp:60}];return game;}};
  const {base,post}=await fixture(t,{engine});
  const a=(await post('/api/rooms',{name:'Shooter'})).body;
  const live=stream(base,a,2);t.after(()=>live.close());await live.wait();
  await post(`/api/rooms/${a.roomCode}/input`,{...a,seq:1,input:{x:0,y:0,angle:0,shoot:true}});
  const damaged=await live.wait(s=>s.walls?.some(w=>w.id==='test-brick'&&w.hp<60));
  assert.ok(damaged.terrainRevision>1);
  const b=(await post(`/api/rooms/${a.roomCode}/join`,{name:'Late'})).body;
  const late=stream(base,b,2);t.after(()=>late.close());const initial=await late.wait();
  assert.ok(initial.walls.every(w=>w.id!=='test-brick'||w.hp<60));
});

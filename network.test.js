'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./engine.js');
const {Timeline, lerpAngle} = require('./network.js');
function packet(frame, time) {
  const game = E.createGame({seed: 19}); game.walls = []; game.tanks = [];
  E.addPlayer(game, {id:'me',vehicle:'scout'}); E.addPlayer(game,{id:'ally'});
  const state = E.snapshot(game); state.frame=frame;state.time=time;state.tanks[0].x=220;state.tanks[0].y=700;
  return state;
}
test('delta packets preserve terrain, new maps need a full terrain snapshot, and old frames are ignored',()=>{
  const net=new Timeline(), first=packet(1,0);
  assert.equal(net.receive(first,0,'me'),true);
  const delta=packet(2,.05);delete delta.walls;
  assert.equal(net.receive(delta,50,'me'),true);assert.equal(net.state.walls,first.walls);
  assert.equal(net.receive(first,60,'me'),false);
  assert.equal(net.receive({...delta,frame:3,mapSeed:33},100,'me'),false);
  const changed={...delta,frame:3,mapSeed:33,walls:[{id:'new',x:400,y:400,w:40,h:40,type:'steel',hp:999}]};
  assert.equal(net.receive(changed,100,'me'),true);assert.equal(net.frames.length,1);
});
test('remote tanks and bullets interpolate between snapshots and turret angles take the short arc',()=>{
  const net=new Timeline(), a=packet(1,0), b=packet(2,.1);
  a.tanks[1].x=500;b.tanks[1].x=520;a.tanks[1].angle=3.1;b.tanks[1].angle=-3.1;
  a.bullets=[{id:'b',x:600,y:600,vx:100,vy:0}];b.bullets=[{id:'b',x:610,y:600,vx:100,vy:0}];
  net.receive(a,0,'me');net.receive(b,100,'me');
  const render=net.render(125,1/60,'me',null);
  assert.ok(Math.abs(render.tanks[1].x-510)<.001);
  assert.ok(Math.abs(render.bullets[0].x-605)<.001);
  assert.ok(Math.abs(Math.abs(render.tanks[1].angle)-Math.PI)<.001);
  assert.ok(Math.abs(lerpAngle(3.1,-3.1,.5)-Math.PI)<.001);
});
test('local controls predict immediately without crossing walls; stale connections stop prediction',()=>{
  const net=new Timeline(), a=packet(1,0);
  a.walls=[{id:'wall',x:250,y:660,w:40,h:80,type:'steel',hp:999}];net.receive(a,0,'me');
  const controls={x:1,y:0,angle:.8,shoot:false};
  const first=net.render(16,1/60,'me',controls).tanks.find(t=>t.id==='me');
  assert.ok(first.x>220,'must move before receiving another server frame');assert.equal(first.angle,.8);
  for(let now=32;now<250;now+=16)net.render(now,1/60,'me',controls);
  assert.ok(net.local.x<=234);
  const x=net.local.x;net.render(1000,.05,'me',controls);assert.equal(net.local.x,x);
  const dead=packet(2,.1);dead.tanks[0].alive=false;dead.tanks[0].deaths=1;dead.tanks[0].hp=0;
  net.receive(dead,1100,'me');assert.equal(net.local.alive,false);
  const respawn=packet(3,.2);respawn.tanks[0].deaths=1;respawn.tanks[0].x=1000;
  net.receive(respawn,1150,'me');assert.equal(net.local.x,1000);
});

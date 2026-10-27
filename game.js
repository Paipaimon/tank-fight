/* TANK FIELD — browser renderer, controls and cooperative client. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const engine = window.TankEngine;
  if (!engine) { $('lobby-error').textContent = '未能加载战斗引擎，请确认 engine.js 与 HTML 在同一文件夹。'; return; }
  const canvas = $('battlefield'), ctx = canvas.getContext('2d');
  const serverBase = String(window.TANK_SERVER_URL || '').trim().replace(/\/+$/, '');
  const serverURL = path => serverBase + path;
  const timeline = new window.TankNetwork.Timeline();
  let selectedVehicle = 'vanguard', terrainCanvas, foliageCanvas, terrainKey = '', hudSignature = '';
  let inputSequence = 0, requestsInFlight = 0, lastSentInput = '', lastSentAt = 0;
  let previewVehicle = '';
  const palette = { repair: '#c0e58a', shield: '#8bc7e9', rapid: '#f0d274', spread: '#eaa186', speed: '#c1aaed' };
  const symbols = { repair: '+', shield: '⬡', rapid: 'ϟ', spread: '⋔', speed: '»' };
  const names = { repair: '战地维修', shield: '能量护盾', rapid: '极速连射', spread: '三重火力', speed: '涡轮加速' };
  const tips = ['砖墙可以被炮弹击碎。\n开辟一条属于你的进攻路线。', '炮塔与车身可以独立转向。\n边移动边射击，更难被敌军命中。', '和队友从不同方向包围敌军。\n协同推进，互相掩护。', '护盾开启时，把握进攻时机。\n维修补给可以恢复受损装甲。'];
  const keys = new Set();
  let game, state, localId = 'commander', mode = 'lobby', paused = false, firing = false;
  let mouse = { x: 850, y: 400, inside: false }, session = null, stream = null;
  let lastFrame = performance.now(), hudTime = 0, lastNetworkInput = 0;
  let soundEnabled = false, audioContext, toastTimer, floorSeed, floorCanvas, lastWave = 1;
  let recentEvents = new Set(), animationClock = 0;
  let connectionLost = false, networkFailureAt = 0, connectionGeneration = 0, connecting = false;

  function seedRandom(seed) { let n = Number(seed) || 73489; return () => { n = Math.imul(1664525, n) + 1013904223 | 0; return (n >>> 0) / 4294967296; }; }
  function roundRect(c, x, y, w, h, r, fill, stroke) { c.beginPath(); c.roundRect(x, y, w, h, r); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.stroke(); } }
  function resetPreview() {
    game = engine.createGame({ seed: 74219 });
    engine.addPlayer(game, { id: localId, name: '指挥官', color: engine.vehicle(selectedVehicle).color, vehicle: selectedVehicle });
    state = engine.snapshot(game); floorSeed = null;  recentEvents.clear(); lastWave = 1;
  }

  function buildFloor(s) {
    const c = document.createElement('canvas'); c.width = s.width; c.height = s.height;
    const g = c.getContext('2d'), rand = seedRandom(s.mapSeed ?? s.seed);
    g.fillStyle = '#38422e'; g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 50; i++) {
      const x = rand() * c.width, y = rand() * c.height, r = 35 + rand() * 150;
      const grad = g.createRadialGradient(x,y,0,x,y,r); grad.addColorStop(0,i%2?'#4d503330':'#223b2d50'); grad.addColorStop(1,'#303d2b00');
      g.fillStyle = grad; g.fillRect(x-r,y-r,r*2,r*2);
    }
    g.lineWidth = 1; g.strokeStyle = '#9aac6d0b';
    for (let x=0;x<c.width;x+=40) { g.beginPath();g.moveTo(x,0);g.lineTo(x,c.height);g.stroke(); }
    for (let y=0;y<c.height;y+=40) { g.beginPath();g.moveTo(0,y);g.lineTo(c.width,y);g.stroke(); }
    for (let i=0;i<1300;i++) {
      const x=rand()*c.width,y=rand()*c.height,r=rand()*2;
      g.fillStyle=i%3?'#9da77916':'#121f1a2e';g.fillRect(x,y,r+1,r+.5);
    }
    g.strokeStyle='#bdc8910a';g.lineWidth=26;g.setLineDash([4,5]);
    g.beginPath();g.moveTo(0,c.height*.5);g.lineTo(c.width,c.height*.5);g.stroke();g.setLineDash([]);
    g.strokeStyle='#d5d6a335';g.lineWidth=2;
    const corners=[[18,18,1,1],[c.width-18,18,-1,1],[18,c.height-18,1,-1],[c.width-18,c.height-18,-1,-1]];
    for (const [x,y,a,b] of corners) {g.beginPath();g.moveTo(x+22*a,y);g.lineTo(x,y);g.lineTo(x,y+22*b);g.stroke();}
    g.font='9px Consolas';g.fillStyle='#d8dfae30';
    for(let x=160;x<c.width;x+=160)g.fillText(String(x/40).padStart(2,'0'),x,15);
    for(let y=160;y<c.height;y+=160)g.fillText(String.fromCharCode(65+y/160),9,y);
    return c;
  }

  function drawWall(w, foliage = false, c = ctx) {
    const {x,y,w:width,h:height,type}=w;
    if(type==='bush') {
      if(!foliage)return;
      const rand=seedRandom(x*37+y*19);
      for(let i=0;i<9;i++){const px=x+rand()*width,py=y+rand()*height,r=8+rand()*12;c.fillStyle=i%2?'#536e3bbd':'#426038d1';c.beginPath();c.arc(px,py,r,0,Math.PI*2);c.fill();c.fillStyle='#8c9e4d38';c.beginPath();c.arc(px-2,py-4,r*.5,0,Math.PI*2);c.fill();}
      return;
    }
    if(foliage)return;
    if(type==='water') {
      roundRect(c,x+1,y+1,width-2,height-2,4,'#334d4d','#65817670');
      c.strokeStyle='#97b7a62b';c.lineWidth=1;
      for(let row=9;row<height;row+=9){c.beginPath();c.moveTo(x+5,y+row);c.quadraticCurveTo(x+width*.4,y+row-4,x+width-5,y+row);c.stroke();}
      return;
    }
    roundRect(c,x+3,y+6,width-2,height-1,3,'#0b17135c');
    if(type==='steel') {
      roundRect(c,x+1,y+1,width-2,height-3,3,'#53605a','#748075');
      roundRect(c,x+5,y+5,width-10,height-11,2,'#46534b','#33453d');
      c.strokeStyle='#79827580';c.lineWidth=2;c.beginPath();c.moveTo(x+8,y+height-10);c.lineTo(x+width-9,y+8);c.stroke();
      c.fillStyle='#9b9e83';for(const [dx,dy] of [[6,6],[width-7,6],[6,height-8],[width-7,height-8]])c.fillRect(x+dx,y+dy,2,2);
    } else {
      roundRect(c,x+1,y+1,width-2,height-3,2,'#967951','#b19765');
      c.fillStyle='#a38b5b';c.fillRect(x+3,y+3,width-6,3);
      c.strokeStyle='#5b5039';c.lineWidth=2;
      for(let r=12;r<height-2;r+=12){c.beginPath();c.moveTo(x+1,y+r);c.lineTo(x+width-1,y+r);c.stroke();}
      for(let row=0;row<height/12;row++){const dx=row%2?width*.65:width*.35;c.beginPath();c.moveTo(x+dx,y+row*12+1);c.lineTo(x+dx,y+Math.min(height-2,(row+1)*12));c.stroke();}
      if(w.hp<60){c.strokeStyle='#453d2c';c.lineWidth=1;c.beginPath();c.moveTo(x+width*.5,y+2);c.lineTo(x+width*.35,y+height*.4);c.lineTo(x+width*.63,y+height*.7);c.lineTo(x+width*.4,y+height-2);c.stroke();}
    }
  }

  function drawTank(c,t,scale=1,preview=false) {
    const enemy=t.team==='enemy', color=t.color||(enemy?'#df9677':'#c4dc8b');
    const kind = t.vehicle || 'vanguard';
    c.save();c.translate(t.x,t.y);c.scale(scale,scale);
    if(!preview && ((t.buffs?.shield||0)>(state?.time||0) || (t.invulnerableUntil||0)>(state?.time||0))) {
      c.beginPath();c.arc(0,0,28+Math.sin(animationClock*4)*1.4,0,Math.PI*2);c.fillStyle='#8bc7e911';c.fill();c.strokeStyle='#a2d5e78a';c.lineWidth=1.5;c.stroke();
    }
    c.save();c.rotate(t.bodyAngle||0);
    c.fillStyle='#07130d55';c.beginPath();c.ellipse(3,5,24,19,0,0,Math.PI*2);c.fill();
    for(const yy of [-17,10]) {
      roundRect(c,-19,yy,37,8,2,'#18231d','#657157');
      c.strokeStyle='#87937388';c.lineWidth=1.3;
      for(let xx=-15;xx<18;xx+=5){c.beginPath();c.moveTo(xx,yy+1);c.lineTo(xx,yy+7);c.stroke();}
    }
    roundRect(c,-17,-12,34,24,3,enemy?'#a8694c':'#829555','#212e24');
    roundRect(c,-13,-10,24,20,2,color);
    if(kind==='heavy') {roundRect(c,-17,-14,34,4,1,'#b5aa85');roundRect(c,-17,10,34,4,1,'#b5aa85');roundRect(c,12,-10,7,20,2,color,'#ead7a780');}
    if(kind==='scout') {c.fillStyle='#1f373d';c.beginPath();c.moveTo(15,-9);c.lineTo(20,0);c.lineTo(15,9);c.fill();c.strokeStyle='#94e1ed';c.beginPath();c.moveTo(-11,-11);c.lineTo(-20,-22);c.stroke();}
    if(kind==='striker') {roundRect(c,-13,-13,8,5,1,'#a68ac3');roundRect(c,-13,8,8,5,1,'#a68ac3');}
    c.fillStyle=enemy?'#b67553':'#80964f';c.fillRect(-12,-8,6,16);
    c.strokeStyle='#24332255';c.lineWidth=1;for(let yy=-6;yy<=6;yy+=3){c.beginPath();c.moveTo(-11,yy);c.lineTo(-7,yy);c.stroke();}
    c.fillStyle='#eff1bfa8';c.fillRect(12,-9,3,3);c.fillRect(12,6,3,3);
    c.restore();
    c.save();c.rotate(t.angle||0);
    for(const offset of kind==='striker'?[-6,0,6]:[0]) {
      const thick=kind==='heavy'?10:kind==='striker'?4:kind==='scout'?5:8;
      const length=kind==='heavy'?35:kind==='scout'?31:29;
      roundRect(c,3,offset-thick/2,length,thick,1,'#233023');roundRect(c,5,offset-thick/2+1,length-4,thick-2,1,color);
      c.fillStyle='#1b2c22';c.fillRect(length-2,offset-thick/2,6,thick);
    }
    c.beginPath();c.arc(0,0,10,0,Math.PI*2);c.fillStyle='#283728';c.fill();
    roundRect(c,-9,-8,18,16,4,enemy?'#d89b75':'#b3cc78','#e1e6ad78');
    roundRect(c,-5,-5,8,10,3,enemy?'#ad7457':'#8b9f57');
    c.fillStyle='#eaf1c38a';c.fillRect(-3,-4,4,2);c.restore();
    if(!preview){
      const hp=Math.max(0,t.hp/(t.maxHp||100));
      c.fillStyle='#101a1299';c.fillRect(-18,-29,36,3);c.fillStyle=enemy?'#e6a17c':'#cce898';c.fillRect(-18,-29,36*hp,3);
      if(t.team==='player'){c.font='9px "Microsoft YaHei",sans-serif';c.textAlign='center';c.fillStyle=t.id===localId?'#e5f3bf':'#b6dce0';c.fillText(t.id===localId?'你':t.name||'队友',0,-36);}
    }
    c.restore();
  }

  function drawPickup(p) {
    const color=palette[p.type]||palette.repair,bob=Math.sin(animationClock*2+p.x)*2;
    ctx.save();ctx.translate(p.x,p.y+bob);ctx.shadowColor=color;ctx.shadowBlur=9;
    roundRect(ctx,-12,-12,24,24,5,'#202f25',color);ctx.shadowBlur=0;
    ctx.fillStyle=color;ctx.font='bold 20px Consolas';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(symbols[p.type]||'+',0,-1);
    ctx.strokeStyle=color+'35';ctx.beginPath();ctx.ellipse(0,19,14,4,0,0,Math.PI*2);ctx.stroke();ctx.restore();
  }

  function draw(s, dt) {
    if(!s)return;
    if(floorSeed!==(s.mapSeed??s.seed)){floorSeed=s.mapSeed??s.seed;floorCanvas=buildFloor(s);}
    const key = `${s.mapSeed}:${s.terrainRevision}`;
    if(key!==terrainKey) {
      terrainKey=key;
      terrainCanvas=document.createElement('canvas');terrainCanvas.width=1280;terrainCanvas.height=800;
      foliageCanvas=document.createElement('canvas');foliageCanvas.width=1280;foliageCanvas.height=800;
      const ground=terrainCanvas.getContext('2d'), foliage=foliageCanvas.getContext('2d');
      ground.drawImage(floorCanvas,0,0);
      for(const wall of s.walls||[]){drawWall(wall,false,ground);drawWall(wall,true,foliage);}
    }
    ctx.clearRect(0,0,1280,800);ctx.drawImage(terrainCanvas,0,0);
    for(const p of s.pickups||[])drawPickup(p);
    for(const t of s.tanks||[]) {
      if(t.alive===false||t.hp<=0)continue;
      drawTank(ctx,t);
    }
    for(const b of s.bullets||[]){ctx.save();ctx.strokeStyle=b.team==='player'?'#e9f2a0':'#f2ac7f';ctx.lineWidth=3;ctx.lineCap='round';ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=8;ctx.beginPath();ctx.moveTo(b.x-b.vx*.013,b.y-b.vy*.013);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.fillStyle='#fff5cc';ctx.beginPath();ctx.arc(b.x,b.y,2.3,0,Math.PI*2);ctx.fill();ctx.restore();}
    ctx.drawImage(foliageCanvas,0,0);
    for(const e of s.effects||[]){const ratio=Math.max(0,Math.min(1,e.life/(e.maxLife||.5)));ctx.save();ctx.globalAlpha=ratio;ctx.strokeStyle=e.color||'#f6c781';ctx.fillStyle=e.color||'#f6c781';const radius=(1-ratio)*(e.type==='explosion'?45:17)+3;ctx.beginPath();ctx.arc(e.x,e.y,radius,0,Math.PI*2);ctx.lineWidth=2;ctx.stroke();for(let j=0;j<8;j++){const a=j*Math.PI/4+e.x;ctx.fillRect(e.x+Math.cos(a)*radius*1.3,e.y+Math.sin(a)*radius*1.3,3,3);}ctx.restore();}
    if(mode!=='lobby'&&mouse.inside&&!paused){ctx.save();ctx.translate(mouse.x,mouse.y);ctx.strokeStyle='#e4f1b7a8';ctx.lineWidth=1;ctx.beginPath();ctx.arc(0,0,9,0,Math.PI*2);ctx.moveTo(-15,0);ctx.lineTo(-5,0);ctx.moveTo(5,0);ctx.lineTo(15,0);ctx.moveTo(0,-15);ctx.lineTo(0,-5);ctx.moveTo(0,5);ctx.lineTo(0,15);ctx.stroke();ctx.fillStyle='#f0f5c8';ctx.fillRect(-1,-1,2,2);ctx.restore();}
    const vignette=ctx.createRadialGradient(640,400,230,640,400,750);vignette.addColorStop(0,'#08160e00');vignette.addColorStop(1,'#0a140c50');ctx.fillStyle=vignette;ctx.fillRect(0,0,1280,800);
  }

  function drawVehiclePreview(kind = selectedVehicle) {
    const spec=engine.vehicle(kind);previewVehicle=spec.id;
    const c=$('tank-preview').getContext('2d');c.clearRect(0,0,240,110);
    c.strokeStyle='#70805c25';c.lineWidth=1;
    c.beginPath();c.ellipse(120,57,70,32,0,0,Math.PI*2);c.stroke();c.beginPath();c.ellipse(120,57,45,22,0,0,Math.PI*2);c.stroke();
    c.setLineDash([2,5]);c.beginPath();c.moveTo(30,57);c.lineTo(210,57);c.moveTo(120,12);c.lineTo(120,102);c.stroke();c.setLineDash([]);
    drawTank(c,{x:120,y:57,bodyAngle:-.5,angle:-.5,team:'player',vehicle:spec.id,color:spec.color},1.75,true);
    $('vehicle-code').textContent=spec.code;$('vehicle-badge').textContent=spec.label;$('tank-id').textContent=spec.name;
  }

  function textNode(tag,text,className){const e=document.createElement(tag);e.textContent=text;if(className)e.className=className;return e;}
  function updateHUD() {
    if(!state)return;
    processEvents();
    const me=state.tanks.find(t=>t.id===localId), human=state.tanks.filter(t=>t.team==='player');
    const signature=JSON.stringify([mode,selectedVehicle,session?.roomCode,state.mapSeed,state.wave,state.phase,Math.ceil(state.nextWaveAt-state.time),Math.floor(state.time),me?.hp,me?.kills,me?.alive,Math.ceil((me?.respawnAt||0)-state.time),Object.entries(me?.buffs||{}).map(([k,v])=>[k,Math.max(0,Math.ceil(v-state.time))]),state.tanks.filter(t=>t.team==='enemy'&&t.alive).length,human.map(t=>[t.id,t.name,t.alive,t.vehicle])]);
    if(signature===hudSignature)return;hudSignature=signature;
    const spec=engine.vehicle(me?.vehicle||selectedVehicle);if(previewVehicle!==spec.id)drawVehiclePreview(spec.id);
    $('map-name').textContent=state.mapName||'荒原前哨';$('wave-value').textContent=String(state.wave).padStart(2,'0');
    $('enemy-value').textContent=String(state.tanks.filter(t=>t.team==='enemy'&&t.alive!==false&&t.hp>0).length).padStart(2,'0');
    $('seed-label').textContent='SEED '+state.seed+' / SECTOR '+String(state.wave).padStart(2,'0');
    $('mode-label').textContent=mode==='online'?'合作作战':mode==='solo'?'单人演练':'训练模式';
    $('kills-value').textContent=String(me?.kills||0).padStart(2,'0');
    const time=Math.floor(state.time||0);$('time-value').textContent=String(Math.floor(time/60)).padStart(2,'0')+':'+String(time%60).padStart(2,'0');
    const hp=Math.max(0,Math.ceil(me?.hp??100)),max=me?.maxHp||100;
    $('health-value').replaceChildren(document.createTextNode(hp+' '),textNode('small','/ '+max));
    $('health-bar').style.width=(hp/max*100)+'%';$('health-bar').style.background=hp<30?'#ed9d7c':'var(--lime)';
    $('player-label').textContent=mode==='lobby'?spec.name:me?.name||spec.name;
    const buffs=Object.entries(me?.buffs||{}).filter(([type,expiry])=>names[type]&&expiry>state.time);
    const list=$('buffs-list');list.replaceChildren();
    if(!buffs.length){const empty=textNode('div','','empty-buff');empty.append(textNode('span','＋'));const label=textNode('div','等待补给');label.append(textNode('small','驶过道具即可自动拾取'));empty.append(label);list.append(empty);}
    for(const [type,expiry] of buffs){const row=textNode('div','','buff-row');row.append(textNode('span',symbols[type],'supply-icon '+type),textNode('span',names[type]),textNode('time',Math.ceil(expiry-state.time)+'s'));list.append(row);}
    $('squad-count').textContent=String(human.length).padStart(2,'0')+' / 04';$('squad-list').replaceChildren();
    for(const p of human){const row=textNode('div','','squad-row'),dot=textNode('span','','avatar-dot');dot.style.background=p.color||'#d3ee89';const label=textNode('span',p.name||'指挥官');if(p.id===localId)label.append(textNode('small','你'));row.append(dot,label,textNode('span',mode==='lobby'?'待命':p.alive===false?'重新部署':'作战中','squad-status'));$('squad-list').append(row);}
    $('room-button').textContent=session?'房间 '+session.roomCode+' · 点击复制':'＋ 邀请朋友一起作战';
    if(mode!=='lobby'&&(state.phase==='transition'||state.phase==='retry')){$('wave-banner').classList.remove('hidden');$('wave-banner').replaceChildren(document.createTextNode(state.phase==='retry'?'全队阵亡 · 重新部署本关':'区域肃清 · 准备推进'),textNode('small',(state.phase==='retry'?'RETRY SECTOR IN ':'NEXT SECTOR IN ')+Math.max(1,Math.ceil(state.nextWaveAt-state.time))+'s'));}else $('wave-banner').classList.add('hidden');
    const dead=mode!=='lobby'&&me&&me.alive===false;$('respawn-banner').classList.toggle('hidden',!dead);if(dead)$('respawn-banner').textContent=state.phase==='retry'?'本关将在 '+Math.max(1,Math.ceil(state.nextWaveAt-state.time))+' 秒后重新开始':'战车已被击毁 · 等待小队清场或全队重新部署';
    if(state.wave!==lastWave){lastWave=state.wave;$('tactical-tip').textContent=tips[(state.wave-1)%tips.length];toast('第 '+state.wave+' 关 · '+(state.mapName||'新战场'));}
  }

  function processEvents(){
    for(const e of state.events||[]){const key=e.id??`${e.time}-${e.type}-${e.x}`;if(recentEvents.has(key))continue;recentEvents.add(key);if(mode==='lobby'||state.time-e.time>1)continue;
      if(e.type==='shot')playSound('shot');else if(e.type==='kill')playSound('kill');else if(e.type==='pickup'){playSound('pickup');if(e.playerId===localId||e.tankId===localId)toast('已获取 '+(names[e.pickupType]||names[e.itemType]||'战场补给'));}
    }if(recentEvents.size>200)recentEvents=new Set([...recentEvents].slice(-70));
  }
  function playSound(type){if(!soundEnabled)return;try{audioContext??=new(window.AudioContext||window.webkitAudioContext)();if(audioContext.state==='suspended')audioContext.resume();const osc=audioContext.createOscillator(),gain=audioContext.createGain(),now=audioContext.currentTime;osc.type=type==='pickup'?'sine':'triangle';osc.frequency.setValueAtTime(type==='pickup'?720:type==='kill'?90:170,now);osc.frequency.exponentialRampToValueAtTime(type==='pickup'?1100:35,now+.12);gain.gain.setValueAtTime(type==='shot'?.025:.05,now);gain.gain.exponentialRampToValueAtTime(.001,now+.16);osc.connect(gain);gain.connect(audioContext.destination);osc.start();osc.stop(now+.17);}catch{soundEnabled=false;}}
  function toast(message){$('toast').textContent=message;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),3000);}
  function input(){const me=(mode==='online'&&timeline.local)||state?.tanks.find(t=>t.id===localId);return{x:(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0),y:(keys.has('KeyS')||keys.has('ArrowDown')?1:0)-(keys.has('KeyW')||keys.has('ArrowUp')?1:0),angle:me?Math.atan2(mouse.y-me.y,mouse.x-me.x):0,shoot:firing||keys.has('Space')};}
  function clearInput(){keys.clear();firing=false;if(session)sendInput(true);}
  function connectionControls(disabled){for(const id of ['host-button','join-button','show-join-button','vehicle-select'])$(id).disabled=disabled;}
  function leaveSession(old){fetch(serverURL(`/api/rooms/${old.roomCode}/leave`),{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({playerId:old.playerId,token:old.token}),keepalive:true}).catch(()=>{});}
  function clearNetwork(){timeline.reset();inputSequence=0;requestsInFlight=0;lastSentInput='';lastSentAt=0;connectionGeneration++;connecting=false;connectionControls(false);if(stream){stream.close();stream=null;}if(session){const old=session;session=null;leaveSession(old);}connectionLost=false;networkFailureAt=0;}
  function enterBattle(){clearInput();hudSignature='';paused=false;recentEvents.clear();$('lobby').classList.add('hidden');$('pause-overlay').classList.add('hidden');$('lobby-error').textContent='';canvas.focus();}
  function startSolo(){clearNetwork();localId='commander';game=engine.createGame({seed:Math.floor(Math.random()*9999999)});engine.addPlayer(game,{id:localId,name:'指挥官',color:engine.vehicle(selectedVehicle).color,vehicle:selectedVehicle});state=engine.snapshot(game);mode='solo';lastWave=1;floorSeed=null;enterBattle();$('connection-label').textContent='单人演练进行中';$('connection-sub').textContent='SOLO OPERATION / ACTIVE';toast('部署完成 · WASD 移动，按住左键开火');updateHUD();}
  function returnLobby(){clearNetwork();mode='lobby';paused=false;clearInput();localId='commander';$('lobby').classList.remove('hidden');$('pause-overlay').classList.add('hidden');$('connection-label').textContent='本地引擎就绪';$('connection-sub').textContent='准备部署 / READY';resetPreview();updateHUD();}
  function togglePause(force){if(mode==='lobby')return;paused=typeof force==='boolean'?force:!paused;clearInput();$('pause-overlay').classList.toggle('hidden',!paused);$('pause-description').textContent=mode==='online'?'联机战斗仍在继续，队友正在等待你的支援。':'深呼吸，下一发命中目标。';if(!paused)canvas.focus();}
  function selectTab(multi){if(!multi&&mode==='lobby')clearNetwork();$('solo-tab').classList.toggle('selected',!multi);$('multi-tab').classList.toggle('selected',multi);$('solo-tab').setAttribute('aria-selected',String(!multi));$('multi-tab').setAttribute('aria-selected',String(multi));$('solo-form').classList.toggle('hidden',multi);$('multi-form').classList.toggle('hidden',!multi);$('lobby-error').textContent='';}
  async function api(path,body){const response=await fetch(serverURL(path),{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'连接失败，请检查服务是否已启动。');return data;}
  async function connectRoom(join){
    if(connecting)return;
    if(location.protocol==='file:'&&!serverBase){$('lobby-error').textContent='多人模式需要联机服务：运行 npm start 后打开终端显示的地址，或在 config.js 中填写服务器地址。';return;}
    const code=$('room-code').value.trim().toUpperCase();if(join&&!/^[A-Z0-9]{4,8}$/.test(code)){$('lobby-error').textContent='请输入有效的房间代码。';return;}
    clearNetwork();const generation=connectionGeneration;connecting=true;connectionControls(true);$('lobby-error').textContent='正在连接战场…';
    try{const credentials=await api(join?`/api/rooms/${code}/join`:'/api/rooms',{name:$('player-name').value.trim()||'指挥官',vehicle:selectedVehicle});if(generation!==connectionGeneration){leaveSession(credentials);return;}session=credentials;localId=session.playerId;const active=session;networkFailureAt=performance.now();stream=new EventSource(serverURL(`/api/rooms/${session.roomCode}/events?v=2&playerId=${encodeURIComponent(session.playerId)}&token=${encodeURIComponent(session.token)}`));let opened=false;
      stream.onmessage=event=>{if(session!==active)return;try{const data=JSON.parse(event.data);if(!Array.isArray(data.tanks))return;if(!timeline.receive(data,performance.now(),localId))return;state=timeline.state;processEvents();connectionLost=false;networkFailureAt=0;if(!opened){opened=true;connecting=false;connectionControls(false);mode='online';floorSeed=null;lastWave=state.wave;enterBattle();toast('已进入房间 '+session.roomCode+' · 邀请朋友加入');}const me=state.tanks.find(t=>t.id===localId);if(!me){returnLobby();$('lobby-error').textContent='连接已过期，请重新加入房间。';return;}$('connection-label').textContent='小队通讯正常';$('connection-sub').textContent='ROOM '+session.roomCode+' / '+Math.round(timeline.rtt)+' ms';}catch{}};
      stream.onerror=()=>{if(session!==active)return;connectionLost=true;networkFailureAt||=performance.now();clearInput();$('connection-label').textContent='连接中断，正在重连';$('connection-sub').textContent='RECONNECTING…';if(!opened)$('lobby-error').textContent='正在连接房间，请稍候…';};
    }catch(error){if(generation===connectionGeneration){clearNetwork();$('lobby-error').textContent=error.message==='Failed to fetch'?'无法连接游戏服务器，请检查服务器地址和网络连接。':error.message;}}
  }
  async function sendInput(force=false) {
    if(!session||requestsInFlight>=2||connectionLost||connecting)return;
    const current=session, generation=connectionGeneration, now=performance.now();
    const controls=paused||document.hidden||$('guide-dialog').open?{x:0,y:0,angle:input().angle,shoot:false}:input();
    controls.angle=Math.round(controls.angle*1000)/1000;
    const encoded=JSON.stringify(controls);
    if(!force&&encoded===lastSentInput&&now-lastSentAt<150)return;
    lastSentInput=encoded;lastSentAt=now;requestsInFlight++;
    try {
      const response=await fetch(serverURL('/api/rooms/'+current.roomCode+'/input'),{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({playerId:current.playerId,token:current.token,seq:++inputSequence,input:controls}),signal:AbortSignal.timeout(1500)});
      if(session!==current)return;
      timeline.recordRTT(performance.now()-now);
      if(!response.ok){returnLobby();$('lobby-error').textContent='房间连接已失效，请重新加入。';}
    } catch {if(session===current)lastSentInput='';}
    finally {if(generation===connectionGeneration)requestsInFlight=Math.max(0,requestsInFlight-1);}
  }
  function updatePointer(event){const r=canvas.getBoundingClientRect(),scale=Math.min(r.width/1280,r.height/800),width=1280*scale,height=800*scale;mouse.x=(event.clientX-r.left-(r.width-width)/2)/scale;mouse.y=(event.clientY-r.top-(r.height-height)/2)/scale;mouse.inside=mouse.x>=0&&mouse.y>=0&&mouse.x<=1280&&mouse.y<=800;}
  canvas.addEventListener('pointermove',updatePointer);canvas.addEventListener('pointerdown',event=>{if(event.button!==0||mode==='lobby'||paused)return;updatePointer(event);firing=true;sendInput(true);canvas.setPointerCapture(event.pointerId);canvas.focus();event.preventDefault();});
  window.addEventListener('pointerup',()=>{if(firing){firing=false;sendInput(true);}});canvas.addEventListener('pointercancel',()=>firing=false);canvas.addEventListener('pointerleave',()=>mouse.inside=false);canvas.addEventListener('contextmenu',event=>event.preventDefault());
  window.addEventListener('keydown',event=>{if(['INPUT','TEXTAREA'].includes(event.target.tagName)||$('guide-dialog').open)return;if(['Escape','KeyP'].includes(event.code)&&!event.repeat){togglePause();return;}if(mode!=='lobby'&&['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(event.code)){event.preventDefault();if(!paused&&!keys.has(event.code)){keys.add(event.code);sendInput(true);}}});
  window.addEventListener('keyup',event=>{if(keys.delete(event.code))sendInput(true);});window.addEventListener('blur',()=>{clearInput();if(mode==='solo')togglePause(true);});document.addEventListener('visibilitychange',()=>{if(document.hidden){clearInput();if(mode==='solo')togglePause(true);}});
  window.addEventListener('pagehide',clearNetwork);
  $('start-button').addEventListener('click',startSolo);$('solo-tab').addEventListener('click',()=>selectTab(false));$('multi-tab').addEventListener('click',()=>selectTab(true));$('host-button').addEventListener('click',()=>connectRoom(false));$('join-button').addEventListener('click',()=>connectRoom(true));$('show-join-button').addEventListener('click',()=>{$('join-form').classList.toggle('hidden');$('room-code').focus();});$('room-code').addEventListener('keydown',e=>{if(e.key==='Enter')connectRoom(true);});
  $('pause-button').addEventListener('click',()=>togglePause());$('resume-button').addEventListener('click',()=>togglePause(false));$('exit-button').addEventListener('click',returnLobby);$('lobby-nav').addEventListener('click',()=>{if(mode!=='lobby')togglePause(true);else $('start-button').focus();});
  $('room-button').addEventListener('click',async()=>{if(session){try{await navigator.clipboard.writeText(session.roomCode);toast('房间代码 '+session.roomCode+' 已复制');}catch{toast('房间代码：'+session.roomCode);}}else{if(mode!=='lobby')returnLobby();selectTab(true);$('player-name').focus();}});
  $('guide-button').addEventListener('click',()=>{clearInput();if(mode==='solo')togglePause(true);$('guide-dialog').showModal();});$('close-guide').addEventListener('click',()=>$('guide-dialog').close());$('guide-ready').addEventListener('click',()=>$('guide-dialog').close());$('guide-dialog').addEventListener('click',e=>{if(e.target===$('guide-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  $('sound-button').addEventListener('click',()=>{soundEnabled=!soundEnabled;$('sound-button').replaceChildren(document.createTextNode('♪'));if(!soundEnabled)$('sound-button').append(textNode('span','╱','slash'));$('sound-button').title=soundEnabled?'关闭音效':'开启音效';$('sound-button').setAttribute('aria-label',$('sound-button').title);playSound('pickup');toast(soundEnabled?'音效已开启':'音效已关闭');});
  $('fullscreen-button').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('canvas-wrap').requestFullscreen();}catch{toast('当前浏览器不支持全屏，可以按 F11 放大战场。');}});

  function frame(now) {
    const dt=Math.min(.05,(now-lastFrame)/1000);lastFrame=now;animationClock+=dt;
    if(mode==='solo'&&!paused){engine.setInput(game,localId,input());engine.step(game,dt);state=game;}
    if(session&&now-lastNetworkInput>33){lastNetworkInput=now;sendInput();}
    if(networkFailureAt&&now-networkFailureAt>15000){returnLobby();$('lobby-error').textContent='重连超时，请检查网络后重新加入房间。';}
    const controls=input();if(paused||document.hidden||$('guide-dialog').open){controls.x=controls.y=0;controls.shoot=false;}
    const rendered=mode==='online'?timeline.render(now,dt,localId,connectionLost?null:controls):state;
    if(!document.hidden)draw(rendered||state,dt);
    hudTime+=dt;if(hudTime>.1){hudTime=0;updateHUD();}requestAnimationFrame(frame);
  }
  for(const spec of Object.values(engine.VEHICLES)){
    const option=document.createElement('option');option.value=spec.id;option.textContent=spec.name+' · '+spec.label;$('vehicle-select').append(option);
  }
  function describeVehicle(){const spec=engine.vehicle(selectedVehicle);$('vehicle-details').textContent='装甲 '+spec.hp+' / 速度 '+spec.speed+' / '+(spec.barrels===3?'三联散射':'单发伤害 '+spec.damage);$('vehicle-description').textContent=spec.description;}
  $('vehicle-select').addEventListener('change',()=>{selectedVehicle=engine.vehicle($('vehicle-select').value).id;describeVehicle();resetPreview();drawVehiclePreview();hudSignature='';updateHUD();});
  describeVehicle();
  resetPreview();drawVehiclePreview();updateHUD();requestAnimationFrame(frame);
})();

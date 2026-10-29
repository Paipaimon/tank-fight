(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./engine.js'),require('./config.js'));
  else root.TankNetwork=factory(root.TankEngine,root.TankConfig);
})(typeof globalThis!=='undefined'?globalThis:this,function(engine,C){
  'use strict';
  const N=C.network, clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const lerpAngle=(a,b,t)=>a+Math.atan2(Math.sin(b-a),Math.cos(b-a))*t;
  class Timeline {
    constructor(){this.reset();}
    reset(){
      this.frames=[];this.history=[];this.state=null;this.local=null;
      this.lastFrame=-1;this.receivedAt=0;this.rtt=50;this.sent=null;
      this.controls={x:0,y:0,angle:-Math.PI/2,shoot:false};
      this.error={x:0,y:0};this.roundChanged=false;
    }
    recordRTT(ms){this.rtt=this.rtt*.75+clamp(ms,0,N.requestTimeoutMs)*.25;}
    sentInput(seq,controls){
      if(this.sent&&!this.sent.x&&!this.sent.y&&!controls.x&&!controls.y)return;
      this.sent={seq,...controls};
    }
    receive(packet,now,localId){
      if(!packet||!Array.isArray(packet.tanks))return false;
      if(packet.frame!=null&&packet.frame<=this.lastFrame)return false;
      const previous=this.state;
      const newRound=!previous||packet.round!==previous.round||packet.mapSeed!==previous.mapSeed;
      let walls=packet.walls||previous?.walls;
      if(!packet.walls&&packet.terrainPatch){
        if(!previous||packet.terrainPatch.base!==previous.terrainRevision)return false;
        const table=new Map(walls.map(w=>[w.id,w]));
        for(const id of packet.terrainPatch.removed)table.delete(id);
        for(const wall of packet.terrainPatch.upserts)table.set(wall.id,wall);
        walls=[...table.values()];
      } else if(!packet.walls&&(newRound||packet.terrainRevision!==previous.terrainRevision))return false;
      if(!walls)return false;
      this.roundChanged=newRound;
      this.state={...packet,walls};
      if(newRound||now-this.receivedAt>N.staleMs){this.frames=[];this.history=[];this.error={x:0,y:0};}
      this.receivedAt=now;this.lastFrame=packet.frame??this.lastFrame+1;
      this.frames.push({state:this.state,now});if(this.frames.length>N.maxFrames)this.frames.shift();
      const tank=packet.tanks.find(t=>t.id===localId);
      if(!tank){this.local=null;return true;}
      const old=this.local, predicted={...tank,buffs:{...tank.buffs}};
      const reset=newRound||!old||old.deaths!==tank.deaths||old.alive!==tank.alive||packet.phase==='retry';
      if(!reset){
        // Replay actual recent controls, never stale tank velocity or an independently moving target.
        const start=now-Math.min(N.predictionMs,this.rtt/2);
        for(const segment of this.history){
          const from=Math.max(start,segment.from),to=Math.min(now,segment.to);
          if(to>from)engine.movePlayer(this.state,predicted,segment.controls,(to-from)/1000);
        }
        const waitingForStop=this.sent&&!this.sent.x&&!this.sent.y&&
          (packet.acks?.[localId]??-1)<this.sent.seq&&!this.controls.x&&!this.controls.y;
        if(waitingForStop){predicted.x=old.x;predicted.y=old.y;}
        const distance=Math.hypot(old.x-predicted.x,old.y-predicted.y);
        this.error=distance>N.snapDistance?{x:0,y:0}:{x:old.x+this.error.x-predicted.x,y:old.y+this.error.y-predicted.y};
      }else{this.history=[];this.error={x:0,y:0};this.sent=null;}
      this.local=predicted;return true;
    }
    render(now,dt,localId,controls){
      const state=this.state;if(!state)return null;
      this.controls=controls||{x:0,y:0,angle:this.local?.angle||0,shoot:false};
      const active=controls&&now-this.receivedAt<=N.staleMs&&['playing','transition'].includes(state.phase);
      if(this.local&&active){
        this.history.push({from:now-dt*1000,to:now,controls:{...controls}});
        engine.movePlayer(state,this.local,controls,dt);
      }
      this.history=this.history.filter(h=>now-h.to<N.historyMs);
      const waitingForStop=this.sent&&!this.sent.x&&!this.sent.y&&(state.acks?.[localId]??-1)<this.sent.seq;
      if(!waitingForStop){const decay=Math.exp(-dt*N.correctionRate);this.error.x*=decay;this.error.y*=decay;}
      if(this.local)this.local.angle=controls?.angle??this.local.angle;
      const renderTime=state.time+Math.min(N.extrapolationMs/1000,(now-this.receivedAt)/1000)-N.interpolationMs/1000;
      let a=this.frames[0].state,b=a;
      for(const frame of this.frames){b=frame.state;if(b.time>=renderTime)break;a=b;}
      const mix=b.time>a.time?clamp((renderTime-a.time)/(b.time-a.time),0,1):1;
      const oldTanks=new Map(a.tanks.map(t=>[t.id,t]));
      const tanks=b.tanks.map(tank=>{
        if(tank.id===localId&&this.local)return{...this.local,x:this.local.x+this.error.x,y:this.local.y+this.error.y};
        const old=oldTanks.get(tank.id);
        if(!old||old.alive!==tank.alive||old.deaths!==tank.deaths||Math.hypot(old.x-tank.x,old.y-tank.y)>N.snapDistance)return tank;
        return{...tank,x:old.x+(tank.x-old.x)*mix,y:old.y+(tank.y-old.y)*mix,angle:lerpAngle(old.angle,tank.angle,mix),bodyAngle:lerpAngle(old.bodyAngle,tank.bodyAngle,mix)};
      });
      const newer=new Map(b.bullets.map(v=>[v.id,v])),source=mix<1?a:b;
      const bullets=source.bullets.map(bullet=>{
        const next=newer.get(bullet.id);
        if(mix<1&&next)return{...bullet,x:bullet.x+(next.x-bullet.x)*mix,y:bullet.y+(next.y-bullet.y)*mix};
        const age=clamp(renderTime-source.time,0,N.extrapolationMs/1000);
        return{...bullet,x:bullet.x+bullet.vx*age,y:bullet.y+bullet.vy*age};
      });
      return{...state,tanks,bullets};
    }
  }
  return{Timeline,lerpAngle};
});

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.TankNetwork = factory(root.TankEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (engine) {
  'use strict';
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

  class Timeline {
    constructor() { this.reset(); }
    reset() {
      this.frames = []; this.state = null; this.local = null; this.target = null;
      this.lastFrame = -1; this.receivedAt = 0; this.rtt = 50;
    }
    recordRTT(milliseconds) { this.rtt = this.rtt * .75 + clamp(milliseconds, 0, 2000) * .25; }
    receive(packet, now, localId) {
      if (!packet || !Array.isArray(packet.tanks)) return false;
      if (packet.frame != null && packet.frame <= this.lastFrame) return false;
      const newMap = !this.state || packet.mapSeed !== this.state.mapSeed;
      if ((newMap || packet.terrainRevision !== this.state.terrainRevision) && !Array.isArray(packet.walls)) return false;
      const previous = this.state;
      this.state = {...packet, walls: packet.walls || previous.walls};
      if (newMap || now - this.receivedAt > 300) this.frames = [];
      this.receivedAt = now; this.lastFrame = packet.frame ?? this.lastFrame + 1;
      this.frames.push({state: this.state, now});
      if (this.frames.length > 8) this.frames.shift();
      const tank = packet.tanks.find(t => t.id === localId);
      if (!tank) { this.local = this.target = null; return true; }
      this.target = {...tank, buffs: {...tank.buffs}};
      // Bounded dead reckoning compensates transport time; collision rules stay identical.
      const speed = engine.vehicle(tank.vehicle).speed * (tank.buffs.speed > packet.time ? 260 / 175 : 1);
      engine.movePlayer(this.state, this.target, {x: (tank.vx || 0) / speed, y: (tank.vy || 0) / speed, angle: tank.angle}, Math.min(.1, this.rtt / 2000));
      if (!this.local || newMap || this.local.deaths !== tank.deaths || this.local.alive !== tank.alive ||
        Math.hypot(this.local.x - tank.x, this.local.y - tank.y) > 96 || packet.phase !== 'playing') this.local = {...this.target};
      else {
        const {x, y, angle, bodyAngle} = this.local;
        this.local = {...tank, x, y, angle, bodyAngle};
      }
      return true;
    }
    render(now, dt, localId, controls) {
      const state = this.state;
      if (!state) return null;
      const stale = now - this.receivedAt > 250;
      const active = controls && !stale && state.phase === 'playing';
      if (this.local && this.target) {
        if (active) {
          engine.movePlayer(state, this.local, controls, dt);
          engine.movePlayer(state, this.target, controls, dt);
          const dx = this.target.x - this.local.x, dy = this.target.y - this.local.y;
          const distance = Math.hypot(dx, dy), bodyAngle = this.local.bodyAngle;
          const speed = engine.vehicle(this.local.vehicle).speed * (this.local.buffs.speed > state.time ? 260 / 175 : 1);
          if (distance > .25) engine.movePlayer(state, this.local,
            {x: dx / distance, y: dy / distance, angle: controls.angle}, distance / speed * (1 - Math.exp(-dt * 9)));
          this.local.bodyAngle = bodyAngle;
        }
        this.local.angle = controls?.angle ?? this.local.angle;
      }
      // Render other entities on a short jitter buffer, with at most 100 ms extrapolation.
      const renderTime = state.time + Math.min(.1, (now - this.receivedAt) / 1000) - .075;
      let a = this.frames[0].state, b = a;
      for (const frame of this.frames) {
        b = frame.state;
        if (b.time >= renderTime) break;
        a = b;
      }
      const mix = b.time > a.time ? clamp((renderTime - a.time) / (b.time - a.time), 0, 1) : 1;
      const oldTanks = new Map(a.tanks.map(t => [t.id, t]));
      const tanks = b.tanks.map(tank => {
        if (tank.id === localId && this.local) return {...tank, ...this.local};
        const old = oldTanks.get(tank.id);
        if (!old || old.alive !== tank.alive || old.deaths !== tank.deaths || Math.hypot(old.x - tank.x, old.y - tank.y) > 96) return tank;
        return {...tank, x: old.x + (tank.x - old.x) * mix, y: old.y + (tank.y - old.y) * mix,
          angle: lerpAngle(old.angle, tank.angle, mix), bodyAngle: lerpAngle(old.bodyAngle, tank.bodyAngle, mix)};
      });
      const newerBullets = new Map(b.bullets.map(v => [v.id, v]));
      const source = mix < 1 ? a : b;
      const bullets = source.bullets.map(bullet => {
        const next = newerBullets.get(bullet.id);
        if (mix < 1 && next) return {...bullet, x: bullet.x + (next.x - bullet.x) * mix, y: bullet.y + (next.y - bullet.y) * mix};
        const age = clamp(renderTime - source.time, 0, .1);
        return {...bullet, x: bullet.x + bullet.vx * age, y: bullet.y + bullet.vy * age};
      });
      return {...state, tanks, bullets};
    }
  }
  return {Timeline, lerpAngle};
});

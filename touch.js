(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config.js'));
  else root.TankTouch = factory(root.TankConfig);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  function vector(dx, dy, radius) {
    const distance = Math.hypot(dx, dy), strength = Math.min(1, distance / Math.max(1, radius));
    if (strength < C.touch.deadZone) return { x: 0, y: 0, active: false };
    return { x: dx / distance * strength, y: dy / distance * strength, active: true };
  }
  function create({ move, aim, enabled = () => true, onChange = () => {} }) {
    const controls = { x: 0, y: 0, angle: -Math.PI / 2, shoot: false, aiming: false };
    const sticks = [move, aim].map(element => ({ element, pointer: null, knob: element.querySelector('.stick-knob') }));
    function release(stick, notify = true) {
      const pointer = stick.pointer; stick.pointer = null;
      if (pointer !== null && stick.element.hasPointerCapture?.(pointer)) stick.element.releasePointerCapture(pointer);
      stick.knob.style.transform = '';
      stick.element.classList.remove('engaged');
      if (stick.element === move) controls.x = controls.y = 0;
      else controls.shoot = controls.aiming = false;
      if (notify) onChange();
    }
    function update(stick, event) {
      const rect = stick.element.getBoundingClientRect(), radius = Math.min(rect.width, rect.height) * C.touch.stickTravel;
      const direction = vector(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2, radius);
      stick.knob.style.transform = `translate(${direction.x * radius}px, ${direction.y * radius}px)`;
      if (stick.element === move) { controls.x = direction.x; controls.y = direction.y; }
      else {
        if (direction.active) controls.angle = Math.atan2(direction.y, direction.x);
        controls.aiming = true; controls.shoot = direction.active;
      }
      onChange();
    }
    for (const stick of sticks) {
      stick.element.addEventListener('pointerdown', event => {
        if (!enabled() || stick.pointer !== null || event.button !== 0) return;
        event.preventDefault(); stick.pointer = event.pointerId;
        stick.element.setPointerCapture(event.pointerId); stick.element.classList.add('engaged'); update(stick, event);
      });
      stick.element.addEventListener('pointermove', event => {
        if (stick.pointer !== event.pointerId) return;
        if (!enabled()) { release(stick); return; }
        event.preventDefault(); update(stick, event);
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stick.element.addEventListener(type, event => {
        if (stick.pointer === event.pointerId) release(stick);
      });
      stick.element.addEventListener('contextmenu', event => event.preventDefault());
    }
    return { read: () => ({ ...controls }), reset: () => { sticks.forEach(stick => release(stick, false)); onChange(); } };
  }
  return { create, vector };
});

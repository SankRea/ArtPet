const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function floors(displays) {
  return displays.map(display => ({ id: `display:${display.id}`, kind: 'floor', left: display.workArea.x, right: display.workArea.x + display.workArea.width, y: display.workArea.y + display.workArea.height, originX: display.workArea.x }));
}

function stepPhysics(body, geometry, surfaces, dt, walkVelocity) {
  let footX = body.x + geometry.footX;
  if (body.support) {
    const old = body.support;
    const support = surfaces.find(surface => surface.id === old.id && footX + surface.originX - old.originX >= surface.left && footX + surface.originX - old.originX <= surface.right);
    if (support) {
      body.x += support.originX - old.originX;
      body.y = support.y - geometry.footY;
      body.support = support;
    } else body.support = null;
  }
  const previousFoot = body.y + geometry.footY;
  body.x += (body.vx + walkVelocity) * dt;
  footX = body.x + geometry.footX;
  if (body.support && (footX < body.support.left || footX > body.support.right)) body.support = null;
  if (!body.support) {
    body.vy = Math.min(body.vy + 1700 * dt, 1800);
    body.y += body.vy * dt;
    const nextFoot = body.y + geometry.footY;
    const landing = body.vy >= 0 && surfaces.filter(surface => footX >= surface.left && footX <= surface.right && previousFoot <= surface.y + 1 && nextFoot >= surface.y).sort((a, b) => a.y - b.y)[0];
    if (landing) {
      body.y = landing.y - geometry.footY;
      body.vy = 0;
      body.support = landing;
    }
  } else body.vy = 0;
  body.vx *= Math.exp(-(body.support ? 7 : 1.2) * dt);
  if (Math.abs(body.vx) < 3) body.vx = 0;
  return !body.support;
}

module.exports = { clamp, floors, stepPhysics };

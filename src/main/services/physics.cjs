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
  const previousFootX = body.x + geometry.footX;
  const previousFootY = body.y + geometry.footY;
  body.x += (body.vx + walkVelocity) * dt;
  footX = body.x + geometry.footX;
  let departedSupport = null;
  if (body.support && (footX < body.support.left || footX > body.support.right)) {
    departedSupport = body.support;
    body.support = surfaces.find(surface => surface !== departedSupport && Math.abs(surface.y - departedSupport.y) <= 1 && footX >= surface.left && footX <= surface.right) || null;
  }
  if (!body.support) {
    body.vy = Math.min(body.vy + 1700 * dt, 1800);
    body.y += body.vy * dt;
    const nextFootY = body.y + geometry.footY;
    const distance = nextFootY - previousFootY;
    let landing = null, landingTime = Infinity;
    if (body.vy >= 0 && distance >= 0) for (const surface of surfaces) {
      if (departedSupport === surface && Math.abs(previousFootY - surface.y) <= 1) continue;
      if (previousFootY > surface.y + 1 || nextFootY < surface.y) continue;
      const time = distance > 0 ? clamp((surface.y - previousFootY) / distance, 0, 1) : 1;
      const crossingX = previousFootX + (footX - previousFootX) * time;
      if (crossingX < surface.left || crossingX > surface.right) continue;
      if (time < landingTime || (time === landingTime && (!landing || surface.y < landing.y))) {
        landing = surface; landingTime = time;
      }
    }
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

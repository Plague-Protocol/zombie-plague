// Trigonometry and distance that give the same bits in every JavaScript engine.
//
// The standard Math.sin, Math.cos, Math.atan2 and Math.hypot are allowed to differ in their last bit
// between engines (V8 in Chrome and Node, JavaScriptCore in Safari and on every iPhone). One bit is
// enough: it flips a comparison a few thousand steps into a night, and a server replaying an honest
// iPhone run then disagrees with it. These use only + - * / and Math.sqrt, Math.abs and Math.floor,
// which the language specifies exactly, so a replay is the same everywhere.
//
// Accuracy is better than 1e-8 (the tests hold it there), far inside what the game can tell apart.

const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const QUARTER_PI = 0.7853981633974483;
const TAN_EIGHTH_PI = 0.41421356237309503;

export const dhypot = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/** Sine: reduce to [-pi, pi], fold to [-pi/2, pi/2], then a degree-15 odd polynomial (Horner form). */
export function dsin(x: number): number {
  let r = x - TWO_PI * Math.floor(x / TWO_PI + 0.5);
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  const r2 = r * r;
  return r * (1 + r2 * (-1 / 6 + r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800 + r2 * (-1 / 1307674368000))))))));
}

export const dcos = (x: number): number => dsin(x + HALF_PI);

/** Arctangent of u for |u| <= tan(pi/8): a degree-17 odd series. */
function atanSmall(u: number): number {
  const u2 = u * u;
  return u * (1 + u2 * (-1 / 3 + u2 * (1 / 5 + u2 * (-1 / 7 + u2 * (1 / 9 + u2 * (-1 / 11 + u2 * (1 / 13 + u2 * (-1 / 15 + u2 * (1 / 17)))))))));
}

/** Angle of the vector (x, y), in (-pi, pi]: octant reduction, then the series above. */
export function datan2(y: number, x: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax === 0 && ay === 0) return 0;
  const t = (ax < ay ? ax : ay) / (ax < ay ? ay : ax); // 0..1
  let a = t > TAN_EIGHTH_PI ? QUARTER_PI + atanSmall((t - 1) / (t + 1)) : atanSmall(t);
  if (ay > ax) a = HALF_PI - a;
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

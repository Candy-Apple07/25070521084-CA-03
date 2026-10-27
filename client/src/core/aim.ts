// Ray-casts the cue ball along the aim line to draw the guide: ghost ball, object ball path,
// and the cue ball's deflection.

import type { Ball } from './physics';
import type { TableGeometry } from './table';

export interface AimPrediction {
  kind: 'ball' | 'cushion' | 'none';
  /** Where the cue ball centre will be at contact. */
  gx: number; gy: number;
  ballId: number | null;
  /** Object ball direction (unit) for ball hits. */
  ox: number; oy: number;
  /** Cue ball direction after contact (unit, may be zero for a full hit). */
  cx: number; cy: number;
  /** 0 (thin) .. 1 (full ball). */
  fullness: number;
}

export function predictAim(table: TableGeometry, balls: Ball[], fromX: number, fromY: number, dx: number, dy: number): AimPrediction {
  const R = table.R;
  let best = Infinity;
  let res: AimPrediction = { kind: 'none', gx: fromX + dx * 4000, gy: fromY + dy * 4000, ballId: null, ox: 0, oy: 0, cx: dx, cy: dy, fullness: 0 };

  for (const b of balls) {
    if (!b.on || b.id === 0) continue;
    const fx = fromX - b.x, fy = fromY - b.y;
    const bq = fx * dx + fy * dy;
    const c = fx * fx + fy * fy - 4 * R * R;
    const disc = bq * bq - c;
    if (disc < 0) continue;
    const t = -bq - Math.sqrt(disc);
    if (t <= 0 || t >= best) continue;
    best = t;
    const gx = fromX + dx * t, gy = fromY + dy * t;
    let ox = b.x - gx, oy = b.y - gy;
    const ol = Math.sqrt(ox * ox + oy * oy) || 1;
    ox /= ol; oy /= ol;
    const dot = dx * ox + dy * oy;
    let cx = dx - ox * dot, cy = dy - oy * dot;
    const cl = Math.sqrt(cx * cx + cy * cy);
    if (cl > 1e-6) { cx /= cl; cy /= cl; } else { cx = 0; cy = 0; }
    res = { kind: 'ball', gx, gy, ballId: b.id, ox, oy, cx, cy, fullness: dot };
  }

  for (const s of table.segments) {
    const t = sweepSegment(fromX, fromY, dx, dy, R, s.ax, s.ay, s.bx, s.by);
    if (t === null || t >= best) continue;
    best = t;
    const gx = fromX + dx * t, gy = fromY + dy * t;
    // Reflect around the contact normal.
    const ex = s.bx - s.ax, ey = s.by - s.ay;
    const len2 = ex * ex + ey * ey;
    let u = ((gx - s.ax) * ex + (gy - s.ay) * ey) / len2;
    u = Math.max(0, Math.min(1, u));
    let nx = gx - (s.ax + ex * u), ny = gy - (s.ay + ey * u);
    const nl = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nl; ny /= nl;
    const vn = dx * nx + dy * ny;
    res = { kind: 'cushion', gx, gy, ballId: null, ox: 0, oy: 0, cx: dx - 2 * vn * nx, cy: dy - 2 * vn * ny, fullness: 0 };
  }
  return res;
}

function sweepSegment(px: number, py: number, dx: number, dy: number, R: number, ax: number, ay: number, bx: number, by: number): number | null {
  let best: number | null = null;
  const ex = bx - ax, ey = by - ay;
  const len = Math.sqrt(ex * ex + ey * ey);
  const tx = ex / len, ty = ey / len;
  // Normal facing the start point.
  let nx = -ty, ny = tx;
  const side = (px - ax) * nx + (py - ay) * ny;
  if (side < 0) { nx = -nx; ny = -ny; }
  const dist = Math.abs(side);
  const approach = dx * nx + dy * ny;
  if (approach < 0 && dist >= R) {
    const t = (dist - R) / -approach;
    const hx = px + dx * t - nx * R, hy = py + dy * t - ny * R;
    const proj = (hx - ax) * tx + (hy - ay) * ty;
    if (proj >= 0 && proj <= len) best = t;
  }
  for (const [qx, qy] of [[ax, ay], [bx, by]]) {
    const fx = px - qx, fy = py - qy;
    const b = fx * dx + fy * dy;
    const c = fx * fx + fy * fy - R * R;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t > 0 && (best === null || t < best)) best = t;
  }
  return best;
}

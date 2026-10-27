import { cueSkin, CUE_SKINS } from '../render/themes';
import { h } from './dom';

/** A small horizontal drawing of a cue, used in the locker. */
export function cuePreview(id: string): HTMLCanvasElement {
  const c = h('canvas', { width: 520, height: 28, 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  const s = cueSkin(id);
  const W = 520, mid = 14;
  const wAt = (x: number) => 3 + (x / W) * 8;
  const band = (x0: number, x1: number, fill: string | CanvasGradient) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x0, mid - wAt(x0));
    ctx.lineTo(x1, mid - wAt(x1));
    ctx.lineTo(x1, mid + wAt(x1));
    ctx.lineTo(x0, mid + wAt(x0));
    ctx.closePath();
    ctx.fill();
  };
  const grad = (a: string, b: string) => {
    const g = ctx.createLinearGradient(0, mid - 12, 0, mid + 12);
    g.addColorStop(0, b); g.addColorStop(0.45, a); g.addColorStop(1, b);
    return g;
  };
  if (s.glow) { ctx.shadowColor = s.glow; ctx.shadowBlur = 8; }
  band(0, 3, '#3b6fb6');
  band(3, 12, '#f3ecdc');
  band(12, 320, grad(s.shaft, '#9c8660'));
  band(320, 325, s.inlay);
  band(325, 508, grad(s.butt, s.buttDark));
  if (s.stripe) for (let x = 345; x < 495; x += 24) band(x, x + 8, s.stripe);
  band(420, 424, s.inlay);
  band(508, 520, '#121212');
  return c;
}

export function cuePicker(current: string, onPick: (id: string) => void, disabled = false): HTMLElement {
  const wrap = h('div.cue-list', { role: 'group', 'aria-label': 'Cue' });
  for (const s of CUE_SKINS) {
    wrap.append(h('button.cue-opt', {
      type: 'button',
      'aria-pressed': String(s.id === current),
      disabled,
      onclick: () => onPick(s.id),
    }, cuePreview(s.id), h('span', {}, s.name)));
  }
  return wrap;
}

// Small shared pieces for the plain-DOM screens: settings switches and the how-to-play card.

import { prefs, savePrefs } from '../prefs';
import { h } from './dom';
import { icon } from './icons';

// The profile card itself is a React component; the plain-DOM screens open it through this.
export { openProfile } from './ProfileDialog';

export function switchRow(name: string, text: string, value: boolean, onChange: (v: boolean) => void, disabled = false): HTMLElement {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: value, disabled, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
  return h('label.switch', {}, h('span', {}, h('b', {}, name), h('small', {}, text)), input);
}

/** The first time someone sits at a table, show them how to play. */
export function maybeShowHowTo(force = false) {
  if (!force && prefs().seenHowTo) return;
  savePrefs({ seenHowTo: true });
  const scrim = h('div.scrim', {});
  const close = () => scrim.remove();
  scrim.append(h('div.card.panel', { role: 'dialog', 'aria-labelledby': 'howto-title' },
    h('div.card-head', {},
      h('h2', { id: 'howto-title' }, 'How to play'),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('x')),
    ),
    h('ol.steps', {},
      h('li', {}, h('span', {}, h('b', {}, 'Aim'), ' by pointing at the table. Use the ridged wheel (or the arrow keys) for tiny adjustments.')),
      h('li', {}, h('span', {}, h('b', {}, 'Pull back'), ' on the power bar, or click and drag back on the table, then let go to strike.')),
      h('li', {}, h('span', {}, h('b', {}, 'Spin'), ': tap the white ball to choose where the tip hits. Low for screw back, high for follow, sides for side.')),
      h('li', {}, h('span', {}, h('b', {}, 'Ball in hand'), ': drag the cue ball anywhere inside the D before you shoot.')),
    ),
    h('p', {}, 'Snooker: pot a red, then any colour, and repeat. When the reds are gone, clear the colours in order from yellow to black.'),
    h('p', {}, '8-ball: your first pot decides whether you are solids (1–7) or stripes (9–15). Clear your group, then sink the 8 to win. Sink it early and you lose.'),
    h('button.btn.btn-gold.btn-lg.btn-block', { type: 'button', onclick: close }, 'Got it'),
  ));
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim);
}

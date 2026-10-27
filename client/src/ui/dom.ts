type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | number | null | undefined | false;

/** Tiny element builder: h('button.btn', { onclick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K | `${K}.${string}`, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name as K);
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let toastWrap: HTMLElement | null = null;

export function toast(text: string, ms = 2600) {
  if (!toastWrap) {
    toastWrap = h('div.toast-wrap', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastWrap);
  }
  const t = h('div.toast', {}, text);
  toastWrap.append(t);
  setTimeout(() => t.remove(), ms);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }) as HTMLTextAreaElement;
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function chipGroup<T extends string | number>(
  options: Array<{ value: T; label: string }>,
  current: T,
  onPick: (v: T) => void,
  disabled = false,
  label?: string,
): HTMLElement {
  const wrap = h('div.chips', { role: 'group', 'aria-label': label });
  for (const o of options) {
    const b = h('button.chip', {
      type: 'button',
      'aria-pressed': String(o.value === current),
      disabled,
      onclick: () => onPick(o.value),
    }, o.label);
    wrap.append(b);
  }
  return wrap;
}

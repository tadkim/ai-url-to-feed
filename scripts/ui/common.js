// 시작 화면·승인 화면 공통 도우미
// 아이콘은 Lucide만 쓴다 (페이지에서 /ui/lucide.js를 먼저 불러온다). 이름은 lucide.dev의 kebab-case
export function icon(name, size = 16) {
  const key = name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  const node = window.lucide?.icons?.[key];
  if (!node) return null;
  const el = window.lucide.createElement(node);
  el.setAttribute('width', size); el.setAttribute('height', size); el.setAttribute('aria-hidden', 'true');
  el.classList.add('icon');
  return el;
}
export const $ = (s, el = document) => el.querySelector(s);
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
};
export async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
export function toast(msg, bad = false) {
  const t = h('div', { class: `toast${bad ? ' bad' : ''}`, role: 'status' }, icon(bad ? 'circle-alert' : 'circle-check', 16), ' ', msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}
export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했어요. Claude Code에 붙여 넣으세요'); }
  catch { toast('복사하지 못했어요. 직접 선택해서 복사해 주세요', true); }
}
// Claude Code에 붙여 넣을 문장
export const sayBox = (text) => h('div', { class: 'say' }, icon('terminal', 16), h('code', {}, text), h('button', { onclick: () => copy(text), 'aria-label': `${text} 복사` }, icon('copy', 14), ' 복사'));
export const projectFromPath = () => /^\/p\/([a-z0-9-]+)/.exec(location.pathname)?.[1] ?? null;
export function modal(title, ...body) {
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) back.remove(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('h3', {}, title), ...body));
  document.body.append(back);
  return back;
}
export const nn = (n) => String(n).padStart(2, '0');

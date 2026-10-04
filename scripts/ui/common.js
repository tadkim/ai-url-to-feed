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
// 대화 상자: Esc·바깥 누르기로 닫고, 열려 있는 동안 Tab 포커스를 안에 가두고, 닫으면 연 버튼으로 포커스를 돌려준다
export function modal(title, ...body) {
  const opener = document.activeElement;
  const id = `m${Math.random().toString(36).slice(2, 8)}`;
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id }, h('h3', { id }, title), ...body);
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } }, box);
  const focusables = () => [...box.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') { const f = focusables(); if (!f.length) return; const [a, z] = [f[0], f.at(-1)]; if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); } }
  };
  function close() { if (!back.isConnected) return; document.removeEventListener('keydown', onKey); back.remove(); opener?.focus?.(); }
  back.close = close;
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  (box.querySelector('[autofocus]') ?? focusables()[0])?.focus();
  return back;
}

// 되돌릴 수 없는 일 확인 (참고: 미리캔버스 워크스페이스 삭제 — 무엇이 사라지는지, 경고, 이름을 똑같이 입력해야 버튼이 켜진다)
// opts: { title, desc, items: [[아이콘, 글]], warn, option: { label, hint }, word, confirmText, onConfirm(optionChecked) }
export function dangerDialog({ title, desc, items = [], warn, option, word, confirmText, onConfirm }) {
  const input = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', autofocus: true, 'aria-label': `확인을 위해 ${word} 입력` });
  const check = option && h('input', { type: 'checkbox' });
  const err = h('div', { class: 'dz-err', role: 'alert' });
  const go = h('button', { class: 'dz-go', disabled: true }, icon('trash-2', 15), ` ${confirmText}`);
  const cancel = h('button', { class: 'dz-cancel' }, '취소');
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== word; });
  const m = modal(title,
    h('button', { class: 'dz-x', 'aria-label': '닫기', onclick: () => m.close() }, icon('x', 18)),
    desc && h('p', { class: 'dz-desc' }, desc),
    items.length ? h('ul', { class: 'dz-list' }, items.map(([ic, text]) => h('li', {}, icon(ic, 15), h('span', {}, text)))) : null,
    warn && h('div', { class: 'dz-warn', role: 'note' }, icon('triangle-alert', 16), h('div', {}, warn)),
    option && h('label', { class: 'dz-opt' }, check, h('span', {}, h('b', {}, option.label), option.hint && h('small', {}, option.hint))),
    h('label', { class: 'dz-word' }, h('span', {}, '확인을 위해 이름(', h('code', {}, word), ')을 그대로 입력해요'), input),
    err,
    h('div', { class: 'dz-foot' }, cancel, go));
  m.querySelector('.modal').classList.add('dz');
  cancel.addEventListener('click', () => m.close());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
  go.addEventListener('click', async () => {
    go.disabled = true; cancel.disabled = true; input.disabled = true;
    go.replaceChildren(icon('loader-circle', 15), ' 처리 중…');
    go.querySelector('.icon')?.classList.add('spin');
    try { await onConfirm(!!check?.checked); m.close(); }
    catch (e) { err.textContent = e.message; go.replaceChildren(icon('trash-2', 15), ` ${confirmText}`); go.disabled = false; cancel.disabled = false; input.disabled = false; }
  });
  return m;
}
export const nn = (n) => String(n).padStart(2, '0');

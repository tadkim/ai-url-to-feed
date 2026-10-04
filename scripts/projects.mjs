// projects.yaml 쓰기: 주소로 프로젝트 등록, 사이트별 설정(mode, bg, asset_count …) 바꾸기.
// 시작 화면(app.mjs)과 명령줄(cli.mjs)이 같이 쓴다. 사람이 단 주석은 지우지 않는다 (YAML 문서 그대로 고친다).
import fs from 'node:fs';
import YAML from 'yaml';
import { PROJECTS_FILE, loadRules, readText, exists, withScheme, isHex } from './lib.mjs';

const EMPTY = '# 이 컴퓨터의 프로젝트 목록. git에 올리지 않는다 (.gitignore). 형식은 projects.example.yaml\nprojects: {}\n';
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

// 주소 → 프로젝트 이름 (stuckyi.studio → stuckyi, localhost:3000 → local-3000)
export function slug(u) {
  const host = u.hostname.replace(/^www\./, '');
  const base = LOCAL_HOSTS.includes(host) ? `local-${u.port || 80}` : host.split('.').slice(0, -1).join('-') || host;
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'site';
}

export function parseUrl(raw) {
  let u;
  try { u = new URL(withScheme(raw)); } catch { throw new Error('주소 형식이 아니에요 (예: stuckyi.studio, localhost:3000)'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('http:// 또는 https:// 주소만 쓸 수 있어요');
  return { u, url: `${u.origin}${u.pathname}`.replace(/\/+$/, ''), local: LOCAL_HOSTS.includes(u.hostname) };
}

// 사이트가 응답하는지, 지금 페이지 제목이 무엇인지 (title을 주면 같은지도 본다)
export async function siteInfo(conf) {
  try {
    const r = await fetch(`${conf.url}/`, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    const html = await r.text();
    const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').trim();
    const ok = r.ok && (conf.title == null || title === String(conf.title));
    return { ok, title, error: ok ? null : r.ok ? `제목이 다름: "${title}"` : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, title: null, error: conf.target === 'local' ? '응답 없음 — 개발 서버를 먼저 띄워요' : `응답 없음 (${e.message})` };
  }
}

// "6" → [6, 6], "5-8" → [5, 8]. rules.yaml assets.count 범위 안이어야 한다
export function parseCount(v, rules = loadRules()) {
  const m = /^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(String(v).trim());
  const [lo, hi] = rules.assets.count;
  const r = m && [Number(m[1]), Number(m[2] ?? m[1])];
  if (!r || r[0] > r[1] || r[0] < lo || r[1] > hi) throw new Error(`게시물 수는 ${lo}~${hi} 사이 숫자 하나 또는 범위예요 (예: 6, 5-8): ${v}`);
  return r;
}

export function normalizeBg(v) {
  const hex = String(v).trim().replace(/^([0-9a-f]{6})$/i, '#$1');
  if (!isHex(hex)) throw new Error(`배경색은 #RRGGBB 형식이에요 (예: #B987FF): ${v}`);
  return hex.toUpperCase();
}

const readDoc = () => {
  const doc = YAML.parseDocument(exists(PROJECTS_FILE) ? readText(PROJECTS_FILE) : EMPTY);
  if (!doc.get('projects')) doc.set('projects', doc.createNode({}));
  return doc;
};
const writeDoc = (doc) => {
  doc.get('projects').flow = false;   // 빈 목록 "{}"에서 시작해도 사람이 읽기 쉬운 블록 형식으로 쓴다
  fs.writeFileSync(PROJECTS_FILE, String(doc));
};

// 사이트별 설정 바꾸기. 값이 null이면 그 줄을 지운다 (기본값으로 돌아간다). 바뀐 키 목록을 돌려준다
export function setProjectFields(project, fields) {
  const doc = readDoc();
  if (!doc.hasIn(['projects', project])) throw new Error(`projects.yaml에 없는 프로젝트예요: ${project}`);
  const changed = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const before = doc.getIn(['projects', project, k]);
    const cur = before?.toJSON?.() ?? before;
    if (JSON.stringify(cur ?? null) === JSON.stringify(v)) continue;
    if (v === null) doc.deleteIn(['projects', project, k]); else doc.setIn(['projects', project, k], v);
    changed.push(k);
  }
  if (changed.length) writeDoc(doc);
  return changed;
}

// mode·bg·count를 projects.yaml 값으로 바꾼다. 기본값(auto, rules.yaml 범위)이면 줄을 지운다
export function projectFields({ mode, bg, count } = {}, rules = loadRules()) {
  const out = {};
  if (mode !== undefined) {
    if (!(rules.modes ?? []).includes(mode)) throw Object.assign(new Error(`mode는 ${(rules.modes ?? []).join(' | ')} 중 하나`), { code: 400 });
    out.mode = mode === (rules.default_mode ?? 'auto') ? null : mode;
  }
  if (bg !== undefined) out.bg = bg === null ? null : normalizeBg(bg);
  if (count !== undefined) {
    const c = count === null ? null : parseCount(count, rules);
    out.asset_count = !c || (c[0] === rules.assets.count[0] && c[1] === rules.assets.count[1]) ? null : c;
  }
  return out;
}

// 주소로 등록한다. 이미 있는 주소면 그 이름을 돌려주고 opts의 설정만 바꾼다 (update: false면 그대로 둔다).
// 내 컴퓨터 주소는 다른 앱을 녹화하지 않게 지금 페이지 제목을 같이 적는다 (title을 주면 그 값)
export async function addProject(raw, opts = {}, { checkSite = siteInfo, update = true } = {}) {
  const rules = loadRules();
  const { u, url, local } = parseUrl(raw);
  const fields = projectFields(opts, rules);
  const doc = readDoc();
  const existing = doc.get('projects').toJSON?.() ?? {};
  const same = Object.entries(existing).find(([, p]) => String(p?.url ?? '').replace(/\/+$/, '') === url);
  if (same) return { name: same[0], url, existed: true, changed: update ? setProjectFields(same[0], fields) : [] };
  let name = slug(u);
  for (let i = 2; existing[name]; i++) name = `${slug(u)}-${i}`;
  const entry = { url };
  if (local || opts.local) {
    let title = opts.title;
    if (title == null) {
      const s = await checkSite({ url, title: null, target: 'local' });
      if (!s.ok) throw new Error(s.error);
      title = s.title;
    }
    Object.assign(entry, { title, target: 'local' });
  } else if (opts.title != null) entry.title = opts.title;
  for (const [k, v] of Object.entries(fields)) if (v !== null) entry[k] = v;
  doc.setIn(['projects', name], doc.createNode(entry));
  writeDoc(doc);
  return { name, url, existed: false, changed: [] };
}

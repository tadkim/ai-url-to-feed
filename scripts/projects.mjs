// projects.yaml 쓰기: 주소로 프로젝트 등록, 사이트별 설정(mode, bg, asset_count …) 바꾸기.
// 시작 화면(app.mjs)과 명령줄(cli.mjs)이 같이 쓴다. 사람이 단 주석은 지우지 않는다 (YAML 문서 그대로 고친다).
import fs from 'node:fs';
import YAML from 'yaml';
import path from 'node:path';
import { ROOT, RUNS, PROJECTS_FILE, loadRules, readText, exists, withScheme, isHex, projectConf, runPath, stateDir, now, runningCli, runningAgent, runningTask } from './lib.mjs';

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

// ---- 삭제: 진행 중이면 멈추고, 등록·기록·캐시를 지운다 ----
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const KEEP_DIR = '_kept';   // 남겨 둔 게시물 파일: runs/_kept/<프로젝트>-<시각>/

// 삭제 확인 창에 보여 줄 내용: 무엇이 지워지는지, 지금 진행 중인지
export function projectSummary(rules, project) {
  const dir = runPath(project, '');
  const list = (rel, re) => { const d = path.join(dir, rel); return exists(d) ? fs.readdirSync(d).filter((f) => re.test(f)) : []; };
  const cli = runningCli(project);
  const agent = runningAgent(project);
  const task = runningTask(project);
  return {
    project, url: projectConf(rules, project).url,
    posts: list('export', /^\d+\.(mp4|png)$/).length,
    recordings: list('raw', /\.mp4$/).length,
    running: cli || agent || task ? {
      cli: !!cli, task: task?.task ?? null, agent: agent?.agent ?? null, since: cli?.started_at ?? agent?.started_at ?? task?.started_at ?? null,
      // 명령줄이 띄우지 않은 에이전트(대화창의 Claude Code)는 여기서 멈출 수 없다
      chat: !!agent && !agent.owner_pid && !cli,
    } : null,
  };
}

// 진행 중인 것을 멈춘다: 명령줄(SIGTERM → 스스로 Claude Code 묶음을 끈다) → 응답이 없으면 강제로, 녹화·내보내기 프로세스.
// 남는 프로세스가 없게 프로세스 묶음 단위로 끈다
export async function stopProject(project) {
  const stopped = [];
  const cli = runningCli(project);
  if (cli) {
    try { process.kill(cli.pid, 'SIGTERM'); } catch { /* 이미 끝났다 */ }
    for (let i = 0; i < 25 && alive(cli.pid); i++) await sleep(200);
    if (alive(cli.pid)) { try { process.kill(cli.pid, 'SIGKILL'); } catch { /* 이미 끝났다 */ } }
    if (cli.child) { try { process.kill(-cli.child, 'SIGKILL'); } catch { /* 이미 끝났다 */ } }
    stopped.push('명령줄');
  }
  const task = runningTask(project);
  if (task) {
    try { process.kill(task.pid, 'SIGTERM'); } catch { /* 이미 끝났다 */ }
    for (let i = 0; i < 25 && alive(task.pid); i++) await sleep(200);
    if (alive(task.pid)) { try { process.kill(task.pid, 'SIGKILL'); } catch { /* 이미 끝났다 */ } }
    stopped.push(task.task === 'record' ? '녹화' : '내보내기');
  }
  return stopped;
}

export async function deleteProject(project, { keepExport = false } = {}) {
  const rules = loadRules();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project) || !rules.projects[project]) throw Object.assign(new Error(`projects.yaml에 없는 프로젝트예요: ${project}`), { code: 404 });
  const url = projectConf(rules, project).url;
  const stopped = await stopProject(project);
  let kept = null;
  const exp = runPath(project, 'export');
  if (keepExport && exists(exp) && fs.readdirSync(exp).some((f) => /^\d+\.(mp4|png)$/.test(f))) {
    const stamp = now().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    kept = path.join(RUNS, KEEP_DIR, `${project}-${stamp}`);
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.renameSync(exp, kept);
  }
  // 프로젝트 이름은 projects.yaml에 있는 것만 받으므로 경로 밖을 지우지 않는다
  const sd = stateDir(rules);
  const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
  rm(runPath(project, ''));
  for (const p of [path.join(sd, 'state', `${project}.json`), path.join(sd, 'log', `${project}.jsonl`), path.join(sd, 'log', `${project}-claude.log`), path.join(sd, 'log', `${project}-cli.jsonl`),
    path.join(RUNS, '.harness', 'busy', `${project}.json`), path.join(RUNS, '.harness', 'cli', `${project}.json`)]) rm(p);
  const scope = path.join(RUNS, '.harness', 'scope');
  if (exists(scope)) for (const f of fs.readdirSync(scope)) if (f.startsWith(`${project}-`) && /^P\d\.json$/.test(f.slice(project.length + 1))) rm(path.join(scope, f));
  for (const d of ['explore', 'try', 'frames', 'thumbs']) rm(path.join(ROOT, '.cache', d, project));
  const act = path.join(ROOT, '.cache', 'activity');
  const mine = new RegExp(`^${project}(-[0-9a-f]{8})?\\.jsonl$`);
  if (exists(act)) for (const f of fs.readdirSync(act)) if (mine.test(f)) rm(path.join(act, f));
  const doc = readDoc();
  doc.deleteIn(['projects', project]);
  writeDoc(doc);
  return { project, url, stopped, kept: kept && path.relative(ROOT, kept) };
}

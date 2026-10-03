#!/usr/bin/env node
// 시작 화면 서버: URL 등록, 7단계 진행 상황, 녹화 확인·완성본 승인(비교 화면), 편집 화면.
// 사용: npm start  (= node scripts/app.mjs [--port N] [--no-open])
//   - 127.0.0.1에서만 연다. 포트가 쓰이고 있으면 다음 빈 포트를 쓴다.
//   - 승인·거절 버튼은 사람이 누를 때만 run.mjs approve|reject를 실행한다 (Claude Code에 말로 하는 것과 같은 기록).
//   - 녹화·편집값 같은 AI 작업은 Claude Code에서 진행한다. 화면은 지금 할 일과 붙여 넣을 문장을 알려 준다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import {
  ROOT, PROJECTS_FILE, loadRules, projectConf, loadContext, readIf, readText, exists, derivedPath, runPath, planHash, finalHash,
  latestHistory, progress, runningAgent, toolProblems, isHuman, assetFile, now, loadState,
} from './lib.mjs';
import { send, readBody, editorRoutes, serveRunFile, serveUi, safeStatus, listen, TYPES } from './server.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : undefined; };
const UI = path.join(ROOT, 'scripts', 'ui');

// ---- 실행 환경 (1단계): 시작할 때 한 번, 그리고 요청이 있을 때 ----
const env = { tools: [], chromium: true };
async function checkEnv() {
  env.tools = toolProblems(loadRules());
  try { const { chromium } = await import('playwright'); env.chromium = fs.existsSync(chromium.executablePath()); } catch { env.chromium = false; }
}
// 사이트 응답 (2단계): 프로젝트마다 마지막 확인 결과를 기억한다
const sites = new Map();
async function checkSite(conf) {
  try {
    const r = await fetch(`${conf.url}/`, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    const html = await r.text();
    const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').trim();
    const ok = r.ok && (conf.title == null || title === String(conf.title));
    sites.set(conf.url, { ok, title, error: ok ? null : r.ok ? `제목이 다름: "${title}"` : `HTTP ${r.status}`, at: now() });
  } catch (e) {
    sites.set(conf.url, { ok: false, title: null, error: conf.target === 'local' ? '응답 없음 — 개발 서버를 먼저 띄워요' : `응답 없음 (${e.message})`, at: now() });
  }
  return sites.get(conf.url);
}

function progressOf(rules, project) {
  const base = loadState(rules, project);
  const conf = projectConf(rules, project);
  if (!sites.has(conf.url)) checkSite(conf);   // 처음 한 번은 뒤에서 확인한다
  return progress(rules, project, base, safeStatus(rules, project), { ...env, site: sites.get(conf.url) });
}

// ---- 프로젝트 등록: URL 하나로 projects.yaml에 추가한다 ----
function slug(u) {
  const host = u.hostname.replace(/^www\./, '');
  const base = ['localhost', '127.0.0.1'].includes(host) ? `local-${u.port || 80}` : host.split('.').slice(0, -1).join('-') || host;
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'site';
}
async function addProject(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('주소 형식이 아니에요 (https://로 시작해요)'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('http:// 또는 https:// 주소만 쓸 수 있어요');
  const url = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  const doc = exists(PROJECTS_FILE) ? YAML.parseDocument(readText(PROJECTS_FILE)) : YAML.parseDocument('# 이 컴퓨터의 프로젝트 목록. git에 올리지 않는다 (.gitignore). 형식은 projects.example.yaml\nprojects: {}\n');
  if (!doc.get('projects')) doc.set('projects', doc.createNode({}));
  const existing = doc.get('projects').toJSON?.() ?? {};
  const same = Object.entries(existing).find(([, p]) => String(p?.url ?? '').replace(/\/+$/, '') === url);
  if (same) return { name: same[0], existed: true };
  let name = slug(u);
  for (let i = 2; existing[name]; i++) name = `${slug(u)}-${i}`;
  const entry = { url };
  if (local) {
    // 로컬 개발 서버는 다른 앱을 녹화하지 않게 지금 페이지 제목을 같이 적는다
    const s = await checkSite({ url, title: null, target: 'local' });
    if (!s.ok) throw new Error(s.error);
    Object.assign(entry, { title: s.title, target: 'local' });
  }
  doc.setIn(['projects', name], doc.createNode(entry));
  doc.get('projects').flow = false;   // 빈 목록 "{}"에서 시작해도 사람이 읽기 쉬운 블록 형식으로 쓴다
  fs.writeFileSync(PROJECTS_FILE, String(doc));
  return { name, existed: false };
}

// ---- 승인 비교 화면 데이터 ----
const fileUrl = (project, rel) => `/p/${project}/files/${rel}`;
function planCompare(rules, project) {
  const ctx = loadContext(rules, project);
  const recs = (raw, prefix) => (raw?.recordings ?? []).filter((r) => !r.error).map((r) => ({ name: r.name, duration: r.duration, writes_blocked: r.writes_blocked, writes_seen: r.writes_seen, video: fileUrl(project, `${prefix}raw/${r.file}`), sheet: fileUrl(project, `${prefix}raw/${r.sheet}`), sheet_every: r.sheet_every }));
  const prev = latestHistory(project, 'plan');
  const st = loadState(rules, project);
  return {
    project, hash: planHash(rules, project), status: safeStatus(rules, project),
    plan: ctx.plan, recordings: recs(ctx.raw, ''),
    previous: prev ? { at: prev.at, note: st.plan_notes?.at(-1)?.note ?? null, plan: readIf(path.join(prev.dir, 'plan/plan.json'), true), recordings: recs(readIf(path.join(prev.dir, 'raw/manifest.json'), true), `${prev.rel}/`) } : null,
  };
}
function diffEdits(prevEdits, curEdits) {
  const out = {};
  if (!prevEdits || !curEdits) return { style: [], assets: out };
  const style = Object.keys(curEdits.style ?? {}).filter((k) => prevEdits.style?.[k] !== curEdits.style[k]).map((k) => ({ key: k, from: prevEdits.style?.[k], to: curEdits.style[k] }));
  for (const a of curEdits.assets) {
    const b = prevEdits.assets.find((x) => x.n === a.n);
    if (!b) { out[a.n] = ['새로 추가']; continue; }
    const d = [];
    if (a.type !== b.type || a.layout !== b.layout) d.push(`배치 ${b.layout} → ${a.layout}`);
    if (a.type === 'video') {
      if (a.source !== b.source) d.push(`원본 ${b.source} → ${a.source}`);
      if (a.in !== b.in || a.out !== b.out) d.push(`구간 ${b.in}~${b.out}초 → ${a.in}~${a.out}초`);
      if ((a.speed ?? 1) !== (b.speed ?? 1)) d.push(`속도 ${b.speed ?? 1}x → ${a.speed ?? 1}x`);
    } else {
      (a.shots ?? []).forEach((s, i) => { const p = b.shots?.[i]; if (!p || p.at !== s.at || p.source !== s.source) d.push(`화면 ${i + 1} ${p ? `${p.at}초` : '없음'} → ${s.at}초`); });
    }
    if (d.length) out[a.n] = d;
  }
  return { style, assets: out };
}
function finalCompare(rules, project) {
  const ctx = loadContext(rules, project);
  const prev = latestHistory(project, 'final');
  const prevEdits = prev ? readIf(path.join(prev.dir, 'edit/edits.json'), true) : null;
  const prevExp = prev ? readIf(path.join(prev.dir, 'export/manifest.json'), true) : null;
  const st = loadState(rules, project);
  const p4 = readIf(derivedPath(rules, project, 'p4'), true);
  const planned = (n) => ctx.plan?.assets?.find((x) => x.n === n);
  const exp = ctx.exp;
  return {
    project, hash: finalHash(rules, project), status: safeStatus(rules, project),
    canvas: rules.assets.canvas, style: ctx.edits?.style ?? null,
    gate: p4 ? { pass: p4.pass, results: p4.results.filter((r) => !isHuman(rules, r.gate)) } : null,
    assets: (ctx.edits?.assets ?? []).map((a) => {
      const m = exp?.assets.find((x) => x.n === a.n);
      const pa = prevExp?.assets.find((x) => x.n === a.n);
      return {
        n: a.n, type: a.type, layout: a.layout, scene: a.scene ?? planned(a.n)?.scene ?? '',
        planned: planned(a.n) ? { type: planned(a.n).type, layout: planned(a.n).layout, scene: planned(a.n).scene } : null,
        file: m && exists(runPath(project, `export/${assetFile(a)}`)) ? `${fileUrl(project, `export/${assetFile(a)}`)}?v=${m.hash}` : null,
        previous: pa ? fileUrl(project, `${prev.rel}/export/${pa.file}`) : null,
        seconds: a.type === 'video' ? Math.round(((a.out - a.in) / (a.speed ?? 1)) * 10) / 10 : null,
      };
    }),
    previous: prev ? { at: prev.at, note: st.final_notes?.at(-1)?.note ?? null } : null,
    changes: diffEdits(prevEdits, ctx.edits),
  };
}

// ---- 승인·거절: 사람이 버튼을 눌렀을 때만 ----
async function decide(rules, project, what, action, body) {
  if (!['plan', 'final'].includes(what)) throw Object.assign(new Error('what은 plan | final'), { code: 400 });
  const agent = runningAgent(project);
  if (agent) throw Object.assign(new Error('AI가 작업 중이라 지금은 승인·거절할 수 없어요. 끝난 뒤 다시 해 주세요'), { code: 409 });
  const want = what === 'plan' ? 'APPROVAL_PLAN' : 'APPROVAL_FINAL';
  const s = safeStatus(rules, project);
  if (s.next !== want) throw Object.assign(new Error(`지금은 ${what === 'plan' ? '녹화 확인' : '완성본'} 승인 단계가 아니에요 (${s.reason})`), { code: 409 });
  if (action === 'approve') {
    const hash = what === 'plan' ? planHash(rules, project) : finalHash(rules, project);
    if (body.hash !== hash) throw Object.assign(new Error('화면을 연 뒤 내용이 바뀌었어요. 새로고침해서 다시 확인해 주세요'), { code: 409 });
    return runScriptArgs(['approve', project, what]);
  }
  const note = String(body.note ?? '').trim();
  if (!note) throw Object.assign(new Error('무엇을 고칠지 적어 주세요'), { code: 400 });
  return runScriptArgs(['reject', project, what, '--note', note]);
}
const runScriptArgs = (argv) => new Promise((ok) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run.mjs'), ...argv], { env: process.env });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => ok({ code, out }));
});

// ---- 라우팅 ----
const page = (res, name) => send(res, 200, fs.readFileSync(path.join(UI, name)), TYPES['.html']);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = decodeURIComponent(url.pathname);
    const rules = loadRules();
    if (req.method === 'GET' && p === '/') return page(res, 'home.html');
    if (serveUi(req, res, p)) return undefined;
    if (req.method === 'GET' && p.startsWith('/docs/')) {
      // 문서 링크는 GitHub에서 보는 것이 읽기 편하다
      res.writeHead(302, { Location: `https://github.com/tadkim/ai-url-to-feed/blob/main${p}` }); return res.end();
    }
    if (req.method === 'GET' && p === '/api/projects') {
      if (url.searchParams.get('recheck') === '1') { await checkEnv(); await Promise.all(Object.keys(rules.projects).map((k) => checkSite(projectConf(rules, k)))); }
      return send(res, 200, { env, projects_file: exists(PROJECTS_FILE), projects: Object.keys(rules.projects).map((k) => progressOf(rules, k)) });
    }
    if (req.method === 'POST' && p === '/api/projects') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const r = await addProject(body.url);
        const fresh = loadRules();
        await checkSite(projectConf(fresh, r.name));
        return send(res, 200, { ...r, progress: progressOf(fresh, r.name) });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    const m = /^\/(api\/projects|p)\/([a-z0-9][a-z0-9-]*)(?:\/(.*))?$/.exec(p);
    if (m) {
      const [, kind, project, rest = ''] = m;
      if (!rules.projects[project]) return send(res, 404, { error: `등록되지 않은 프로젝트: ${project}` });
      if (kind === 'api/projects') {
        if (req.method === 'GET' && rest === 'progress') return send(res, 200, progressOf(rules, project));
        if (req.method === 'GET' && rest === 'compare/plan') return send(res, 200, planCompare(rules, project));
        if (req.method === 'GET' && rest === 'compare/final') return send(res, 200, finalCompare(rules, project));
        const d = /^(approve|reject)\/(plan|final)$/.exec(rest);
        if (req.method === 'POST' && d) {
          try {
            const body = JSON.parse((await readBody(req)) || '{}');
            const r = await decide(rules, project, d[2], d[1], body);
            if (r.code !== 0) return send(res, 500, { error: r.out.trim().split('\n').pop() });
            return send(res, 200, { ok: true, progress: progressOf(loadRules(), project) });
          } catch (e) { return send(res, e.code ?? 500, { error: e.message }); }
        }
        if (req.method === 'POST' && rest === 'open-export') {
          const dir = runPath(project, 'export');
          const opener = { darwin: 'open', win32: 'explorer', linux: 'xdg-open' }[process.platform];
          if (opener && exists(dir)) spawn(opener, [dir], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
          return send(res, 200, { ok: true, dir });
        }
        return send(res, 404, { error: 'not found' });
      }
      // /p/<project>/...
      if (rest === '' || rest === 'approve/plan' || rest === 'approve/final') return page(res, rest === '' ? 'home.html' : rest === 'approve/plan' ? 'approve-plan.html' : 'approve-final.html');
      if (rest.startsWith('files/')) return serveRunFile(req, res, project, rest.slice('files/'.length));
      if (rest === 'edit') { res.writeHead(302, { Location: `/p/${project}/edit/` }); return res.end(); }
      if (rest.startsWith('edit/') && (await editorRoutes(req, res, project, rest.slice('edit/'.length), url))) return undefined;
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

await checkEnv();
listen(server, {
  port: Number(opt('--port') ?? loadRules().review.port), fixed: opt('--port') != null, label: 'app', open: !args.includes('--no-open'),
  onReady: (addr) => console.log(`시작 화면: ${addr}  (끝내려면 Ctrl+C)`),
});

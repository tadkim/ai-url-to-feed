#!/usr/bin/env node
// 시작 화면 서버: URL 등록, 7단계 진행 상황, 녹화 확인·완성본 승인(비교 화면), 편집 화면.
// 사용: npm start  (= node scripts/app.mjs [--port N] [--no-open] [--path /p/<project>/edit/])
//   - 127.0.0.1에서만 연다. 포트가 쓰이고 있으면 다음 빈 포트를 쓴다.
//   - 승인·거절 버튼은 사람이 누를 때만 run.mjs approve|reject를 실행한다 (Claude Code에 말로 하는 것과 같은 기록).
//   - 녹화·편집값 같은 AI 작업은 Claude Code에서 진행한다. 화면은 지금 할 일과 붙여 넣을 문장을 알려 준다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ROOT, PROJECTS_FILE, loadRules, projectConf, loadContext, readIf, exists, derivedPath, runPath, planHash, finalHash,
  latestHistory, progress, runningAgent, toolProblems, isHuman, assetFile, now, loadState,
  applyPlanAssets, planErrors, writeJson, phasePath, appendLog, ff,
} from './lib.mjs';
import { addProject, setProjectFields, projectFields, siteInfo, projectSummary, deleteProject } from './projects.mjs';
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
const checking = new Map();   // 확인 중인 주소 → Promise (화면이 3초마다 물어도 한 번만 보낸다)
function checkSite(conf) {
  if (!checking.has(conf.url)) checking.set(conf.url, fetchSite(conf).finally(() => checking.delete(conf.url)));
  return checking.get(conf.url);
}
async function fetchSite(conf) {
  sites.set(conf.url, { ...(await siteInfo(conf)), at: now() });
  return sites.get(conf.url);
}

function progressOf(rules, project) {
  const base = loadState(rules, project);
  const conf = projectConf(rules, project);
  if (!sites.has(conf.url)) checkSite(conf);   // 처음 한 번은 뒤에서 확인한다
  const out = progress(rules, project, base, safeStatus(rules, project), { ...env, site: sites.get(conf.url) });
  return { ...out, ...previews(rules, project) };
}
// 진행 화면에 보여 줄 미리보기: 지금까지 찍은 장면(녹화 주요 장면)과 완성된 게시물 파일
function previews(rules, project) {
  const ctx = loadContext(rules, project);
  const scenes = [];
  for (const r of (ctx.raw?.recordings ?? []).filter((x) => !x.error)) {
    const p = ctx.plan?.recordings?.find((x) => x.name === r.name);
    for (const m of highlightsOf(ctx, r, p).highlights) scenes.push({ rec: r.name, t: m.t, text: m.text, thumb: `/api/projects/${project}/thumb?rec=${encodeURIComponent(r.name)}&t=${m.t.toFixed(1)}` });
  }
  const posts = ctx.exp && ctx.edits ? ctx.edits.assets.map((a) => {
    const m = ctx.exp.assets.find((x) => x.n === a.n);
    const file = m && exists(runPath(project, `export/${assetFile(a)}`)) ? `${fileUrl(project, `export/${assetFile(a)}`)}?v=${m.hash}` : null;
    return { n: a.n, type: a.type, file, seconds: a.type === 'video' ? Math.round(((a.out - a.in) / (a.speed ?? 1)) * 10) / 10 : null, scene: a.scene ?? ctx.plan?.assets?.find((x) => x.n === a.n)?.scene ?? '' };
  }).filter((x) => x.file) : [];
  return { scenes: scenes.slice(0, 8), posts };
}

// 진행 방식 바꾸기 (projects.yaml의 mode). AI가 일하는 중에는 바꾸지 않는다
function setMode(project, mode) {
  const fields = projectFields({ mode });
  if (runningAgent(project)) throw Object.assign(new Error('AI가 작업 중이라 지금은 바꿀 수 없어요'), { code: 409 });
  setProjectFields(project, fields);
}

// ---- 승인 비교 화면 데이터 ----
const fileUrl = (project, rel) => `/p/${project}/files/${rel}`;
function planCompare(rules, project) {
  const ctx = loadContext(rules, project);
  const conf = projectConf(rules, project);
  const recs = (raw, prefix) => (raw?.recordings ?? []).filter((r) => !r.error).map((r) => ({ name: r.name, duration: r.duration, writes_blocked: r.writes_blocked, writes_seen: r.writes_seen, video: fileUrl(project, `${prefix}raw/${r.file}`), sheet: fileUrl(project, `${prefix}raw/${r.sheet}`), sheet_every: r.sheet_every }));
  const prev = latestHistory(project, 'plan');
  const st = loadState(rules, project);
  const status = safeStatus(rules, project);
  const recordings = recs(ctx.raw, '').map((r) => {
    const p = ctx.plan?.recordings?.find((x) => x.name === r.name);
    return { ...r, note: p?.note ?? '', ...highlightsOf(ctx, r, p) };
  });
  return {
    project, hash: planHash(rules, project), status,
    mode: conf.mode,
    editable: status.next === 'APPROVAL_PLAN' && !runningAgent(project),
    // 다시 찍기 요청: review 모드는 녹화 확인 단계에서, edit·auto 모드는 완성된 뒤에도 할 수 있다
    retake: !runningAgent(project) && ['APPROVAL_PLAN', 'APPROVAL_FINAL', 'DONE'].includes(status.next),
    limits: { count: conf.count, maxVideoSeconds: conf.maxVideoSeconds },
    plan: ctx.plan, recordings,
    previous: prev ? { at: prev.at, note: st.plan_notes?.at(-1)?.note ?? null, plan: readIf(path.join(prev.dir, 'plan/plan.json'), true), recordings: recs(readIf(path.join(prev.dir, 'raw/manifest.json'), true), `${prev.rel}/`) } : null,
  };
}
// 주요 장면: planner가 쓴 highlights(무엇을 어떻게 찍었는지). 없으면 에셋 cue와 처음·끝으로 고른다
function highlightsOf(ctx, r, p) {
  const clamp = (t) => Math.max(0, Math.min(Number(t), r.duration - 0.1));
  if (p?.highlights?.length) return { highlights: p.highlights.map((x) => ({ t: clamp(x.t), text: x.text })), highlights_auto: false };
  const pts = [{ t: 0.5, text: '녹화 첫 화면' },
    ...(ctx.plan?.assets ?? []).filter((a) => a.sources?.includes(r.name) && a.cue != null).map((a) => ({ t: clamp(a.cue), text: `${String(a.n).padStart(2, '0')} ${a.scene}` })),
    { t: clamp(r.duration - 0.3), text: '녹화 끝 장면' }].sort((a, b) => a.t - b.t);
  const out = [];
  for (const x of pts) if (!out.length || x.t - out.at(-1).t > 0.8) out.push(x);
  return { highlights: out.slice(0, 6), highlights_auto: true };
}
// 녹화본의 한 순간을 작은 이미지로 (.cache/thumbs/에 남겨 다시 쓴다)
function thumb(rules, project, name, t) {
  const r = loadContext(rules, project).raw?.recordings?.find((x) => x.name === name && !x.error);
  if (!r) return null;
  const at = Math.max(0, Math.min(Number(t) || 0, r.duration - 0.05));
  const out = path.join(ROOT, '.cache', 'thumbs', project, `${name}-${String(r.sha ?? r.recorded_at ?? '').slice(0, 10).replace(/[^a-z0-9]/gi, '')}-${at.toFixed(1)}.jpg`);
  if (!exists(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    ff('ffmpeg', ['-v', 'error', '-y', '-ss', at.toFixed(2), '-i', runPath(project, `raw/${r.file}`), '-frames:v', '1', '-vf', 'scale=300:-2', '-q:v', '4', out]);
  }
  return out;
}
// 녹화 확인 화면에서 사람이 고친 에셋 목록 저장 (다시 찍지 않는 변경만)
function savePlanAssets(rules, project, items) {
  if (runningAgent(project)) throw Object.assign(new Error('AI가 작업 중이라 지금은 바꿀 수 없어요'), { code: 409 });
  if (safeStatus(rules, project).next !== 'APPROVAL_PLAN') throw Object.assign(new Error('녹화 확인 단계에서만 에셋을 바꿀 수 있어요'), { code: 409 });
  const ctx = loadContext(rules, project);
  const plan = applyPlanAssets(ctx.plan, items);
  const errs = planErrors({ ...ctx, plan }).filter((e) => !/시나리오|scenario/.test(e));
  if (errs.length) throw Object.assign(new Error(errs[0]), { code: 400 });
  writeJson(phasePath(rules, project, 'P1'), plan);
  appendLog(rules, project, { event: 'plan_edit', by: 'human', assets: plan.assets.length });
  return planCompare(rules, project);
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
    project, hash: finalHash(rules, project), status: safeStatus(rules, project), mode: projectConf(rules, project).mode,
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
  const retake = what === 'plan' && action === 'reject' && ['APPROVAL_FINAL', 'DONE'].includes(s.next);   // 완성본을 본 뒤 다시 찍기 요청
  if (s.next !== want && !retake) throw Object.assign(new Error(`지금은 ${what === 'plan' ? '녹화 확인' : '완성본'} 승인 단계가 아니에요 (${s.reason})`), { code: 409 });
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
        const r = await addProject(body.url, { mode: ['auto', 'edit', 'review'].includes(body.mode) ? body.mode : undefined }, { checkSite, update: false });   // 이미 있는 주소면 설정을 바꾸지 않는다
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
        // 삭제: 확인 창에 보여 줄 요약, 그리고 실제 삭제 (진행 중이면 멈추고 지운다). 이름을 똑같이 적어야 지운다
        if (req.method === 'GET' && rest === 'summary') return send(res, 200, projectSummary(rules, project));
        if (req.method === 'DELETE' && rest === '') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}');
            if (body.confirm !== project) return send(res, 400, { error: '확인을 위해 프로젝트 이름을 똑같이 적어 주세요' });
            const r = await deleteProject(project, { keepExport: !!body.keepExport });
            sites.delete(r.url); checking.delete(r.url);
            return send(res, 200, r);
          } catch (e) { return send(res, e.code ?? 500, { error: e.message }); }
        }
        if (req.method === 'POST' && rest === 'mode') {
          try { setMode(project, JSON.parse((await readBody(req)) || '{}').mode); return send(res, 200, progressOf(loadRules(), project)); }
          catch (e) { return send(res, e.code ?? 400, { error: e.message }); }
        }
        if (req.method === 'GET' && rest === 'compare/plan') return send(res, 200, planCompare(rules, project));
        if (req.method === 'PUT' && rest === 'plan/assets') {
          try { return send(res, 200, savePlanAssets(rules, project, JSON.parse((await readBody(req)) || '{}').assets)); }
          catch (e) { return send(res, e.code ?? 400, { error: e.message }); }
        }
        if (req.method === 'GET' && rest === 'thumb') {
          const f = thumb(rules, project, url.searchParams.get('rec'), url.searchParams.get('t'));
          if (!f) return send(res, 404, { error: '녹화 없음' });
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' });
          return res.end(fs.readFileSync(f));
        }
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
  port: Number(opt('--port') ?? loadRules().review.port), fixed: opt('--port') != null, label: 'app', open: !args.includes('--no-open'), openPath: opt('--path'),
  onReady: (addr) => console.log(`시작 화면: ${addr}  (끝내려면 Ctrl+C)`),
});

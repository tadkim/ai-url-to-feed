// 로컬 화면 서버 공통: 편집 화면 API, 파일 전송(Range), 포트 고르기. review.mjs(편집 화면만)와 app.mjs(시작 화면 전체)가 같이 쓴다.
// 모든 서버는 127.0.0.1에서만 연다.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  ROOT, loadRules, projectConf, loadContext, editsErrors, layoutOf, rawSize, assetHash, assetFile,
  phasePath, derivedPath, runPath, readIf, exists, editsHash, exportHash, lcmSeconds, loopSeam, frameRgb, psnr,
} from './lib.mjs';
import { status } from './run.mjs';

export const TYPES = { '.mp4': 'video/mp4', '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.gif': 'image/gif' };

export const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
export const readBody = (req) => new Promise((ok, no) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', no); });

export const runScript = (project, script, extra = []) => new Promise((ok) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', script), project, ...extra], { env: process.env });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => ok({ code, out }));
});

// 영상은 구간 이동(Range)을 받아야 브라우저에서 원하는 시점으로 넘어갈 수 있다
// 브라우저는 영상을 넘기거나 바꿀 때 요청을 중간에 끊는다. pipe()는 그때 파일을 닫지 않으니 pipeline으로 같이 닫는다
export function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (!m) { res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }); pipeline(fs.createReadStream(file), res, () => {}); return; }
  const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
  res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  pipeline(fs.createReadStream(file, { start, end }), res, () => {});
}

// runs/<project>/ 아래에서 화면에 보여 줘도 되는 파일만 (녹화본, 결과, 승인 비교용 이전 버전)
const SERVABLE = /^(raw|export|history\/(plan|final)\/[^/]+\/(raw|export))\/[^/]+\.(mp4|png)$/;
export function serveRunFile(req, res, project, rel) {
  const clean = path.posix.normalize(rel);   // Windows에서도 / 구분자로 검사한다
  if (!SERVABLE.test(clean)) return send(res, 403, { error: '열 수 없는 경로' });
  const file = runPath(project, clean);
  if (!exists(file)) return send(res, 404, { error: '파일 없음' });
  return sendFile(req, res, file);
}

export function safeStatus(rules, project) {
  try { return status(rules, project); } catch (e) { return { next: 'STOP', reason: e.message }; }
}

// 화면 공통 파일: /ui/* (scripts/ui/), /ui/lucide.js (아이콘, node_modules/lucide). 처리했으면 true
const UI = path.join(ROOT, 'scripts', 'ui');
const LUCIDE = path.join(ROOT, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js');
export function serveUi(req, res, p) {
  if (req.method !== 'GET' || !p.startsWith('/ui/')) return false;
  if (p === '/ui/lucide.js') {
    if (!exists(LUCIDE)) { send(res, 404, '// lucide 없음 — npm install', TYPES['.js']); return true; }
    send(res, 200, fs.readFileSync(LUCIDE), TYPES['.js']); return true;
  }
  const f = path.join(UI, path.posix.normalize(p.slice(4)));
  if (!f.startsWith(UI) || !exists(f)) { send(res, 404, { error: 'not found' }); return true; }
  send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] ?? 'application/octet-stream');
  return true;
}

// 편집 화면이 쓰는 상태
export function editorState(rules, project) {
  const conf = projectConf(rules, project);
  const ctx = loadContext(rules, project);
  const errors = ctx.edits ? editsErrors(ctx) : [];
  const p4 = readIf(derivedPath(rules, project, 'p4'), true);
  const gateCurrent = !!p4 && p4.edits_hash === editsHash(rules, project) && p4.export_hash === exportHash(rules, project);
  return {
    project, title: conf.title ?? project, url: conf.url,
    canvas: rules.assets.canvas, raw: rawSize(rules), fps: rules.export.video.fps,
    layouts: Object.fromEntries(Object.keys(rules.assets.layouts).map((k) => [k, layoutOf(rules, k)])),
    limits: { count: conf.count, maxVideoSeconds: conf.maxVideoSeconds, minSeconds: rules.edit.min_seconds, speed: rules.edit.speed, bw: rules.style.bw, radius: rules.style.radius, loopPsnrMin: rules.gate.loop_psnr_min },
    defaultStyle: rules.style.default,
    plan: ctx.plan?.assets ?? [],
    recordings: (ctx.raw?.recordings ?? []).filter((r) => !r.error),
    edits: ctx.edits, errors,
    built: Object.fromEntries((ctx.edits?.assets ?? []).map((a) => {
      let hash = null;
      try { hash = assetHash(rules, ctx.edits, a, ctx.raw); } catch { /* 형식 오류는 errors에 있다 */ }
      const m = ctx.exp?.assets.find((x) => x.n === a.n);
      const file = exists(runPath(project, `export/${assetFile(a)}`)) ? assetFile(a) : null;
      return [a.n, { file, hash: m?.hash ?? null, current: !!file && !!hash && m?.hash === hash }];
    })),
    gate: p4 ? { current: gateCurrent, pass: p4.pass, measured_at: p4.measured_at, results: p4.results } : null,
    status: safeStatus(rules, project),
  };
}

// 편집 화면 API. sub는 편집 화면 기준 경로 ('/', 'api/state', 'files/raw/x.mp4' …). 처리했으면 true
const building = new Map();
export async function editorRoutes(req, res, project, sub, url) {
  const rules = loadRules();
  if (req.method === 'GET' && (sub === '' || sub === '/')) { send(res, 200, fs.readFileSync(path.join(ROOT, 'scripts', 'review.html')), TYPES['.html']); return true; }
  if (req.method === 'GET' && sub === 'api/state') { send(res, 200, editorState(rules, project)); return true; }
  if (req.method === 'PUT' && sub === 'api/edits') {
    const edits = JSON.parse(await readBody(req));
    if (!edits || !Array.isArray(edits.assets) || typeof edits.style !== 'object') { send(res, 400, { error: 'edits 형식 오류' }); return true; }
    const file = phasePath(rules, project, 'P3');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(edits, null, 2)}\n`);
    send(res, 200, editorState(rules, project));
    return true;
  }
  if (req.method === 'POST' && sub === 'api/build') {
    if (!building.has(project)) {
      building.set(project, (async () => {
        const e = await runScript(project, 'export.mjs');
        const j = e.code === 0 ? await runScript(project, 'judge.mjs', ['--phase', 'P4', '--no-count']) : null;
        return { export_code: e.code, judge_code: j?.code ?? null, log: e.code === 0 ? '' : e.out.slice(-2000) };
      })().finally(() => building.delete(project)));
    }
    const r = await building.get(project);
    send(res, 200, { ...r, state: editorState(rules, project) });
    return true;
  }
  // 루프 이음매: 구간 시작·끝 프레임의 PSNR. scan=1이면 시작점을 앞뒤로 옮겨 가며 가장 높은 곳을 찾는다
  if (req.method === 'GET' && sub === 'api/seam') {
    const ctx = loadContext(rules, project);
    const a = ctx.edits?.assets.find((x) => x.n === Number(url.searchParams.get('n')));
    if (!a || a.type !== 'video') { send(res, 404, { error: '영상 에셋 없음' }); return true; }
    const len = a.loop ? lcmSeconds(a.loop.periods) : null;
    if (url.searchParams.get('scan') !== '1' || !len) { send(res, 200, { psnr: loopSeam(ctx, a), lcm: len }); return true; }
    const r = ctx.raw.recordings.find((x) => x.name === a.source);
    const file = ctx.dir(`raw/${r.file}`);
    const o = { size: [270, 480], matrix: rules.record.matrix };
    const tries = [];
    for (let k = -10; k <= 10; k++) {
      const t = Math.round((a.in + k * 0.1) * 100) / 100;
      if (t < 0 || t + len > r.duration) continue;
      tries.push({ in: t, out: Math.round((t + len) * 1000) / 1000, psnr: psnr(frameRgb(file, t, o), frameRgb(file, t + len, o)) });
    }
    send(res, 200, { lcm: len, tries, best: tries.reduce((b, x) => (x.psnr > (b?.psnr ?? -1) ? x : b), null) });
    return true;
  }
  if (req.method === 'GET' && sub.startsWith('files/')) { serveRunFile(req, res, project, sub.slice('files/'.length)); return true; }
  return false;
}

// 기본 포트가 쓰이고 있으면 다음 빈 포트를 쓴다 (--port를 주면 그 포트만)
export function listen(server, { port, fixed, label, open, openPath, onReady }) {
  const base = port;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !fixed && port < base + 20) { port += 1; server.listen(port, '127.0.0.1'); return; }
    console.error(`${label} 오류: ${e.code === 'EADDRINUSE' ? `포트 ${port}가 이미 쓰이고 있다 (--port로 바꾼다)` : e.message}`);
    process.exit(2);
  });
  server.listen(port, '127.0.0.1');
  server.on('listening', () => {
    const addr = `http://127.0.0.1:${port}/`;
    onReady?.(addr);
    const target = `${addr}${String(openPath ?? '').replace(/^\//, '')}`;   // --path: 처음 열 화면 (예: /p/stuckyi/edit/)
    const opener = { darwin: ['open', [target]], win32: ['cmd', ['/c', 'start', '', target]], linux: ['xdg-open', [target]] }[process.platform];
    if (open && opener) spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  });
}

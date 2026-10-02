#!/usr/bin/env node
// 검토용 HTML 서버. 사람이 결과를 눈으로 보면서 구간·재생 속도·배경색 등을 고친다.
// 사용: node scripts/review.mjs <project> [--port N] [--no-open]
//   - 127.0.0.1에서만 연다. 포트가 쓰이고 있으면(다른 프로젝트의 검토 화면 등) 다음 빈 포트를 쓴다 (--port를 주면 그 포트만).
//   - 화면에서 바꾼 값은 runs/<project>/edit/edits.json에 저장한다.
//   - "내보내기"는 export.mjs → judge.mjs --phase P4 --no-count를 실행한다 (사람이 고치는 중의 FAIL은 시도 횟수에 넣지 않는다).
//   - 승인·거절은 하지 않는다. 사람이 Claude Code에 말로 한다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ROOT, loadRules, assertProject, projectConf, loadContext, editsErrors, layoutOf, rawSize, assetHash, assetFile, videoSeconds,
  phasePath, derivedPath, runPath, readIf, exists, editsHash, exportHash, lcmSeconds, loopSeam, frameRgb, psnr,
} from './lib.mjs';
import { status } from './run.mjs';

const [project, ...args] = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : undefined; };
const rules = loadRules();
assertProject(rules, project);
const conf = projectConf(rules, project);
const fixedPort = opt('--port') != null;
let port = Number(opt('--port') ?? rules.review.port);
const TYPES = { '.mp4': 'video/mp4', '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };

function state() {
  const ctx = loadContext(rules, project);
  const errors = ctx.edits ? editsErrors(ctx) : [];
  const p4 = readIf(derivedPath(rules, project, 'p4'), true);
  const gateCurrent = !!p4 && p4.edits_hash === editsHash(rules, project) && p4.export_hash === exportHash(rules, project);
  let next = null;
  try { next = status(rules, project); } catch (e) { next = { next: 'STOP', reason: e.message }; }
  return {
    project, title: conf.title, url: conf.url,
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
    status: next,
  };
}

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, no) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', no); });
const run = (script, extra = []) => new Promise((ok) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', script), project, ...extra]);
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => ok({ code, out }));
});

// 영상은 구간 이동(Range)을 받아야 브라우저에서 원하는 시점으로 넘어갈 수 있다
function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (!m) { res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res); return; }
  const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
  res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  fs.createReadStream(file, { start, end }).pipe(res);
}

let building = null;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = decodeURIComponent(url.pathname);
    if (req.method === 'GET' && p === '/') return send(res, 200, fs.readFileSync(path.join(ROOT, 'scripts', 'review.html')), TYPES['.html']);
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, state());
    if (req.method === 'PUT' && p === '/api/edits') {
      const edits = JSON.parse(await readBody(req));
      if (!edits || !Array.isArray(edits.assets) || typeof edits.style !== 'object') return send(res, 400, { error: 'edits 형식 오류' });
      const file = phasePath(rules, project, 'P3');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(edits, null, 2)}\n`);
      return send(res, 200, state());
    }
    if (req.method === 'POST' && p === '/api/build') {
      building ??= (async () => {
        const e = await run('export.mjs');
        const j = e.code === 0 ? await run('judge.mjs', ['--phase', 'P4', '--no-count']) : null;
        return { export_code: e.code, judge_code: j?.code ?? null, log: e.code === 0 ? '' : e.out.slice(-2000) };
      })().finally(() => { building = null; });
      const r = await building;
      return send(res, 200, { ...r, state: state() });
    }
    // 루프 이음매: 구간 시작·끝 프레임의 PSNR. scan=1이면 시작점을 앞뒤로 옮겨 가며 가장 높은 곳을 찾는다
    if (req.method === 'GET' && p === '/api/seam') {
      const ctx = loadContext(rules, project);
      const a = ctx.edits?.assets.find((x) => x.n === Number(url.searchParams.get('n')));
      if (!a || a.type !== 'video') return send(res, 404, { error: '영상 에셋 없음' });
      const len = a.loop ? lcmSeconds(a.loop.periods) : null;
      if (url.searchParams.get('scan') !== '1' || !len) return send(res, 200, { psnr: loopSeam(ctx, a), lcm: len });
      const r = ctx.raw.recordings.find((x) => x.name === a.source);
      const file = ctx.dir(`raw/${r.file}`);
      const o = { size: [270, 480], matrix: rules.record.matrix };
      const tries = [];
      for (let k = -10; k <= 10; k++) {
        const t = Math.round((a.in + k * 0.1) * 100) / 100;
        if (t < 0 || t + len > r.duration) continue;
        tries.push({ in: t, out: Math.round((t + len) * 1000) / 1000, psnr: psnr(frameRgb(file, t, o), frameRgb(file, t + len, o)) });
      }
      return send(res, 200, { lcm: len, tries, best: tries.reduce((b, x) => (x.psnr > (b?.psnr ?? -1) ? x : b), null) });
    }
    if (req.method === 'GET' && p.startsWith('/files/')) {
      const rel = path.normalize(p.slice('/files/'.length));
      if (!/^(raw|export)\/[^/]+\.(mp4|png)$/.test(rel)) return send(res, 403, { error: '열 수 없는 경로' });
      const file = runPath(project, rel);
      if (!exists(file)) return send(res, 404, { error: '파일 없음' });
      return sendFile(req, res, file);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !fixedPort && port < rules.review.port + 20) { port += 1; server.listen(port, '127.0.0.1'); return; }
  console.error(`review 오류: ${e.code === 'EADDRINUSE' ? `포트 ${port}가 이미 쓰이고 있다 (--port로 바꾼다)` : e.message}`);
  process.exit(2);
});
server.listen(port, '127.0.0.1');
server.on('listening', () => {
  const addr = `http://127.0.0.1:${port}/`;
  console.log(`검토용 화면: ${addr}  (project: ${project}, 끝내려면 Ctrl+C)`);
  const opener = { darwin: ['open', [addr]], win32: ['cmd', ['/c', 'start', '', addr]], linux: ['xdg-open', [addr]] }[process.platform];
  if (!args.includes('--no-open') && opener) spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
});

#!/usr/bin/env node
// README "빠른 시작"의 터미널 미리보기 GIF를 만든다. 명령줄을 실제로 실행한 기록을 터미널 모양 화면에서 그대로 재생해 녹화한다.
// 진행 막대는 명령줄(cli.mjs)과 같은 함수(barParts, doneLine)로 그린다.
// 사용: node scripts/make-cli-demo.mjs [기록 파일=docs/assets/cli-run.txt] [결과 폴더=runs/<프로젝트>/export]
// 출력: docs/assets/cli.gif|mp4
// 기록 파일 형식 (한 줄씩):
//   $ <명령>        한 글자씩 입력한다
//   #! <자막>       화면 위 자막을 바꾼다
//   #! results      결과 폴더의 게시물 첫 장면을 터미널 아래에 보여 준다
//   @{...}          진행 기록 한 줄 (명령줄이 남기는 runs/.harness/log/<프로젝트>-cli.jsonl 그대로). 진행 막대를 그 상태로 바꾼다.
//                   end: true인 줄(명령줄이 끝난 시각)까지 막대의 시계를 감는다
//   그 밖의 줄      출력 그대로
// 내용은 고치지 않고 기다리는 시간만 줄인다 (AI가 일하는 실제 5~25분 → 몇 초). 막대의 경과 시간은 실제 시각을 따라 빨리 감는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { record } from 'walkthrough-recorder';
import { ROOT, ff, probe } from './lib.mjs';
import { STEPS, barParts, doneLine } from './cli.mjs';

const transcript = path.resolve(process.argv[2] ?? path.join(ROOT, 'docs', 'assets', 'cli-run.txt'));
const lines = fs.readFileSync(transcript, 'utf8').replace(/\r/g, '').split('\n').filter((l, i, a) => l || i < a.length - 1);
const project = /npx ai-url-to-feed (\S+)/.exec(lines.join('\n'))?.[1]?.split('.')[0] ?? 'stuckyi';
const exportDir = path.resolve(process.argv[3] ?? path.join(ROOT, 'runs', project, 'export'));
const OUT = path.join(ROOT, 'docs', 'assets');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-demo-'));
const log = (...a) => console.error('▶', ...a);

// 결과 폴더의 게시물마다 첫 장면을 작은 그림으로 (영상은 1초 지점)
const posts = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).filter((f) => /^\d+\.(mp4|png)$/.test(f)).sort() : [];
const thumbs = posts.map((f) => {
  const out = path.join(TMP, `${f}.jpg`);
  ff('ffmpeg', ['-v', 'error', '-y', ...(f.endsWith('.mp4') ? ['-ss', '1'] : []), '-i', path.join(exportDir, f), '-frames:v', '1', '-vf', 'scale=180:-2', '-q:v', '3', out]);
  return { name: f, src: `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}` };
});

// 터미널 모양 화면. 색은 명령줄(cli.mjs)이 터미널에 칠하는 색을 따른다
const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: #e4e4e7; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; font-family: "Apple SD Gothic Neo", sans-serif; }
  .win { width: 1060px; height: 500px; background: #111113; border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.28); display: flex; flex-direction: column; overflow: hidden; }
  .bar { height: 34px; display: flex; align-items: center; justify-content: center; color: #a1a1aa; font-size: 13px; background: #1c1c1f; border-bottom: 1px solid #27272a; }
  #t { flex: 1; padding: 16px 20px; color: #e4e4e7; font: 16px/1.55 Menlo, "Apple SD Gothic Neo", monospace; white-space: pre-wrap; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; }
  .p { color: #c6f36b; } .dim { color: #71717a; } .ok { color: #4ade80; } .ai { color: #c084fc; } .b { font-weight: 700; color: #fafafa; } .done { color: #4ade80; font-weight: 700; }
  .cur { display: inline-block; width: 9px; height: 18px; background: #e4e4e7; vertical-align: -3px; animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .k-spin, .k-bar, .k-label { color: #c084fc; } .k-rest, .k-sep, .k-step, .k-time { color: #71717a; } .k-pct { font-weight: 700; color: #fafafa; }
  #pb.fin .k-spin, #pb.fin .k-bar, #pb.fin .k-label { color: #4ade80; }
  .res { display: flex; gap: 10px; align-items: flex-end; height: 168px; visibility: hidden; } .res.on { visibility: visible; }   /* 자리는 처음부터 비워 둔다 (나타날 때 터미널이 움직이지 않게) */
  .res figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; font: 600 12px Menlo, monospace; color: #3f3f46; }
  .res img { width: 112px; border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.18); }
  #cap { min-height: 25px; background: #fff; color: #111; font: 700 21px/1.3 "Apple SD Gothic Neo", sans-serif; padding: 11px 22px; border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.3); white-space: nowrap; }
  #cap:empty { visibility: hidden; }
</style></head><body>
<div id="cap"></div>
<div class="win"><div class="bar">ai-url-to-feed — zsh</div><div id="t"></div></div>
<div class="res" id="res"></div>
<script>
const T = document.getElementById('t');
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const SPIN = ${JSON.stringify(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'])};
// cli.mjs가 칠하는 색: 항목 이름은 굵게, 완료·완성은 초록, 보조 설명은 흐리게
function paint(line) {
  let h = esc(line);
  h = h.replace(/^(환경 확인|사이트 등록)/, '<span class="b">$1</span>');
  h = h.replace(/^완성 /, '<span class="done">완성</span> ');
  h = h.replace(/ 완료$/, ' <span class="ok">완료</span>');
  h = h.replace(/(\\(새로 등록\\)|\\(이미 등록됨[^)]*\\)|  배경 .*$)/g, '<span class="dim">$1</span>');
  if (/^✓ /.test(line)) h = '<span class="ok">' + h + '</span>';
  else if (/^  /.test(line)) h = '<span class="dim">' + h + '</span>';
  return h;
}
let cur = null, pb = null, anim = null;
const tail = () => pb && pb.isConnected ? pb : null;
function add(el) { const p = tail(); p ? T.insertBefore(el, p) : T.append(el); while (T.children.length > 22) T.firstChild.remove(); }
function prompt() { cur = document.createElement('div'); cur.innerHTML = '<span class="p">~/ai-url-to-feed $</span> <span class="cmd"></span><span class="cur"></span>'; add(cur); }
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
window.term = {
  prompt,
  type: (text) => new Promise((ok) => { const c = cur.querySelector('.cmd'); let i = 0; const id = setInterval(() => { c.textContent = text.slice(0, ++i); if (i >= text.length) { clearInterval(id); ok(); } }, 38); }),
  enter: () => { cur.querySelector('.cur').remove(); },
  print: (line) => { const d = document.createElement('div'); d.innerHTML = paint(line) || ' '; add(d); },
  // 진행 막대: 조각(kind, text)으로 받아 맨 아래 한 줄을 고쳐 그린다
  bar: (parts, fin) => {
    if (!tail()) { pb = document.createElement('div'); pb.id = 'pb'; T.append(pb); }
    pb.className = fin ? 'fin' : '';
    pb.innerHTML = parts.map(([k, t]) => '<span class="k-' + k + '">' + esc(t) + '</span>').join('');
  },
  // 경과 시간을 실제 시각 from → to 로 빨리 감고, 스피너를 돌린다
  run: (from, to, dur) => new Promise((ok) => {
    cancelAnimationFrame(anim);
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const time = pb && pb.querySelector('.k-time'), spin = pb && pb.querySelector('.k-spin');
      if (time) time.textContent = mmss(from + (to - from) * k);
      if (spin && !pb.classList.contains('fin')) spin.textContent = SPIN[Math.floor(now / 110) % SPIN.length];
      if (k < 1) anim = requestAnimationFrame(step); else ok();
    };
    anim = requestAnimationFrame(step);
  }),
  close: () => { pb = null; },   // 막대를 그 자리에 남기고, 다음 출력은 그 아래에 쌓는다
  caption: (text) => { document.getElementById('cap').textContent = text; },
  results: (items) => { const r = document.getElementById('res'); r.innerHTML = items.map((x) => '<figure><img src="' + x.src + '"><figcaption>' + x.name + '</figcaption></figure>').join(''); r.classList.add('on'); },
};
</script></body></html>`;

const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.on('exit', () => server.close());

const raw = await record({
  baseUrl: BASE, outDir: TMP, outName: 'cli', viewport: { width: 1200, height: 760 }, scale: 1, jpegQuality: 92, crf: 18,
  scenario: async ({ page, dwell, goto, startCapture, stopCapture }) => {
    const term = (fn, ...a) => page.evaluate(([f, args]) => window.term[f](...args), [fn, a]);
    await goto('/');
    await term('prompt');
    startCapture();
    await dwell(700);
    let prog = null;   // 진행 막대 상태: { i, since(단계 시작 시각), t(마지막 기록 시각), label, text }
    for (const line of lines) {
      if (line.startsWith('#! ')) {
        const text = line.slice(3).trim();
        if (text === 'results') { await term('results', thumbs); await dwell(400); } else await term('caption', text);
        continue;
      }
      if (line.startsWith('$ ')) {
        await page.evaluate(() => { if (!document.querySelector('#t .cur')) window.term.prompt(); });
        await term('type', line.slice(2));
        await dwell(450);
        await term('enter');
        await dwell(350);
        continue;
      }
      if (line.startsWith('@')) {
        const e = JSON.parse(line.slice(1));
        if (!prog) prog = { i: e.i, since: 0, t: 0 };
        // 실제로 기다린 만큼을 짧게: 분 단위 대기도 2.4초 안쪽으로, 그동안 막대의 시계를 실제 시각까지 빨리 감는다
        await term('run', prog.t, e.t, Math.min(2400, 500 + (e.t - prog.t) / 400));
        for (let k = prog.i; k < Math.min(e.i, STEPS.length); k++) { await term('print', doneLine(STEPS[k], k === prog.i ? e.t - prog.since : 0)); await dwell(140); }
        if (e.i !== prog.i) prog.since = e.t;
        Object.assign(prog, { i: e.i, t: e.t });
        const fin = e.next === 'DONE';
        if (!e.end) await term('bar', barParts({ i: e.i, label: e.label, text: e.text, ms: e.t, done: fin }), fin);
        continue;
      }
      if (prog) { await dwell(500); await term('close'); prog = null; }   // 명령이 끝났다: 막대를 그 자리에 남긴다
      await dwell(line ? 160 : 60);
      await term('print', line);
    }
    await dwell(3200);
    await stopCapture();
  },
});
server.close();

const mp4 = path.join(OUT, 'cli.mp4');
ff('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-r', '30', '-c:v', 'libx264', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
const gif = path.join(OUT, 'cli.gif');
const pal = path.join(TMP, 'cli.pal.png');
ff('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', 'fps=12,scale=900:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=diff', pal]);
ff('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-i', pal, '-lavfi', 'fps=12,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif]);
fs.rmSync(TMP, { recursive: true, force: true });
log('cli', { mp4, seconds: probe(mp4).duration, gif, gif_mb: +(fs.statSync(gif).size / 1e6).toFixed(1), posts: posts.length });

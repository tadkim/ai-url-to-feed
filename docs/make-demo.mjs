#!/usr/bin/env node
// README의 미리보기 GIF 두 개를 만든다. 끝까지 진행한(export/가 있는) 프로젝트 1개가 필요하다.
// 사용: node docs/make-demo.mjs <project>
// 출력:
//   docs/hero.gif   — 맨 위: "URL만 넣으면 → 인스타그램 3:4 영상·이미지"
//   docs/editor.gif — 아래: 세부 수정 도구 (에셋 편집 화면 조작)
//   같은 이름의 .mp4도 함께 만든다 (선명한 버전).
// 두 장면 모두 walkthrough-recorder로 실제 화면을 녹화한다. 편집 화면은 runs/<project>를 임시 폴더에 복사해 띄운다 (실제 편집값은 건드리지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { record } from 'walkthrough-recorder';
import { ROOT, RUNS, loadRules, assertProject, projectConf, ff, probe } from '../scripts/lib.mjs';

const project = process.argv[2];
const rules = loadRules();
assertProject(rules, project);
const conf = projectConf(rules, project);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-demo-'));
const OUT = path.join(ROOT, 'docs');
const src = path.join(RUNS, project);
const exp = JSON.parse(fs.readFileSync(path.join(src, 'export', 'manifest.json'), 'utf8'));
const log = (...a) => console.error('▶', ...a);

// GIF는 README에 바로 보이도록 작게, mp4는 선명하게
function toGif(mp4, gif, width, fps) {
  const pal = path.join(TMP, `${path.basename(gif)}.pal.png`);
  ff('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff`, pal]);
  ff('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-i', pal, '-lavfi', `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif]);
}
function finish(raw, name, { cut, width, fps }) {
  const mp4 = path.join(OUT, `${name}.mp4`);
  const vf = cut ? ['-vf', `select='not(between(t,${cut[0]},${cut[1]}))',setpts=N/FRAME_RATE/TB`] : [];
  ff('ffmpeg', ['-v', 'error', '-y', '-i', raw, ...vf, '-r', '30', '-c:v', 'libx264', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  const gif = path.join(OUT, `${name}.gif`);
  toGif(mp4, gif, width, fps);
  return { mp4, seconds: probe(mp4).duration, gif, gif_mb: +(fs.statSync(gif).size / 1e6).toFixed(1) };
}

// ---- 1. hero: URL 입력 → 안 해도 되는 두 가지 → 결과 게시물 ----
const W = 1200, H = 680;
const assets = exp.assets.slice(0, 5).map((a) => ({ ...a, url: pathToFileURL(path.join(src, 'export', a.file)).href }));
const nVideo = assets.filter((a) => a.type === 'video').length;
const heroHtml = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${W}px; height: ${H}px; overflow: hidden; background: #f6f7f9; color: #111; font-family: "Apple SD Gothic Neo", "Pretendard", sans-serif; }
  .scene { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; transition: opacity .45s ease, transform .45s ease; }
  .hide { opacity: 0; transform: translateY(14px); pointer-events: none; }
  h1 { font-size: 46px; letter-spacing: -1.2px; }
  h1 b { color: #2563eb; }
  .url { width: 760px; height: 72px; border-radius: 16px; background: #fff; border: 2px solid #d5d9e0; display: flex; align-items: center; gap: 14px; padding: 0 24px; font: 26px ui-monospace, Menlo, monospace; box-shadow: 0 8px 30px rgba(15,23,42,.08); }
  .url .lock { color: #9aa1ab; font-size: 22px; }
  .caret { display: inline-block; width: 2px; height: 30px; background: #2563eb; margin-left: 2px; vertical-align: middle; animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .go { height: 56px; padding: 0 28px; border-radius: 99px; background: #2563eb; color: #fff; font-size: 22px; font-weight: 700; display: flex; align-items: center; transition: transform .2s; }
  .go.press { transform: scale(.94); }
  .skips { display: flex; flex-direction: column; gap: 18px; }
  .skip { display: flex; align-items: center; gap: 16px; font-size: 30px; font-weight: 600; opacity: 0; transform: translateX(-12px); transition: all .4s ease; }
  .skip.on { opacity: 1; transform: none; }
  .skip s { color: #9aa1ab; font-weight: 400; text-decoration-thickness: 2px; }
  .skip i { font-style: normal; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: #16a34a; color: #fff; font-size: 22px; }
  .row { display: flex; gap: 22px; align-items: flex-end; }
  .post { width: 196px; background: #fff; border-radius: 12px; box-shadow: 0 8px 24px rgba(15,23,42,.10); overflow: hidden; opacity: 0; transform: translateY(20px) scale(.96); transition: all .45s cubic-bezier(.2,.8,.2,1); }
  .post.on { opacity: 1; transform: none; }
  .post .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 12px; color: #444; }
  .post .head span { width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg,#f59e0b,#ec4899); }
  .post .media { width: 196px; height: 261px; background: #ddd; display: block; object-fit: cover; }
  .post .tag { padding: 7px 10px; font-size: 12px; color: #666; }
  .note { font-size: 22px; color: #555; }
  .note b { color: #111; }
</style></head><body>
  <section class="scene" id="s1">
    <h1><b>URL</b>만 넣으면</h1>
    <div class="url"><span class="lock">🔒</span><span id="typed"></span><span class="caret"></span></div>
    <div class="go" id="go">게시물 만들기</div>
  </section>
  <section class="scene hide" id="s2">
    <div class="skips">
      <div class="skip"><i>✓</i><span><s>페이지마다 동작 흐름 직접 캡처</s> → AI가 둘러보고 녹화</span></div>
      <div class="skip"><i>✓</i><span><s>캡처 후 배경색·배치 다시 작업</s> → 인스타그램 3:4로 완성</span></div>
    </div>
  </section>
  <section class="scene hide" id="s3">
    <div class="row">${assets.map((a, i) => `<div class="post"><div class="head"><span></span>portfolio · ${String(i + 1).padStart(2, '0')}/${assets.length}</div>${
      a.type === 'video' ? `<video class="media" src="${a.url}" muted loop playsinline preload="auto"></video>` : `<img class="media" src="${a.url}">`
    }<div class="tag">${a.type === 'video' ? '▶ 영상 mp4' : '▣ 이미지 png'}</div></div>`).join('')}</div>
    <p class="note"><b>바로 올릴 수 있는 파일 ${assets.length}개</b> · 1080×1440 · 영상 ${nVideo} · 이미지 ${assets.length - nVideo}</p>
  </section>
<script>
  const url = ${JSON.stringify(conf.url.replace(/^https?:\/\//, ''))};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.play = async () => {
    await wait(500);
    for (let i = 1; i <= url.length; i++) { typed.textContent = url.slice(0, i); await wait(45); }
    await wait(500); go.classList.add('press'); await wait(220); go.classList.remove('press'); await wait(300);
    s1.classList.add('hide'); s2.classList.remove('hide');
    for (const el of document.querySelectorAll('.skip')) { await wait(450); el.classList.add('on'); }
    await wait(2200);
    s2.classList.add('hide'); s3.classList.remove('hide');
    document.querySelectorAll('video').forEach((v) => { v.currentTime = 0; v.play(); });
    for (const el of document.querySelectorAll('.post')) { await wait(160); el.classList.add('on'); }
    await wait(5200);
    window.done = true;
  };
</script></body></html>`;
fs.writeFileSync(path.join(TMP, 'hero.html'), heroHtml);

const heroRaw = await record({
  baseUrl: pathToFileURL(TMP).href, outDir: TMP, outName: 'hero', viewport: { width: W, height: H }, scale: 1, jpegQuality: 92, crf: 18, cursor: false,
  scenario: async ({ page, goto, startCapture, stopCapture }) => {
    await goto('/hero.html');
    await page.waitForFunction(() => [...document.images].every((i) => i.complete) && [...document.querySelectorAll('video')].every((v) => v.readyState >= 2), null, { timeout: 15000 });
    startCapture();
    await page.evaluate(() => window.play());
    await page.waitForFunction(() => window.done, null, { timeout: 30000 });
    await stopCapture();
  },
});
const hero = finish(heroRaw, 'hero', { width: 800, fps: 12 });
log('hero', hero);

// ---- 2. editor: 세부 수정 도구 ----
const PORT = 4468;
const runs = path.join(TMP, 'runs');
fs.cpSync(src, path.join(runs, project), { recursive: true });
const state = path.join(RUNS, rules.state_dir, 'state', `${project}.json`);
if (fs.existsSync(state)) fs.cpSync(state, path.join(runs, rules.state_dir, 'state', `${project}.json`));
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'review.mjs'), project, '--no-open', '--port', String(PORT)], { env: { ...process.env, HARNESS_RUNS: runs }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.once('data', ok));

const marks = {};
let t0 = 0;
const editorRaw = await record({
  baseUrl: `http://127.0.0.1:${PORT}`, outDir: TMP, outName: 'editor', viewport: { width: 1360, height: 820 }, scale: 1, jpegQuality: 90, crf: 18,
  tapDefaults: { pre: 260, post: 450 },
  setupContext: (context) => context.addInitScript(() => { try { localStorage.setItem('review.coach.v1', '1'); } catch { /* 안내 말풍선은 생략 */ } }),
  scenario: async ({ page: p, tap, dwell, goto, startCapture, stopCapture }) => {
    await goto('/');
    await p.waitForSelector('.thumb');
    await p.waitForFunction(() => [...document.querySelectorAll('#big video')].every((v) => v.readyState >= 2), null, { timeout: 15000 });
    startCapture();
    t0 = Date.now();
    await dwell(1000);
    await tap('.seg.chips >> text="1.5x"');
    await dwell(900);
    // 타임라인 끝 지점을 끈다
    const r = await p.locator('.tl .range').boundingBox();
    const [x, y] = [r.x + r.width - 2, r.y + r.height / 2];
    await p.evaluate(([cx, cy]) => window.__moveCursor?.(cx, cy), [x, y]);
    await p.mouse.move(x, y); await dwell(400);
    await p.evaluate(() => window.__pressCursor?.());
    await p.mouse.down();
    for (let i = 1; i <= 16; i++) { const nx = x - i * 6; await p.mouse.move(nx, y); await p.evaluate(([cx, cy]) => window.__moveCursor?.(cx, cy), [nx, y]); await dwell(28); }
    await p.mouse.up();
    await dwell(800);
    await tap('#panelTabs >> text="전체 스타일"');
    const hex = p.locator('input[aria-label="배경색 HEX 값"]');
    await tap(hex, { blur: false });
    await hex.selectText();
    await hex.pressSequentially('#FDE68A', { delay: 60 });
    await hex.press('Enter');
    await dwell(1300);
    await tap('#build', { post: 200 });
    marks.a = (Date.now() - t0) / 1000;
    await p.waitForFunction(() => !document.querySelector('#build').dataset.busy, null, { timeout: 300000 });
    marks.b = (Date.now() - t0) / 1000;
    await dwell(2200);
    await stopCapture();
  },
});
server.kill();
const editor = finish(editorRaw, 'editor', { cut: [marks.a + 0.8, Math.max(marks.a + 0.8, marks.b - 0.3)], width: 900, fps: 10 });
log('editor', editor);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(JSON.stringify({ hero, editor }, null, 2));

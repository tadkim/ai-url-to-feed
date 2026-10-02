#!/usr/bin/env node
// README의 미리보기 영상을 만든다. 끝까지 진행한(export/가 있는) 프로젝트 1개가 필요하다.
// 사용: node docs/make-demo.mjs <project>
// 출력: docs/demo.mp4 (1280x800), docs/demo.gif (README에 바로 보이는 미리보기)
//   - 단계 설명 카드는 HTML을 Playwright로 찍는다.
//   - 에셋 편집 화면은 runs/<project>를 임시 폴더에 복사해 띄우고 walkthrough-recorder로 녹화한다 (실제 편집값은 건드리지 않는다).
//   - 결과 화면은 export/의 영상을 나란히 놓는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { record } from 'walkthrough-recorder';
import { ROOT, RUNS, loadRules, assertProject, ff, probe } from '../scripts/lib.mjs';

const project = process.argv[2];
const rules = loadRules();
assertProject(rules, project);
const W = 1280, H = 800, FPS = 30, PORT = 4468;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-demo-'));
const OUT = path.join(ROOT, 'docs');
const src = path.join(RUNS, project);
const exportsDir = path.join(src, 'export');
if (!fs.existsSync(exportsDir)) throw new Error(`export/가 없다: ${exportsDir}`);
const log = (...a) => console.error('▶', ...a);

// ---- 1. 카드 ----
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
const STEPS = ['준비·등록', '말로 시작', '촬영 계획 승인', '편집·내보내기'];
const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { width: ${W}px; height: ${H}px; background: #141517; color: #eceef0; font-family: "Apple SD Gothic Neo", "Pretendard", sans-serif; display: flex; flex-direction: column; padding: 64px 80px; gap: 28px; }
  .steps { display: flex; gap: 10px; }
  .steps span { padding: 6px 14px; border-radius: 99px; background: #272a2e; color: #9aa0a8; font-size: 18px; }
  .steps span.on { background: #3ec7e6; color: #062a33; font-weight: 700; }
  h1 { font-size: 52px; line-height: 1.25; letter-spacing: -1px; }
  h1 b { color: #3ec7e6; }
  p.desc { font-size: 24px; color: #b8bec6; line-height: 1.5; }
  .body { flex: 1; display: flex; gap: 28px; align-items: stretch; min-height: 0; }
  .term { flex: 1; background: #0b0c0d; border: 1px solid #33373c; border-radius: 14px; padding: 26px 30px; font: 21px/1.7 ui-monospace, Menlo, monospace; color: #cfd3d8; white-space: pre; }
  .term .c { color: #5fd08a; } .term .d { color: #6b7178; } .term .k { color: #3ec7e6; }
  .chat { flex: 1; display: flex; flex-direction: column; gap: 16px; background: #1d1f22; border-radius: 14px; padding: 28px; }
  .msg { max-width: 82%; padding: 14px 20px; border-radius: 16px; font-size: 22px; line-height: 1.45; }
  .me { align-self: flex-end; background: #3ec7e6; color: #062a33; font-weight: 700; }
  .ai { align-self: flex-start; background: #272a2e; }
  .ai small { display: block; color: #9aa0a8; font-size: 16px; margin-top: 4px; }
  .label { font-size: 16px; color: #6b7178; }
  .sheet { flex: 1.4; background: #000; border-radius: 14px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .sheet img { max-width: 100%; max-height: 100%; }
  .side { flex: 1; display: flex; flex-direction: column; gap: 14px; }
  .note { background: #1d1f22; border-radius: 14px; padding: 20px 24px; font-size: 20px; line-height: 1.5; color: #b8bec6; }
  .note b { color: #eceef0; }
  .center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 26px; }
`;
const page = (step, inner) => `<style>${CSS}</style>${step ? `<div class="steps">${STEPS.map((s, i) => `<span class="${i + 1 === step ? 'on' : ''}">${i + 1}. ${s}</span>`).join('')}</div>` : ''}${inner}`;
const recCount = JSON.parse(fs.readFileSync(path.join(src, 'raw', 'manifest.json'), 'utf8')).recordings.filter((r) => !r.error).length;
const sheet = path.join(src, 'raw', fs.readdirSync(path.join(src, 'raw')).find((f) => f.endsWith('.sheet.png')));

const CARDS = {
  intro: page(0, `<div class="center">
    <h1>웹 콘텐츠를 <b>인스타그램 포트폴리오 에셋</b>으로</h1>
    <p class="desc">Claude Code에 말로 시키면 녹화 → 편집 → 1080×1440 영상·이미지 파일까지.<br>사람은 두 번 확인하고 승인만 해요.</p>
    <div class="steps">${STEPS.map((s, i) => `<span class="on">${i + 1}. ${s}</span>`).join('')}</div></div>`),
  step1: page(1, `<h1>1. 설치하고 <b>프로젝트를 등록</b>해요</h1>
    <div class="body">
      <div class="term"><span class="d"># 한 번만</span>
<span class="k">$</span> npm install
<span class="k">$</span> npx playwright install chromium
<span class="k">$</span> npm test
<span class="c">86/86 PASS</span></div>
      <div class="term"><span class="d"># projects.yaml</span>
projects:
  <span class="k">${esc(project)}</span>:
    url: ${esc(rules.projects[project].url)}
    title: ${esc(rules.projects[project].title)}
    target: ${esc(rules.projects[project].target ?? 'deployed')}
    allow_writes: ${rules.projects[project].allow_writes ? 'true' : 'false'}</div>
    </div>`),
  step2: page(2, `<h1>2. Claude Code에 <b>"하네스 시작해줘"</b></h1>
    <div class="body"><div class="chat">
      <div class="label">Claude Code 대화 예시</div>
      <div class="msg me">${esc(project)} 하네스 시작해줘</div>
      <div class="msg ai">planner가 사이트를 둘러보고 촬영 계획과 녹화 시나리오를 써요<small>scripts/explore.mjs · try.mjs</small></div>
      <div class="msg ai">녹화 ${recCount}개 완료 · 검사 통과<br>에셋 목록과 장면 모음을 확인하고 승인해 주세요<small>scripts/record.mjs → runs/${esc(project)}/raw/</small></div>
    </div></div>`),
  step3: page(3, `<h1>3. 녹화본을 보고 <b>촬영 계획 승인</b></h1>
    <div class="body">
      <div class="sheet"><img src="${dataUri(sheet)}"></div>
      <div class="side">
        <div class="note"><b>장면 모음(1초 간격)</b>으로 흐름이 끝까지 찍혔는지 확인해요.</div>
        <div class="note">바꾸고 싶으면 말로 피드백해요.<br><b>"버튼 사이 간격을 절반으로, 스크롤은 사람처럼"</b></div>
        <div class="chat" style="flex:none"><div class="msg me" style="max-width:100%">${esc(project)} 촬영 계획 승인</div></div>
      </div>
    </div>`),
  step4: page(4, `<div class="center"><h1>4. <b>에셋 편집 화면</b>에서 다듬고 내보내기</h1>
    <p class="desc">구간 자르기 · 재생 속도 · 배경색을 눈으로 보며 고치고,<br><b style="color:#3ec7e6">내보내기</b>를 눌러야 mp4·png 파일에 반영돼요.</p>
    <div class="term" style="flex:none;font-size:22px"><span class="k">$</span> npm run review -- ${esc(project)}</div></div>`),
  result: page(0, `<h1>결과 — <b>runs/${esc(project)}/export/</b></h1><div class="body"></div>`),
  outro: page(0, `<div class="center"><h1>마음에 들면 <b>"완성본 승인"</b></h1>
    <p class="desc">자동 검사(크기·길이·빈 화면·배경색)를 통과하고 사람이 승인하면 끝.<br>게시 문구와 업로드는 직접 해요.</p>
    <div class="chat" style="flex:none;width:640px"><div class="msg me" style="max-width:100%">${esc(project)} 완성본 승인</div></div></div>`),
};

const browser = await chromium.launch();
const shot = await browser.newPage({ viewport: { width: W, height: H } });
const cards = {};
for (const [name, html] of Object.entries(CARDS)) {
  await shot.setContent(html);
  await shot.waitForTimeout(150);
  cards[name] = path.join(TMP, `${name}.png`);
  await shot.screenshot({ path: cards[name] });
}
await browser.close();
log('카드', Object.keys(cards).length);

// ---- 2. 에셋 편집 화면 녹화 (임시 복사본) ----
const runs = path.join(TMP, 'runs');
fs.cpSync(src, path.join(runs, project), { recursive: true });
const state = path.join(RUNS, rules.state_dir, 'state', `${project}.json`);
if (fs.existsSync(state)) fs.cpSync(state, path.join(runs, rules.state_dir, 'state', `${project}.json`));
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'review.mjs'), project, '--no-open', '--port', String(PORT)], { env: { ...process.env, HARNESS_RUNS: runs }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.once('data', ok));

const marks = {};
let t0 = 0;
const ui = await record({
  baseUrl: `http://127.0.0.1:${PORT}`, outDir: TMP, outName: 'ui', viewport: { width: 1440, height: 900 }, scale: 1, jpegQuality: 90, crf: 18,
  tapDefaults: { pre: 300, post: 500 },
  scenario: async ({ page: p, tap, dwell, goto, startCapture, stopCapture }) => {
    await goto('/');
    await p.waitForSelector('.thumb');
    await p.waitForFunction(() => [...document.querySelectorAll('#big video')].every((v) => v.readyState >= 2), null, { timeout: 15000 });
    startCapture();
    t0 = Date.now();
    await dwell(2200);
    await tap('text="알겠어요"');
    await dwell(500);
    await tap('.seg.chips >> text="1.5x"');
    await dwell(1400);
    // 타임라인 끝 지점을 왼쪽으로 끈다
    const r = await p.locator('.tl .range').boundingBox();
    const [x, y] = [r.x + r.width - 2, r.y + r.height / 2];
    await p.evaluate(([cx, cy]) => window.__moveCursor?.(cx, cy), [x, y]);
    await p.mouse.move(x, y); await dwell(450);
    await p.evaluate(() => window.__pressCursor?.());
    await p.mouse.down();
    for (let i = 1; i <= 20; i++) { const nx = x - i * 6; await p.mouse.move(nx, y); await p.evaluate(([cx, cy]) => window.__moveCursor?.(cx, cy), [nx, y]); await dwell(30); }
    await p.mouse.up();
    await dwell(1200);
    await tap('#panelTabs >> text="전체 스타일"');
    await dwell(600);
    const hex = p.locator('input[aria-label="배경색 HEX 값"]');
    await tap(hex, { blur: false });
    await hex.selectText();
    await hex.pressSequentially('#1F1D29', { delay: 70 });
    await hex.press('Enter');
    await dwell(1500);
    await tap('.thumb >> nth=1');
    await dwell(1300);
    await tap('#build', { post: 200 });
    marks.exportStart = (Date.now() - t0) / 1000;
    await p.waitForFunction(() => !document.querySelector('#build').dataset.busy, null, { timeout: 300000 });
    marks.exportEnd = (Date.now() - t0) / 1000;
    await dwell(2600);
    await tap('#panelTabs >> text="자동 검사"');
    await dwell(2600);
    await stopCapture();
  },
});
server.kill();
log('편집 화면', probe(ui).duration, '초, 내보내기', marks);

// ---- 3. 이어 붙이기 ----
const seg = (name, args) => { const f = path.join(TMP, `seg-${name}.mp4`); ff('ffmpeg', ['-v', 'error', '-y', ...args, '-r', String(FPS), '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', f]); return f; };
const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x141517,setsar=1`;
const still = (name, sec) => seg(name, ['-loop', '1', '-t', String(sec), '-i', cards[name], '-vf', `${fit},format=yuv420p`]);

// 내보내기를 기다리는 구간은 잘라 낸다 (앞뒤 조금만 남긴다)
const cutA = marks.exportStart + 1.2, cutB = Math.max(cutA, marks.exportEnd - 0.4);
const uiSeg = seg('ui', ['-i', ui, '-vf', `select='not(between(t,${cutA},${cutB}))',setpts=N/FRAME_RATE/TB,${fit}`]);

// 결과: 내보낸 영상을 나란히 (같은 영상은 한 번만)
const vids = [];
const seen = new Set();
for (const f of fs.readdirSync(exportsDir).filter((x) => x.endsWith('.mp4')).sort()) {
  const key = fs.statSync(path.join(exportsDir, f)).size;
  if (!seen.has(key)) { seen.add(key); vids.push(path.join(exportsDir, f)); }
}
const show = vids.slice(0, 4);
const tw = 240, th = 320, gap = 24, top = 210;
const left = Math.round((W - (show.length * tw + (show.length - 1) * gap)) / 2);
const inputs = show.flatMap((f) => ['-stream_loop', '-1', '-t', '7', '-i', f]);
const graph = [`[0:v]${fit}[b0]`, ...show.map((_, i) => `[${i + 1}:v]scale=${tw}:${th}:flags=lanczos[v${i}]`),
  ...show.map((_, i) => `[b${i}][v${i}]overlay=${left + i * (tw + gap)}:${top}:shortest=0[b${i + 1}]`)].join(';');
const resultSeg = seg('result', ['-loop', '1', '-t', '7', '-i', cards.result, ...inputs, '-filter_complex', `${graph};[b${show.length}]format=yuv420p[o]`, '-map', '[o]', '-t', '7']);

const parts = [still('intro', 3.5), still('step1', 4.5), still('step2', 4.5), still('step3', 4.5), still('step4', 3), uiSeg, resultSeg, still('outro', 3.5)];
const list = path.join(TMP, 'list.txt');
fs.writeFileSync(list, parts.map((f) => `file '${f}'`).join('\n'));
const mp4 = path.join(OUT, 'demo.mp4');
ff('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);

// README용 GIF: 작게, 초당 8프레임
const gif = path.join(OUT, 'demo.gif');
const pal = path.join(TMP, 'pal.png');
ff('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', 'fps=8,scale=960:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff', pal]);
ff('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-i', pal, '-lavfi', 'fps=8,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif]);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(JSON.stringify({ mp4, mp4_seconds: probe(mp4).duration, mp4_mb: +(fs.statSync(mp4).size / 1e6).toFixed(1), gif, gif_mb: +(fs.statSync(gif).size / 1e6).toFixed(1) }, null, 2));

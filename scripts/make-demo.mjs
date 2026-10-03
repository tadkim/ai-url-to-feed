#!/usr/bin/env node
// README의 미리보기 GIF를 실제 화면(npm start)으로 녹화한다. 끝까지 진행한(export/가 있는) 프로젝트 1개를 재료로 쓴다.
// 사용: node scripts/make-demo.mjs <project>
// 출력: docs/assets/hero.gif|mp4   — URL 입력 → AI 녹화 중 → 녹화 확인·승인 → AI 파일 만드는 중 → 완성본 넘겨 보기·승인 → 완성
//       docs/assets/editor.gif|mp4 — 편집 화면에서 속도·구간·배경색 고치고 내보내기
//       docs/assets/start.png, working.png, approve-plan.png, approve-final.png — 시작하기 문서의 화면 캡처
// 재료 프로젝트를 임시 폴더에 복사해 단계별 상태(녹화 확인 대기, 완성본 확인 대기)를 만들고, 그 폴더로 시작 화면 서버를 띄운다.
// 실제 runs/와 projects.yaml은 건드리지 않는다. AI가 일하는 구간은 실제로 기다리지 않고 다음 단계 상태로 바꿔 끼운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { record } from 'walkthrough-recorder';
import { ROOT, RUNS, loadRules, assertProject, projectConf, ff, probe, now } from './lib.mjs';

const source = process.argv[2];
const rules = loadRules();
assertProject(rules, source);
const conf = projectConf(rules, source);
const SRC = path.join(RUNS, source);
if (!fs.existsSync(path.join(SRC, 'export', 'manifest.json'))) throw new Error(`export/가 없다: ${SRC}`);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-demo-'));
const DEMO_RUNS = path.join(TMP, 'runs');
const DEMO_PROJECTS = path.join(TMP, 'projects.yaml');
const OUT = path.join(ROOT, 'docs', 'assets');
const log = (...a) => console.error('▶', ...a);
// 시나리오 오류가 녹화 루프 오류("page closed")에 가려지지 않게 먼저 찍는다
const loud = (fn) => async (api) => { try { await fn(api); } catch (e) { console.error('시나리오 오류:', e.stack); throw e; } };

// ---- 단계별 상태 만들기 ----
let NAME = null;   // 시작 화면에서 URL을 넣으면 주소로 정해지는 이름 (hero 녹화 중에 정해진다)
function stage(kind) {
  const dst = path.join(DEMO_RUNS, NAME);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(SRC, dst, { recursive: true, filter: (f) => !/[/\\](history|\.cache)([/\\]|$)/.test(f) });
  for (const f of ['gate/approval-final.json', ...(kind === 'plan' ? ['gate/approval-plan.json', 'gate/p4-gate.json'] : [])]) fs.rmSync(path.join(dst, f), { force: true });
  if (kind === 'plan') { fs.rmSync(path.join(dst, 'edit'), { recursive: true, force: true }); fs.rmSync(path.join(dst, 'export'), { recursive: true, force: true }); }
  const t = (m) => new Date(Date.now() - m * 60000).toISOString();
  // making: 촬영 계획 승인 뒤 editor가 아직 끝나지 않은 상태 (5. 게시물 만들기)
  const st = kind === 'plan' ? { done: { P1: t(10) } } : kind === 'making' ? { done: { P1: t(20) }, approved_plan_at: t(10) } : { done: { P1: t(20), P3: t(5) }, approved_plan_at: t(10) };
  fs.mkdirSync(path.join(DEMO_RUNS, '.harness', 'state'), { recursive: true });
  fs.writeFileSync(path.join(DEMO_RUNS, '.harness', 'state', `${NAME}.json`), JSON.stringify(st, null, 2));
}
// AI가 일하는 중인 상태: 하네스가 실제로 남기는 표시(에이전트 편집 범위 파일, 녹화·내보내기 표시)를 그대로 만든다
const harness = (...p) => path.join(DEMO_RUNS, '.harness', ...p);
function working(kind) {
  for (const d of ['scope', 'busy']) fs.rmSync(harness(d), { recursive: true, force: true });
  if (!kind) return;
  const started = new Date(Date.now() - 60000).toISOString();
  const agent = { planner: 'P1', editor: 'P3' }[kind];
  const [dir, file, body] = agent
    ? ['scope', `${NAME}-${agent}.json`, { project: NAME, phase: agent, agent: kind, started_at: started, files: {} }]
    : ['busy', `${NAME}.json`, { task: kind, pid: process.pid, started_at: started }];
  fs.mkdirSync(harness(dir), { recursive: true });
  fs.writeFileSync(harness(dir, file), JSON.stringify(body));
}
fs.mkdirSync(DEMO_RUNS, { recursive: true });
fs.writeFileSync(DEMO_PROJECTS, 'projects: {}\n');

// 시작 화면 서버: 기본 포트부터 빈 포트를 찾아 쓰고, 이 스크립트가 어떻게 끝나든 같이 끈다
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'app.mjs'), '--no-open'],
  { env: { ...process.env, HARNESS_RUNS: DEMO_RUNS, HARNESS_PROJECTS: DEMO_PROJECTS }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => server.kill());
const BASE = await new Promise((ok) => server.stdout.on('data', (d) => { const m = /http:\/\/127\.0\.0\.1:\d+/.exec(String(d)); if (m) ok(m[0]); }));

// 화면 아래에 단계 설명 자막을 띄운다 (실제 화면 위에 얹는 안내)
// 페이지가 막 바뀌는 중이면 다 열린 뒤 다시 얹는다
const caption = async (page, text) => {
  for (let i = 0; ; i++) {
    try { await page.waitForLoadState('domcontentloaded'); return await putCaption(page, text); }
    catch (e) { if (i > 4 || !/context was destroyed/.test(e.message)) throw e; await page.waitForTimeout(300); }
  }
};
const putCaption = (page, text) => page.evaluate((t) => {
  let el = document.getElementById('__cap');
  if (!el) {
    el = document.createElement('div');
    el.id = '__cap';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483646;background:#fff;color:#111;font:700 22px/1.3 "Apple SD Gothic Neo",sans-serif;padding:12px 22px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);white-space:nowrap;transition:opacity .25s';
    document.body.append(el);
  }
  el.textContent = t;
}, text);

const setup = async (context) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await context.addInitScript(() => { try { localStorage.setItem('review.coach.v1', '1'); } catch { /* 안내 말풍선은 생략 */ } });
};

function finish(raw, name, { cuts = [], width, fps }) {
  const mp4 = path.join(OUT, `${name}.mp4`);
  const keep = cuts.filter(([a, b]) => b > a).map(([a, b]) => `not(between(t,${a.toFixed(2)},${b.toFixed(2)}))`).join('*');
  const vf = keep ? ['-vf', `select='${keep}',setpts=N/FRAME_RATE/TB`] : [];
  ff('ffmpeg', ['-v', 'error', '-y', '-i', raw, ...vf, '-r', '30', '-c:v', 'libx264', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  const gif = path.join(OUT, `${name}.gif`);
  const pal = path.join(TMP, `${name}.pal.png`);
  ff('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff`, pal]);
  ff('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-i', pal, '-lavfi', `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif]);
  return { mp4, seconds: probe(mp4).duration, gif, gif_mb: +(fs.statSync(gif).size / 1e6).toFixed(1) };
}

// ---- 1. hero: 실제 시작 화면 흐름 ----
// 페이지를 옮기는 순간 녹화 루프의 스크린샷이 몇 초씩 걸릴 때가 있다. 그동안은 화면이 멈춘 채로 찍히므로,
// 옮긴 뒤 스크린샷이 다시 찍히는 것을 확인하고 멈춰 있던 구간을 잘라 낸다
const heroCuts = [];
let heroT0 = 0;
const sinceStart = () => (Date.now() - heroT0) / 1000;
async function nav(page, tap, sel, ready) {
  const a = sinceStart();
  await tap(sel, { blur: false });   // 링크는 누르면 페이지가 바뀌어 blur를 할 수 없다
  await page.waitForSelector(ready);
  await page.screenshot({ timeout: 15000 });
  const b = sinceStart();
  if (b - a > 1.5) heroCuts.push([a + 0.4, b - 0.1]);
}
const heroRaw = await record({
  baseUrl: BASE, outDir: TMP, outName: 'hero', viewport: { width: 1280, height: 800 }, scale: 1, jpegQuality: 90, crf: 18,
  tapDefaults: { pre: 260, post: 450 }, setupContext: setup,
  scenario: loud(async ({ page, tap, dwell, goto, startCapture, stopCapture }) => {
    page.setDefaultTimeout(8000);   // 선택자가 안 맞으면 멈춰 있지 않고 실패한다. 녹화 루프의 스크린샷이 페이지 이동 중에 걸려도 8초 안에 풀린다
    await goto('/');
    await page.waitForSelector('.hero input');
    startCapture();
    heroT0 = Date.now();
    await caption(page, '① 녹화할 사이트 주소를 넣어요');
    await dwell(900);
    const input = page.locator('.hero input');
    await tap(input, { blur: false });
    await input.pressSequentially(conf.url, { delay: 28 });
    await dwell(400);
    await tap('.hero button[type=submit]');
    await page.waitForSelector('.step');
    NAME = new URL(page.url()).pathname.split('/')[2];
    await caption(page, '② 이 문장을 Claude Code에 붙여 넣어요');
    await dwell(1200);
    await tap('.say button');
    await dwell(1400);

    // 이후 시작 화면은 다시 열지 않는다. 화면이 3초마다 스스로 진행 상황을 다시 읽는 것을 그대로 찍는다
    working('planner');   // ---- AI가 장면을 정하고 녹화하는 동안 ----
    await page.waitForSelector('.step.working', { timeout: 8000 });
    await caption(page, '③ AI가 사이트를 둘러보고 찍을 장면을 정해요');
    await dwell(2200);
    working('record');
    await page.waitForSelector('text=녹화하는 중이에요', { timeout: 8000 });
    await caption(page, '녹화하는 중 — 진행 상황이 화면에 보여요');
    await dwell(2000);
    working(null);
    stage('plan');   // ---- AI가 녹화를 마친 뒤 ----
    await page.waitForSelector('.nowcard a.btn', { timeout: 8000 });
    await caption(page, '④ 녹화가 끝나면 화면에서 보고 승인해요');
    await dwell(1300);
    await nav(page, tap, '.nowcard a.btn', '.rec video');
    await caption(page, '계획한 장면과 실제 녹화본을 나란히 확인');
    await page.evaluate(() => { const v = document.querySelector('.rec video'); v.playbackRate = 2; v.play(); });
    await dwell(2600);
    for (const box of await page.locator('[data-seen]').all()) { await tap(box); await dwell(250); }   // 녹화본마다 "끝까지 봤어요"
    await dwell(300);
    await tap('#bar button.primary');
    await page.waitForSelector('.modal');
    await dwell(1400);

    stage('making');   // ---- AI가 구간·속도를 정하고 파일을 만드는 동안 ----
    working('editor');
    await nav(page, tap, '.modal a', '.step.working');   // "진행 화면으로"
    await caption(page, '⑤ AI가 쓸 구간과 속도를 정해요');
    await dwell(2000);
    working('export');
    await page.waitForSelector('text=영상·이미지 파일을 만드는 중이에요', { timeout: 8000 });
    await caption(page, '영상·이미지 파일을 만드는 중');
    await dwell(2000);
    working(null);
    stage('final');   // ---- AI가 게시물 파일을 만든 뒤 ----
    await page.waitForSelector('.nowcard a.btn', { timeout: 8000 });
    await nav(page, tap, '.nowcard a.btn', '.asset');
    await caption(page, '⑥ 완성본을 게시물처럼 넘겨 보고 승인해요');
    await dwell(1300);
    await tap('#tabFeed');
    for (let i = 0; i < 5; i++) { await dwell(750); await tap('.feed > button:last-child', { pre: 120, post: 100 }); }
    await dwell(700);
    await tap('#bar button.primary');
    await page.waitForSelector('.modal');
    await dwell(1100);
    await nav(page, tap, '.modal a', 'text=완성됐어요');
    await caption(page, '완성 — 1080×1440 영상·이미지 파일이 남아요');
    await dwell(2200);
    await stopCapture();
  }),
});
const hero = finish(heroRaw, 'hero', { cuts: heroCuts, width: 900, fps: 10 });
log('hero', hero);

// ---- 2. editor: 세부 수정 도구 ----
stage('final');
const marks = {};
let t0 = 0;
const editorRaw = await record({
  baseUrl: BASE, outDir: TMP, outName: 'editor', viewport: { width: 1360, height: 820 }, scale: 1, jpegQuality: 90, crf: 18,
  tapDefaults: { pre: 260, post: 450 }, setupContext: setup,
  scenario: loud(async ({ page: p, tap, dwell, goto, startCapture, stopCapture }) => {
    await goto(`/p/${NAME}/edit/`);
    await p.waitForSelector('.thumb');
    await p.waitForFunction(() => [...document.querySelectorAll('#big video')].every((v) => v.readyState >= 2), null, { timeout: 15000 });
    startCapture();
    t0 = Date.now();
    await dwell(1000);
    await tap('.seg.chips >> text="1.5x"');
    await dwell(900);
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
  }),
});
const editor = finish(editorRaw, 'editor', { cuts: [[marks.a + 0.8, marks.b - 0.3]], width: 900, fps: 10 });
log('editor', editor);

// ---- 3. 시작하기 문서의 화면 캡처 ----
const stills = [];
{
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const shot = async (name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }); stills.push(f); };
  fs.rmSync(path.join(DEMO_RUNS, NAME), { recursive: true, force: true });
  fs.rmSync(path.join(DEMO_RUNS, '.harness', 'state', `${NAME}.json`), { force: true });
  await page.goto(`${BASE}/p/${NAME}/`);
  await page.waitForSelector('.nowcard .say');
  await shot('start');
  working('record');
  await page.goto(`${BASE}/p/${NAME}/`);
  await page.waitForSelector('.step.working');
  await shot('working');
  working(null);
  stage('plan');
  await page.goto(`${BASE}/p/${NAME}/approve/plan`);
  await page.waitForSelector('.rec video');
  await page.evaluate(() => { const v = document.querySelector('.rec video'); v.currentTime = Math.min(4, v.duration / 2); });
  await page.waitForTimeout(800);
  await shot('approve-plan');
  stage('final');
  await page.goto(`${BASE}/p/${NAME}/approve/final`);
  await page.waitForSelector('.asset');
  await page.waitForFunction(() => [...document.querySelectorAll('.asset video')].every((v) => v.readyState >= 2), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await shot('approve-final');
  await browser.close();
}
log('stills', stills);

server.kill();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(JSON.stringify({ at: now(), hero, editor, stills }, null, 2));

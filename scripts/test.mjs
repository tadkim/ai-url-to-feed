#!/usr/bin/env node
// 하네스 자체 검사. 임시 폴더(HARNESS_RUNS)에 가짜 녹화본을 만들어 계획 → 승인 → 편집 → 내보내기 → 판정 흐름을 돌려 본다.
// 실제 사이트를 열지 않는다. rules.yaml, scripts/, 에이전트 md를 고치면 다시 돌린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
process.env.HARNESS_RUNS = TMP;
// 실제 projects.yaml과 상관없이 테스트용 프로젝트 1개로 돌린다
process.env.HARNESS_PROJECTS = path.join(TMP, 'projects.yaml');
fs.writeFileSync(process.env.HARNESS_PROJECTS, 'projects:\n  test-site:\n    url: http://127.0.0.1:9\n    title: 테스트 사이트\n    target: local\n    allow_writes: false\n');
const L = await import('./lib.mjs');
const { coverPng } = await import('./export.mjs');

const rules = L.loadRules();
const P = Object.keys(rules.projects)[0];
let failed = 0;
let count = 0;
const ok = (cond, name, extra = '') => { count++; if (!cond) { failed++; console.log(`FAIL  ${name} ${extra}`); } };

// ---- 실행 환경 (설치가 덜 됐으면 여기서 멈춘다. 아래 흐름 검사는 녹화 엔진 없이도 통과하기 때문이다) ----
const env = L.toolProblems(rules);
try { await import('walkthrough-recorder'); } catch (e) { env.push(`walkthrough-recorder를 불러올 수 없다: ${e.message.split('\n')[0]}`); }
try { const { chromium } = await import('playwright'); if (!fs.existsSync(chromium.executablePath())) env.push('chromium이 없다 — npx playwright install chromium'); } catch (e) { env.push(`playwright: ${e.message.split('\n')[0]}`); }
if (env.length) {
  console.log(`FAIL  실행 환경\n${env.map((x) => `  - ${x}`).join('\n')}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `— ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const node = (script, ...args) => { const r = spawnSync(process.execPath, [path.join(L.ROOT, 'scripts', script), ...args], { encoding: 'utf8', env: process.env }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* 오류 출력 */ } return { code: r.status, json, err: r.stderr }; };
const status = () => node('run.mjs', 'status', P).json;
const dir = (rel) => L.runPath(P, rel);
const write = (rel, text) => { fs.mkdirSync(path.dirname(dir(rel)), { recursive: true }); fs.writeFileSync(dir(rel), text); };
const setState = (patch) => { const st = L.loadState(rules, P); Object.assign(st, patch, { done: { ...st.done, ...(patch.done ?? {}) } }); L.saveState(rules, P, st); };
const gate = (r, id) => r.results.find((x) => x.gate === id);

// ---- 규격 계산 ----
const { width: W, height: H } = rules.assets.canvas;
eq(L.rawSize(rules), { width: 1080, height: 1920 }, '녹화 크기');
for (const [name, l] of Object.entries(rules.assets.layouts)) {
  const lo = L.layoutOf(rules, name);
  ok(Number.isInteger(1080 * l.scale) && Number.isInteger(1920 * l.scale), `${name}: 축소 크기가 정수`);
  ok(l.scale < 1, `${name}: 축소만 한다`);
  const [first, last] = [lo.slots[0], lo.slots.at(-1)];
  eq(first.x, W - (last.x + last.w), `${name}: 좌우 여백이 같다`);
  eq(first.y, H - (first.y + first.h), `${name}: 상하 여백이 같다`);
  ok(lo.slots.every((s, i) => i === 0 || s.x >= lo.slots[i - 1].x + lo.slots[i - 1].w + 2 * rules.style.bw[1]), `${name}: 화면이 겹치지 않는다`);
}
ok(rules.assets.layouts.single.types.includes('video') && Object.entries(rules.assets.layouts).every(([k, l]) => k === 'single' || !l.types.includes('video')), '영상은 화면 1개 배치만');
eq(L.lcmSeconds([3, 2]), 6, 'lcm 3,2');
eq(L.lcmSeconds([1.5, 2]), 6, 'lcm 1.5,2');
eq(L.lcmSeconds([0]), null, 'lcm 0');
ok(L.deltaE('#B987FF', '#B987FF') === 0 && L.deltaE('#000000', '#FFFFFF') > 90, 'deltaE');
for (const id of Object.keys(rules.gates)) ok(typeof L.CHECKERS[id] === 'function', `게이트 ${id}에 판정 함수가 있다`);
for (const a of Object.values(rules.agents)) ok(a.phases.every((p) => rules.phases[p]), '에이전트 phase가 phases에 있다');
for (const name of Object.keys(rules.agents)) ok(fs.existsSync(path.join(L.ROOT, '.claude', 'agents', `${name}.md`)), `에이전트 지시문 ${name}.md`);
const png = coverPng(rules.assets.canvas, L.layoutOf(rules, 'single').slots, { bg: '#B987FF', border: '#444444', bw: 2, radius: 24 });
ok(png.readUInt32BE(16) === W && png.readUInt32BE(20) === H, '덮개 PNG 크기');

// ---- 흐름 ----
eq(status().next, 'P1', '처음은 P1');
const scenario = (body) => `// 백엔드 쓰기: 없음\nexport default {\n  cursor: false,\n  scenario: async ({ page, goto, dwell, startCapture, stopCapture }) => {\n${body}\n  },\n};\n`;
const good = "    await goto('/');\n    await page.waitForFunction(() => document.images.length >= 0);\n    startCapture();\n    await dwell(1000);\n    await stopCapture();";
const asset = (n, type, layout, sources = ['r1']) => ({ n, type, layout, scene: `장면 ${n}`, sources, loop: false });
const plan = { recordings: [{ name: 'r1', scenario: 'r1.scenario.mjs', note: '' }, { name: 'flat', scenario: 'flat.scenario.mjs', note: '' }], assets: [asset(1, 'video', 'single'), asset(2, 'image', 'single'), asset(3, 'image', 'double'), asset(4, 'image', 'triple'), asset(5, 'video', 'single', ['flat'])] };
write('plan/plan.json', JSON.stringify(plan, null, 2));
write('plan/r1.scenario.mjs', scenario(good));
write('plan/flat.scenario.mjs', scenario(good));
let ctx = L.loadContext(rules, P);
eq(L.planErrors(ctx), [], '계획 통과');
eq(L.scenarioErrors(ctx), [], '시나리오 통과');

// 시나리오 규칙 위반
const badCases = { 'startCapture 없음': "    await goto('/');", 'setTimeout': `${good}\n    await new Promise((r) => setTimeout(r, 500));`, 'waitForTimeout': `${good}\n    await page.waitForTimeout(500);`, 'viewport 지정': `${good}\n    const o = { viewport: 1 };` };
for (const [name, body] of Object.entries(badCases)) { write('plan/flat.scenario.mjs', scenario(body)); ok(L.scenarioErrors(L.loadContext(rules, P)).length > 0, `시나리오 규칙: ${name}`); }
write('plan/flat.scenario.mjs', "import { record } from 'walkthrough-recorder';\nawait record({ scenario: async ({ startCapture }) => { startCapture(); } });\n");
ok(L.scenarioErrors(L.loadContext(rules, P)).length > 0, '시나리오 규칙: record() 직접 호출');
write('plan/flat.scenario.mjs', scenario(good));
// 계획 위반
const planBad = (patch, name) => { write('plan/plan.json', JSON.stringify(patch(structuredClone(plan)))); ok(L.planErrors(L.loadContext(rules, P)).length > 0, `계획 규칙: ${name}`); };
planBad((p) => { p.assets.pop(); return p; }, '에셋 수 부족');
planBad((p) => { p.assets[2].type = 'video'; return p; }, '화면 2개 영상');
planBad((p) => { p.assets[1].n = 7; return p; }, '번호 불연속');
planBad((p) => { p.assets[0].sources = ['nope']; return p; }, '없는 녹화본');
write('plan/plan.json', JSON.stringify(plan, null, 2));

setState({ done: { P1: L.now() } });
eq([status().next, status().todo], ['P2', 'record'], 'P1 뒤 녹화');

// 가짜 녹화본: 무늬가 움직이는 영상과 한 가지 색 영상 (녹화 엔진처럼 태그 없는 bt601)
const FLAT = '#3366CC';
const mk = (src, file) => L.ff('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-t', '12', '-vf', 'scale=out_color_matrix=bt601:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', dir(`raw/${file}`)]);
fs.mkdirSync(dir('raw'), { recursive: true });
mk('testsrc2=s=1080x1920:r=30', 'r1.mp4');
mk(`color=c=0x${FLAT.slice(1)}:s=1080x1920:r=30`, 'flat.mp4');
const recEntry = (name) => { const p = L.probe(dir(`raw/${name}.mp4`)); return { name, file: `${name}.mp4`, width: p.width, height: p.height, duration: p.duration, fps: p.fps, sha: L.fileSha(dir(`raw/${name}.mp4`)), scenes: [], sheet: `${name}.sheet.png`, sheet_every: 2, writes_seen: 0, writes_blocked: 0 }; };
L.writeJson(L.derivedPath(rules, P, 'raw'), { record_hash: L.recordHash(rules, P), recorded_at: L.now(), recordings: [recEntry('r1'), recEntry('flat')] });
eq(L.rawErrors(L.loadContext(rules, P)), [], '녹화본 통과');
eq(status().next, 'APPROVAL_PLAN', '녹화 뒤 승인 1');
eq(node('run.mjs', 'approve', P, 'final').code, 2, '단계가 아닐 때 완성본 승인 거부');
eq(node('run.mjs', 'approve', P, 'plan').json?.next, 'P3', '승인 1 → P3');

// 편집값
const style = { bg: '#B987FF', border: '#444444', bw: 2, radius: 24 };
const edits = { style, assets: [
  { n: 1, type: 'video', layout: 'single', source: 'r1', in: 1, out: 5, speed: 2, loop: null },
  { n: 2, type: 'image', layout: 'single', shots: [{ source: 'r1', at: 2 }] },
  { n: 3, type: 'image', layout: 'double', shots: [{ source: 'r1', at: 3 }, { source: 'r1', at: 6 }] },
  { n: 4, type: 'image', layout: 'triple', shots: [{ source: 'r1', at: 1 }, { source: 'r1', at: 4 }, { source: 'r1', at: 8 }] },
  { n: 5, type: 'video', layout: 'single', source: 'r1', in: 6, out: 9, speed: 1, loop: null },
] };
const putEdits = (e) => write('edit/edits.json', `${JSON.stringify(e, null, 2)}\n`);
const editsBad = (patch, name) => { putEdits(patch(structuredClone(edits))); ok(L.editsErrors(L.loadContext(rules, P)).length > 0, `편집값 규칙: ${name}`); };
editsBad((e) => { e.assets[0].out = 99; return e; }, '구간이 녹화본 밖');
editsBad((e) => { e.assets[0].speed = 9; return e; }, '속도 범위 밖');
editsBad((e) => { e.assets[0].layout = 'double'; return e; }, '화면 2개 영상');
editsBad((e) => { e.assets[2].shots.pop(); return e; }, 'shots 수');
editsBad((e) => { e.style.bg = 'purple'; return e; }, '배경색 형식');
editsBad((e) => { e.style.radius = 999; return e; }, '모서리 범위');
putEdits(edits);
eq(L.editsErrors(L.loadContext(rules, P)), [], '편집값 통과');
eq(status().next, 'P3', '완료 기록 없으면 P3');
setState({ done: { P3: L.now() } });
eq([status().next, status().todo], ['P4', 'export'], 'P3 뒤 내보내기');

let r = node('export.mjs', P);
eq(r.code, 0, '내보내기');
eq([status().next, status().todo], ['P4', 'judge'], '내보내기 뒤 판정');
r = node('judge.mjs', P, '--phase', 'P4');
eq(r.code, 0, `P4 PASS ${JSON.stringify(r.json?.results.filter((x) => !x.pass && x.gate !== 'approval_final'))}`);
const v1 = L.probe(dir('export/01.mp4'));
eq([v1.width, v1.height, v1.codec, v1.pix_fmt, v1.fps, v1.color_space, v1.audio], [W, H, 'h264', 'yuv420p', 30, 'bt709', false], '영상 규격');
ok(Math.abs(v1.duration - 2) < 0.05, '4초 구간 ÷ 2배속 = 2초', `— ${v1.duration}`);
const img = L.probe(dir('export/03.png'));
eq([img.width, img.height], [W, H], '이미지 규격');
eq(status().next, 'APPROVAL_FINAL', '판정 뒤 승인 2');

// 순서만 바꾸면 다시 인코딩하지 않는다
const swapped = structuredClone(edits); [swapped.assets[1], swapped.assets[2]] = [swapped.assets[2], swapped.assets[1]]; swapped.assets.forEach((a, i) => { a.n = i + 1; });
putEdits(swapped);
eq(status().todo, 'export', '편집값이 바뀌면 다시 내보내기');
r = node('export.mjs', P);
ok(r.json.assets.every((a) => !a.built), '순서만 바꾸면 캐시를 쓴다');
putEdits(edits); node('export.mjs', P);

// 색: 한 가지 색 녹화본이 화면 자리에서 같은 색으로 나오고(bt601 → bt709), 빈 화면으로 잡힌다
const flat = structuredClone(edits); flat.assets[4].source = 'flat'; flat.assets[1].shots[0].source = 'flat';
putEdits(flat); node('export.mjs', P);
r = node('judge.mjs', P, '--phase', 'P4');
eq(r.code, 1, '빈 화면이면 FAIL');
ok(gate(r.json, 'clip_edges').detail.length === 3, '빈 화면: 영상 첫·마지막 프레임 + 이미지', JSON.stringify(gate(r.json, 'clip_edges').detail));
ok(gate(r.json, 'canvas_bg').pass, '배경색 통과');
const center = (buf) => { const s = L.layoutOf(rules, 'single').slots[0]; const i = ((s.y + s.h / 2) * W + s.x + s.w / 2) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; };
const dv = L.deltaE(center(L.frameRgb(dir('export/05.mp4'), 0.5, { matrix: 'bt709' })), FLAT);
const di = L.deltaE(center(L.frameRgb(dir('export/02.png'), null)), FLAT);
ok(dv <= 3 && di <= 3, '화면 색이 녹화본과 같다', `— 영상 ΔE ${dv}, 이미지 ΔE ${di}`);
eq(status().next, 'P3', 'P4 FAIL → P3');

// 길이 초과, 루프 길이
const long = structuredClone(edits); long.assets[0] = { ...long.assets[0], in: 0, out: 12, speed: 0.5 };
long.assets[4].loop = { periods: [3, 2] };
putEdits(long); node('export.mjs', P);
r = node('judge.mjs', P, '--phase', 'P4');
ok(!gate(r.json, 'video_length').pass, '길이 초과 FAIL');
ok(!gate(r.json, 'loop_seam').pass, '루프 길이가 최소공배수가 아니면 FAIL');
eq(L.readJson(L.derivedPath(rules, P, 'p4')).attempt, 2, '다른 내용으로 다시 FAIL이면 시도 2');
r = node('judge.mjs', P, '--phase', 'P4');
eq(L.readJson(L.derivedPath(rules, P, 'p4')).attempt, 2, '같은 내용은 세지 않는다');

// 승인 2와 무효화
putEdits(edits); node('export.mjs', P); node('judge.mjs', P, '--phase', 'P4');
eq(node('run.mjs', 'approve', P, 'final').json?.next, 'DONE', '승인 2 → DONE');
const prog = () => L.progress(rules, P, L.loadState(rules, P), status());
eq([prog().current, prog().todo.who], [7, 'done'], '진행 화면: 승인 2 뒤 7단계 완성');
const tweak = structuredClone(edits); tweak.style.bg = '#112233';
putEdits(tweak);
eq(status().next, 'P4', '승인 뒤 편집값이 바뀌면 다시');
node('export.mjs', P); node('judge.mjs', P, '--phase', 'P4');
eq(status().next, 'APPROVAL_FINAL', '다시 승인받는다');
eq(node('run.mjs', 'reject', P, 'final', '--note', '더 빠르게').json?.next, 'P3', '완성본 거절 → P3');
ok(L.latestHistory(P, 'final'), '완성본 거절 → 이전 결과를 비교용으로 남긴다');
eq([prog().current, prog().todo.say], [5, `${P} 이어서 해줘`], '진행 화면: 거절 뒤 5단계, 이어서 해줘 안내');
L.markBusy(P, 'export');
eq(prog().todo.text, '영상·이미지 파일을 만드는 중이에요', '진행 화면: 내보내기가 도는 동안 만드는 중 표시');
fs.writeFileSync(path.join(L.RUNS, '.harness', 'busy', `${P}.json`), JSON.stringify({ task: 'export', pid: 2 ** 22 + 7, started_at: L.now() }));
ok(!L.runningTask(P), '진행 화면: 꺼진 프로세스의 표시는 무시한다');
fs.rmSync(path.join(L.RUNS, '.harness', 'busy'), { recursive: true, force: true });
node('run.mjs', 'begin', P, 'P3'); node('run.mjs', 'end', P, 'P3');
eq(status().next, 'STOP', '거절 뒤 editor가 아무것도 바꾸지 않으면 승인 대기로 넘기지 않는다');
eq(node('run.mjs', 'unblock', P).json?.next, 'P3', '계속 진행해 → editor 다시');

// 쓰기 차단에서 통과시키는 읽기 전용 POST
const readPost = (u) => rules.record.read_post.some((x) => new RegExp(x).test(u));
ok(readPost('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel'), '읽기 POST: Firestore Listen은 통과');
ok(!readPost('https://firestore.googleapis.com/google.firestore.v1.Firestore/Write/channel'), '쓰기 POST: Firestore Write는 막는다');
ok(!readPost('https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents:commit'), '쓰기 POST: Firestore commit은 막는다');

// 편집 범위
node('run.mjs', 'begin', P, 'P3');
fs.writeFileSync(path.join(TMP, P, 'plan', 'plan.json'), JSON.stringify(plan));
eq(node('run.mjs', 'end', P, 'P3').code, 1, 'editor가 plan/을 고치면 FAIL');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${count - failed}/${count} PASS`);
process.exit(failed ? 1 : 0);

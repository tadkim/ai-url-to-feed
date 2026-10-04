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
// review 모드(승인 2번)로 전체 흐름을 보고, 중간에 auto·edit 모드로 바꿔 승인을 건너뛰는지 본다
const writeProjects = (mode) => fs.writeFileSync(process.env.HARNESS_PROJECTS, `projects:\n  test-site:\n    url: http://127.0.0.1:9\n    title: 테스트 사이트\n    target: local\n    allow_writes: false\n    mode: ${mode}\n`);
writeProjects('review');
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
writeProjects('edit');
eq(status().next, 'P3', 'edit 모드: 촬영 계획 승인 없이 편집으로');
writeProjects('auto');
eq(status().next, 'P3', 'auto 모드: 촬영 계획 승인 없이 편집으로');
writeProjects('review');
eq(node('run.mjs', 'approve', P, 'final').code, 2, '단계가 아닐 때 완성본 승인 거부');
eq(node('run.mjs', 'approve', P, 'plan').json?.next, 'P3', '승인 1 → P3');

// 편집값
const style = { bg: '#B987FF', border: '#444444', bw: 2, radius: 24 };
const edits = { style, assets: [
  { n: 1, type: 'video', layout: 'single', source: 'r1', in: 1, out: 5, speed: 2, loop: null },
  // 이미지 화면은 영상 구간의 대표 지점(4등분)과 겹치지 않는 시각에서 뽑는다 (게이트 asset_variety)
  { n: 2, type: 'image', layout: 'single', shots: [{ source: 'r1', at: 2.5 }] },
  { n: 3, type: 'image', layout: 'double', shots: [{ source: 'r1', at: 3.5 }, { source: 'r1', at: 5.5 }] },
  { n: 4, type: 'image', layout: 'triple', shots: [{ source: 'r1', at: 0.5 }, { source: 'r1', at: 4.5 }, { source: 'r1', at: 9.5 }] },
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
writeProjects('auto');
eq(status().next, 'DONE', 'auto 모드: 자동 검사를 통과하면 승인 없이 완성');
writeProjects('edit');
eq(status().next, 'APPROVAL_FINAL', 'edit 모드: 완성본은 한 번 승인한다');
{
  const r2 = L.loadRules();
  const stg = (m) => L.progress({ ...r2, projects: { [P]: { ...r2.projects[P], mode: m } } }, P, L.loadState(r2, P), status()).stages.map((x) => x.title);
  eq([stg('auto').length, stg('edit').length, stg('review').length], [5, 6, 7], '진행 단계 수: auto 5 · edit 6 · review 7');
  ok(!stg('auto').includes('녹화 확인') && stg('edit').includes('다듬기·승인'), '진행 단계: auto는 확인 단계 없음, edit은 다듬기·승인');
}
writeProjects('review');

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
ok(!gate(r.json, 'video_motion').pass && /05 영상/.test(gate(r.json, 'video_motion').detail[0]), '멈춘 영상(한 가지 색 녹화본)은 video_motion FAIL', JSON.stringify(gate(r.json, 'video_motion').detail));
const center = (buf) => { const s = L.layoutOf(rules, 'single').slots[0]; const i = ((s.y + s.h / 2) * W + s.x + s.w / 2) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; };
const dv = L.deltaE(center(L.frameRgb(dir('export/05.mp4'), 0.5, { matrix: 'bt709' })), FLAT);
const di = L.deltaE(center(L.frameRgb(dir('export/02.png'), null)), FLAT);
ok(dv <= 3 && di <= 3, '화면 색이 녹화본과 같다', `— 영상 ΔE ${dv}, 이미지 ΔE ${di}`);
eq(status().next, 'P3', 'P4 FAIL → P3');

// 같은 화면이 두 에셋에: 이미지 화면을 영상 구간의 대표 지점(2초)에서 뽑으면 asset_variety FAIL
{
  const dup = structuredClone(edits); dup.assets[1].shots[0].at = 2;
  const errs = L.CHECKERS.asset_variety({ ...L.loadContext(rules, P), edits: dup });
  ok(errs.length === 1 && errs[0].startsWith('01 영상과 02 이미지에 같은 화면'), '같은 화면이 두 에셋에 있으면 asset_variety FAIL', JSON.stringify(errs));
  eq(L.CHECKERS.asset_variety({ ...L.loadContext(rules, P), edits }), [], '다른 화면이면 asset_variety 통과');
  eq(L.CHECKERS.video_motion({ ...L.loadContext(rules, P), edits }), [], '움직이는 영상은 video_motion 통과');
}

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

// 녹화 확인 화면: 주요 장면 코멘트, 사람이 고친 에셋 목록
{
  const pctx = L.loadContext(rules, P);
  const withHl = (hl) => L.planErrors({ ...pctx, plan: { ...pctx.plan, recordings: pctx.plan.recordings.map((r, i) => (i ? r : { ...r, highlights: hl })) } }).filter((e) => /highlights/.test(e));
  eq(withHl([{ t: 1, text: '첫 화면을 3초 둠' }]), [], 'highlights: 시점과 설명이 있으면 통과');
  ok(withHl([]).length && withHl([{ t: -1, text: 'x' }]).length && withHl(Array(6).fill({ t: 1, text: 'x' })).length, 'highlights: 비었거나 6개 이상이거나 시점이 틀리면 FAIL');
  const edited = L.applyPlanAssets(pctx.plan, [{ from: 2, scene: '바꾼 설명' }, { from: 1 }, { source: pctx.plan.recordings[0].name, type: 'image', scene: '새 장면', cue: 1.23 }]);
  eq(edited.assets.map((a) => [a.n, a.type, a.scene]), [[1, pctx.plan.assets[1].type, '바꾼 설명'], [2, pctx.plan.assets[0].type, pctx.plan.assets[0].scene], [3, 'image', '새 장면']], '에셋 고치기: 순서·설명·추가, 번호는 다시 매긴다');
  eq(edited.assets[2].cue, 1.2, '에셋 고치기: 새 에셋은 그 순간(cue)과 녹화를 기억한다');
  ok(edited.recordings === pctx.plan.recordings, '에셋 고치기: 녹화·시나리오는 그대로라 다시 찍지 않는다');
  const rh = L.recordHash(rules, P);
  const planFile = L.phasePath(rules, P, 'P1');
  const orig = fs.readFileSync(planFile, 'utf8');
  fs.writeFileSync(planFile, JSON.stringify({ ...pctx.plan, recordings: pctx.plan.recordings.map((r) => ({ ...r, highlights: [{ t: 1, text: '설명' }] })) }));
  eq(L.recordHash(rules, P), rh, 'highlights를 더해도 다시 찍지 않는다');
  fs.writeFileSync(planFile, orig);
  let threw = false; try { L.applyPlanAssets(pctx.plan, [{ from: 1 }, { from: 1 }]); } catch { threw = true; }
  ok(threw, '에셋 고치기: 같은 에셋을 두 번 넣으면 막는다');
}

// 시작 화면 주소 입력: https:// 없이 넣어도 된다
eq(['stuckyi.studio', 'https://a.com', 'localhost:3000', '127.0.0.1:4400/app', 'www.a.co.kr/x'].map(L.withScheme),
  ['https://stuckyi.studio', 'https://a.com', 'http://localhost:3000', 'http://127.0.0.1:4400/app', 'https://www.a.co.kr/x'], '주소 앞에 https:// (내 컴퓨터는 http://)를 붙인다');

// 사이트별 배경색 (명령줄 --bg → projects.yaml bg): editor가 따라야 하고, 사람이 편집 화면에서 바꾼 색은 그대로 둔다
{
  const ctx = (bg, style) => ({ conf: { bg }, edits: { style } });
  eq(L.styleBgErrors(ctx(null, { bg: '#112233' })), [], 'bg 없으면 배경색을 검사하지 않는다');
  ok(L.styleBgErrors(ctx('#B987FF', { bg: '#112233' })).length === 1, 'bg와 다른 배경색이면 FAIL');
  eq(L.styleBgErrors(ctx('#b987ff', { bg: '#B987FF' })), [], 'bg는 대소문자 구분 없이 같으면 통과');
  eq(L.styleBgErrors(ctx('#B987FF', { bg: '#112233', bg_by: 'human' })), [], '사람이 편집 화면에서 바꾼 배경색은 그대로 둔다');
  putEdits({ ...edits, style: { ...style, bg_by: 'ai' } });
  ok(L.editsErrors(L.loadContext(rules, P)).length > 0, '편집값 규칙: bg_by는 human만');
  putEdits(edits);
}

// 명령줄 (cli.mjs): 인자 해석, projects.yaml 등록·설정 바꾸기
{
  const C = await import('./cli.mjs');
  const Pj = await import('./projects.mjs');
  const a = C.parseArgs(['stuckyi.studio', '--bg', '#b987ff', '--count=6', '--edit']);
  eq([a.cmd, a.args, a.opts.bg, a.opts.count, a.opts.edit], ['make', ['stuckyi.studio'], '#b987ff', '6', true], '명령줄: 주소와 옵션 (--bg 값, --count=값)');
  eq(C.parseArgs(['retake', 'stuckyi', '02를', '더 오래']).cmd, 'retake', '명령줄: retake');
  eq(C.parseArgs([]).cmd, 'help', '명령줄: 주소가 없으면 도움말');
  eq([C.parseArgs(['continue', 'stuckyi']).cmd, C.parseArgs(['continue', 'stuckyi']).args], ['continue', ['stuckyi']], '명령줄: continue');
  {
    const since = new Date(Date.now() - 1000).toISOString();
    L.activity('act-test', 'explore', 4); L.activity('act-test', 'try', 3); L.activity('act-test', 'explore', 2);
    const got = L.activitySince('act-test', since);
    eq([got.explore, got.try], [6, 3], '활동 기록: 에이전트 시작 뒤 둘러본 화면·돌려 본 시나리오 수');
    eq(L.activitySince('act-test', new Date(Date.now() + 60000).toISOString()), {}, '활동 기록: 시작 전 기록은 세지 않는다');
    ok(L.activityFile('act-test').includes('act-test-'), '활동 기록: 따로 지정한 실행 폴더는 실제 기록과 파일을 나눈다');
    fs.rmSync(L.activityFile('act-test'), { force: true });
  }
  eq([C.stepOf({ next: 'P1' }).i, C.stepOf({ next: 'P2' }).i, C.stepOf({ next: 'P3' }).i, C.stepOf({ next: 'P4', todo: 'export' }).i, C.stepOf({ next: 'P4', todo: 'judge' }).i, C.stepOf({ next: 'DONE' }).label], [0, 1, 2, 3, 4, '완성'], '진행 막대: status → 단계');
  eq(C.stepOf({ next: 'P4', todo: 'export' }, 2, 'editor').label, '구간·속도 정하기', '진행 막대: editor가 아직 돌면 status가 앞서가도 그 단계');
  eq(C.stepOf({ next: 'STOP' }, 3).i, 3, '진행 막대: 멈추면 그 자리');
  const bar = C.barParts({ i: 2, label: '구간·속도 정하기', text: '작업 중', ms: 61000 }).map(([, t]) => t).join('');
  ok(/████████░{12}  40% \| 3\/5 구간·속도 정하기 \| 작업 중 \| 01:01$/.test(bar), '진행 막대 모양', bar);
  ok(/^✓ █{20} 100% \| 5\/5 완성/.test(C.barParts({ i: 5, label: '완성', ms: 0, done: true }).map(([, t]) => t).join('')), '진행 막대: 완성은 100%');
  for (const cols of [140, 100, 80, 60, 45, 30]) {
    const st = { i: 0, label: '장면 계획', text: 'AI가 작업 중이에요 (장면 계획·녹화 준비) · 화면 13개 둘러봄', ms: 97000, frame: 3 };
    const line = C.fitBar(st, cols).map(([, t]) => t).join('');
    ok(C.width(line) <= cols - 1 && /01:37$/.test(line), `진행 막대: 터미널 폭 ${cols}에서 한 줄에 들어가고 시간이 보인다`, `${C.width(line)} · ${line}`);
  }
  eq(C.width('█░⠋한'), 8, '진행 막대: 막대·스피너·한글은 두 칸으로 센다');
  let threw = false; try { C.parseArgs(['a.com', '--edit', '--auto']); } catch { threw = true; }
  ok(threw, '명령줄: --edit와 --auto는 같이 못 쓴다');
  threw = false; try { C.parseArgs(['a.com', '--bg']); } catch { threw = true; }
  ok(threw, '명령줄: --bg에 값이 없으면 막는다');
  eq([Pj.parseCount('6', rules), Pj.parseCount('5-8', rules)], [[6, 6], [5, 8]], '게시물 수: 하나 또는 범위');
  threw = false; try { Pj.parseCount('11', rules); } catch { threw = true; }
  ok(threw, '게시물 수: rules.yaml 범위 밖이면 막는다');
  eq(Pj.normalizeBg('b987ff'), '#B987FF', '배경색: # 없이 넣어도 된다');
  threw = false; try { Pj.normalizeBg('purple'); } catch { threw = true; }
  ok(threw, '배경색: #RRGGBB가 아니면 막는다');
  const before = fs.readFileSync(process.env.HARNESS_PROJECTS, 'utf8');
  const r1 = await Pj.addProject('example.com', { bg: 'b987ff', count: '6' });
  const y = () => L.loadRules().projects;
  eq([r1.name, r1.existed, y().example], ['example', false, { url: 'https://example.com', bg: '#B987FF', asset_count: [6, 6] }], '등록: 주소 → 이름, bg·asset_count를 적는다');
  const r2 = await Pj.addProject('https://example.com/', { bg: '#112233', count: '5-10', mode: 'edit' });
  eq([r2.existed, r2.changed, y().example], [true, ['mode', 'bg', 'asset_count'], { url: 'https://example.com', bg: '#112233', mode: 'edit' }], '다시 등록: 바꾼 설정만 적고, 기본값(5~10)은 줄을 지운다');
  eq((await Pj.addProject('example.com', { bg: '#000000' }, { update: false })).changed, [], '시작 화면에서 같은 주소: 설정을 바꾸지 않는다');
  eq(L.projectConf(L.loadRules(), 'example').bg, '#112233', 'projectConf에 bg');
  const r3 = await Pj.addProject('localhost:3999', { title: '내 앱' });
  eq(y()[r3.name], { url: 'http://localhost:3999', title: '내 앱', target: 'local' }, '내 컴퓨터 주소: --title로 제목을 적는다 (서버에 묻지 않는다)');
  fs.writeFileSync(process.env.HARNESS_PROJECTS, before);
}

// 명령줄이 중간에 멈추며(Ctrl+C) 남긴 에이전트 기록: 그 명령줄이 사라졌으면 실행 중으로 보지 않고 정리한다
{
  const scope = path.join(L.RUNS, '.harness', 'scope');
  fs.mkdirSync(scope, { recursive: true });
  const put = (pid) => fs.writeFileSync(path.join(scope, `${P}-P1.json`), JSON.stringify({ project: P, phase: 'P1', agent: 'planner', started_at: L.now(), owner_pid: pid, files: {} }));
  put(process.pid);
  eq(L.runningAgent(P)?.agent, 'planner', '끊긴 기록: 명령줄이 살아 있으면 실행 중');
  put(2147483646);
  eq(L.runningAgent(P), null, '끊긴 기록: 명령줄이 사라졌으면 실행 중이 아니다');
  eq(L.clearStaleAgents(rules, P), ['P1'], '끊긴 기록: 정리한다');
  put(undefined);
  eq([L.runningAgent(P)?.agent, L.clearStaleAgents(rules, P)], ['planner', []], '끊긴 기록: 명령줄 표시가 없으면(대화로 진행) 그대로 둔다');
  eq(L.clearStaleAgents(rules, P, { all: true }), ['P1'], '끊긴 기록: continue는 표시가 없는 기록도 정리한다');
}

// 편집 범위
node('run.mjs', 'begin', P, 'P3');
fs.writeFileSync(path.join(TMP, P, 'plan', 'plan.json'), JSON.stringify(plan));
eq(node('run.mjs', 'end', P, 'P3').code, 1, 'editor가 plan/을 고치면 FAIL');

// 삭제: 진행 중인 명령줄·Claude Code 묶음·녹화 프로세스를 멈추고, 등록·기록·캐시를 지운다. 게시물만 남길 수도 있다
{
  const Pj = await import('./projects.mjs');
  const { spawn } = await import('node:child_process');
  const before = fs.readFileSync(process.env.HARNESS_PROJECTS, 'utf8');
  const D = 'del-test';
  fs.appendFileSync(process.env.HARNESS_PROJECTS, `  ${D}:\n    url: https://del.example.com\n`);
  const run = (rel, text = 'x') => { const f = L.runPath(D, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  run('export/01.mp4'); run('export/02.png'); run('raw/r1.mp4'); run('plan/plan.json', '{}');
  const sd = L.stateDir(rules);
  const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put(path.join(sd, 'state', `${D}.json`), '{}'); put(path.join(sd, 'log', `${D}-cli.jsonl`), '');
  put(path.join(L.RUNS, '.harness', 'scope', `${D}-P1.json`), JSON.stringify({ project: D, phase: 'P1', agent: 'planner', started_at: L.now(), files: {} }));
  put(L.activityFile(D), ''); put(path.join(L.ROOT, '.cache', 'explore', D, 'a.png'), 'x');
  const forever = ['-e', 'setInterval(() => {}, 1000)'];
  const group = process.platform !== 'win32';
  const cli = spawn(process.execPath, forever, { stdio: 'ignore' });
  const claude = spawn(process.execPath, forever, { stdio: 'ignore', detached: group });
  const rec = spawn(process.execPath, forever, { stdio: 'ignore' });
  put(path.join(L.RUNS, '.harness', 'cli', `${D}.json`), JSON.stringify({ pid: cli.pid, started_at: L.now(), child: group ? claude.pid : null }));
  put(path.join(L.RUNS, '.harness', 'busy', `${D}.json`), JSON.stringify({ task: 'record', pid: rec.pid, started_at: L.now() }));
  const sum = Pj.projectSummary(L.loadRules(), D);
  eq([sum.posts, sum.recordings, sum.running?.cli, sum.running?.chat], [2, 1, true, false], '삭제 요약: 게시물·녹화본 수, 명령줄로 진행 중');
  const r = await Pj.deleteProject(D, { keepExport: true });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await new Promise((ok) => setTimeout(ok, 300));
  eq([alive(cli.pid), alive(rec.pid)], [false, false], '삭제: 진행 중인 명령줄·녹화 프로세스를 멈춘다');
  if (group) eq(alive(claude.pid), false, '삭제: 명령줄이 띄운 Claude Code 묶음까지 멈춘다'); else claude.kill();
  eq(r.stopped, ['명령줄', '녹화'], '삭제: 멈춘 것을 알려 준다');
  ok(!fs.existsSync(L.runPath(D, '')) && !fs.existsSync(path.join(sd, 'state', `${D}.json`)) && !fs.existsSync(path.join(L.RUNS, '.harness', 'scope', `${D}-P1.json`)) && !fs.existsSync(L.activityFile(D)) && !fs.existsSync(path.join(L.ROOT, '.cache', 'explore', D)), '삭제: 기록·상태·작업 표시·캐시를 지운다');
  ok(r.kept && fs.existsSync(path.join(path.resolve(L.ROOT, r.kept), '01.mp4')), '삭제: 게시물 파일은 남겨 둘 수 있다', r.kept);   // 드라이브가 다르면(Windows) r.kept는 절대 경로다
  eq(L.loadRules().projects[D], undefined, '삭제: projects.yaml에서 뺀다');
  let threw = false; try { await Pj.deleteProject('../x'); } catch { threw = true; }
  ok(threw, '삭제: 등록되지 않은 이름·경로는 거부한다');
  fs.rmSync(path.resolve(L.ROOT, r.kept), { recursive: true, force: true });
  fs.writeFileSync(process.env.HARNESS_PROJECTS, before);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${count - failed}/${count} PASS`);
process.exit(failed ? 1 : 0);

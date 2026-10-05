#!/usr/bin/env node
// 명령줄: 주소 하나로 끝까지 만든다 (화면 없이). 시작 화면은 `ui`로 원할 때만 연다.
//   npx ai-url-to-feed <주소> [--bg=#RRGGBB] [--count=6|5-8] [--edit|--auto] [--local --title="<페이지 제목>"] [--no-ai]
//   npx ai-url-to-feed status|open <project> · retake <project> "<요청>" · ui [--port N]
// AI 단계(장면 계획·녹화, 구간·속도 정하기)는 Claude Code를 헤드리스(claude -p)로 띄워 "하네스 시작해줘"를 대신 말한다.
// 권한은 .claude/settings.json의 허용 목록(하네스 스크립트)과 파일 편집만 쓴다. 승인·거절은 사람이 이 명령을 쳤을 때만 기록한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, RUNS, loadRules, assertProject, projectConf, loadState, progress, toolProblems, runningAgent, runningTask, runningCli, clearStaleAgents, stateDir, activityText, markCli } from './lib.mjs';
import { addProject, projectSummary, deleteProject } from './projects.mjs';
import readline from 'node:readline/promises';
import { status } from './run.mjs';

const HELP = `ai-url-to-feed — URL 하나로 인스타그램 3:4(1080×1440) 영상·이미지를 만들어요

  npx ai-url-to-feed <주소> [옵션]       등록하고 끝까지 만들어요 (기본: 자동 생성, 승인 없음)
    --bg=#B987FF                         배경색 (없으면 AI가 사이트와 잘 구분되는 색을 골라요)
    --count=6 | --count=5-8              게시물 수 (기본 5~10개)
    --edit                               다 만든 뒤 편집 화면을 열어 다듬고 한 번 승인해요
    --auto                               편집 모드였던 사이트를 다시 자동 생성으로
    --local --title="내 앱"              내 컴퓨터의 개발 서버 (주소가 localhost면 --local은 생략)
    --no-ai                              등록만 하고 Claude Code에 붙여 넣을 문장을 보여 줘요

  npx ai-url-to-feed status <프로젝트>   진행 상황
  npx ai-url-to-feed open <프로젝트>     결과 폴더 열기
  npx ai-url-to-feed retake <프로젝트> "<요청>"   요청대로 장면을 다시 찍고 다시 만들어요
  npx ai-url-to-feed continue <프로젝트> 멈춘 곳부터 다시 진행해요 (멈춤(STOP)도 풀어요)
  npx ai-url-to-feed delete <프로젝트> [--keep] 사이트와 만든 기록 삭제 (진행 중이면 멈추고, --keep은 게시물 파일만 남겨요)
  npx ai-url-to-feed ui [--port 4455]    시작 화면(HTML)을 열어요

같은 주소로 다시 실행하면 이어서 진행해요. 옵션을 바꿔 다시 실행하면 그 설정으로 다시 만들어요.`;

const VALUE_FLAGS = ['bg', 'count', 'title', 'port'];
const COMMANDS = ['status', 'open', 'retake', 'continue', 'delete', 'ui', 'help'];

// --bg=#fff, --bg #fff 둘 다 받는다
export function parseArgs(argv) {
  const out = { cmd: 'make', args: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.opts.help = true; continue; }
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(a);
    if (!m) { out.args.push(a); continue; }
    if (m[2] !== undefined) out.opts[m[1]] = m[2];
    else if (VALUE_FLAGS.includes(m[1]) && argv[i + 1] != null && !argv[i + 1].startsWith('--')) out.opts[m[1]] = argv[++i];
    else out.opts[m[1]] = true;
  }
  if (COMMANDS.includes(out.args[0])) out.cmd = out.args.shift();
  if (out.opts.help || (out.cmd === 'make' && !out.args.length)) out.cmd = 'help';
  if (out.opts.edit && out.opts.auto) throw new Error('--edit와 --auto는 같이 쓸 수 없어요');
  for (const k of VALUE_FLAGS) if (out.opts[k] === true) throw new Error(`--${k}에 값이 필요해요 (예: --${k}=${{ bg: '#B987FF', count: '6', title: '"내 앱"', port: '4455' }[k]})`);
  return out;
}

// ---- 출력 ----
const isTTY = process.stdout.isTTY;
const paint = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2'), bold = paint('1'), green = paint('32'), red = paint('31'), purple = paint('35'), yellow = paint('33');
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const say = (...a) => console.log(...a);
// 한글은 터미널에서 두 칸을 차지한다
const pad = (str, n) => str + ' '.repeat(Math.max(0, n - [...str].reduce((w, ch) => w + (/[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 2 : 1), 0)));
const STATE = { done: green('완료'), now: yellow('지금'), working: purple('진행 중'), stopped: red('멈춤'), todo: dim('대기'), optional: dim('선택') };

const safe = (rules, p) => { try { return status(rules, p); } catch (e) { return { next: 'STOP', reason: e.message }; } };
function snapshot(project) {
  const rules = loadRules();
  const s = safe(rules, project);
  const pr = progress(rules, project, loadState(rules, project), s, { tools: [], chromium: true, site: { ok: true } });
  return { rules, s, pr };
}
const exportFiles = (project) => { const d = path.join(RUNS, project, 'export'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^\d+\.(mp4|png)$/.test(f)).sort() : []; };
const exportDir = (project) => path.relative(process.cwd(), path.join(RUNS, project, 'export')) || '.';

function envProblems(rules) {
  const out = toolProblems(rules);
  return import('playwright').then(({ chromium }) => { if (!fs.existsSync(chromium.executablePath())) out.push('녹화용 브라우저가 없어요 — npx playwright install chromium'); return out; })
    .catch(() => { out.push('playwright를 불러올 수 없어요 — npm install'); return out; });
}
const hasClaude = () => !spawnSync('claude', ['--version'], { encoding: 'utf8' }).error;
// 헤드리스 실행은 한 번도 신뢰하지 않은 폴더(새로 clone한 폴더)의 .claude/settings.json 허용 목록을 무시한다. 같은 목록을 직접 넘긴다
const allowed = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8')).permissions?.allow ?? []; } catch { return []; } };
const opener = { darwin: 'open', win32: 'explorer', linux: 'xdg-open' }[process.platform];

const usageText = (u) => (u?.runs ? ` · Claude Code 사용량 $${u.cost.toFixed(2)} (API 요금 기준, ${u.turns}턴)` : '');
function printDone(project, s, ms, usage) {
  const files = exportFiles(project);
  say(`\n${green(bold('완성'))}  ${exportDir(project)}/  ${files.join(' ')}`);
  say(dim(`  ${s.reason}${ms ? ` · ${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초` : ''}${usageText(usage)}`));
  say(dim(`  결과 폴더 열기: npx ai-url-to-feed open ${project} · 게시물처럼 넘겨 보기: npx ai-url-to-feed ui`));
}
function printStop(s, project) {
  say(`\n${red(bold('멈췄어요'))}  ${s.reason}`);
  if (project) say(dim(`  원인을 고친 뒤 이어서 하려면: npx ai-url-to-feed continue ${project}`));
  for (const f of s.failing ?? []) say(red(`  - ${f.gate}: ${[].concat(f.detail ?? []).join(' / ')}`));
  if (s.notes?.length) say(dim(`  요청: ${s.notes.at(-1).note}`));
}

// 편집 모드: 다 만든 뒤 편집 화면을 연다 (이 명령이 화면 서버를 띄우고, Ctrl+C로 끈다)
function openUi(pathname, port) {
  const args = [path.join(ROOT, 'scripts', 'app.mjs'), ...(pathname ? ['--path', pathname] : []), ...(port ? ['--port', String(port)] : [])];
  const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
  process.on('SIGINT', () => child.kill('SIGINT'));
  return new Promise((ok) => child.on('exit', (code) => ok(code ?? 0)));
}

// ---- 진행 막대 (cli-progress 모양) ----
// 맨 아래 한 줄을 계속 고쳐 그리고, 끝난 단계는 그 위에 한 줄씩 쌓는다:
//   ✓ 장면 계획          13:32
//   ⠋ ████████░░░░░░░░░░░░  40% | 2/5 녹화 | 녹화하는 중이에요 | 13:40
// 터미널이 아니면(로그 파일·파이프) 바뀐 순간만 "[13:40] (2/5) 녹화 — 녹화하는 중이에요"로 찍는다.
// make-cli-demo.mjs가 같은 함수로 README 미리보기를 그린다.
export const STEPS = ['장면 계획', '녹화', '구간·속도 정하기', '파일 만들기', '자동 검사'];
export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// status → 몇 번째 단계인지 (0부터, STEPS.length면 다 끝남).
// 지금 실제로 도는 일(에이전트 planner·editor, 녹화·내보내기)이 있으면 그것을 따른다 — status는 결과 파일이 생기면 먼저 다음 단계로 넘어간다
export function stepOf(s, prev = 0, running = null) {
  const at = { P1: 0, P2: 1, APPROVAL_PLAN: 2, P3: 2, APPROVAL_FINAL: STEPS.length, DONE: STEPS.length }[s.next];
  const doing = { planner: 0, record: 1, editor: 2, export: 3 }[running];
  const i = doing ?? (s.next === 'P4' ? (s.todo === 'judge' ? 4 : 3) : at ?? prev);
  const label = doing != null ? STEPS[i] : s.next === 'DONE' ? '완성' : s.next === 'STOP' ? '멈춤' : s.next === 'APPROVAL_PLAN' ? '녹화 확인' : s.next === 'APPROVAL_FINAL' ? '다듬기·승인' : STEPS[i];
  return { i, label };
}
// 화면에 쓸 조각들. kind: spin | bar | pct | step | label | text | time
export function barParts({ i, label, text, ms, frame = 0, done = false, width = 20 }) {
  const n = STEPS.length;
  const fill = Math.round((Math.min(i, n) / n) * width);
  return [
    ['spin', done ? '✓' : SPIN[frame % SPIN.length]], ['sp', ' '],
    ['bar', '█'.repeat(fill)], ['rest', '░'.repeat(width - fill)], ['sp', ' '],
    ['pct', `${String(Math.round((Math.min(i, n) / n) * 100)).padStart(3)}%`], ['sep', ' | '],
    ['step', `${Math.min(i + (done ? 0 : 1), n)}/${n}`], ['sp', ' '], ['label', label],
    ...(text ? [['sep', ' | '], ['text', text]] : []), ['sep', ' | '], ['time', clock(ms)],
  ];
}
export const doneLine = (label, ms) => `✓ ${pad(label, 18)} ${clock(ms)}`;
// 터미널에 따라 두 칸을 차지할 수 있는 글자(한글, 막대 █░, 스피너 ⠋, … · — ✓ 등)는 넉넉히 두 칸으로 센다.
// 한 칸으로 잘못 세면 줄이 터미널 폭을 넘어 다음 줄로 넘어가고, 다시 그릴 때마다 줄이 쌓인다
const WIDE = /[\u00b7\u1100-\u11ff\u2010-\u2027\u2190-\u21ff\u2500-\u25ff\u2700-\u27bf\u2800-\u28ff\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/;
export const width = (str) => [...str].reduce((w, ch) => w + (WIDE.test(ch) ? 2 : 1), 0);
const cut = (str, max) => { let w = 0, out = ''; for (const ch of str) { const c = WIDE.test(ch) ? 2 : 1; if (w + c > max) break; out += ch; w += c; } return out; };
// 터미널 폭(cols)에 들어가는 진행 막대 조각. 좁으면 막대를 줄이고, 하는 일 → 단계 이름 순으로 줄이거나 뺀다
export function fitBar(state, cols) {
  const room = Math.max(10, cols - 1);
  const total = (parts) => width(parts.map(([, t]) => t).join(''));
  let parts = barParts({ ...state, width: cols >= 110 ? 20 : cols >= 80 ? 12 : 6 });
  const drop = (kind) => { const i = parts.findIndex(([k]) => k === kind); if (i > 0) parts = [...parts.slice(0, i - 1), ...parts.slice(i + 1)]; };   // 앞의 구분자와 함께
  if (total(parts) > room) {
    const i = parts.findIndex(([k]) => k === 'text');
    if (i > -1) {
      const budget = room - (total(parts) - width(parts[i][1])) - 2;
      if (budget >= 8) parts[i] = ['text', `${cut(parts[i][1], budget)}…`]; else drop('text');
    }
  }
  if (total(parts) > room) drop('label');
  if (total(parts) > room) parts = [parts.find(([k]) => k === 'spin'), ['sp', ' '], parts.find(([k]) => k === 'pct'), ['sep', ' | '], parts.find(([k]) => k === 'time')];
  return parts;
}
const KIND = { spin: purple, bar: purple, rest: dim, pct: bold, sep: dim, step: dim, label: purple, text: (x) => x, time: dim, sp: (x) => x };
// 그리는 동안은 터미널 줄바꿈을 꺼서(\x1b[?7l), 폭 계산이 어긋나도 줄이 쌓이지 않게 한다. 끝나거나 멈추면 다시 켠다
const wrapOff = () => { if (isTTY) process.stdout.write('\x1b[?7l'); };
const wrapOn = () => { if (isTTY) process.stdout.write('\x1b[?7h'); };
process.on('exit', wrapOn);
function drawBar(state) {
  process.stdout.write(`\r\x1b[2K${fitBar(state, process.stdout.columns || 80).map(([k, t]) => KIND[k](t)).join('')}`);
}

// ---- Claude Code를 헤드리스로 돌리며 진행 막대를 보여 준다 ----
async function drive(project, phrase) {
  const rules0 = loadRules();
  const cleared = clearStaleAgents(rules0, project);   // 지난번 명령줄이 중간에 멈추며 남긴 기록
  if (cleared.length) say(dim(`  지난번에 멈춘 ${cleared.join(', ')} 작업 기록을 정리하고 이어서 해요`));
  const busy = runningCli(project) || runningAgent(project) || runningTask(project);
  if (busy) {
    say(red(`이미 다른 창에서 진행 중이에요 (${busy.agent ?? busy.task ?? '명령줄'}). 그 창이 끝난 뒤 다시 실행해요.`));
    if (busy.agent && !busy.owner_pid) say(dim(`  다른 창에서 돌고 있지 않다면(직접 멈춘 실행) 이렇게 이어서 해요: npx ai-url-to-feed continue ${project}`));
    return 1;
  }
  if (!hasClaude()) {
    say(red('Claude Code(claude)를 찾을 수 없어요.') + ' 설치: npm install -g @anthropic-ai/claude-code → claude 한 번 실행해 로그인');
    say(`설치 뒤 다시 실행하거나, 이 폴더에서 연 Claude Code에 붙여 넣어요:  ${bold(`${project} ${phrase}`)}`);
    return 2;
  }
  markCli(project);   // 시작 화면이 "명령줄이 진행 중"으로 보여 준다
  const logDir = path.join(stateDir(loadRules()), 'log');
  const logFile = path.join(logDir, `${project}-claude.log`);
  const eventFile = path.join(logDir, `${project}-cli.jsonl`);   // 진행 기록 (README 미리보기의 재료)
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(eventFile, '');
  const t0 = Date.now();
  const usage = { runs: 0, cost: 0, turns: 0 };   // Claude Code 사용량 (실행마다 더한다)
  const budget = rules0.cli?.budget_usd;   // 이 명령 한 번에 쓸 수 있는 금액. 여러 번 띄우면 남은 금액만 넘긴다
  const cur = { i: null, label: STEPS[0], text: '', since: t0 };   // i는 첫 확인 때 정한다 (이어서 할 때 이미 끝난 단계는 다시 찍지 않는다)
  let frame = 0;
  let lastLine = '';
  const above = (line) => { if (isTTY) process.stdout.write('\r\x1b[2K'); wrapOn(); say(line); wrapOff(); };   // 막대 위에 한 줄 남기기 (긴 줄은 줄바꿈해서 다 보이게)
  const render = (done = false) => { if (isTTY) drawBar({ ...cur, ms: Date.now() - t0, frame, done }); };
  const tick = () => {
    const { s, pr } = snapshot(project);
    const { i, label } = stepOf(s, cur.i ?? 0, runningAgent(project)?.agent ?? runningTask(project)?.task);
    cur.i ??= i;
    // 단계 사이에 Claude Code가 다음 할 일을 고르는 순간 (화면용 "Claude Code에 말해서 …" 대신)
    // 에이전트가 일하는 동안에는 도구 활동(둘러본 화면·돌려 본 시나리오·확인한 프레임 수)을 붙여 멈춘 게 아님을 보여 준다
    const ag = runningAgent(project);
    const extra = ag ? activityText(project, ag.started_at) : '';
    // 단계 이름이 이미 앞에 있으니, 에이전트가 일할 때는 짧게 "AI 작업 중 · 화면 13개 둘러봄"만 쓴다 (좁은 터미널에서도 숫자가 보이게)
    const text = ag ? `AI 작업 중${extra ? ` · ${extra}` : ''}` : pr.todo.since ? pr.todo.text : s.next === 'DONE' ? '' : 'Claude Code가 다음 할 일을 정하는 중';
    if (i > cur.i) for (let k = cur.i; k < Math.min(i, STEPS.length); k++) above(green(doneLine(STEPS[k], Date.now() - (k === cur.i ? cur.since : Date.now()))));
    if (i !== cur.i) cur.since = Date.now();
    Object.assign(cur, { i, label, text });
    const line = `(${Math.min(i + 1, STEPS.length)}/${STEPS.length}) ${label} — ${text}`;
    if (line !== lastLine) {
      lastLine = line;
      fs.appendFileSync(eventFile, `${JSON.stringify({ t: Date.now() - t0, i, label, text, next: s.next })}\n`);
      if (!isTTY && text) say(`[${clock(Date.now() - t0)}] ${line}`);
    }
    render();
    return s;
  };
  wrapOff();
  const spinner = isTTY ? setInterval(() => { frame++; render(); }, 120) : null;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const text = `${project} ${attempt === 1 ? phrase : '이어서 해줘'}`;
      fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} claude -p "${text}"\n`);
      const fd = fs.openSync(logFile, 'a');
      // 결과는 JSON 한 덩어리(사용량 포함)로 받는다. 보고 글은 기록 파일에 남긴다
      // Claude Code를 자기 프로세스 묶음으로 띄운다 (Windows 제외). 멈출 때 그 아래 도구·브라우저까지 묶음째 끄려고
      const group = process.platform !== 'win32';
      const limit = budget ? ['--max-budget-usd', (budget - usage.cost).toFixed(2)] : [];
      const child = spawn('claude', ['-p', text, '--output-format', 'json', '--permission-mode', 'acceptEdits', ...limit, '--allowedTools', ...allowed()], { cwd: ROOT, stdio: ['ignore', 'pipe', fd], detached: group, env: { ...process.env, HARNESS_CLI_PID: String(process.pid) } });
      markCli(project, group ? child.pid : null);
      const killChild = () => { try { if (group) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* 이미 끝났다 */ } };
      process.once('exit', killChild);   // 명령줄이 어떤 이유로 끝나든 Claude Code가 남지 않게
      let stdout = '';
      let overBudget = false;
      child.stdout.on('data', (d) => { stdout += d; });
      const stop = (sig) => { killChild(); wrapOn(); if (sig === 'SIGTERM') process.exit(143); if (isTTY) process.stdout.write('\n'); say(`\n멈췄어요. 이어서 하려면 같은 명령을 다시 실행해요. 기록: ${path.relative(process.cwd(), logFile)}`); process.exit(130); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);   // 시작 화면의 삭제 등 다른 곳에서 멈출 때
      tick();
      const timer = setInterval(tick, 2000);
      const code = await new Promise((ok) => child.on('close', ok));
      try {
        const r = JSON.parse(stdout);
        Object.assign(usage, { runs: usage.runs + 1, cost: usage.cost + (r.total_cost_usd ?? 0), turns: usage.turns + (r.num_turns ?? 0) });
        overBudget = r.subtype === 'error_max_budget_usd' || (!!budget && usage.cost >= budget);
        fs.appendFileSync(logFile, `${r.result ?? ''}\n(사용량 $${(r.total_cost_usd ?? 0).toFixed(2)}, ${r.num_turns}턴, ${Math.round((r.duration_ms ?? 0) / 1000)}초)\n`);
      } catch { fs.appendFileSync(logFile, stdout); }
      clearInterval(timer);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      process.removeListener('exit', killChild);
      fs.closeSync(fd);
      const s = tick();
      if (['DONE', 'STOP', 'APPROVAL_FINAL', 'APPROVAL_PLAN'].includes(s.next)) {
        clearInterval(spinner);
        fs.appendFileSync(eventFile, `${JSON.stringify({ t: Date.now() - t0, i: cur.i, label: cur.label, text: cur.text, next: s.next, end: true, cost_usd: Math.round(usage.cost * 100) / 100, turns: usage.turns })}\n`);
        render(s.next === 'DONE');
        if (isTTY) process.stdout.write('\n');
        wrapOn();
        if (s.next === 'DONE') { printDone(project, s, Date.now() - t0, usage); return 0; }
        if (s.next === 'STOP') { printStop(s, project); say(dim(`  ${usageText(usage).replace(/^ · /, '')}`)); return 1; }
        return 'approval';
      }
      if (overBudget) {
        clearInterval(spinner);
        if (isTTY) process.stdout.write('\n');
        wrapOn();
        say(`\n${red(bold('멈췄어요'))}  Claude Code 사용량이 이 명령의 상한 $${budget}에 닿았어요 (rules.yaml cli.budget_usd)`);
        say(dim(`  ${usageText(usage).replace(/^ · /, '')} · 아직 ${s.next} 단계`));
        say(dim(`  이어서 하려면: npx ai-url-to-feed continue ${project} (명령마다 상한을 새로 세요)`));
        return 1;
      }
      above(dim(`  Claude Code가 끝났지만 아직 ${s.next} 단계예요 (종료 코드 ${code}). 이어서 진행해요 (${attempt}/3)`));
    }
  } finally { clearInterval(spinner); wrapOn(); }
  if (isTTY) process.stdout.write('\n');
  say(red(`세 번 이어서 했지만 끝나지 않았어요. 기록: ${path.relative(process.cwd(), logFile)}`));
  return 1;
}

async function afterApproval(project, port) {
  const { s } = snapshot(project);
  if (s.next === 'APPROVAL_FINAL') {
    say(`\n${bold('다 만들었어요 — 내 취향대로 다듬고 승인해요')} (편집 모드)`);
    say('  편집 화면에서 구간·속도·배경색을 고치고 내보내기 → 완성본 확인에서 승인해요. 그대로 써도 되면 바로 승인해도 돼요.');
    say(dim('  화면을 닫으려면 Ctrl+C. 승인한 뒤에는 다시 할 일이 없어요.'));
    return openUi(`/p/${project}/edit/`, port);
  }
  say(`\n${bold('녹화를 확인하고 승인해요')} (꼼꼼 모드)`);
  say(dim(`  승인한 뒤 같은 명령을 다시 실행하면 이어서 만들어요.`));
  return openUi(`/p/${project}/approve/plan`, port);
}

// ---- 명령 ----
async function make(target, opts) {
  const rules = loadRules();
  const env = await envProblems(rules);
  if (env.length) { say(red('실행 환경을 먼저 준비해야 해요')); env.forEach((x) => say(`  - ${x}`)); return 2; }
  say(`${bold('환경 확인')}      Node ${process.versions.node} · ffmpeg · chromium ${green('완료')}`);
  const r = await addProject(target, { mode: opts.edit ? 'edit' : opts.auto ? 'auto' : undefined, bg: opts.bg, count: opts.count, title: opts.title, local: !!opts.local });
  const conf = projectConf(loadRules(), r.name);
  const extra = [conf.mode !== 'auto' && `진행 방식 ${conf.mode}`, conf.bg && `배경 ${conf.bg}`, `게시물 ${conf.count.join('~')}개`].filter(Boolean).join(' · ');
  say(`${bold('사이트 등록')}    ${r.url} → ${bold(r.name)} ${dim(r.existed ? `(이미 등록됨${r.changed.length ? ` · 바꾼 설정: ${r.changed.join(', ')}` : ''})` : '(새로 등록)')}  ${dim(extra)}`);
  const s = safe(loadRules(), r.name);
  if (opts['no-ai']) {
    say(`\n이 폴더에서 연 Claude Code에 붙여 넣어요:  ${bold(`${r.name} ${s.next === 'P1' && !r.existed ? '하네스 시작해줘' : '이어서 해줘'}`)}`);
    say(dim(`  진행 상황: npx ai-url-to-feed status ${r.name}`));
    return 0;
  }
  if (s.next === 'DONE') { printDone(r.name, s); return 0; }
  if (s.next === 'STOP') { printStop(s, r.name); return 1; }
  const res = ['APPROVAL_FINAL', 'APPROVAL_PLAN'].includes(s.next) ? 'approval' : await drive(r.name, r.existed ? '이어서 해줘' : '하네스 시작해줘');
  return res === 'approval' ? afterApproval(r.name, opts.port) : res;
}

function showStatus(project) {
  const rules = loadRules();
  assertProject(rules, project);
  const conf = projectConf(rules, project);
  const { s, pr } = snapshot(project);
  say(`${bold(project)}  ${conf.url}  ${dim(`진행 방식 ${conf.mode}${conf.bg ? ` · 배경 ${conf.bg}` : ''} · 게시물 ${conf.count.join('~')}개`)}`);
  pr.stages.filter((x) => x.key !== 'env' || x.state !== 'done').forEach((x, i) => {
    const st = pr.todo.who === 'ai' && pr.todo.since && x.state === 'now' ? 'working' : x.state;
    say(`  ${i + 1}. ${pad(x.title, 14)} ${STATE[st] ?? st}  ${dim(x.checks.find((c) => c.detail)?.detail ?? '')}`);
  });
  say(`\n${bold('지금')}  ${pr.todo.text}${pr.todo.since ? dim(` (${clock(Date.now() - Date.parse(pr.todo.since))}째)`) : ''}`);
  if (s.next === 'DONE') say(`${bold('결과')}  ${exportDir(project)}/  ${exportFiles(project).join(' ')}`);
  else if (s.next === 'STOP') printStop(s);
  return 0;
}

function openExport(project) {
  assertProject(loadRules(), project);
  const dir = path.join(RUNS, project, 'export');
  if (!fs.existsSync(dir)) { say(red(`아직 결과 폴더가 없어요: ${exportDir(project)}`)); return 1; }
  if (!opener) { say(dir); return 0; }
  spawn(opener, [dir], { stdio: 'ignore', detached: true }).on('error', () => say(dir)).unref();
  say(`결과 폴더를 열었어요: ${exportDir(project)}/`);
  return 0;
}

// 다시 찍기: 촬영 계획 거절로 기록하고(사람이 이 명령을 친 것이 요청이다) 이어서 진행한다
async function retake(project, note) {
  const rules = loadRules();
  assertProject(rules, project);
  if (!note?.trim()) { say(red('무엇을 바꿀지 적어 주세요. 예: npx ai-url-to-feed retake stuckyi "02는 지도 화면을 더 오래 보여 줘"')); return 1; }
  if (runningAgent(project)) { say(red('AI가 작업 중이라 지금은 다시 찍을 수 없어요. 끝난 뒤 다시 해요.')); return 1; }
  const s = safe(rules, project);
  if (!['APPROVAL_PLAN', 'APPROVAL_FINAL', 'DONE'].includes(s.next)) { say(red(`녹화가 끝난 뒤에 다시 찍을 수 있어요 (지금: ${s.next} — ${s.reason})`)); return 1; }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run.mjs'), 'reject', project, 'plan', '--note', note.trim()], { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) { say(red(r.stderr || r.stdout)); return 2; }
  say(`${bold('다시 찍기 요청')}  "${note.trim()}"`);
  const res = await drive(project, '이어서 해줘');
  return res === 'approval' ? afterApproval(project) : res;
}

// 멈춘 곳부터 다시: 멈춤(STOP)이면 사람이 이 명령을 친 것을 "계속 진행해"로 기록하고(run.mjs unblock) 이어서 한다
async function resume(project, port) {
  const rules = loadRules();
  assertProject(rules, project);
  if (runningCli(project)) { say(red('이미 다른 창의 명령줄이 진행 중이에요. 그 창이 끝난 뒤 다시 실행해요.')); return 1; }
  // 사람이 continue를 쳤다 = 다른 창에서 돌고 있지 않다. 끊긴 에이전트 기록(예전 명령줄·대화가 남긴 것 포함)을 정리한다
  const cleared = clearStaleAgents(rules, project, { all: true });
  if (cleared.length) say(dim(`  멈춘 ${cleared.join(', ')} 작업 기록을 정리했어요`));
  const s = safe(rules, project);
  if (s.next === 'DONE') { printDone(project, s); return 0; }
  if (s.next === 'STOP') {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run.mjs'), 'unblock', project], { encoding: 'utf8', cwd: ROOT });
    if (r.status !== 0) { say(red(r.stderr || r.stdout)); return 2; }
    say(`${bold('멈춤 해제')}  ${dim(s.reason)}`);
  }
  const res = ['APPROVAL_FINAL', 'APPROVAL_PLAN'].includes(s.next) ? 'approval' : await drive(project, '이어서 해줘');
  return res === 'approval' ? afterApproval(project, port) : res;
}

// 삭제: 무엇이 지워지는지 보여 주고, 이름을 똑같이 입력해야 지운다 (--yes면 묻지 않는다)
async function remove(project, opts) {
  const rules = loadRules();
  assertProject(rules, project);
  const s = projectSummary(rules, project);
  say(`${bold(`${project} 사이트를 삭제할까요?`)}  ${dim(s.url)}`);
  say(`  게시물 파일 ${s.posts}개 · 녹화본 ${s.recordings}개 · 촬영 계획·편집값·검사 결과·진행 기록`);
  if (s.running) say(red(`  지금 진행 중이에요. 삭제하면 진행을 멈추고 지워요.${s.running.chat ? ' 대화창의 Claude Code에서 진행 중이면 그 창은 직접 멈춰 주세요.' : ''}`));
  if (opts.keep) say(dim('  게시물 파일은 runs/_kept/로 옮겨 남겨요'));
  if (!opts.yes) {
    if (!process.stdin.isTTY) { say(red('확인할 수 없어요. 터미널에서 실행하거나 --yes를 붙여요')); return 1; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question(`  확인을 위해 이름(${bold(project)})을 그대로 입력해요: `)).trim();
    rl.close();
    if (typed !== project) { say('취소했어요'); return 1; }
  }
  const r = await deleteProject(project, { keepExport: !!opts.keep });
  say(`${green('삭제했어요')}  ${project}${r.stopped.length ? dim(` (${r.stopped.join('·')} 멈춤)`) : ''}${r.kept ? dim(` · 게시물은 ${r.kept}/에 남겼어요`) : ''}`);
  return 0;
}

async function main(argv) {
  const { cmd, args, opts } = parseArgs(argv);
  if (cmd === 'help') { say(HELP); return 0; }
  if (cmd === 'ui') return openUi(null, opts.port);
  if (cmd === 'status') return args[0] ? showStatus(args[0]) : (say(red('프로젝트 이름을 적어요: npx ai-url-to-feed status <프로젝트>')), 1);
  if (cmd === 'open') return args[0] ? openExport(args[0]) : (say(red('프로젝트 이름을 적어요: npx ai-url-to-feed open <프로젝트>')), 1);
  if (cmd === 'retake') return retake(args[0], args.slice(1).join(' '));
  if (cmd === 'delete') return args[0] ? remove(args[0], opts) : (say(red('프로젝트 이름을 적어요: npx ai-url-to-feed delete <프로젝트>')), 1);
  if (cmd === 'continue') return args[0] ? resume(args[0], opts.port) : (say(red('프로젝트 이름을 적어요: npx ai-url-to-feed continue <프로젝트>')), 1);
  if (args.length > 1) { say(red(`주소는 하나만 넣어요: ${args.join(' ')}`)); return 1; }
  return make(args[0], opts);
}

// bin 링크(node_modules/.bin)로 실행해도 이 파일이 진입점인지 실제 경로로 비교한다
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(typeof code === 'number' ? code : 0), (e) => { console.error(red(e.message)); process.exit(2); });
}

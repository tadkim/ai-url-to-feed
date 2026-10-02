// 하네스 스크립트 공통 모듈. 판정 수치는 rules.yaml에서만 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS = process.env.HARNESS_RUNS || path.join(ROOT, 'runs');

export const readText = (p) => fs.readFileSync(p, 'utf8');
export const readJson = (p) => JSON.parse(readText(p));
export const exists = (p) => fs.existsSync(p);
export const now = () => new Date().toISOString();
export const sha = (...parts) => {
  const h = crypto.createHash('sha256');
  parts.forEach((p, i) => { if (i) h.update('\0'); h.update(p ?? ''); });
  return h.digest('hex');
};
export const fileSha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const readIf = (p, json = false) => {
  if (!exists(p)) return null;
  if (!json) return readText(p);
  try { return readJson(p); } catch { return null; }
};

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// 프로젝트 목록은 projects.yaml(이 컴퓨터에만, git 제외)에서 읽는다. 테스트는 HARNESS_PROJECTS로 바꾼다
export const PROJECTS_FILE = process.env.HARNESS_PROJECTS || path.join(ROOT, 'projects.yaml');
export function loadRules() {
  const rules = YAML.parse(readText(path.join(ROOT, 'rules.yaml')));
  rules.projects = (exists(PROJECTS_FILE) && YAML.parse(readText(PROJECTS_FILE))?.projects) || {};
  return rules;
}

// 실행 환경 검사: node 버전, ffmpeg, npm 패키지. 문제가 있으면 사람이 읽을 문장 목록을 돌려준다
export function toolProblems(rules) {
  const out = [];
  const num = (v) => String(v).split('.').reduce((acc, x) => acc * 1000 + Number(x), 0);
  if (num(process.versions.node) < num(rules.tools.node_min)) out.push(`node ${rules.tools.node_min} 이상이 필요하다 (지금 ${process.versions.node})`);
  for (const c of rules.tools.commands) {
    const r = spawnSync(c, ['-version']);
    if (r.error || r.status !== 0) out.push(`${c}를 실행할 수 없다 — ffmpeg를 설치한다 (macOS: brew install ffmpeg)`);
  }
  for (const p of rules.tools.packages) {
    try { import.meta.resolve(p); } catch { out.push(`npm 패키지 ${p}를 불러올 수 없다 — npm install을 실행한다`); }
  }
  return out;
}

export function assertProject(rules, project) {
  if (!rules.projects[project]) {
    const known = Object.keys(rules.projects);
    if (!known.length) throw new Error(`등록된 프로젝트가 없다 — cp projects.example.yaml projects.yaml 후 프로젝트를 적는다 (${path.relative(ROOT, PROJECTS_FILE) || PROJECTS_FILE})`);
    throw new Error(`project는 ${known.join(' | ')} 중 하나여야 한다 (projects.yaml): ${project}`);
  }
}

// 프로젝트별 요청이 있으면 그 값, 없으면 기본값
export function projectConf(rules, project) {
  const p = rules.projects[project];
  return {
    ...p,
    url: String(p.url).replace(/\/+$/, ''),
    count: p.asset_count ?? rules.assets.count,
    maxVideoSeconds: p.max_video_seconds ?? rules.export.video.max_seconds,
  };
}

export const runPath = (project, rel) => path.join(RUNS, project, rel);
export const phasePath = (rules, project, phase) => runPath(project, rules.phases[phase]);
export const derivedPath = (rules, project, key) => runPath(project, rules.derived[key]);
export const nn = (n) => String(n).padStart(2, '0');

// ---- 색 ----
export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`색 형식 오류: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v));

function toLab(rgb) {
  const lin = rgb.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const [x, y, z] = [
    (lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805) / 0.95047,
    lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722,
    (lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505) / 1.08883,
  ];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

// CIE76 색 차이
export function deltaE(a, b) {
  const [l1, a1, b1] = toLab(typeof a === 'string' ? parseHex(a) : a);
  const [l2, a2, b2] = toLab(typeof b === 'string' ? parseHex(b) : b);
  return Math.round(Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 10) / 10;
}

// ---- 배치 ----
export const rawSize = (rules) => ({ width: rules.record.viewport.width * rules.record.scale, height: rules.record.viewport.height * rules.record.scale });

// 배치 이름 → 화면 크기와 자리 [{ x, y, w, h }]
export function layoutOf(rules, name) {
  const l = rules.assets.layouts[name];
  if (!l) return null;
  const raw = rawSize(rules);
  const [w, h] = [Math.round(raw.width * l.scale), Math.round(raw.height * l.scale)];
  return { name, types: l.types, w, h, slots: l.slots.map(([x, y]) => ({ x, y, w, h })) };
}

// 주기(초) 목록의 최소공배수 (초). ms 단위 정수로 계산한다
export function lcmSeconds(periods) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const ms = periods.map((p) => Math.round(Number(p) * 1000));
  if (!ms.length || ms.some((v) => !(v > 0))) return null;
  return ms.reduce((a, b) => (a / gcd(a, b)) * b) / 1000;
}

// ---- ffmpeg ----
export function ff(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: opts.binary ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} 실행 실패: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} 오류: ${String(r.stderr).trim().split('\n').slice(-3).join(' / ')}`);
  return r.stdout;
}

export function probe(file) {
  const d = JSON.parse(ff('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  const v = d.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error(`영상 스트림 없음: ${file}`);
  const [a, b] = (v.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    width: v.width, height: v.height, codec: v.codec_name, pix_fmt: v.pix_fmt,
    fps: b ? Math.round((a / b) * 100) / 100 : 0,
    duration: Math.round(Number(d.format.duration ?? v.duration ?? 0) * 1000) / 1000,
    color_space: v.color_space ?? null, color_primaries: v.color_primaries ?? null, color_transfer: v.color_transfer ?? null,
    audio: d.streams.some((s) => s.codec_type === 'audio'),
  };
}

// 한 프레임을 RGB로. t가 null이면 첫 프레임(이미지 파일). matrix는 영상의 YUV 행렬
export function frameRgb(file, t, { size, matrix } = {}) {
  const scale = ['scale=', size ? `${size[0]}:${size[1]}:` : '', 'flags=bilinear', matrix ? `:in_color_matrix=${matrix}:in_range=tv` : ''].join('');
  const args = ['-v', 'error', ...(t == null ? [] : ['-ss', String(Math.max(0, t))]), '-i', file, '-frames:v', '1', '-vf', `${scale},format=rgb24`, '-f', 'rawvideo', '-'];
  return ff('ffmpeg', args, { binary: true });
}

export function psnr(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  if (se === 0) return 100;
  return Math.round(10 * Math.log10((255 * 255) / (se / a.length)) * 10) / 10;
}

// 컨택트 시트와 장면 전환 시점 — 영상을 재생하지 않고 흐름을 본다. 마지막 칸은 항상 끝 프레임이다
export function inspectVideo(rules, file, duration, sheet = file.replace(/\.mp4$/, '.sheet.png')) {
  const r = rules.record;
  const every = Math.max(r.sheet_every_seconds, Math.ceil(duration / r.sheet_max_tiles));
  const n = Math.max(1, Math.floor(duration / every) + 1);
  const cols = Math.min(8, n + 1);
  const tmp = `${sheet}.end.png`;
  ff('ffmpeg', ['-v', 'error', '-y', '-sseof', '-0.1', '-i', file, '-frames:v', '1', '-vf', 'scale=180:-2', tmp]);
  ff('ffmpeg', ['-v', 'error', '-y', '-i', file, '-i', tmp, '-filter_complex',
    `[0:v]fps=1/${every}:start_time=0:round=down,scale=180:-2,trim=end_frame=${n}[a];[a][1:v]concat=n=2:v=1,tile=${cols}x${Math.ceil((n + 1) / cols)}:padding=4:color=black`, '-frames:v', '1', sheet]);
  fs.rmSync(tmp, { force: true });
  const out = ff('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select='gt(scene,${r.scene_threshold})',metadata=print:file=-`, '-f', 'null', '-']);
  const scenes = [...out.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 100) / 100);
  return { sheet: path.basename(sheet), sheet_every: every, scenes };
}

// 녹화 결과에 영향을 주는 설정만 (컨택트 시트 설정을 바꿔도 다시 녹화하지 않는다)
export const engineSettings = (rules) => { const { viewport, scale, fps, jpeg_quality, crf, locale } = rules.record; return { viewport, scale, fps, jpeg_quality, crf, locale }; };

// ---- 계획 ----
export const planDir = (rules, project) => path.dirname(phasePath(rules, project, 'P1'));
export const scenarioFiles = (rules, project) => {
  const dir = planDir(rules, project);
  return exists(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.scenario.mjs')).sort() : [];
};

// 녹화에 영향을 주는 것: plan.json의 recordings + 시나리오 파일 내용
export function recordHash(rules, project) {
  const plan = readIf(phasePath(rules, project, 'P1'), true);
  if (!plan) return null;
  const dir = planDir(rules, project);
  return sha(JSON.stringify(plan.recordings ?? null), ...scenarioFiles(rules, project).flatMap((f) => [f, readText(path.join(dir, f))]));
}

// 승인 1 해시: plan.json + 시나리오 + 녹화본. 이후 하나라도 바뀌면 승인이 무효가 된다
export function planHash(rules, project) {
  const plan = readIf(phasePath(rules, project, 'P1'));
  if (!plan) return null;
  const raw = readIf(derivedPath(rules, project, 'raw'), true);
  return sha(plan, recordHash(rules, project), JSON.stringify((raw?.recordings ?? []).map((r) => [r.name, r.sha ?? null])));
}

// ---- 편집값 ----
export const defaultStyle = (rules) => ({ ...rules.style.default });

// 에셋 1개를 다시 만들어야 하는지 가르는 해시: 편집값 + 공통 꾸밈 + 배치·내보내기 규격 + 녹화본 내용
export function assetHash(rules, edits, asset, raw) {
  const sources = asset.type === 'video' ? [asset.source] : (asset.shots ?? []).map((s) => s.source);
  const shaOf = (name) => raw?.recordings?.find((r) => r.name === name)?.sha ?? null;
  const spec = asset.type === 'video'
    ? { type: 'video', layout: asset.layout, source: asset.source, in: asset.in, out: asset.out, speed: asset.speed ?? 1 }
    : { type: 'image', layout: asset.layout, shots: (asset.shots ?? []).map((s) => ({ source: s.source, at: s.at })) };
  return sha(JSON.stringify([spec, edits.style, rules.assets.canvas, rules.assets.layouts[asset.layout], rules.export, rules.record.matrix, sources.map(shaOf)])).slice(0, 16);
}

export const editsHash = (rules, project) => { const t = readIf(phasePath(rules, project, 'P3')); return t ? sha(t) : null; };
export const assetFile = (asset) => `${nn(asset.n)}.${asset.type === 'video' ? 'mp4' : 'png'}`;
export const videoSeconds = (asset) => Math.round(((asset.out - asset.in) / (asset.speed ?? 1)) * 1000) / 1000;

// 승인 2 해시: export/의 에셋 파일 이름 + 내용 + edits.json
export function exportHash(rules, project) {
  const dir = path.dirname(derivedPath(rules, project, 'export'));
  if (!exists(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^\d{2}\.(png|mp4)$/.test(f)).sort();
  return files.length ? sha(...files.flatMap((f) => [f, fileSha(path.join(dir, f))])) : null;
}
export const finalHash = (rules, project) => sha(exportHash(rules, project), editsHash(rules, project));

// ---- 실행 상태 (runs/.harness/). 오케스트레이터만 쓴다 ----
export const stateDir = (rules) => path.join(RUNS, rules.state_dir);
const stateFile = (rules, project) => path.join(stateDir(rules), 'state', `${project}.json`);

export function loadState(rules, project) {
  return {
    plan_rejects: 0, plan_notes: [], plan_rejected_at: null,
    final_rejects: 0, final_notes: [], final_rejected_at: null, final_rejected_edits: null,
    approved_plan_at: null, approved_final_at: null, unblocked_at: null, p3_invalid_runs: 0, done: {},
    ...(readIf(stateFile(rules, project), true) ?? {}),
  };
}
export const saveState = (rules, project, state) => writeJson(stateFile(rules, project), state);

const logFile = (rules, project) => path.join(stateDir(rules), 'log', `${project}.jsonl`);
export function appendLog(rules, project, entry) {
  fs.mkdirSync(path.dirname(logFile(rules, project)), { recursive: true });
  fs.appendFileSync(logFile(rules, project), `${JSON.stringify({ at: now(), ...entry })}\n`);
}
export const readLog = (rules, project) => (readIf(logFile(rules, project)) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---- 판정에 쓰는 현재 상태 ----
export function loadContext(rules, project) {
  return {
    rules, project, conf: projectConf(rules, project),
    plan: readIf(phasePath(rules, project, 'P1'), true),
    planText: readIf(phasePath(rules, project, 'P1')),
    raw: readIf(derivedPath(rules, project, 'raw'), true),
    edits: readIf(phasePath(rules, project, 'P3'), true),
    editsText: readIf(phasePath(rules, project, 'P3')),
    exp: readIf(derivedPath(rules, project, 'export'), true),
    dir: (rel) => runPath(project, rel),
  };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, [lo, hi]) => isNum(v) && v >= lo && v <= hi;

// 번호가 01부터 연속이고 수가 범위 안인지
function numbering(assets, [lo, hi]) {
  const errs = [];
  if (assets.length < lo || assets.length > hi) errs.push(`에셋 ${assets.length}개 — ${lo}~${hi}개여야 한다`);
  assets.forEach((a, i) => { if (a.n !== i + 1) errs.push(`에셋 번호가 01부터 연속이 아니다: ${i + 1}번째가 ${a.n}`); });
  return errs;
}

function layoutErrors(rules, a) {
  if (!rules.assets.types.includes(a.type)) return [`${nn(a.n)}: 유형 ${a.type} — ${rules.assets.types.join(' | ')}`];
  const l = rules.assets.layouts[a.layout];
  if (!l) return [`${nn(a.n)}: 배치 ${a.layout} — ${Object.keys(rules.assets.layouts).join(' | ')}`];
  if (!l.types.includes(a.type)) return [`${nn(a.n)}: ${a.type}는 배치 ${a.layout}을 쓸 수 없다 (${l.types.join(', ')}만)`];
  return [];
}

export function planErrors(ctx) {
  const { rules, plan, conf, project } = ctx;
  if (!plan) return ['plan.json이 없거나 JSON이 아니다'];
  if (!Array.isArray(plan.recordings) || !plan.recordings.length) return ['recordings가 비어 있다'];
  if (!Array.isArray(plan.assets)) return ['assets가 배열이 아니다'];
  const errs = [];
  const names = new Set();
  const files = new Set(scenarioFiles(rules, project));
  for (const r of plan.recordings) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(r.name ?? '')) errs.push(`recording 이름은 소문자·숫자·-만: ${r.name}`);
    if (names.has(r.name)) errs.push(`recording 이름 중복: ${r.name}`);
    names.add(r.name);
    if (r.scenario !== `${r.name}.scenario.mjs`) errs.push(`${r.name}: scenario는 "${r.name}.scenario.mjs"여야 한다`);
    else if (!files.has(r.scenario)) errs.push(`${r.name}: 시나리오 파일 없음 (plan/${r.scenario})`);
  }
  for (const f of files) if (!plan.recordings.some((r) => r.scenario === f)) errs.push(`recordings에 없는 시나리오 파일: ${f}`);
  errs.push(...numbering(plan.assets, conf.count));
  for (const a of plan.assets) {
    errs.push(...layoutErrors(rules, a));
    if (!String(a.scene ?? '').trim()) errs.push(`${nn(a.n)}: scene(어떤 장면인지)이 비어 있다`);
    if (!Array.isArray(a.sources) || !a.sources.length) errs.push(`${nn(a.n)}: sources가 비어 있다`);
    else for (const s of a.sources) if (!names.has(s)) errs.push(`${nn(a.n)}: sources의 ${s}가 recordings에 없다`);
  }
  return errs;
}

export function scenarioErrors(ctx) {
  const { rules, project, conf } = ctx;
  const dir = planDir(rules, project);
  const errs = [];
  const files = scenarioFiles(rules, project);
  if (!files.length) return ['시나리오 파일(*.scenario.mjs)이 없다'];
  for (const f of files) {
    const src = readText(path.join(dir, f));
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const head = src.slice(0, src.search(/^\s*(import|export)\b/m) >>> 0);
    if (!/export\s+default\b/.test(code)) errs.push(`${f}: export default가 없다`);
    if (!/\bscenario\s*[:(]/.test(code)) errs.push(`${f}: scenario 함수가 없다`);
    if (!/\bstartCapture\s*\(/.test(code)) errs.push(`${f}: startCapture() 호출이 없다`);
    if (/\bsetTimeout\s*\(|\bwaitForTimeout\s*\(/.test(code)) errs.push(`${f}: setTimeout·waitForTimeout을 쓰지 않는다 (속도 조절은 dwell, 준비 확인은 waitForFunction·waitFor)`);
    if (/\brecord(Clips)?\s*\(|from\s+['"]walkthrough-recorder['"]/.test(code)) errs.push(`${f}: record()를 직접 부르지 않는다 (record.mjs가 실행한다)`);
    if (/\b(viewport|scale|deviceScaleFactor|outDir|baseUrl)\s*:/.test(code)) errs.push(`${f}: viewport·scale·outDir·baseUrl을 지정하지 않는다 (rules.yaml 값으로 고정)`);
    if (/\bfs\b|node:fs|child_process|process\.env/.test(code)) errs.push(`${f}: 파일·프로세스·환경변수에 접근하지 않는다`);
    if (conf.allow_writes && !/쓰기/.test(head)) errs.push(`${f}: 쓰기 허용 프로젝트 — 맨 위 주석에 백엔드 쓰기 여부("쓰기")를 적는다`);
  }
  return errs;
}

export function rawErrors(ctx) {
  const { rules, project, plan, raw } = ctx;
  if (!raw) return ['raw/manifest.json 없음 — record.mjs'];
  if (raw.record_hash !== recordHash(rules, project)) return ['계획·시나리오가 바뀐 뒤 녹화하지 않았다'];
  const errs = [];
  const size = rawSize(rules);
  for (const r of plan?.recordings ?? []) {
    const m = raw.recordings.find((x) => x.name === r.name);
    if (!m) { errs.push(`${r.name}: 녹화 기록 없음`); continue; }
    if (m.error) { errs.push(`${r.name}: ${m.error}`); continue; }
    if (!exists(ctx.dir(`raw/${m.file}`))) { errs.push(`${r.name}: 파일 없음 raw/${m.file}`); continue; }
    if (m.width !== size.width || m.height !== size.height) errs.push(`${r.name}: ${m.width}x${m.height} — ${size.width}x${size.height}이어야 한다`);
    if (m.duration > rules.record.max_raw_seconds) errs.push(`${r.name}: ${m.duration}초 — ${rules.record.max_raw_seconds}초 이하여야 한다`);
  }
  return errs;
}

export function editsErrors(ctx) {
  const { rules, edits, raw, conf } = ctx;
  if (!edits) return ['edits.json이 없거나 JSON이 아니다'];
  if (!Array.isArray(edits.assets)) return ['assets가 배열이 아니다'];
  const errs = [];
  const s = edits.style ?? {};
  if (!isHex(s.bg)) errs.push(`style.bg는 #RRGGBB: ${s.bg}`);
  if (!isHex(s.border)) errs.push(`style.border는 #RRGGBB: ${s.border}`);
  if (!Number.isInteger(s.bw) || !inRange(s.bw, rules.style.bw)) errs.push(`style.bw는 ${rules.style.bw.join('~')} 정수: ${s.bw}`);
  if (!Number.isInteger(s.radius) || !inRange(s.radius, rules.style.radius)) errs.push(`style.radius는 ${rules.style.radius.join('~')} 정수: ${s.radius}`);
  errs.push(...numbering(edits.assets, conf.count));
  const dur = (name) => { const r = raw?.recordings?.find((x) => x.name === name); return r && !r.error ? r.duration : null; };
  for (const a of edits.assets) {
    const id = nn(a.n);
    const le = layoutErrors(rules, a);
    if (le.length) { errs.push(...le); continue; }
    if (a.type === 'video') {
      const d = dur(a.source);
      if (d == null) { errs.push(`${id}: 녹화본 ${a.source} 없음`); continue; }
      if (!isNum(a.in) || !isNum(a.out) || a.in < 0 || a.out > d + 0.001 || a.in >= a.out) errs.push(`${id}: 구간 ${a.in}~${a.out} — 0 <= in < out <= ${d}`);
      if (!inRange(a.speed ?? 1, rules.edit.speed)) errs.push(`${id}: 속도 ${a.speed} — ${rules.edit.speed.join('~')}`);
      if (a.loop != null && (!Array.isArray(a.loop.periods) || lcmSeconds(a.loop.periods) == null)) errs.push(`${id}: loop.periods는 0보다 큰 초 목록`);
    } else {
      const need = rules.assets.layouts[a.layout].slots.length;
      if (!Array.isArray(a.shots) || a.shots.length !== need) { errs.push(`${id}: shots ${a.shots?.length ?? 0}개 — 배치 ${a.layout}은 ${need}개`); continue; }
      for (const sh of a.shots) {
        const d = dur(sh.source);
        if (d == null) errs.push(`${id}: 녹화본 ${sh.source} 없음`);
        else if (!isNum(sh.at) || sh.at < 0 || sh.at > d) errs.push(`${id}: 추출 시점 ${sh.at} — 0~${d}`);
      }
    }
  }
  return errs;
}

// ---- P4: 내보낸 파일 측정 ----
const px = (buf, w, x, y) => [buf[(y * w + x) * 3], buf[(y * w + x) * 3 + 1], buf[(y * w + x) * 3 + 2]];

// 에셋 파일에서 검사할 프레임들 (영상: 첫·마지막, 이미지: 1장). 한 번만 뽑아 여러 게이트가 같이 쓴다
function framesOf(ctx, a) {
  ctx.frameCache ??= new Map();
  if (ctx.frameCache.has(a.n)) return ctx.frameCache.get(a.n);
  const file = ctx.dir(`export/${assetFile(a)}`);
  let out = [];
  if (exists(file)) {
    if (a.type === 'video') {
      const p = probe(file);
      const matrix = ctx.rules.export.video.color;
      out = [['첫 프레임', frameRgb(file, 0, { matrix })], ['마지막 프레임', frameRgb(file, p.duration - 1.5 / (p.fps || 30), { matrix })]];
    } else out = [['이미지', frameRgb(file, null)]];
  }
  ctx.frameCache.set(a.n, out);
  return out;
}

function exportErrors(ctx) {
  const { rules, edits, raw, exp } = ctx;
  if (!exp) return ['export/manifest.json 없음 — export.mjs'];
  const errs = [];
  const { width, height } = rules.assets.canvas;
  const v = rules.export.video;
  for (const a of edits.assets) {
    const id = nn(a.n);
    const file = ctx.dir(`export/${assetFile(a)}`);
    const m = exp.assets.find((x) => x.n === a.n);
    if (!m || m.hash !== assetHash(rules, edits, a, raw) || !exists(file)) { errs.push(`${id}: 현재 편집값으로 내보내지 않았다`); continue; }
    const p = probe(file);
    if (p.width !== width || p.height !== height) errs.push(`${id}: ${p.width}x${p.height} — ${width}x${height}`);
    if (a.type !== 'video') continue;
    if (p.codec !== v.codec) errs.push(`${id}: 코덱 ${p.codec} — ${v.codec}`);
    if (p.pix_fmt !== v.pix_fmt) errs.push(`${id}: 픽셀 형식 ${p.pix_fmt} — ${v.pix_fmt}`);
    if (Math.abs(p.fps - v.fps) > 0.01) errs.push(`${id}: ${p.fps}fps — ${v.fps}fps`);
    if (p.audio) errs.push(`${id}: 소리가 있다`);
    for (const k of ['color_space', 'color_primaries', 'color_transfer']) if (p[k] !== v.color) errs.push(`${id}: ${k} ${p[k]} — ${v.color}`);
  }
  const extra = fs.readdirSync(ctx.dir('export')).filter((f) => /\.(png|mp4)$/.test(f) && !edits.assets.some((a) => assetFile(a) === f));
  if (extra.length) errs.push(`edits.json에 없는 파일: ${extra.join(', ')}`);
  return errs;
}

function lengthErrors(ctx) {
  const errs = [];
  for (const a of ctx.edits.assets.filter((x) => x.type === 'video')) {
    const file = ctx.dir(`export/${assetFile(a)}`);
    if (!exists(file)) continue;
    const d = probe(file).duration;
    if (d > ctx.conf.maxVideoSeconds + 0.05) errs.push(`${nn(a.n)}: ${d}초 — ${ctx.conf.maxVideoSeconds}초 이하`);
    if (d < ctx.rules.edit.min_seconds) errs.push(`${nn(a.n)}: ${d}초 — ${ctx.rules.edit.min_seconds}초 이상`);
  }
  return errs;
}

function edgeErrors(ctx) {
  const { rules, edits } = ctx;
  const W = rules.assets.canvas.width;
  const errs = [];
  for (const a of edits.assets) {
    const l = layoutOf(rules, a.layout);
    for (const [label, buf] of framesOf(ctx, a)) {
      l.slots.forEach((s, i) => {
        const inset = Math.max(8, edits.style.radius);
        const counts = new Map();
        let total = 0;
        for (let y = s.y + inset; y < s.y + s.h - inset; y += 6) for (let x = s.x + inset; x < s.x + s.w - inset; x += 6) {
          const key = px(buf, W, x, y).map((c) => c >> 4).join(',');
          counts.set(key, (counts.get(key) ?? 0) + 1);
          total++;
        }
        const share = Math.max(...counts.values()) / total;
        if (share >= rules.gate.blank_share) errs.push(`${nn(a.n)} ${label}${l.slots.length > 1 ? ` 화면 ${i + 1}` : ''}: 빈 화면 (한 가지 색 ${(share * 100).toFixed(1)}%)`);
      });
    }
  }
  return errs;
}

function bgErrors(ctx) {
  const { rules, edits } = ctx;
  const { width: W, height: H } = rules.assets.canvas;
  const bg = parseHex(edits.style.bg);
  const errs = [];
  for (const a of edits.assets) {
    const l = layoutOf(rules, a.layout);
    const m = edits.style.bw + 4;
    const inSlot = (x, y) => l.slots.some((s) => x >= s.x - m && x < s.x + s.w + m && y >= s.y - m && y < s.y + s.h + m);
    for (const [label, buf] of framesOf(ctx, a)) {
      let worst = 0;
      for (let y = 4; y < H; y += 24) for (let x = 4; x < W; x += 24) if (!inSlot(x, y)) worst = Math.max(worst, deltaE(px(buf, W, x, y), bg));
      if (worst > rules.gate.same_color_delta_e) errs.push(`${nn(a.n)} ${label}: 배경이 ${edits.style.bg}와 ΔE ${worst} 다르다 (허용 ${rules.gate.same_color_delta_e})`);
    }
  }
  return errs;
}

// 루프 이음매: 녹화본의 구간 시작 프레임과 끝 프레임
export function loopSeam(ctx, a) {
  const r = ctx.raw?.recordings?.find((x) => x.name === a.source);
  const file = r && ctx.dir(`raw/${r.file}`);
  if (!file || !exists(file)) return null;
  const opt = { size: [270, 480], matrix: ctx.rules.record.matrix };
  return psnr(frameRgb(file, a.in, opt), frameRgb(file, a.out, opt));
}

function loopErrors(ctx) {
  const { rules, edits } = ctx;
  const errs = [];
  for (const a of edits.assets.filter((x) => x.type === 'video' && x.loop)) {
    const lcm = lcmSeconds(a.loop.periods);
    const len = Math.round((a.out - a.in) * 1000) / 1000;
    if (Math.abs(len - lcm) > rules.gate.loop_tolerance_seconds) errs.push(`${nn(a.n)}: 구간 ${len}초 — 주기(${a.loop.periods.join(', ')})의 최소공배수 ${lcm}초여야 한다`);
    const p = loopSeam(ctx, a);
    if (p == null) errs.push(`${nn(a.n)}: 녹화본 ${a.source} 없음`);
    else if (p < rules.gate.loop_psnr_min) errs.push(`${nn(a.n)}: 이음매 PSNR ${p}dB — ${rules.gate.loop_psnr_min}dB 이상 (시작점을 옮긴다)`);
  }
  return errs;
}

const approvalOk = (ctx, key, hash) => {
  const a = readIf(derivedPath(ctx.rules, ctx.project, key), true);
  if (!a) return ['승인 기록 없음'];
  return a.hash === hash ? [] : ['승인 뒤 내용이 바뀌었다'];
};

export const CHECKERS = {
  plan_valid: planErrors,
  scenario_rules: scenarioErrors,
  approval_plan: (ctx) => approvalOk(ctx, 'approval_plan', planHash(ctx.rules, ctx.project)),
  raw_files: rawErrors,
  edits_valid: editsErrors,
  export_files: exportErrors,
  video_length: lengthErrors,
  clip_edges: edgeErrors,
  canvas_bg: bgErrors,
  loop_seam: loopErrors,
  approval_final: (ctx) => approvalOk(ctx, 'approval_final', finalHash(ctx.rules, ctx.project)),
};

export const gatesFor = (rules, phase) => Object.entries(rules.gates).filter(([, g]) => g.phase === phase);
export const isHuman = (rules, id) => !!rules.gates[id]?.human_approval;

export function runGates(ctx, gates) {
  return gates.map(([id]) => {
    let detail;
    try { detail = CHECKERS[id](ctx); } catch (e) { detail = [`측정 오류: ${e.message}`]; }
    return { gate: id, pass: detail.length === 0, detail };
  });
}

// ---- 에이전트 편집 범위 기록 (겹쳐 도는 다른 project의 쓰기를 구분한다) ----
export const scopeDir = () => { const d = path.join(RUNS, '.harness', 'scope'); fs.mkdirSync(d, { recursive: true }); return d; };

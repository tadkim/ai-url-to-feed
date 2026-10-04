#!/usr/bin/env node
// 오케스트레이터 명령. 에이전트는 실행하지 않는다.
// 사용:
//   node scripts/run.mjs status  <project>                   다음 할 일. 오케스트레이터는 항상 이것부터 실행한다
//   node scripts/run.mjs begin   <project> <phase>           에이전트 실행 직전 (phase: P1 | P3)
//   node scripts/run.mjs end     <project> <phase> [--tokens N]   에이전트 실행 직후: 편집 범위 확인 + 완료 기록
//   node scripts/run.mjs approve <project> plan|final        사람이 "촬영 계획 승인" / "완성본 승인"이라고 했을 때만
//   node scripts/run.mjs reject  <project> plan|final [--note "<요청>"]   사람이 거절했을 때만
//   node scripts/run.mjs unblock <project>                   사람이 "계속 진행해"라고 했을 때만 (STOP 해제)
//   node scripts/run.mjs accept  <project> <phase>           end가 FAIL인데 사람이 "그 편집은 내가 했다"고 확인했을 때만
//   node scripts/run.mjs usage   <project> <phase> --tokens N    완료 알림의 토큰 수를 나중에 기록
// 종료 코드: 0 정상(status는 항상 0), 1 편집 범위 위반, 2 실행 오류
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  ROOT, RUNS, readJson, readIf, exists, writeJson, now, loadRules, assertProject, derivedPath, loadContext,
  gatesFor, runGates, isHuman, planHash, recordHash, finalHash, editsHash, exportHash, assetHash, assetFile,
  loadState, saveState, appendLog, readLog, scopeDir, editsErrors, toolProblems, planContentHash, snapshotHistory,
  needsPlanApproval, needsFinalApproval,
} from './lib.mjs';

const [cmd, project, phaseArg] = process.argv.slice(2);
const opt = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const after = (a, b) => !!a && (!b || a > b);

// ---- status: 파일 존재가 아니라 게이트·승인·완료 기록·내용 해시로 다음 할 일을 정한다 ----
// next: P1 | P2 | APPROVAL_PLAN | P3 | P4 | APPROVAL_FINAL | DONE | STOP
// todo: agent(에이전트 실행) | record | export | judge (오케스트레이터가 스크립트 실행)
export function status(rules, project) {
  const missing = rules.inputs.filter((f) => !exists(path.join(ROOT, f)));
  if (missing.length) return { next: 'STOP', reason: `필수 입력 파일 없음: ${missing.join(', ')}` };
  const tools = toolProblems(rules);
  if (tools.length) return { next: 'STOP', reason: `실행 환경: ${tools.join(' / ')}` };

  const st = loadState(rules, project);
  const ctx = loadContext(rules, project);
  const failing = (phase) => runGates(ctx, gatesFor(rules, phase).filter(([id]) => !isHuman(rules, id))).filter((r) => !r.pass);
  const human = (id) => runGates(ctx, [[id]])[0].pass;

  // P1 촬영 계획
  if (st.plan_rejects > rules.retry.plan_reject) return { next: 'STOP', reason: `촬영 계획 거절 ${st.plan_rejects}회 — retry.plan_reject(${rules.retry.plan_reject}) 초과` };
  if (!ctx.plan || !st.done.P1 || !after(st.done.P1, st.plan_rejected_at)) {
    return { next: 'P1', todo: 'agent', reason: st.plan_rejected_at && !after(st.done.P1, st.plan_rejected_at) ? '촬영 계획 거절 — 사람 요청을 planner에게 넘긴다' : 'P1 완료 기록 없음', notes: st.plan_notes.slice(-1) };
  }
  // 거절 뒤 planner가 돌았는데 계획·시나리오가 그대로면 요청이 반영되지 않은 것이다 — 승인 대기로 넘기지 않는다
  if (st.plan_rejected_at && st.plan_rejected_hash === planContentHash(rules, project)) {
    if (after(st.unblocked_at, st.done.P1)) return { next: 'P1', todo: 'agent', reason: '촬영 계획 거절 — 사람 요청을 planner에게 다시 넘긴다', notes: st.plan_notes.slice(-1) };
    return { next: 'STOP', reason: 'planner가 거절 요청을 반영하지 못했다 (계획·시나리오가 거절 때와 같다). 요청을 더 구체적으로 다시 거절하거나 "계속 진행해"', notes: st.plan_notes.slice(-1) };
  }
  let f = failing('P1');
  if (f.length) return { next: 'P1', todo: 'agent', reason: 'P1 게이트 FAIL', failing: f };

  // P2 녹화
  if (ctx.raw?.record_hash !== recordHash(rules, project)) return { next: 'P2', todo: 'record', reason: '계획·시나리오가 바뀐 뒤 녹화하지 않음 — record.mjs' };
  f = failing('P2');
  if (f.length) return { next: 'P1', todo: 'agent', reason: 'P2 게이트 FAIL — 시나리오를 고친다', failing: f };

  // 승인 1: 에셋 목록 + 녹화본 (review 모드만). auto·edit 모드는 녹화가 끝난 시점을 승인 시점으로 본다
  const mode = ctx.conf.mode;
  const planOkAt = needsPlanApproval(mode) ? st.approved_plan_at : ctx.raw?.recorded_at;
  if (needsPlanApproval(mode) && !human('approval_plan')) return { next: 'APPROVAL_PLAN', reason: st.approved_plan_at ? '승인 뒤 계획·녹화본이 바뀜 — 다시 승인받는다' : '사람 승인 대기 — 에셋 목록과 녹화본을 요약하고, 시작 화면의 녹화 확인(/p/<p>/approve/plan)을 알려 준다' };

  // P3 편집값
  if (st.final_rejects > rules.retry.final_reject) return { next: 'STOP', reason: `완성본 거절 ${st.final_rejects}회 — retry.final_reject(${rules.retry.final_reject}) 초과` };
  const eh = editsHash(rules, project);
  const unchanged = st.final_rejected_at && st.final_rejected_edits === eh;
  const rejected = unchanged && (!after(st.done.P3, st.final_rejected_at) || after(st.unblocked_at, st.done.P3));
  // 거절 뒤 editor가 돌았는데 편집값이 그대로면 요청이 반영되지 않은 것이다 — 완성본 승인 대기로 넘기지 않는다
  if (unchanged && !rejected) return { next: 'STOP', reason: 'editor가 거절 요청을 반영하지 못했다 (edits.json이 거절 때와 같다). 검토 화면에서 직접 고치거나 "계속 진행해"', notes: st.final_notes.slice(-1) };
  if (!ctx.edits || !after(st.done.P3, planOkAt) || rejected) {
    return { next: 'P3', todo: 'agent', reason: rejected ? '완성본 거절 — 사람 요청을 editor에게 넘긴다' : '승인 1 이후 P3 완료 기록 없음', notes: rejected ? st.final_notes.slice(-1) : undefined };
  }
  f = failing('P3');
  if (f.length) {
    if (st.p3_invalid_runs > rules.retry.p4_fail_to_p3 && !after(st.unblocked_at, st.done.P3)) return { next: 'STOP', reason: `editor가 edits.json 형식을 ${st.p3_invalid_runs}회 맞추지 못함`, failing: f };
    return { next: 'P3', todo: 'agent', reason: 'P3 게이트 FAIL', failing: f };
  }

  // P4 내보내기 → 판정
  const exported = ctx.exp && ctx.edits.assets.every((a) => ctx.exp.assets.find((x) => x.n === a.n)?.hash === assetHash(rules, ctx.edits, a, ctx.raw) && exists(ctx.dir(`export/${assetFile(a)}`)));
  if (!exported) return { next: 'P4', todo: 'export', reason: '현재 편집값으로 내보내지 않음 — export.mjs' };
  const p4 = readIf(derivedPath(rules, project, 'p4'), true);
  if (!p4 || p4.edits_hash !== eh || p4.export_hash !== exportHash(rules, project)) return { next: 'P4', todo: 'judge', reason: '마지막 내보내기 이후 판정하지 않음 — judge.mjs --phase P4' };
  if (!p4.pass) {
    const p4Failing = p4.results.filter((r) => !r.pass && !isHuman(rules, r.gate));
    const unblocked = after(st.unblocked_at, p4.measured_at);
    if (p4.next === 'STOP' && !unblocked) return { next: 'STOP', reason: `P4 ${p4.attempt}/${p4.max_attempts}회 FAIL — 사람에게 묻는다 (편집 화면에서 직접 고칠 수도 있다)`, failing: p4Failing };
    if (after(st.done.P3, p4.measured_at) && !unblocked) return { next: 'STOP', reason: 'editor가 실행됐지만 edits.json이 바뀌지 않았다', failing: p4Failing };
    return { next: 'P3', todo: 'agent', reason: `P4 FAIL (시도 ${p4.attempt}/${p4.max_attempts}) — failing을 editor에게 넘긴다`, failing: p4Failing };
  }

  // 승인 2 (edit·review 모드). auto 모드는 자동 검사를 통과하면 완성이다
  if (!needsFinalApproval(mode)) return { next: 'DONE', reason: '자동 모드 — 모든 자동 검사 PASS (사람 승인 없이 완성)' };
  if (!human('approval_final')) return { next: 'APPROVAL_FINAL', reason: st.approved_final_at ? '승인 뒤 에셋·편집값이 바뀜 — 다시 승인받는다' : '사람 승인 대기 — 시작 화면의 완성본 확인(/p/<p>/approve/final)을 알려 준다' };
  return { next: 'DONE', reason: '모든 게이트 PASS, 촬영 계획·완성본 승인' };
}

// Phase별 소요 시간·토큰 합계
function timing(rules) {
  const out = {};
  for (const e of readLog(rules, project)) {
    if (e.event !== 'end' && e.event !== 'usage') continue;
    const t = (out[e.phase] ??= { runs: 0, duration_s: 0, tokens: 0 });
    t.tokens += e.tokens ?? 0;
    if (e.event === 'usage') continue;
    t.runs += 1;
    t.duration_s = Math.round((t.duration_s + e.duration_ms / 1000) * 10) / 10;
  }
  return out;
}

// ---- 편집 범위: 파일 해시 스냅샷 ----
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.cache']);

function snapshot() {
  const out = {};
  const walk = (dir, prefix, skipRuns) => {
    if (!exists(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const key = `${prefix}${e.name}`;
      if (SKIP.has(e.name) || (skipRuns && key === 'runs')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, `${key}/`, skipRuns);
      else if (e.isFile()) { const s = fs.statSync(p); out[key] = s.size > 8e6 ? `${s.size}:${s.mtimeMs}` : crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); }
    }
  };
  walk(ROOT, '', true);
  walk(RUNS, 'runs/', false);
  return out;
}

const scopeFile = (p, phase) => path.join(scopeDir(), `${p}-${phase}.json`);
const agentOf = (rules, phase) => Object.entries(rules.agents).find(([, a]) => a.phases.includes(phase))?.[0];
const allowedOf = (rules, s) => rules.agents[s.agent].writes.map((w) => `runs/${s.project}/${w}`);
const within = (f, list) => list.some((a) => (a.endsWith('/') ? f.startsWith(a) : f === a));

function begin(rules) {
  const agent = agentOf(rules, phaseArg);
  if (!agent) throw new Error(`phase는 ${Object.values(rules.agents).flatMap((a) => a.phases).join(' | ')} (나머지는 스크립트가 실행): ${phaseArg}`);
  const file = scopeFile(project, phaseArg);
  if (exists(file)) throw new Error(`이미 실행 중으로 기록됨: ${file} — 이전 실행을 end로 닫거나 파일을 지운다`);
  appendLog(rules, project, { event: 'begin', phase: phaseArg, agent });   // 스냅샷보다 먼저 써야 자기 로그가 변경으로 잡히지 않는다
  const snap = { project, phase: phaseArg, agent, started_at: now(), files: snapshot() };
  writeJson(file, snap);
  console.log(JSON.stringify({ begin: phaseArg, agent, writes: allowedOf(rules, snap) }, null, 2));
}

function end(rules) {
  const file = scopeFile(project, phaseArg);
  if (!exists(file)) throw new Error(`스냅샷 없음: 에이전트 실행 전에 begin ${project} ${phaseArg}를 먼저 실행한다`);
  const prev = readJson(file);
  const cur = snapshot();
  const changed = [...new Set([...Object.keys(prev.files), ...Object.keys(cur)])].filter((f) => prev.files[f] !== cur[f]);
  const own = allowedOf(rules, prev);
  // 실행 시간이 겹친 다른 project의 쓰기는 그쪽 몫이다
  const outside = changed.filter((f) => !within(f, own) && !(f.startsWith('runs/') && !f.startsWith(`runs/${project}/`)));
  const pass = outside.length === 0;
  const tokens = opt('--tokens') ? Number(opt('--tokens')) : undefined;
  if (pass) {
    const st = loadState(rules, project);
    st.done[prev.phase] = now();
    if (prev.phase === 'P3') st.p3_invalid_runs = editsErrors(loadContext(rules, project)).length ? st.p3_invalid_runs + 1 : 0;
    saveState(rules, project, st);
  }
  fs.rmSync(file);
  appendLog(rules, project, { event: 'end', phase: prev.phase, agent: prev.agent, pass, duration_ms: Date.now() - Date.parse(prev.started_at), tokens, outside });
  console.log(JSON.stringify({ agent: prev.agent, allowed: own, changed, outside, pass }, null, 2));
  process.exit(pass ? 0 : 1);
}

// ---- 사람의 결정 기록. 사람이 그 말을 했을 때만 실행한다 ----
function approve(rules) {
  const st = loadState(rules, project);
  const s = status(rules, project);
  const want = phaseArg === 'plan' ? 'APPROVAL_PLAN' : phaseArg === 'final' ? 'APPROVAL_FINAL' : null;
  if (!want) throw new Error('사용: run.mjs approve <project> plan|final');
  if (s.next !== want) throw new Error(`지금은 ${phaseArg === 'plan' ? '촬영 계획' : '완성본'} 승인 단계가 아니다 (next: ${s.next} — ${s.reason})`);
  const at = now();
  const hash = phaseArg === 'plan' ? planHash(rules, project) : finalHash(rules, project);
  writeJson(derivedPath(rules, project, phaseArg === 'plan' ? 'approval_plan' : 'approval_final'), { approved_at: at, hash });
  st[phaseArg === 'plan' ? 'approved_plan_at' : 'approved_final_at'] = at;
  saveState(rules, project, st);
  appendLog(rules, project, { event: 'approve', what: phaseArg, hash });
  console.log(JSON.stringify({ approved: phaseArg, hash, ...status(rules, project) }, null, 2));
}

function reject(rules) {
  const st = loadState(rules, project);
  const note = opt('--note') ?? null;
  const at = now();
  if (phaseArg === 'plan' || phaseArg === 'final') snapshotHistory(rules, project, phaseArg);   // 다음 승인 화면에서 "이전 ↔ 지금"을 비교한다
  if (phaseArg === 'plan') {
    st.plan_rejects += 1;
    st.plan_rejected_at = at;
    st.plan_rejected_hash = planContentHash(rules, project);
    st.plan_notes = [...st.plan_notes, { at, note }];
    fs.rmSync(derivedPath(rules, project, 'approval_plan'), { force: true });
  } else if (phaseArg === 'final') {
    st.final_rejects += 1;
    st.final_rejected_at = at;
    st.final_rejected_edits = editsHash(rules, project);
    st.final_notes = [...st.final_notes, { at, note }];
    fs.rmSync(derivedPath(rules, project, 'approval_final'), { force: true });
  } else throw new Error('사용: run.mjs reject <project> plan|final [--note "<요청>"]');
  saveState(rules, project, st);
  appendLog(rules, project, { event: 'reject', what: phaseArg, note });
  console.log(JSON.stringify({ rejected: phaseArg, plan_rejects: st.plan_rejects, final_rejects: st.final_rejects, ...status(rules, project) }, null, 2));
}

// STOP 해제. 시도 횟수를 다시 세고, 거절은 한 번 더 할 수 있게 횟수를 한도로 되돌린다
function unblock(rules) {
  const st = loadState(rules, project);
  st.unblocked_at = now();
  st.plan_rejects = Math.min(st.plan_rejects, rules.retry.plan_reject);
  st.final_rejects = Math.min(st.final_rejects, rules.retry.final_reject);
  st.p3_invalid_runs = 0;
  saveState(rules, project, st);
  appendLog(rules, project, { event: 'unblock' });
  console.log(JSON.stringify({ unblocked_at: st.unblocked_at, ...status(rules, project) }, null, 2));
}

function accept(rules) {
  const last = readLog(rules, project).filter((e) => e.event === 'end' && e.phase === phaseArg).at(-1);
  if (!last) throw new Error(`${phaseArg}의 end 기록 없음`);
  if (last.pass) throw new Error(`${phaseArg}의 마지막 end는 이미 PASS`);
  const st = loadState(rules, project);
  st.done[phaseArg] = now();
  saveState(rules, project, st);
  appendLog(rules, project, { event: 'accept', phase: phaseArg, accepted_outside: last.outside });
  console.log(JSON.stringify({ accepted: phaseArg, outside: last.outside }, null, 2));
}

function usage(rules) {
  const tokens = Number(opt('--tokens'));
  if (!phaseArg || !Number.isFinite(tokens)) throw new Error('사용: run.mjs usage <project> <phase> --tokens N');
  appendLog(rules, project, { event: 'usage', phase: phaseArg, tokens });
  console.log(JSON.stringify({ phase: phaseArg, tokens, timing: timing(rules) }, null, 2));
}

function main() {
  const rules = loadRules();
  assertProject(rules, project);
  if (cmd === 'status') {
    const st = loadState(rules, project);
    console.log(JSON.stringify({ project, ...status(rules, project), plan_rejects: st.plan_rejects, final_rejects: st.final_rejects, timing: timing(rules) }, null, 2));
  } else if (cmd === 'begin') begin(rules);
  else if (cmd === 'end') end(rules);
  else if (cmd === 'approve') approve(rules);
  else if (cmd === 'reject') reject(rules);
  else if (cmd === 'unblock') unblock(rules);
  else if (cmd === 'accept') accept(rules);
  else if (cmd === 'usage') usage(rules);
  else throw new Error(`모르는 명령: ${cmd}`);
}

if (process.argv[1]?.endsWith('run.mjs')) {
  try { main(); } catch (e) { console.error(`run 오류: ${e.message}`); process.exit(2); }
}

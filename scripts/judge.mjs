#!/usr/bin/env node
// Phase별 게이트 판정. 통과·실패는 이 스크립트만 정한다 (에이전트 보고를 PASS/FAIL로 읽지 않는다).
// 사용: node scripts/judge.mjs <project> --phase P1|P2|P3|P4 [--no-count]
//   P1~P3 → gate/checks.json, P4 → gate/p4-gate.json (시도 횟수 포함)
//   --no-count: 검토용 서버가 쓴다. 사람이 고치는 중의 FAIL은 시도 횟수에 넣지 않는다
// 종료 코드: 0 PASS(사람 승인 게이트는 빼고), 1 FAIL, 2 실행 오류
import {
  loadRules, assertProject, loadContext, gatesFor, runGates, isHuman, derivedPath, readIf, writeJson, now, sha,
  editsHash, exportHash, loadState, appendLog,
} from './lib.mjs';

export function judge(rules, project, phase, { count = true } = {}) {
  const ctx = loadContext(rules, project);
  const gates = gatesFor(rules, phase);
  if (!gates.length) throw new Error(`phase는 P1 | P2 | P3 | P4: ${phase}`);
  if (phase === 'P4' && !ctx.edits) throw new Error('edits.json 없음');
  const results = runGates(ctx, gates);
  const failing = results.filter((r) => !r.pass && !isHuman(rules, r.gate));
  const pass = failing.length === 0;
  const measured_at = now();

  if (phase !== 'P4') {
    const file = derivedPath(rules, project, 'checks');
    writeJson(file, { ...(readIf(file, true) ?? {}), [phase]: { measured_at, pass, results } });
  } else {
    const file = derivedPath(rules, project, 'p4');
    const prev = readIf(file, true);
    const signature = sha(editsHash(rules, project), exportHash(rules, project));
    const st = loadState(rules, project);
    const base = prev && !(st.unblocked_at && st.unblocked_at > prev.measured_at) ? prev.attempt ?? 0 : 0;
    // 같은 내용을 다시 판정하면 세지 않는다. PASS면 0으로 돌아간다
    const attempt = pass ? 0 : !count || prev?.signature === signature ? Math.max(base, count ? 1 : 0) : base + 1;
    const max_attempts = rules.retry.p4_fail_to_p3 + 1;
    writeJson(file, {
      measured_at, pass, signature, edits_hash: editsHash(rules, project), export_hash: exportHash(rules, project),
      attempt, max_attempts, next: pass ? 'APPROVAL_FINAL' : attempt >= max_attempts ? 'STOP' : 'P3', results,
    });
  }
  appendLog(rules, project, { event: 'judge', phase, pass, failing: failing.map((r) => r.gate) });
  return { project, phase, pass, results };
}

if (process.argv[1]?.endsWith('judge.mjs')) {
  try {
    const project = process.argv[2];
    const i = process.argv.indexOf('--phase');
    const rules = loadRules();
    assertProject(rules, project);
    const r = judge(rules, project, process.argv[i + 1], { count: !process.argv.includes('--no-count') });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.pass ? 0 : 1);
  } catch (e) {
    console.error(`judge 오류: ${e.message}`);
    process.exit(2);
  }
}

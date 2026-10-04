#!/usr/bin/env node
// planner가 시나리오를 미리 돌려 본다. record.mjs와 같은 엔진·언어·쓰기 차단으로 실행하되 배율 1로 찍어 .cache/try/<project>/에 둔다 (git·편집 범위 검사에서 빠진다).
// 사용: node scripts/try.mjs <project> <recording 이름> [<이름> …]
//   이름을 여러 개 주면 동시에 돌린다 (시나리오를 다 쓴 뒤 한 번에 확인할 때). 출력은 { results: [이름마다 아래 출력] }
//   runs/<project>/plan/<이름>.scenario.mjs를 실행한다. plan.json에 아직 없어도 된다.
// 출력(JSON): 길이, 컨택트 시트 경로(1초 간격 + 끝 프레임, Read로 본다), 영상 경로, 장면 전환 시점, 막힌 쓰기 요청, 오류
//   대기 조건이 끝나지 않거나 선택자가 틀리면 error에 나온다. 녹화(P2)로 넘기기 전에 여기서 먼저 잡는다.
// 종료 코드: 0 끝까지 실행, 1 시나리오 오류, 2 실행 오류
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { record } from 'walkthrough-recorder';
import { ROOT, loadRules, assertProject, projectConf, loadContext, scenarioErrors, planDir, exists, probe, inspectVideo, activity } from './lib.mjs';
import { assertTarget, applyContext, ignoreClosedCapture } from './browser.mjs';

ignoreClosedCapture();

async function tryOne(rules, project, conf, name) {
  const src = path.join(planDir(rules, project), `${name}.scenario.mjs`);
  const out = { name, rule_errors: scenarioErrors(loadContext(rules, project)).filter((e) => e.startsWith(`${name}.scenario.mjs:`)) };
  if (!exists(src)) return { ...out, error: `시나리오 파일 없음: ${src}` };
  const rec = rules.record;
  const dir = path.join(ROOT, '.cache', 'try', project);   // 저장소 안이어야 Claude가 Read로 열 수 있다. .cache/는 git·편집 범위 검사에서 빠진다
  fs.mkdirSync(dir, { recursive: true });
  const counts = { seen: 0, blocked: 0 };
  let t;
  try {
    const mod = (await import(`${pathToFileURL(src).href}?v=${Date.now()}`)).default;
    if (typeof mod?.scenario !== 'function') throw new Error('export default { scenario }가 없다');
    const made = await Promise.race([
      record({
        baseUrl: conf.url, outDir: dir, outName: name, viewport: rec.viewport, scale: 1, fps: rec.fps, jpegQuality: 70, crf: 28,
        cursor: mod.cursor ?? {}, tapDefaults: mod.tapDefaults,
        setupContext: (context) => applyContext(context, rules, conf, counts), scenario: mod.scenario,
      }),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`시간 초과 — ${rec.max_raw_seconds + 180}초`)), (rec.max_raw_seconds + 180) * 1000); }),
    ]);
    const file = path.join(dir, `${name}.mp4`);
    fs.renameSync(made, file);
    const p = probe(file);
    Object.assign(out, { video: file, duration: p.duration, over_max_raw: p.duration > rec.max_raw_seconds, ...inspectVideo(rules, file, p.duration) });
    out.sheet = path.join(dir, out.sheet);
  } catch (e) {
    out.error = e.message.split('\n').slice(0, 3).join(' / ').slice(0, 500);
  } finally {
    clearTimeout(t);
  }
  return Object.assign(out, { writes_seen: counts.seen, writes_blocked: counts.blocked, blocked_urls: [...(counts.blocked_urls ?? [])].slice(0, 10) });
}

async function main() {
  const [project, ...names] = process.argv.slice(2);
  const rules = loadRules();
  assertProject(rules, project);
  if (!names.length) throw new Error('사용: try.mjs <project> <recording 이름> [<이름> …]');
  const conf = projectConf(rules, project);
  await assertTarget(conf);
  activity(project, 'try', names.length);
  const log = console.log;
  console.log = () => {};   // 엔진의 진행 로그를 끈다 (출력은 JSON 하나)
  let results;
  // 사이트가 잠깐 느려 첫 페이지 열기가 시간 초과면 그 시나리오만 한 번 더 돌린다 (시나리오 잘못이 아니다)
  const once = async (n) => { const r = await tryOne(rules, project, conf, n); return /page\.goto: Timeout/.test(r.error ?? '') ? { ...(await tryOne(rules, project, conf, n)), retried: true } : r; };
  try { results = await Promise.all(names.map(once)); } finally { console.log = log; }
  console.log(JSON.stringify(names.length > 1 ? { project, results } : { project, ...results[0] }, null, 2));
  process.exit(results.some((r) => r.error) ? 1 : 0);
}

main().catch((e) => { console.error(`try 오류: ${e.message}`); process.exit(2); });

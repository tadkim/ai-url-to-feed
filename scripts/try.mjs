#!/usr/bin/env node
// planner가 시나리오를 미리 돌려 본다. record.mjs와 같은 엔진·언어·쓰기 차단으로 실행하되 배율 1로 찍어 저장소 밖 임시 폴더에 둔다.
// 사용: node scripts/try.mjs <project> <recording 이름>
//   runs/<project>/plan/<이름>.scenario.mjs를 실행한다. plan.json에 아직 없어도 된다.
// 출력(JSON): 길이, 컨택트 시트 경로(1초 간격 + 끝 프레임, Read로 본다), 영상 경로, 장면 전환 시점, 막힌 쓰기 요청, 오류
//   대기 조건이 끝나지 않거나 선택자가 틀리면 error에 나온다. 녹화(P2)로 넘기기 전에 여기서 먼저 잡는다.
// 종료 코드: 0 끝까지 실행, 1 시나리오 오류, 2 실행 오류
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { record } from 'walkthrough-recorder';
import { loadRules, assertProject, projectConf, loadContext, scenarioErrors, planDir, exists, probe, inspectVideo } from './lib.mjs';
import { assertTarget, applyContext } from './browser.mjs';

async function main() {
  const [project, name] = process.argv.slice(2);
  const rules = loadRules();
  assertProject(rules, project);
  const conf = projectConf(rules, project);
  const src = path.join(planDir(rules, project), `${name}.scenario.mjs`);
  if (!exists(src)) throw new Error(`시나리오 파일 없음: ${src}`);
  const out = { project, name, rule_errors: scenarioErrors(loadContext(rules, project)).filter((e) => e.startsWith(`${name}.scenario.mjs:`)) };
  await assertTarget(conf);

  const rec = rules.record;
  const dir = path.join(os.tmpdir(), `harness-try-${project}`);
  fs.mkdirSync(dir, { recursive: true });
  const counts = { seen: 0, blocked: 0 };
  const log = console.log;
  console.log = () => {};   // 엔진의 진행 로그를 끈다 (출력은 JSON 하나)
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
    console.log = log;
  }
  Object.assign(out, { writes_seen: counts.seen, writes_blocked: counts.blocked, blocked_urls: [...(counts.blocked_urls ?? [])].slice(0, 10) });
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.error ? 1 : 0);
}

main().catch((e) => { console.error(`try 오류: ${e.message}`); process.exit(2); });

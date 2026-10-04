#!/usr/bin/env node
// plan.json의 recordings를 녹화한다 (walkthrough-recorder). 오케스트레이터만 실행한다.
// 사용: node scripts/record.mjs <project> [--only <recording 이름>] [--force]
//   시나리오: runs/<project>/plan/<name>.scenario.mjs
//     // 백엔드 쓰기: 없음            ← 맨 위 주석. 쓰기가 일어나면 경고를 적는다
//     export default {
//       cursor: false,                 // 조작이 없는 감상용 클립. 생략하면 가짜 커서를 보인다
//       scenario: async ({ page, tap, tapVisible, scrollBy, dwell, goto, startCapture, stopCapture }) => { ... },
//     };
//   viewport·배율·품질·출력 위치는 rules.yaml record 값으로 고정한다. 시나리오가 바꾸지 못한다.
// 출력: raw/<name>.mp4 (viewport x scale), raw/<name>.sheet.png (컨택트 시트), raw/manifest.json
//   시나리오·설정이 같고 파일이 있으면 다시 녹화하지 않는다 (--force로 다시).
// 종료 코드: 0 모두 성공, 1 시나리오 오류가 있는 녹화가 있다(manifest의 error), 2 실행 오류
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { record } from 'walkthrough-recorder';
import {
  loadRules, assertProject, projectConf, loadContext, planErrors, scenarioErrors, planDir, recordHash, derivedPath, runPath,
  readIf, readText, writeJson, exists, sha, fileSha, now, probe, appendLog, inspectVideo, engineSettings, markBusy,
} from './lib.mjs';
import { assertTarget, applyContext, ignoreClosedCapture } from './browser.mjs';

ignoreClosedCapture();

const withTimeout = (p, ms, msg) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t)); };

async function main() {
  const [project, ...args] = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : undefined; };
  const rules = loadRules();
  assertProject(rules, project);
  const conf = projectConf(rules, project);
  const ctx = loadContext(rules, project);
  const bad = [...planErrors(ctx), ...scenarioErrors(ctx)];
  if (bad.length) throw new Error(`계획이 규칙에 맞지 않아 녹화하지 않는다:\n- ${bad.join('\n- ')}`);
  await assertTarget(conf);
  markBusy(project, 'record');

  const rec = rules.record;
  const rawDir = runPath(project, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const manifestPath = derivedPath(rules, project, 'raw');
  const prev = readIf(manifestPath, true)?.recordings ?? [];
  const only = opt('--only');
  const out = [];

  for (const r of ctx.plan.recordings) {
    const src = path.join(planDir(rules, project), r.scenario);
    const hash = sha(readText(src), JSON.stringify(engineSettings(rules)), conf.url, String(!!conf.allow_writes));
    const file = `${r.name}.mp4`;
    const old = prev.find((x) => x.name === r.name);
    const reusable = old && !old.error && old.scenario_hash === hash && exists(path.join(rawDir, file));
    if (reusable && (!args.includes('--force') || (only && only !== r.name))) {
      // 다시 녹화하지 않아도 컨택트 시트 설정이 바뀌었으면 시트만 다시 만든다
      if (old.sheet_every !== Math.max(rec.sheet_every_seconds, Math.ceil(old.duration / rec.sheet_max_tiles)) || !exists(path.join(rawDir, old.sheet))) Object.assign(old, inspectVideo(rules, path.join(rawDir, file), old.duration));
      out.push(old); continue;
    }
    if (only && only !== r.name) { out.push(old ?? { name: r.name, error: '아직 녹화하지 않음' }); continue; }

    const entry = { name: r.name, file, scenario_hash: hash, recorded_at: now() };
    const counts = { seen: 0, blocked: 0 };
    try {
      const mod = (await import(`${pathToFileURL(src).href}?v=${Date.now()}`)).default;
      if (typeof mod?.scenario !== 'function') throw new Error('export default { scenario }가 없다');
      const made = await withTimeout(record({
        baseUrl: conf.url, outDir: rawDir, outName: r.name,
        viewport: rec.viewport, scale: rec.scale, fps: rec.fps, jpegQuality: rec.jpeg_quality, crf: rec.crf,
        cursor: mod.cursor ?? {}, tapDefaults: mod.tapDefaults,
        observe: (conf.observe ?? []).map((s) => new RegExp(s)),
        setupContext: (context) => applyContext(context, rules, conf, counts),
        scenario: mod.scenario,
      }), (rec.max_raw_seconds + 180) * 1000, `시간 초과 — 준비 + 녹화가 ${rec.max_raw_seconds + 180}초를 넘었다`);
      fs.renameSync(made, path.join(rawDir, file));
      const p = probe(path.join(rawDir, file));
      Object.assign(entry, { width: p.width, height: p.height, duration: p.duration, fps: p.fps, sha: fileSha(path.join(rawDir, file)), ...inspectVideo(rules, path.join(rawDir, file), p.duration) });
    } catch (e) {
      entry.error = e.message.split('\n').slice(0, 3).join(' / ').slice(0, 500);
      fs.rmSync(path.join(rawDir, `.${r.name}-raw`), { recursive: true, force: true });
    }
    Object.assign(entry, { writes_seen: counts.seen, writes_blocked: counts.blocked, blocked_urls: [...(counts.blocked_urls ?? [])].slice(0, 10) });
    out.push(entry);
  }

  // 계획에서 빠진 녹화의 파일을 지운다 (녹화를 합치거나 이름을 바꾸면 예전 파일이 남았다)
  const keepFiles = new Set(['manifest.json', ...out.flatMap((r) => [r.file, r.sheet])]);
  for (const f of fs.readdirSync(rawDir)) if (/\.(mp4|png)$/.test(f) && !keepFiles.has(f)) fs.rmSync(path.join(rawDir, f));

  writeJson(manifestPath, { record_hash: recordHash(rules, project), recorded_at: now(), allow_writes: !!conf.allow_writes, recordings: out });
  appendLog(rules, project, { event: 'record', recordings: out.map((r) => ({ name: r.name, duration: r.duration, error: r.error })) });
  console.log(JSON.stringify({ project, recordings: out.map(({ scenario_hash, sha: _s, ...r }) => r) }, null, 2));
  process.exit(out.some((r) => r.error) ? 1 : 0);
}

main().catch((e) => { console.error(`record 오류: ${e.message}`); process.exit(2); });

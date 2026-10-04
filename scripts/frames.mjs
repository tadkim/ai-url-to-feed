#!/usr/bin/env node
// editor가 녹화본의 특정 순간을 확인할 때 쓴다. 프레임을 뽑아 한 장으로 이어 붙이고 경로를 돌려준다 (Read로 연다).
// 사용:
//   node scripts/frames.mjs <project> <recording> --at 6.5,8.8,9.2            정한 시점들
//   node scripts/frames.mjs <project> <recording> --from 12 --to 15 [--every 0.25]   구간을 일정 간격으로
// 출력(JSON): image(이어 붙인 PNG 경로), times(칸마다 시점, 왼쪽 위부터), duration(녹화본 길이)
//   .cache/frames/<project>/에만 쓴다 (git·편집 범위 검사에서 빠진다).
// 종료 코드: 0 정상, 2 실행 오류
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadRules, assertProject, derivedPath, runPath, readIf, ff, activity } from './lib.mjs';

function main() {
  const [project, name, ...args] = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : undefined; };
  const rules = loadRules();
  assertProject(rules, project);
  activity(project, 'frames');   // 명령줄 진행 막대에 "프레임 N번 확인"으로 보인다
  const raw = readIf(derivedPath(rules, project, 'raw'), true);
  const rec = raw?.recordings?.find((r) => r.name === name && !r.error);
  if (!rec) throw new Error(`녹화본 없음: ${name} (raw/manifest.json에 있는 이름: ${(raw?.recordings ?? []).map((r) => r.name).join(', ')})`);
  const file = runPath(project, `raw/${rec.file}`);

  let times;
  if (opt('--at')) times = opt('--at').split(',').map(Number);
  else {
    const [from, to, every] = [Number(opt('--from') ?? 0), Number(opt('--to') ?? rec.duration), Number(opt('--every') ?? 0.25)];
    times = [];
    for (let t = from; t <= to + 1e-6 && times.length < 48; t += every) times.push(Math.round(t * 100) / 100);
  }
  times = times.filter((t) => Number.isFinite(t) && t >= 0).map((t) => Math.min(t, Math.max(0, rec.duration - 0.05)));
  if (!times.length) throw new Error('시점이 없다 — --at 또는 --from/--to를 준다');

  const dir = path.join(ROOT, '.cache', 'frames', project);   // 저장소 안이어야 Claude가 Read로 열 수 있다. .cache/는 git·편집 범위 검사에서 빠진다
  fs.mkdirSync(dir, { recursive: true });
  const parts = times.map((t, i) => {
    const f = path.join(dir, `f${i}.png`);
    // 칸 순서 = times 순서 (ffmpeg 빌드에 따라 글자 넣기 필터가 없어서 시점은 JSON으로 준다)
    ff('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=240:-2', f]);
    return f;
  });
  const cols = Math.min(6, parts.length);
  const rows = Math.ceil(parts.length / cols);
  const image = path.join(dir, `${name}-${Date.now()}.png`);
  ff('ffmpeg', ['-v', 'error', '-y', ...parts.flatMap((f) => ['-i', f]), '-filter_complex',
    `${parts.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${parts.length}:layout=${parts.map((_, i) => `${(i % cols) * 244}_${Math.floor(i / cols) * 431}`).join('|')}:fill=black`, image]);
  parts.forEach((f) => fs.rmSync(f, { force: true }));
  console.log(JSON.stringify({ image, times, columns: cols, rows, duration: rec.duration }, null, 2));
}

try { main(); } catch (e) { console.error(`frames 오류: ${e.message}`); process.exit(2); }

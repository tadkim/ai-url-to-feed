#!/usr/bin/env node
// edits.json대로 게시할 파일을 만든다 (구간 → 속도 → 배치 → 테두리·모서리). 오케스트레이터와 편집 화면 서버가 실행한다.
// 사용: node scripts/export.mjs <project>
// 출력: export/<nn>.mp4 | <nn>.png, export/manifest.json
//   - 항상 녹화본(raw/)에서 다시 만든다. 편집값이 같은 에셋은 export/.cache/에서 가져온다 (순서만 바꾸면 다시 인코딩하지 않는다).
//   - 배치 좌표는 rules.yaml assets.layouts (이전 프로젝트 instagram-frame.sh와 같은 값).
//   - 테두리·둥근 모서리는 덮개 PNG(배경색 + 테두리 + 화면 자리만 투명) 한 장을 얹어 만든다 (round-corners.sh 방식).
//   - 합성은 RGB로 하고 마지막에 bt709로 변환·태그한다. 녹화본은 태그 없는 bt601이다 (rules.yaml record.matrix).
// 종료 코드: 0 정상, 1 edits.json이 규칙에 맞지 않음, 2 실행 오류
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  loadRules, assertProject, loadContext, editsErrors, layoutOf, parseHex, assetHash, assetFile, videoSeconds, derivedPath, runPath,
  writeJson, exists, now, ff, appendLog, nn,
} from './lib.mjs';

// RGBA 버퍼 → PNG
function png(width, height, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// 둥근 사각형까지의 거리 (안쪽이 음수)
function sdf(x, y, s, grow, radius) {
  const [hw, hh] = [s.w / 2 + grow, s.h / 2 + grow];
  const r = Math.min(radius, hw, hh);
  const [qx, qy] = [Math.abs(x - (s.x + s.w / 2)) - (hw - r), Math.abs(y - (s.y + s.h / 2)) - (hh - r)];
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// 덮개: 캔버스 전체를 배경색으로 칠하고, 화면 자리는 투명하게 뚫고, 그 둘레에 테두리를 그린다
export function coverPng(canvas, slots, style) {
  const { width: W, height: H } = canvas;
  const [bg, bd] = [parseHex(style.bg), parseHex(style.border)];
  const buf = Buffer.alloc(W * H * 4);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const outerR = style.radius > 0 ? style.radius + style.bw : 0;   // 직각이면 테두리도 직각
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let inner = 0;
    let outer = 0;
    for (const s of slots) {
      if (x < s.x - style.bw - 1 || x > s.x + s.w + style.bw || y < s.y - style.bw - 1 || y > s.y + s.h + style.bw) continue;
      inner = Math.max(inner, clamp(0.5 - sdf(x + 0.5, y + 0.5, s, 0, style.radius)));
      outer = Math.max(outer, clamp(0.5 - sdf(x + 0.5, y + 0.5, s, style.bw, outerR)));
    }
    const i = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) buf[i + c] = Math.round(bg[c] + (bd[c] - bg[c]) * (style.bw > 0 ? outer : 0));
    buf[i + 3] = Math.round(255 * (1 - inner));
  }
  return png(W, H, buf);
}

function build(rules, ctx, asset, outFile, coverFile) {
  const { width: W, height: H } = rules.assets.canvas;
  const l = layoutOf(rules, asset.layout);
  const bg = `0x${ctx.edits.style.bg.slice(1)}`;
  const rawFile = (name) => ctx.dir(`raw/${ctx.raw.recordings.find((r) => r.name === name).file}`);
  const toRgb = `scale=${l.w}:${l.h}:flags=lanczos:in_color_matrix=${rules.record.matrix}:in_range=tv,format=rgb24`;
  const place = (s) => `pad=${W}:${H}:${s.x}:${s.y}:color=${bg}`;

  if (asset.type === 'video') {
    const v = rules.export.video;
    const speed = asset.speed ?? 1;
    const graph = [
      `[0:v]setpts=(PTS-STARTPTS)/${speed},fps=${v.fps},${toRgb},${place(l.slots[0])}[s]`,
      `[s][1:v]overlay=0:0:format=rgb,scale=out_color_matrix=${v.color}:out_range=tv,format=${v.pix_fmt},setparams=colorspace=${v.color}:color_primaries=${v.color}:color_trc=${v.color}:range=tv[o]`,
    ].join(';');
    ff('ffmpeg', ['-v', 'error', '-y', '-ss', String(asset.in), '-t', String(asset.out - asset.in), '-i', rawFile(asset.source), '-i', coverFile,
      '-filter_complex', graph, '-map', '[o]', '-t', String(videoSeconds(asset)), '-r', String(v.fps), '-fps_mode', 'cfr',
      '-c:v', 'libx264', '-crf', String(v.crf), '-pix_fmt', v.pix_fmt,
      '-colorspace', v.color, '-color_primaries', v.color, '-color_trc', v.color, '-color_range', 'tv',
      '-movflags', '+faststart', '-an', outFile]);
    return;
  }
  const n = asset.shots.length;
  const inputs = asset.shots.flatMap((s) => ['-ss', String(s.at), '-i', rawFile(s.source)]);
  const parts = [`[0:v]${toRgb},${place(l.slots[0])}[b0]`];
  for (let i = 1; i < n; i++) parts.push(`[${i}:v]${toRgb}[s${i}]`, `[b${i - 1}][s${i}]overlay=${l.slots[i].x}:${l.slots[i].y}:format=rgb[b${i}]`);
  parts.push(`[b${n - 1}][${n}:v]overlay=0:0:format=rgb,format=rgb24[o]`);
  ff('ffmpeg', ['-v', 'error', '-y', ...inputs, '-i', coverFile, '-filter_complex', parts.join(';'), '-map', '[o]', '-frames:v', '1', outFile]);
}

export function exportProject(rules, project) {
  const ctx = loadContext(rules, project);
  const bad = editsErrors(ctx);
  if (bad.length) return { ok: false, errors: bad };
  const dir = runPath(project, 'export');
  const cache = path.join(dir, '.cache');
  fs.mkdirSync(cache, { recursive: true });

  const covers = new Map();
  const coverFor = (layout) => {
    if (!covers.has(layout)) {
      const f = path.join(cache, `cover-${layout}.png`);
      fs.writeFileSync(f, coverPng(rules.assets.canvas, layoutOf(rules, layout).slots, ctx.edits.style));
      covers.set(layout, f);
    }
    return covers.get(layout);
  };

  const assets = [];
  const keep = new Set();
  for (const a of ctx.edits.assets) {
    const hash = assetHash(rules, ctx.edits, a, ctx.raw);
    const ext = path.extname(assetFile(a));
    const cached = path.join(cache, `${hash}${ext}`);
    const built = !exists(cached);
    if (built) build(rules, ctx, a, cached, coverFor(a.layout));
    fs.copyFileSync(cached, path.join(dir, assetFile(a)));
    keep.add(`${hash}${ext}`);
    assets.push({ n: a.n, file: assetFile(a), type: a.type, layout: a.layout, hash, built });
  }
  // edits.json에 없는 파일과 쓰지 않는 캐시를 지운다
  for (const f of fs.readdirSync(dir)) if (/^\d{2}\.(png|mp4)$/.test(f) && !assets.some((a) => a.file === f)) fs.rmSync(path.join(dir, f));
  for (const f of fs.readdirSync(cache)) if (!keep.has(f)) fs.rmSync(path.join(cache, f));

  writeJson(derivedPath(rules, project, 'export'), { exported_at: now(), style: ctx.edits.style, assets: assets.map(({ built: _b, ...a }) => a) });
  appendLog(rules, project, { event: 'export', built: assets.filter((a) => a.built).map((a) => nn(a.n)) });
  return { ok: true, assets };
}

if (process.argv[1]?.endsWith('export.mjs')) {
  try {
    const project = process.argv[2];
    const rules = loadRules();
    assertProject(rules, project);
    const r = exportProject(rules, project);
    console.log(JSON.stringify({ project, ...r }, null, 2));
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`export 오류: ${e.message}`);
    process.exit(2);
  }
}

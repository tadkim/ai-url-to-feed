#!/usr/bin/env node
// 편집 화면만 따로 여는 서버. 보통은 `npm start`(app.mjs)의 시작 화면에서 들어간다.
// 사용: node scripts/review.mjs <project> [--port N] [--no-open]
//   - 127.0.0.1에서만 연다. 포트가 쓰이고 있으면 다음 빈 포트를 쓴다 (--port를 주면 그 포트만).
//   - 화면에서 바꾼 값은 runs/<project>/edit/edits.json에 저장한다.
//   - "내보내기"는 export.mjs → judge.mjs --phase P4 --no-count를 실행한다 (사람이 고치는 중의 FAIL은 시도 횟수에 넣지 않는다).
import http from 'node:http';
import { loadRules, assertProject } from './lib.mjs';
import { send, editorRoutes, serveUi, listen } from './server.mjs';

const [project, ...args] = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : undefined; };
const rules = loadRules();
assertProject(rules, project);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (serveUi(req, res, decodeURIComponent(url.pathname))) return;
    const sub = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (!(await editorRoutes(req, res, project, sub, url))) send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

listen(server, {
  port: Number(opt('--port') ?? rules.review.port), fixed: opt('--port') != null, label: 'review', open: !args.includes('--no-open'),
  onReady: (addr) => console.log(`편집 화면: ${addr}  (project: ${project}, 끝내려면 Ctrl+C)`),
});

# Roles

에이전트는 2개이고, 각자 `runs/<project>/` 아래 정해진 경로(rules.yaml `agents.<name>.writes`)에만 쓴다.
판정은 오케스트레이터가 실행하는 `scripts/judge.mjs`가 한다. 오케스트레이터 절차는 [CLAUDE.md](../CLAUDE.md).

## 에이전트

| 에이전트 | Phase | 쓰는 곳 | 외부 도구 |
|---|---|---|---|
| planner | P1 | plan/ (plan.json, *.scenario.mjs) | explore.mjs (둘러보기), try.mjs (시나리오 미리 돌려 보기) |
| editor | P3 | edit/edits.json 1개 | frames.mjs (녹화본의 원하는 순간을 뽑아 보기) |

## 스크립트 (오케스트레이터가 실행)

| 스크립트 | 하는 일 |
|---|---|
| run.mjs | status, begin/end(편집 범위), approve/reject(plan, final), unblock, accept, usage |
| explore.mjs | planner가 실행한다. record.mjs와 같은 viewport·언어·쓰기 차단으로 사이트를 열어 스크린샷·누를 수 있는 요소·선택자·애니메이션 주기를 돌려준다. `--batch`로 여러 화면을 브라우저 하나에서 한 번에(동시에 3개씩) 본다. `.cache/`에만 쓴다 (git·편집 범위 검사 제외) |
| try.mjs | planner가 실행한다. 시나리오를 실제 녹화 엔진으로 끝까지 돌려 보고(배율 1) 길이·컨택트 시트·오류를 돌려준다. 이름을 여러 개 주면 동시에 돌린다. 페이지 열기 시간 초과는 한 번 더 돌린다. `.cache/`에만 쓴다 (git·편집 범위 검사 제외) |
| frames.mjs | editor가 실행한다. 녹화본에서 정한 시점·구간의 프레임을 한 장으로 이어 붙여 준다. `.cache/`에만 쓴다 (git·편집 범위 검사 제외) |
| record.mjs | plan/의 시나리오를 walkthrough-recorder로 녹화 (viewport x scale). 녹화본마다 컨택트 시트와 장면 전환 시점을 만든다. 도는 동안 `runs/.harness/busy/<p>.json`을 남긴다 (시작 화면의 "만드는 중") |
| export.mjs | edits.json대로 구간 → 속도 → 배치 → 테두리·모서리를 합성해 export/에 영상·이미지를 만든다. 도는 동안 `runs/.harness/busy/<p>.json`을 남긴다 |
| judge.mjs | Phase별 게이트 판정. gate/checks.json, gate/p4-gate.json을 쓴다 |
| cli.mjs (`npx ai-url-to-feed`) | 사람이 치는 기본 진입점. 환경 확인 → projects.mjs로 projects.yaml 등록(`bg`, `asset_count`, `mode`) → `claude -p "<p> 하네스 시작해줘"`를 허용 목록(`--allowedTools`)과 함께 띄우고 status를 읽어 진행을 한 줄씩 보여 준다. 끝나지 않았으면 "이어서 해줘"로 두 번까지 더. edit·review 모드면 승인 화면(app.mjs)을 연다. `retake`는 사람의 다시 찍기 요청이라 run.mjs reject plan을 기록한다 |
| app.mjs (`npm start`) | 시작 화면 서버 (127.0.0.1). URL로 projects.yaml에 등록, 7단계 진행 표시(lib.mjs `progress`), 녹화 확인·완성본 확인 화면(이전 결과와 비교), 편집 화면(`/p/<p>/edit/`). 승인·거절 버튼은 사람이 누를 때만 run.mjs approve·reject를 실행한다 |
| review.mjs | 편집 화면만 여는 서버. 사람이 고친 값을 edits.json에 저장하고, "내보내기"로 export.mjs → judge.mjs를 실행한다 (app.mjs와 server.mjs를 같이 쓴다) |

## 사람

- 배경색(projects.yaml `bg`, 명령줄 `--bg`): editor는 이 색을 쓴다 (게이트 style_bg). 사람이 편집 화면에서 바꾼 색(`style.bg_by: human`)이 우선한다.
- 진행 방식(projects.yaml `mode`): auto는 사람 승인 없이 자동 검사만으로 완성, edit는 완성본만, review는 둘 다 사람이 승인한다. 어떤 승인을 건너뛸지는 run.mjs status가 정한다.
- 승인은 사람만 한다. "<project> 촬영 계획 승인" → `run.mjs approve <project> plan`, "<project> 완성본 승인" → `run.mjs approve <project> final`. 시작 화면의 승인·거절 버튼도 같은 명령을 실행한다 (화면을 연 뒤 내용이 바뀌었으면 승인하지 않는다).
- 거절하면 run.mjs가 직전 결과를 `runs/<p>/history/<plan|final>/`에 남긴다 (최근 3개). 승인 화면이 이전과 지금을 나란히 보여 준다.
- 승인 1은 plan.json + 시나리오 + 녹화본 해시, 승인 2는 export/ 파일 + edits.json 해시를 남긴다. 이후 내용이 바뀌면 예전 승인은 무효다.
- 사람은 편집 화면에서 edits.json을 직접 고칠 수 있다 (구간, 속도, 추출 시점, 배경색·테두리·모서리, 순서, 빼기·더하기). 거절하고 editor에게 맡길 수도 있다.
- STOP은 사람이 "<project> 계속 진행해"라고 해야 풀린다.
- 쓰기 허용(`allow_writes`, `allow_post`)은 사람이 projects.yaml에 직접 적는다. 에이전트가 바꾸지 못한다. 읽기 전용 POST의 기본 통과 목록은 rules.yaml `record.read_post`.

## 편집 범위 확인

- 에이전트 실행 전후로 `run.mjs begin`/`end`. 에이전트가 자기 경로 밖(다른 폴더, `runs/.harness/`, 저장소 파일)에 쓰면 FAIL.
- Chrome은 쓰지 않는다. planner는 explore.mjs로 사이트를 둘러보기만 한다.

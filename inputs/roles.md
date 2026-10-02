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
| explore.mjs | planner가 실행한다. record.mjs와 같은 viewport·언어·쓰기 차단으로 사이트를 열어 스크린샷·누를 수 있는 요소·선택자·애니메이션 주기를 돌려준다. `.cache/`에만 쓴다 (git·편집 범위 검사 제외) |
| try.mjs | planner가 실행한다. 시나리오 하나를 실제 녹화 엔진으로 끝까지 돌려 보고(배율 1) 길이·컨택트 시트·오류를 돌려준다. `.cache/`에만 쓴다 (git·편집 범위 검사 제외) |
| frames.mjs | editor가 실행한다. 녹화본에서 정한 시점·구간의 프레임을 한 장으로 이어 붙여 준다. `.cache/`에만 쓴다 (git·편집 범위 검사 제외) |
| record.mjs | plan/의 시나리오를 walkthrough-recorder로 녹화 (viewport x scale). 녹화본마다 컨택트 시트와 장면 전환 시점을 만든다 |
| export.mjs | edits.json대로 구간 → 속도 → 배치 → 테두리·모서리를 합성해 export/에 영상·이미지를 만든다 |
| judge.mjs | Phase별 게이트 판정. gate/checks.json, gate/p4-gate.json을 쓴다 |
| review.mjs | 검토용 HTML 서버 (127.0.0.1). 사람이 고친 값을 edits.json에 저장하고, "내보내기"로 export.mjs → judge.mjs를 실행한다 |

## 사람

- 승인은 사람만 한다. "<project> 촬영 계획 승인" → `run.mjs approve <project> plan`, "<project> 완성본 승인" → `run.mjs approve <project> final`.
- 승인 1은 plan.json + 시나리오 + 녹화본 해시, 승인 2는 export/ 파일 + edits.json 해시를 남긴다. 이후 내용이 바뀌면 예전 승인은 무효다.
- 사람은 검토용 HTML에서 edits.json을 직접 고칠 수 있다 (구간, 속도, 추출 시점, 배경색·테두리·모서리, 순서, 빼기·더하기). 거절하고 editor에게 맡길 수도 있다.
- STOP은 사람이 "<project> 계속 진행해"라고 해야 풀린다.
- 쓰기 허용(`allow_writes`)은 사람이 rules.yaml에 직접 적는다. 에이전트가 바꾸지 못한다.

## 편집 범위 확인

- 에이전트 실행 전후로 `run.mjs begin`/`end`. 에이전트가 자기 경로 밖(다른 폴더, `runs/.harness/`, 저장소 파일)에 쓰면 FAIL.
- Chrome은 쓰지 않는다. planner는 explore.mjs로 사이트를 둘러보기만 한다.

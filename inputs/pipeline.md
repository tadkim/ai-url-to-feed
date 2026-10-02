# Pipeline

한 번 실행할 때 `project` 1개를 처리한다 (inputs/purpose.md).
Phase는 4개이고, 사람 승인이 2번 있다.

## Phase

| Phase | story-work 단계 | 맡는 쪽 | 입력 | 출력 (`runs/<project>/`) |
|---|---|---|---|---|
| (시작 전) | 1, 2 | status, explore.mjs, record.mjs | projects.yaml | 도구·대상 확인. 실패하면 STOP 또는 실행 오류 |
| P1 촬영 계획 | 3, 4, 5 | planner | 웹 콘텐츠 | plan/plan.json, plan/*.scenario.mjs |
| P2 녹화 | 6, 7 | record.mjs | plan/ | raw/*.mp4, raw/*.sheet.png, raw/manifest.json |
| ✋ 승인 1 | — | 사람 | 에셋 목록, 녹화본, 쓰기 요청 수 | gate/approval-plan.json (run.mjs approve plan) |
| P3 편집값 | 8, 9, 10, 11 | editor | plan/, raw/ | edit/edits.json |
| P4 내보내기·검토 | 12, 13, 14 | export.mjs → judge.mjs | edits.json, raw/ | export/, gate/p4-gate.json |
| ✋ 승인 2 | 9, 11, 14 | 사람 (검토용 HTML에서 보고 고친 뒤) | export/ | gate/approval-final.json (run.mjs approve final) |

- P1: planner는 `scripts/explore.mjs`로 사이트를 둘러보고, 쓴 시나리오를 `scripts/try.mjs`로 미리 돌려 본 뒤 계획과 시나리오를 넘긴다. 녹화는 오케스트레이터가 `node scripts/record.mjs <project>`로 실행한다.
- P2: 시나리오·설정이 같은 녹화본은 다시 찍지 않는다. 시나리오가 실행 중 오류를 내면 manifest의 `error`에 남고, status가 P1로 돌려보낸다.
- 승인 1이 녹화 뒤에 있는 이유: 사람이 에셋 목록만이 아니라 실제 녹화본을 보고 승인하고, 시나리오를 고칠 때마다 다시 승인받지 않기 위해서다. 쓰기 허용은 rules.yaml에서 사람이 미리 정하므로 녹화가 승인보다 먼저여도 허용하지 않은 쓰기는 일어나지 않는다.
- P3: editor는 편집값만 쓴다. 파일은 오케스트레이터가 `node scripts/export.mjs <project>`로 만든다 (편집값이 같으면 결과가 같다).
- P4 뒤: 사람이 검토용 HTML에서 값을 고치면 edits.json이 바뀌고, "내보내기"가 export.mjs → judge.mjs를 다시 실행한다. 승인은 마지막으로 만든 파일과 편집값에 대해 한다.

## 결정 항목

| 결정할 것 | 누가 | 어디서 |
|---|---|---|
| 에셋 수·순서, 에셋마다 유형(video/image)·배치(화면 1·2·3개)·장면 | planner 제안 → 사람 | 승인 1 |
| 백엔드 쓰기를 허용할지 | 사람 | rules.yaml (시작 전) |
| 구간, 재생 속도, 이미지 추출 시점, 루프 시작점 | editor 제안 → 사람 | 검토용 HTML, 승인 2 |
| 배경색, 테두리색·두께, 모서리 | editor 제안 → 사람 | 검토용 HTML, 승인 2 |

- 셀 수 있는 조건(에셋 수, 영상 길이, 크기, 빈 화면, 배경색 통일, 루프 이음매)은 게이트가 판정한다.

## 되돌아가는 지점

| 조건 | 돌아갈 곳 | 최대 횟수 | 넘으면 |
|---|---|---|---|
| P1 게이트 FAIL | P1 (planner) | — | — |
| P2 게이트 FAIL (시나리오 오류) | P1 (manifest의 error를 planner에게) | — | — |
| 승인 1 거절 | P1 | `retry.plan_reject` | STOP |
| P4 게이트 FAIL | P3 (실패 게이트와 detail을 editor에게) | `retry.p4_fail_to_p3` | STOP |
| 승인 2 거절 | P3 (사람 요청을 editor에게) | `retry.final_reject` | STOP |

- 검토용 HTML의 "내보내기"에서 난 FAIL은 시도 횟수에 넣지 않는다 (사람이 고치는 중이다).

## 재개

- `node scripts/run.mjs status <project>`의 `next`에서 시작한다. 파일이 있는지만으로 판단하지 않는다.

## 에이전트 경계

- B1: P1 → P2 (웹 탐색·시나리오 → 녹화).
- B2: P2 → P3 (녹화본 → 편집값). 승인 1이 이 경계에 있다.
- B3: 승인 2 뒤 (에셋 → 게시 문구·게시). 하네스는 여기서 멈춘다.

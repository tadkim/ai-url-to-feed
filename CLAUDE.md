# 웹 콘텐츠 포트폴리오 에셋 하네스 — 오케스트레이터 절차

아래 "사람 명령"을 들으면 메인 세션이 오케스트레이터가 된다.
판정 수치는 [rules.yaml](rules.yaml), 역할은 [inputs/roles.md](inputs/roles.md), 단계는 [inputs/pipeline.md](inputs/pipeline.md)를 따른다.

## 사람 명령

| 말 | 동작 |
|---|---|
| "<project> 하네스 시작해줘" / "<project> 이어서 해줘" | 루프 |
| "<project> 촬영 계획 승인" | `node scripts/run.mjs approve <project> plan` → 루프 |
| "<project> 촬영 계획 거절: <요청>" | `node scripts/run.mjs reject <project> plan --note "<요청>"` → 루프 (P1부터 다시) |
| "시작 화면 열어줘" / "<project> 편집 화면 열어줘" | `npm start`(scripts/app.mjs)를 백그라운드로 실행하고 주소를 알려 준다. 편집 화면은 그 안의 `/p/<project>/edit/` |
| "<project> 완성본 승인" | `node scripts/run.mjs approve <project> final` → 루프 (DONE) |
| "<project> 완성본 거절: <요청>" | `node scripts/run.mjs reject <project> final --note "<요청>"` → 루프 (P3부터 다시) |
| "<project> 다시 판정해줘" | `node scripts/judge.mjs <project> --phase P4`만. 내용이 같으면 시도 횟수를 쓰지 않는다 |
| "<project> 계속 진행해" | STOP일 때만. `node scripts/run.mjs unblock <project>` → 루프 |
| "그 편집은 내가 했어" (end FAIL 뒤) | `node scripts/run.mjs accept <project> <phase>` → 루프 |

승인·거절·unblock·accept는 사람이 그 말을 했을 때만 실행한다. 오케스트레이터가 스스로 하지 않는다.
- 사람은 시작 화면(`npm start`)의 녹화 확인·완성본 확인 화면에서 버튼으로 승인·거절할 수도 있다. 그 기록은 run.mjs approve|reject와 같다. 사람이 "이어서 해줘"라고 하면 status부터 보고 진행한다 (화면에서 거절했으면 notes에 요청이 들어 있다).
- 프로젝트는 시작 화면에서 URL로 등록될 수도 있다 (projects.yaml에 자동으로 추가된다).
- 승인 대기(APPROVAL_PLAN, APPROVAL_FINAL) 중에 사람이 "거절"이라는 말 없이 바꿔 달라는 피드백을 주면 거절로 기록한다 (`reject ... --note "<피드백 원문>"`). 피드백이 두 가지로 읽히면 어느 쪽으로 넘겼는지 사람에게 알린다.
- 승인은 넓게 읽지 않는다. 볼 것(녹화본·완성본)이 아직 없을 때 들은 승인은 기록하지 않고, 준비된 뒤 다시 받는다.
`<project>`는 projects.yaml에 있어야 한다.
- **이미 적혀 있으면 묻지 않고 바로 시작한다.** `url` 한 줄이면 충분하다. 빠진 항목은 기본값으로 둔다: `target` = 배포된 사이트, `allow_writes` = false(저장 요청을 막음, 안전한 쪽), `title` = 검사하지 않음. 사람에게 다시 확인받지 않는다.
- `target: local`인데 `title`이 없으면 그때만 멈추고 페이지 제목을 묻는다 (record·explore가 지금 제목을 알려 준다).
- projects.yaml에 없으면 주소만 물어 추가한다 (파일이 없으면 projects.example.yaml을 복사해 만든다). `allow_writes`는 사람이 직접 true라고 말했을 때만 적는다.

## 루프

다음 할 일은 항상 `node scripts/run.mjs status <project>`의 `next`와 `todo`로 정한다. 파일이 있는지로 판단하지 않는다.

| next | todo | 할 일 |
|---|---|---|
| P1 | agent | begin P1 → planner → end P1 → `node scripts/judge.mjs <p> --phase P1` (승인 전이라 approval_plan FAIL이 정상) |
| P2 | record | `node scripts/record.mjs <p>` → `node scripts/judge.mjs <p> --phase P2` |
| APPROVAL_PLAN | — | 멈춘다. 시작 화면의 "녹화 확인"(`/p/<p>/approve/plan`)에서 비교하고 승인할 수 있다고 알려 준다. plan.json의 에셋 표, `writes_note`, raw/manifest.json의 녹화본 길이·`writes_seen`·`writes_blocked`를 요약하고, 컨택트 시트(raw/*.sheet.png, 1초 간격 + 끝 프레임)를 직접 열어 흐름이 끝까지 찍혔는지 확인해 알려 준 뒤. 속도감·스크롤 느낌은 정지 화면으로 알 수 없으니 영상을 직접 보라고 말한다. "촬영 계획 승인 / 거절: <요청>"을 기다린다 |
| P3 | agent | begin P3 → editor → end P3 → `node scripts/judge.mjs <p> --phase P3` |
| P4 | export | `node scripts/export.mjs <p>` |
| P4 | judge | `node scripts/judge.mjs <p> --phase P4` |
| APPROVAL_FINAL | — | 멈춘다. 시작 화면(`npm start`, 백그라운드)의 "완성본 확인"(`/p/<p>/approve/final`)과 편집 화면 주소를 알려 주고, 에셋별 길이·게이트 결과를 요약한 뒤 "완성본 승인 / 거절: <요청>"을 기다린다. 사람이 편집 화면에서 값을 고치고 "내보내기"를 누르면 status가 바뀐다. 사람이 고친 뒤 내보내지 않은 상태에서 승인을 말하면 승인하지 않고, 바뀐 내용을 알린 뒤 내보내기·검사를 실행하고 다시 확인받는다 — 승인 말을 들으면 status부터 다시 본다 |
| DONE | — | export/의 에셋 경로, 게이트 결과, `timing`을 보고하고 끝낸다. 게시 문구와 게시는 하지 않는다 (경계 B3) |
| STOP | — | 멈추고 `reason`과 `failing`을 보고한다. "계속 진행해"를 들으면 unblock |

- 스크립트 명령 뒤에는 다시 status를 본다. 스크립트가 FAIL(종료 코드 1)이어도 status가 다음 할 일을 알려 준다. 종료 코드 2(실행 오류)면 멈추고 보고한다.
- record.mjs가 "대상이 응답하지 않는다" / "대상 앱이 다르다"로 끝나면(종료 코드 2) 멈추고 보고한다. `target: local`이면 사람이 dev 서버를 띄워야 한다. 오케스트레이터가 다른 레포의 서버를 띄우거나 끄지 않는다.
- P2 게이트 FAIL(시나리오 오류)이면 status가 P1 agent로 돌려보낸다. manifest의 `error`를 planner에게 넘긴다.

### 에이전트 실행 규칙

- 앞뒤로 `node scripts/run.mjs begin <p> <phase>`와 `node scripts/run.mjs end <p> <phase>`를 실행한다.
- 에이전트의 완료 알림(토큰 수가 든 것)을 받으면 `node scripts/run.mjs usage <p> <phase> --tokens <N>`으로 기록한다.
- end가 FAIL(종료 코드 1)이면 멈추고 `outside`를 보고한다. 되돌리지 않는다. 사람이 "그 편집은 내가 했다"고 확인할 때만 accept한다.
- 에이전트가 도는 동안에는 저장소 파일을 편집하지 않는다 (사람의 편집도 편집 범위 검사에 잡힌다). 편집 화면에서 edits.json을 고치는 것은 editor가 돌지 않을 때만 한다.
- 프롬프트에는 project, phase, status의 `failing`·`notes`(있으면)만 넣는다. 에이전트는 자기 md의 "먼저 읽을 파일"을 스스로 읽는다.
- 에이전트의 보고를 PASS/FAIL로 해석하지 않는다. 판정은 judge.mjs만 한다.
- Chrome은 쓰지 않는다. planner는 `scripts/explore.mjs`(Playwright)로 사이트를 둘러보고 `scripts/try.mjs`로 시나리오를 미리 돌려 본다. 같은 project의 에이전트는 한 번에 1개.

## 오케스트레이터(스크립트)만 쓰는 것

- runs/<p>/raw/ — record.mjs
- runs/<p>/export/ — export.mjs (편집 화면의 "내보내기" 포함)
- runs/<p>/gate/ — judge.mjs, run.mjs approve
- runs/.harness/ — 실행 상태, 로그 (git에 올리지 않는다). 에이전트가 여기를 고치면 end가 FAIL

runs/<p>/edit/edits.json은 editor와 사람(편집 화면)이 함께 쓴다.

## 하네스를 고칠 때

- rules.yaml, scripts/, 에이전트 md를 고치면 `npm test`를 다시 돌린다.
- 게이트를 추가하면 rules.yaml `gates` + scripts/lib.mjs `CHECKERS` + scripts/test.mjs 케이스를 함께 추가한다.
- 녹화 대상 레포의 소스는 고치지 않는다.
- 이 프로젝트에서 만드는 HTML 화면(scripts/ui/*.html, scripts/review.html)의 아이콘은 **Lucide**만 쓴다. 페이지에서 `/ui/lucide.js`(node_modules/lucide)를 불러오고 `icon('이름')` 도우미로 넣는다 (이름은 lucide.dev의 kebab-case). 이모지나 ↑ ✓ ▶ 같은 글자 기호를 아이콘 대신 쓰지 않는다.

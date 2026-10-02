# Input Context

하네스가 시작하기 전에 아래가 모두 있어야 한다.
판정: `node scripts/run.mjs status <project>`가 rules.yaml `inputs`·`tools`(node 버전, ffmpeg, npm 패키지)를 확인한다. 하나라도 없으면 STOP. `npm test`도 같은 검사로 시작한다.

## 필수 파일

| 파일 | 역할 |
|---|---|
| prd.md | 무엇을 만드는지, 규격, 기능 요구사항 |
| story-service.md | 판정 기준: 보는 사람·만드는 사람, 유저스토리, 어기면 안 되는 것 |
| story-work.md | 파이프라인 재료: 실제 작업 흐름, 게이트, 경계 |
| rules.yaml | 수치·형식·게이트 SSOT |
| projects.yaml | 프로젝트 목록 (주소, `<title>`, 쓰기 허용). 이 컴퓨터에만 두고 git에 올리지 않는다. 형식은 projects.example.yaml |

## 도구

| 도구 | 용도 |
|---|---|
| node (rules.yaml `tools.node_min` 이상) | 스크립트 실행 |
| ffmpeg, ffprobe | 컨택트 시트, 내보내기, 측정 |
| walkthrough-recorder (별도 공개 레포 tadkim/walkthrough-recorder, `npm install`로 설치) | 녹화 엔진: 가짜 커서, 배율 반영 캡처, 실타이밍 인코딩 |
| playwright + chromium | 사이트 둘러보기(explore.mjs). 녹화 엔진은 자기 폴더의 playwright를 쓴다 |

## 외부 소스

| 소스 | 방법 | 쓰는 곳 |
|---|---|---|
| 프로젝트 웹 콘텐츠 | projects.yaml `projects.<project>.url`. explore.mjs·record.mjs가 열기 전에 `<title>`을 확인한다 | P1 둘러보기, P2 녹화 |

- `target: local`이면 사람이 dev 서버를 먼저 띄운다. 하네스는 다른 레포의 서버를 띄우거나 끄지 않는다.
- `allow_writes: false`면 POST·PUT·PATCH·DELETE 요청을 막는다. 읽기가 POST인 백엔드는 `allow_post`에 주소 정규식을 적는다.

## 읽지 않는 것

- 녹화 대상 레포의 소스 — 브라우저로 보이는 화면만 본다. 소스를 고치지 않는다.
- 인스타그램 피드, Figma, UI Bowl — 이 하네스의 범위 밖이다.

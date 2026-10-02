# 시작하기

[← README](../README.md)

이 문서를 따라 하면 웹사이트 1개로 인스타그램 게시물 1개 분량의 파일(1080×1440 영상·이미지 5~10개)을 만들어요.
AI가 녹화하고, 사람은 두 번 확인해서 승인해요. AI 작업은 한 프로젝트에 5~25분이고, 여기에 확인하는 시간이 더해져요.

| 단계 | 하는 일 | 입력 | 결과 |
|---|---|---|---|
| 0. 미리 설치 | 컴퓨터에 한 번 | Node.js · ffmpeg · Claude Code | |
| 1. 받기 | 저장소 내려받기 | `git clone` | 폴더 |
| 2. 설치·검사 | 패키지와 녹화용 브라우저 설치 | 터미널 명령 3줄 | `88/88 PASS`처럼 모두 PASS |
| 3. 프로젝트 등록 | 녹화할 사이트 적기 | `projects.yaml`에 주소 | 등록된 프로젝트 |
| 4. Claude Code 실행 | 이 폴더에서 열기 | `claude` | 하네스 준비 |
| 5. 녹화 | AI가 장면을 정해 녹화 → 사람이 승인 | `my-site 하네스 시작해줘` | `raw/` 녹화본 |
| 6. 다듬기 (선택) | 편집 화면에서 고치고 내보내기 | `npm run review -- my-site` | `export/` 갱신 |
| 7. 끝내기 | 완성본 승인 | `my-site 완성본 승인` | `export/` 게시물 파일 |

## 0. 미리 설치 (컴퓨터에 한 번)

| 도구 | 설치 |
|---|---|
| Node.js 22.2 이상 | [nodejs.org](https://nodejs.org) |
| ffmpeg | `brew install ffmpeg` (macOS, [Homebrew](https://brew.sh) 필요) |
| Claude Code | `npm install -g @anthropic-ai/claude-code` → 처음 실행할 때 로그인 |

```bash
node -v           # v22.2 이상이면 돼요
ffmpeg -version   # 버전이 나오면 돼요
```

## 1. 받기

```bash
git clone https://github.com/tadkim/ai-url-to-feed.git
cd ai-url-to-feed
```

## 2. 설치·검사

녹화 엔진 [walkthrough-recorder](https://github.com/tadkim/walkthrough-recorder)도 함께 설치돼요.

```bash
npm install
npx playwright install chromium
npm test
```

마지막 줄이 `88/88 PASS`처럼 앞뒤 숫자가 같으면 준비가 끝났어요. 실패하면 메시지에 빠진 항목이 나와요 ([문제 해결](troubleshooting.md)).

## 3. 프로젝트 등록

예시 파일을 복사해요.

```bash
cp projects.example.yaml projects.yaml
```

`projects.yaml`을 열어 내용을 지우고 녹화할 사이트를 적어요. 배포된 사이트는 주소 한 줄이면 돼요.

```yaml
projects:
  my-site:                         # 프로젝트 이름 (영문 소문자·숫자·-)
    url: https://example.com       # 사이트 주소. 끝에 "/" 없이
```

내 컴퓨터의 개발 서버, 저장 장면 녹화, 에셋 수 변경 같은 추가 설정은 [설정](configuration.md)을 봐요.

## 4. Claude Code 실행

**반드시 이 폴더 안에서** 실행해요. 그래야 진행 순서(`CLAUDE.md`)와 에이전트가 함께 불러와져요.

```bash
claude
```

처음 실행하면 이 폴더를 신뢰할지 물어요. **신뢰(Yes)** 를 골라야 하네스 명령이 미리 허용된 상태로 동작해요.

## 5. 녹화

Claude Code에 입력해요.

```text
my-site 하네스 시작해줘
```

AI가 사이트를 둘러보고 찍을 장면을 정해 녹화해요 (5분 안팎). 끝나면 `runs/my-site/raw/`에 녹화본(`.mp4`)과 1초 간격 장면 모음(`.sheet.png`)이 생기고, Claude가 확인을 요청해요.

```text
my-site 촬영 계획 승인
my-site 촬영 계획 거절: 버튼 사이 간격을 더 짧게, 스크롤은 사람처럼
```

괜찮으면 승인하고, 바꾸고 싶으면 거절하면서 요청을 적어요. 승인하면 AI가 구간·속도를 정해 게시물 파일을 만들고 다시 확인을 요청해요.

## 6. 다듬기 (선택)

그대로 써도 되면 건너뛰어요. 고치고 싶으면 **새 터미널 창**에서 같은 폴더로 가서 편집 화면을 열어요.

```bash
npm run review -- my-site
```

브라우저에서 구간·재생 속도·배경색을 고친 뒤 오른쪽 위 **내보내기**를 눌러요. 편집은 자동 저장되지만 **파일에는 내보내기를 눌러야 반영돼요.** 자세한 사용법은 [편집 화면](editor.md)을 봐요.

## 7. 끝내기

Claude Code에 입력해요.

```text
my-site 완성본 승인
```

`runs/my-site/export/`의 `01.mp4`, `02.png` … 를 순서대로 인스타그램에 올리면 돼요.

## 처음 쓸 때 막힐 수 있는 곳

| 지점 | 내용 |
|---|---|
| 4단계 | 폴더를 신뢰하지 않으면 하네스 명령마다 실행 허락을 물어요. 신뢰(Yes)를 골라요 |
| 5·7단계 | 승인·거절을 기록하는 명령은 **일부러** 매번 실행 허락을 물어요. 사람이 직접 확인하게 하려는 장치라 허용을 누르면 돼요 |
| 0단계 | Windows·Linux는 아직 확인 전이에요. Linux는 `npx playwright install --with-deps chromium`과 한글 폰트가 필요할 수 있어요 |
| 5단계 | 로그인이 필요한 사이트는 아직 찍을 수 없어요 |

## Claude Code에 하는 말

| 말 | 하는 일 |
|---|---|
| `<프로젝트> 하네스 시작해줘` / `이어서 해줘` | 처음부터 / 멈춘 곳부터 진행 |
| `<프로젝트> 촬영 계획 승인` / `거절: <요청>` | 녹화본 확정 / 요청대로 다시 찍기 |
| `<프로젝트> 검토 화면 열어줘` | 편집 화면 열기 |
| `<프로젝트> 완성본 승인` / `거절: <요청>` | 끝내기 / 요청대로 다시 편집 |
| `<프로젝트> 계속 진행해` | 멈춘(STOP) 하네스 다시 시작 |

## 다음 단계

| 하고 싶은 것 | 방법 |
|---|---|
| 다른 사이트 추가 | `projects.yaml`에 항목을 하나 더 적고 5번부터 해요. 프로젝트마다 따로 진행돼요 |
| 에셋 수·영상 길이 바꾸기 | [설정](configuration.md)의 `asset_count`, `max_video_seconds` |
| 동작 원리 알기 | [동작 방식](how-it-works.md) |

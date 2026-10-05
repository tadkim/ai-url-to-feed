# 시작하기

[← README](../README.md)

> **이 문서는**
> - 처음 설치해서 사이트 1개로 게시물을 만들어 보는 사람을 위한 순서예요
> - 설치는 명령 3줄, 만들기는 1줄이에요. stuckyi.studio는 처음부터 끝까지 약 12분 걸렸어요
> - 미리 필요한 것은 Node.js 22.2+, ffmpeg, 로그인한 Claude Code예요
> - 결과는 `runs/<프로젝트>/export/`에 생기고, 끝나면 터미널에 파일 목록이 나와요
> - 멈추거나 오류가 나면 [문제 해결](troubleshooting.md)을 봐요

## 1. 미리 설치

| 도구 | 설치 |
|---|---|
| Node.js 22.2 이상 | [nodejs.org](https://nodejs.org) |
| ffmpeg | `brew install ffmpeg` (macOS, [Homebrew](https://brew.sh) 필요) |
| Claude Code | `npm install -g @anthropic-ai/claude-code` → `claude`를 한 번 실행해 로그인 |

## 2. 받기

```bash
git clone https://github.com/tadkim/ai-url-to-feed.git
cd ai-url-to-feed
npm install
```

`npm install`이 녹화용 브라우저(chromium)도 받아요. 받지 못했다는 안내가 나오면 `npx playwright install chromium`을 실행해요.

## 3. 만들기

이 폴더에서 주소를 넣어 실행해요. `https://`는 빼도 돼요.

```bash
npx ai-url-to-feed stuckyi.studio --bg=#B987FF
```

진행 중에는 맨 아래 줄이 계속 바뀌어요. 둘러본 화면 수가 늘어나고 있으면 진행 중이에요.

```text
⠦ ░░░░░░░░░░░░░░░░░░░░   0% | 1/5 장면 계획 | AI 작업 중 · 화면 14개 둘러봄 | 02:38
```

끝나면 이렇게 남아요 (빈 폴더에서 위 명령으로 만든 실제 화면).

```text
✓ 장면 계획          08:31
✓ 녹화               01:12
✓ 구간·속도 정하기   01:58
✓ 파일 만들기        00:08
✓ 자동 검사          00:04
✓ ████████████████████ 100% | 5/5 완성 | 12:07

완성  runs/stuckyi/export/  01.mp4 02.png 03.mp4 04.png 05.mp4 06.png
  자동 모드 — 모든 자동 검사 PASS (사람 승인 없이 완성) · 12분 7초 · Claude Code 사용량 $2.63 (API 요금 기준, 21턴)
```

`01.mp4`부터 번호 순서대로 인스타그램에 올리면 돼요. 자동 검사에 걸리면 AI가 고쳐 다시 만들고, 그 단계 줄이 한 번 더 남아요.

## 4. 옵션

| 옵션 | 하는 일 |
|---|---|
| `--bg=#B987FF` | 배경색. 없으면 AI가 사이트와 잘 구분되는 색을 골라요 |
| `--count=6` · `--count=5-8` | 게시물 수 (기본 5~10개) |
| `--edit` | 다 만든 뒤 [편집 화면](editor.md)(작업 중)을 열어요 |

같은 주소로 옵션을 바꿔 다시 실행하면 그 설정으로 다시 만들어요.

## 5. 만든 뒤

| 하고 싶은 것 | 명령 |
|---|---|
| 진행 상황 보기 | `npx ai-url-to-feed status stuckyi` |
| 결과 폴더 열기 | `npx ai-url-to-feed open stuckyi` |
| 멈춘 곳부터 다시 | `npx ai-url-to-feed continue stuckyi` |
| 사이트와 기록 삭제 | `npx ai-url-to-feed delete stuckyi` (이름을 한 번 더 입력해요. `--keep`이면 게시물 파일은 `runs/_kept/`에 남겨요) |
| 브라우저로 진행 상황·결과 보기 | `npx ai-url-to-feed ui` |

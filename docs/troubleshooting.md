# 문제 해결

[← README](../README.md)

> **이 문서는**
> - 명령이 멈추거나 오류로 끝났을 때 보는 문서예요
> - 증상마다 원인과 해결 명령만 적었어요
> - 대부분 원인을 고친 뒤 `npx ai-url-to-feed continue <프로젝트>`로 멈춘 곳부터 이어서 해요
> - Claude Code가 한 일은 `runs/.harness/log/<프로젝트>-claude.log`에 남아요

## "Claude Code(claude)를 찾을 수 없어요"

명령줄은 AI 단계를 Claude Code에 맡겨요. 설치하고 한 번 실행해 로그인한 뒤 같은 명령을 다시 실행해요.

```bash
npm install -g @anthropic-ai/claude-code
claude          # 로그인한 뒤 /exit
```

## "실행 환경을 먼저 준비해야 해요"

그 아래에 빠진 도구가 나와요. 설치한 뒤 같은 명령을 다시 실행해요.

```bash
brew install ffmpeg               # ffmpeg (macOS)
npx playwright install chromium   # 녹화용 브라우저
```

## 진행 막대가 한참 그대로예요

장면 계획(1/5)은 AI가 사이트를 둘러보고 시나리오를 미리 돌려 보느라 6~9분 걸려요. 오른쪽 "화면 N개 둘러봄 · 시나리오 N번 돌려 봄"이 늘고 있으면 진행 중이에요. 30분이 넘도록 숫자가 그대로면 Ctrl+C로 멈추고 `continue`로 이어서 해요.

## Ctrl+C로 멈춘 뒤 "이미 다른 창에서 진행 중"이라고 나와요

다른 창에서 돌고 있지 않다면 `npx ai-url-to-feed continue <프로젝트>`를 실행해요. 남은 작업 기록을 정리하고 멈춘 단계부터 이어서 해요.

## "멈췄어요"로 끝나요

자동 검사가 정해진 횟수(`rules.yaml`의 `retry`)보다 많이 실패했거나, 실행 환경이 빠졌을 때 멈춰요. 그 아래에 이유가 나와요 (`npx ai-url-to-feed status <프로젝트>`로 다시 볼 수 있어요). 원인을 고친 뒤 `npx ai-url-to-feed continue <프로젝트>`로 이어서 해요.

## "세 번 이어서 했지만 끝나지 않았어요"

Claude Code가 완성 전에 끝나는 일이 세 번 이어졌어요. 사이트가 응답하지 않아 녹화가 실패한 경우가 많아요. `runs/.harness/log/<프로젝트>-claude.log` 끝부분에 이유가 있어요. 사이트가 열리는지 확인한 뒤 `npx ai-url-to-feed continue <프로젝트>`로 이어서 해요.

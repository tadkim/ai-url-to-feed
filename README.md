# ai-url-to-feed

**URL만 넣으면, 인스타그램에 바로 올릴 수 있는 3:4 영상·이미지가 나와요.**

![URL 입력 → 인스타그램 3:4 영상·이미지 5개](docs/assets/hero.gif)

- **페이지마다 동작 흐름을 직접 캡처하지 않아도 돼요.** AI가 사이트를 둘러보고 주요 흐름을 녹화해요.
- **캡처한 뒤 배경색·배치를 다시 작업하지 않아도 돼요.** 1080×1440 게시물 규격으로 맞춰 나와요.

<sub>예시: [TodoMVC](https://todomvc.com/examples/react/dist/) 주소만 넣고 만든 결과 · 선명한 버전 [hero.mp4](docs/assets/hero.mp4)</sub>

## 한눈에

| 필요한 것 | 입력 | 결과 |
|---|---|---|
| macOS · Node.js 22.2+ · ffmpeg · [Claude Code](https://claude.com/claude-code) | 웹사이트 주소 | `runs/<프로젝트>/export/`의 `01.mp4`, `02.png` … (5~10개) |

AI가 녹화하고 사람은 두 번 확인해서 승인해요. AI 작업은 한 프로젝트에 5~25분이에요.

## 빠른 시작

```bash
git clone https://github.com/tadkim/ai-url-to-feed.git && cd ai-url-to-feed
npm install && npx playwright install chromium && npm test
cp projects.example.yaml projects.yaml   # 열어서 url에 사이트 주소를 적어요
claude                                   # 이 폴더에서 실행, 폴더 신뢰는 Yes
```

Claude Code에 이렇게 말해요.

```text
my-site 하네스 시작해줘     → AI가 녹화하고 확인을 요청해요
my-site 촬영 계획 승인      → AI가 게시물 파일을 만들고 다시 확인을 요청해요
my-site 완성본 승인         → runs/my-site/export/에 파일이 남아요
```

단계별 설명은 [시작하기](docs/getting-started.md)에 있어요.

## 세부 수정 도구

AI가 만든 결과를 그대로 써도 되고, 편집 화면에서 구간·재생 속도·배경색을 직접 다듬을 수도 있어요.

![편집 화면: 재생 속도 1.5x → 구간 자르기 → 배경색 변경 → 내보내기](docs/assets/editor.gif)

```bash
npm run review -- my-site
```

사용법은 [편집 화면](docs/editor.md)에 있어요.

## 할 수 있는 것 · 할 수 없는 것

| 할 수 있어요 | 할 수 없어요 |
|---|---|
| 배포된 사이트, 내 컴퓨터의 개발 서버 녹화 | 로그인이 필요한 사이트 |
| 모바일 화면(360×640)을 3배 화질로 녹화 | 데스크톱 화면 크기 녹화 |
| 인스타그램 3:4(1080×1440) 게시물 | 4:5, 9:16 등 다른 규격 |
| 영상(화면 1개)·이미지(화면 1~3개) 섞어 5~10개 | 영상 한 장에 화면 2개 이상 |
| 구간·재생 속도·배경색·테두리·모서리 편집 | 소리, 글자·자막 넣기 |
| 크기·길이·빈 화면·배경색 자동 검사 | 게시 문구 작성, 인스타그램 업로드 |
| 사이트에 데이터를 남기지 않고 녹화 | |

macOS에서 확인했어요. Windows·Linux는 아직 돌려 보지 않았어요.

## 문서

| 문서 | 내용 |
|---|---|
| [시작하기](docs/getting-started.md) | 설치부터 완성본 승인까지 0~7단계, Claude Code에 하는 말 |
| [편집 화면](docs/editor.md) | 구간·속도·배경색 고치기, 내보내기, 단축키 |
| [동작 방식](docs/how-it-works.md) | 하네스와 에이전트, 흐름, 자동 검사, 폴더 구조 |
| [설정](docs/configuration.md) | `projects.yaml`(사이트별), `rules.yaml`(공통 규격) |
| [자주 묻는 질문](docs/faq.md) | 코딩 몰라도 되는지, 시간·비용, 어떤 사이트에 쓰는지 |
| [문제 해결](docs/troubleshooting.md) | 증상별 원인과 해결 |

## 라이선스

MIT · 녹화 엔진 [walkthrough-recorder](https://github.com/tadkim/walkthrough-recorder)도 MIT

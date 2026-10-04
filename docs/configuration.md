# 설정

[← README](../README.md)

설정 파일은 두 개예요.

| 파일 | 무엇을 정하나 | git |
|---|---|---|
| `projects.yaml` | 녹화할 사이트 (프로젝트마다) | 올라가지 않아요 |
| `rules.yaml` | 게시물 규격과 검사 기준 (모든 프로젝트 공통) | 올라가요 |

## projects.yaml

시작 화면에 주소를 넣으면 자동으로 만들어지고 항목이 추가돼요. 직접 고칠 때는 `projects.example.yaml`을 참고해요.

배포된 사이트는 주소 한 줄이면 돼요. 시작 화면이 쓰는 형식도 이것과 같아요.

```yaml
projects:
  my-site:                         # 프로젝트 이름 (영문 소문자·숫자·-)
    url: https://example.com       # 사이트 주소. 끝에 "/" 없이
```

필요할 때만 더 적어요.

| 항목 | 언제 | 값 | 기본값 |
|---|---|---|---|
| `mode` | 진행 방식을 바꿀 때 | `edit`(자동으로 만든 뒤 다듬고 한 번 승인) · `review`(녹화·완성본 둘 다 승인) | `auto` (승인 없이 끝까지) |
| `title` | 내 컴퓨터의 개발 서버일 때 (필수) | 그 페이지의 `<title>`. 다른 앱을 녹화하는 실수를 막아요 | 검사 안 함 |
| `target` | 내 컴퓨터의 개발 서버일 때 | `local` (서버를 먼저 띄워 둬요) | `deployed` |
| `allow_writes` | 저장·업로드 장면까지 찍어야 할 때 | `true` | `false` (저장 요청을 막아요) |
| `allow_post` | 읽기에 POST를 쓰는 사이트라 목록·본문이 비어 찍힐 때 | 통과시킬 주소 정규식 목록 | 없음 (Firestore 읽기·Algolia 검색은 기본 통과) |
| `asset_count` | 에셋 수를 바꿀 때 | `[5, 7]` (최소, 최대) | `[5, 10]` |
| `max_video_seconds` | 영상 최대 길이를 바꿀 때 | `15` | `20` |

### 예: 내 컴퓨터의 개발 서버

```yaml
projects:
  my-app:
    url: http://localhost:4400
    title: 내 앱                   # 브라우저 탭 제목 그대로
    target: local
```

서버를 먼저 띄운 뒤 시작해요. 같은 포트에 다른 앱이 떠 있으면 `title`이 달라 녹화 전에 멈춰요.

### 예: 저장 장면까지 녹화

```yaml
projects:
  my-site:
    url: https://example.com
    allow_writes: true
```

기본값(`false`)에서는 글 등록·업로드 같은 저장 요청과 방문 통계 요청을 막고 녹화해요. `true`로 바꾸면 막지 않고, 어떤 요청이 몇 번 나갔는지 녹화 원본 화면에 보여 줘요.

## rules.yaml

모든 프로젝트에 공통인 숫자예요. 고친 뒤에는 `npm test`를 다시 돌려요.

| 항목 | 뜻 | 기본값 |
|---|---|---|
| `assets.canvas` | 게시물 크기 | 1080×1440 (3:4) |
| `assets.count` | 에셋 수 | 5~10개 |
| `assets.layouts` | 화면 1·2·3개 배치의 크기와 위치 | 648×1152 · 432×768 · 324×576 |
| `record.viewport`, `record.scale` | 녹화 화면 크기와 배율 | 360×640, 3배 (바꾸지 않아요) |
| `record.read_post` | 저장 요청을 막을 때도 통과시키는 읽기 전용 POST | Firestore 읽기, Algolia 검색 |
| `export.video.max_seconds` | 영상 최대 길이 | 20초 |
| `style.default` | 배경색·테두리 기본값 | 보라 `#B987FF`, 테두리 2px |
| `retry` | 거절·검사 실패를 몇 번까지 다시 할지 | 5 · 5 · 2 |
| `review.port` | 시작 화면·편집 화면 포트 | 4455 (쓰이고 있으면 다음 빈 포트) |

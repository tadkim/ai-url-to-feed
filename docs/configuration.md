# 설정

[← README](../README.md)

> **이 문서는**
> - 사이트별 배경색·게시물 수·진행 방식을 바꾸거나, 저장 장면까지 찍어야 하는 사람을 위한 문서예요
> - 사이트별 설정은 `projects.yaml`이고, 명령줄 옵션(`--bg`, `--count`, `--edit`)이 그대로 여기에 적혀요
> - 모든 사이트에 공통인 규격은 `rules.yaml`이에요. 보통 바꿀 일이 없어요
> - `projects.yaml`은 git에 올라가지 않아요

## projects.yaml (사이트별)

처음 명령을 실행하면 자동으로 만들어져요. 주소 한 줄이면 돼요.

```yaml
projects:
  stuckyi:                       # 프로젝트 이름 (주소로 정해져요)
    url: https://stuckyi.studio
```

필요할 때만 더 적어요.

| 항목 | 명령줄 옵션 | 값 | 없으면 |
|---|---|---|---|
| `bg` | `--bg=#B987FF` | `"#B987FF"`. AI가 이 색을 쓰고 자동 검사가 확인해요 | AI가 사이트와 잘 구분되는 색을 골라요 |
| `asset_count` | `--count=6` · `--count=5-8` | `[6, 6]` · `[5, 8]` | 5~10개 |
| `mode` | `--edit` · `--auto` | `edit`: 다 만든 뒤 [편집 화면](editor.md)(작업 중)에서 다듬고 승인 | 승인 없이 끝까지 |
| `allow_writes` | — | `true`: 저장·업로드 장면까지 찍어요 | 저장 요청을 막고 찍어요 |
| `allow_post` | — | 데이터를 읽을 때도 POST를 쓰는 사이트에서 통과시킬 주소 정규식 목록 | Firestore 읽기·Algolia 검색만 통과 |

명령줄 옵션(`--bg`, `--count`)은 같은 주소로 바꿔 다시 실행하면 그 설정으로 다시 만들어요. `allow_writes`·`allow_post`는 녹화 전에 적어 둬야 해요 (이미 만든 녹화본에는 반영되지 않아요).

## rules.yaml (공통)

| 항목 | 기본값 |
|---|---|
| `assets.canvas` 게시물 크기 | 1080×1440 (3:4) |
| `assets.count` 게시물 수 | 5~10개 |
| `export.video.max_seconds` 영상 최대 길이 | 20초 |
| `record.viewport`, `record.scale` 녹화 화면 | 360×640, 3배 |

고친 뒤에는 `npm test`로 하네스 자체 검사를 다시 돌려요.

# Recall · AI 녹음 앱

회의·발표 현장을 녹음해 **타임라인**과 **요약**으로 자동 정리해 주는 모바일 우선 AI 녹음 웹앱(PWA)입니다. 서버 없이 폰 브라우저에서 바로 동작하며, 홈 화면에 설치해 네이티브 앱처럼 쓸 수 있습니다.

## 주요 기능

- 🎙️ **실시간 녹음 + 전사** — 오디오를 녹음하면서 음성을 실시간으로 텍스트화 (Web Speech API)
- 🕒 **타임라인 정리** — 대화를 시간 구간별로 나누고 각 구간의 주제·요약을 자동 추출
- 📝 **AI 요약** — 한눈에 보기 · 핵심 요점 · 액션 아이템을 자동 생성
- 🌐 **장소 기반 언어 자동 전환** — 위치(GPS)·시간대·기기 언어로 인식 언어를 추천하고, 잘못 인식했을 땐 **다른 언어로 다시 정리** 가능
- ♾️ **녹음 개수 무제한** — 저장 개수 제한 없음
- 🗑️ **200시간 자동 회전** — 총 저장 시간이 한도(기본 200시간)를 넘으면 **가장 오래된 녹음부터 자동 삭제** (한도는 설정에서 변경 가능)
- 📴 **오프라인 지원** — 모든 데이터는 기기 내 IndexedDB에 저장, 서비스워커로 오프라인 실행

## 실행 방법

브라우저 마이크·음성인식은 보안 컨텍스트(HTTPS 또는 `localhost`)에서만 동작합니다.

```bash
# 저장소 루트에서 정적 서버 실행 (아무 방법이나 사용)
python3 -m http.server 8080
# 또는
npx serve .
```

브라우저에서 `http://localhost:8080` 접속.
폰에서 테스트하려면 HTTPS 배포(예: GitHub Pages, Netlify, Vercel)가 필요합니다 — 정적 파일 그대로 올리면 됩니다.

## 배포 (폰에서 쓰기)

마이크·음성인식은 HTTPS에서만 동작하므로, 폰에서 쓰려면 정적 호스팅에 올려야 합니다. 저장소 전체가 정적 사이트(루트에 `index.html`)라 아래 셋 중 아무거나 그대로 됩니다.

### 방법 A — GitHub Pages (설정 포함됨)

`.github/workflows/deploy-pages.yml` 워크플로우가 포함되어 있습니다.

1. 저장소 **Settings → Pages → Build and deployment → Source = "GitHub Actions"** 선택
2. `main` 또는 `claude/recording-ai-app-izqo84` 브랜치에 푸시하면 자동 배포 (Actions 탭에서 진행 상황 확인)
3. 배포 URL: `https://<사용자명>.github.io/<저장소명>/`

### 방법 B — Netlify

`netlify.toml` 포함. 대시보드에서 저장소 연결만 하면 됩니다(빌드 명령 없음, publish = 루트). 또는 CLI: `netlify deploy --prod`

### 방법 C — Vercel

`vercel.json` 포함. `vercel` 대시보드에서 저장소 import 하거나 CLI: `vercel --prod` (프레임워크 없음/정적).

### 폰에 설치 (PWA)

1. 모바일 브라우저(Chrome/Safari)로 배포 URL 접속
2. 공유 메뉴 → **홈 화면에 추가**
3. 홈 아이콘으로 실행하면 전체화면 앱으로 동작

## 브라우저 지원

| 기능 | 지원 |
|------|------|
| 오디오 녹음 (MediaRecorder) | Chrome, Edge, Firefox, Safari |
| 실시간 전사 (SpeechRecognition) | Chrome / Edge / Android Chrome / iOS Safari |

전사를 지원하지 않는 브라우저에서도 **오디오는 정상 저장**됩니다. (요약·타임라인은 전사 텍스트가 있어야 생성됩니다.)

## AI 요약 서버 연동 (선택)

기본값은 **온디바이스(오프라인) 요약**입니다. 설정에서 요약 서버 엔드포인트(+선택적 접근 토큰)를 지정하면 **자동으로 LLM 기반 요약으로 전환**되고, 서버 호출이 실패하면 오프라인 요약으로 폴백합니다.

API 계약:

- 요청: `POST {endpoint}` — `{ "language": "ko-KR", "transcript": [{ "t": 0, "text": "..." }] }`
  - 접근 토큰을 설정하면 `Authorization: Bearer <token>` 헤더가 함께 전송됩니다.
- 응답(JSON):
  ```json
  {
    "overview": "회의 개요...",
    "keyPoints": ["요점1", "요점2"],
    "actionItems": [{ "t": 120, "text": "다음 주까지 보고서 작성" }],
    "topics": [{ "t": 0, "topic": "예산", "recap": "..." }]
  }
  ```

> 앱은 Anthropic API 키를 저장하지 않습니다. 키는 아래 서버 함수의 환경변수로만 보관됩니다.

## Supabase Edge Function (Anthropic 요약)

`supabase/functions/summarize/` 에 위 API 계약을 만족하는 **Anthropic 기반 서버리스 요약 함수**가 포함되어 있습니다. Claude로 개요·핵심 요점·액션 아이템·타임라인을 생성합니다.

### 배포

```bash
# 1) Supabase CLI 설치 후 프로젝트 연결
supabase link --project-ref <your-project-ref>

# 2) 시크릿 설정 (앱에는 절대 넣지 않음)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
# 선택: 공개 남용을 막는 공유 토큰 (앱 설정의 '접근 토큰'과 동일하게)
supabase secrets set SUMMARIZE_SHARED_SECRET=$(openssl rand -hex 24)
# 선택: 모델/CORS 오리진
supabase secrets set SUMMARY_MODEL=claude-opus-5
supabase secrets set ALLOWED_ORIGIN=https://<사용자명>.github.io

# 3) 배포
supabase functions deploy summarize
```

배포 후 엔드포인트: `https://<project-ref>.functions.supabase.co/summarize`
이 URL을 앱 **설정 → AI 요약 서버**에 넣고, `SUMMARIZE_SHARED_SECRET`을 설정했다면 **접근 토큰**에 같은 값을 넣으세요.

### 환경변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API 키 |
| `SUMMARY_MODEL` | | 기본 `claude-opus-5`. 비용을 낮추려면 `claude-sonnet-5` 또는 `claude-haiku-4-5` |
| `SUMMARIZE_SHARED_SECRET` | | 설정 시 `Authorization: Bearer <값>` 필요 (공개 남용 방지 권장) |
| `ALLOWED_ORIGIN` | | CORS 허용 오리진. 기본 `*` (배포 도메인으로 좁히는 것을 권장) |

로컬 테스트: `supabase functions serve summarize` → `http://localhost:54321/functions/v1/summarize`

> 다른 플랫폼(Vercel/Cloudflare Functions 등)에서도 같은 요청/응답 계약만 지키면 그대로 연동됩니다. `supabase/functions/summarize/index.ts`가 참고 구현입니다.

## 프로젝트 구조

```
index.html                 앱 셸 (모바일 UI)
css/styles.css             다크 테마, 모바일 우선 스타일
js/app.js                  화면 전환·녹음 플로우·이벤트 배선
js/db.js                   IndexedDB 저장 + 200h 회전 삭제(enforceCap)
js/recorder.js             MediaRecorder + 파형 시각화
js/transcriber.js          Web Speech API 실시간 전사(타임스탬프)
js/summarizer.js           오프라인 요약/타임라인 + 요약 서버 연동
js/i18n.js                 언어 목록 + 위치/시간대→언어 추천
manifest.webmanifest       PWA 매니페스트
sw.js                      오프라인 캐시 서비스워커
icons/                     앱 아이콘
supabase/
  config.toml              Supabase 프로젝트 설정 (summarize: verify_jwt=false)
  functions/summarize/     Anthropic 기반 요약 Edge Function (Deno)
.github/workflows/
  deploy-pages.yml         GitHub Pages 자동 배포
netlify.toml               Netlify 정적 배포 설정
vercel.json                Vercel 정적 배포 설정
```

## 데이터·프라이버시

- 오디오와 전사·요약은 모두 **기기 로컬(IndexedDB)** 에만 저장됩니다.
- 위치 기반 언어 추천을 사용할 때만 좌표가 역지오코딩 API로 전송되며, 그 외 녹음 내용은 외부로 전송되지 않습니다(요약 서버를 직접 설정한 경우 제외).

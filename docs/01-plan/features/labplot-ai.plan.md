# LabPlot AI — Plan (Rebalanced MVP)

> **Summary**: 연구자가 데이터를 업로드하면 규칙 + AI가 적절한 그래프를 추천하고, ggplot2로 논문 수준 Figure를 만들며, AI가 Figure의 출판 품질을 검토·개선하고, 출판용 이미지 + 재현 가능한 R 코드를 제공하는 연구실용 시각화 코파일럿.
>
> **Project**: LabPlot AI
> **Version**: 2.0 (Rebalanced — restores AI copilot core, trims speculative breadth)
> **Author**: Jaeyong Ryu
> **Date**: 2026-06-13
> **Status**: Draft
> **Reference codebase**: `../al_platform` (FastAPI + Next.js + R/ggplot2 + Celery, 검증됨 → 인증·프론트·R 파이프라인·배포 이식)

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | 연구자는 R/ggplot2 학습 없이 논문용 Figure를 만들고 싶고, 상용 도구는 재현 코드가 없으며, "이 그림이 출판에 적합한가"를 판단할 도구가 없다. |
| **Solution** | 업로드 → (규칙+AI) 그래프 추천 → 컬럼 매핑·스타일 → ggplot2 렌더 → **AI Figure Review·Improve** → PNG/SVG/TIFF/PDF + 재현 R 코드 export. |
| **Product Direction** | 단순 차트 도구가 아니라 **"AI-Powered Publication Figure Copilot"**. 단, AI는 *시각화 품질*을 돕고 통계 검정·생물학적 결론은 내리지 않는다. |
| **Core Value** | "R을 몰라도 ggplot2 기반의 출판급 Figure와 재현 가능한 R 코드를 빠르게 얻고, AI가 출판 품질을 점검해 준다." |

### 이번 리밸런싱 (v1.2 → v2.0)

직전 v1.1/1.2(Codex)는 MVP를 *일반 차트 도구*로 과도하게 축소해 제품의 정체성(AI 코파일럿)과 생물·오믹스 성격을 제거했고, 앞서 사용자가 확정한 결정(Claude + Vision Review)과도 어긋났다. v2.0은 핵심을 복원하되 과한 폭은 그대로 v1.1+로 미룬다.

| 항목 | v1.2 (Codex) | v2.0 (복원/유지) |
|------|--------------|------------------|
| AI 그래프 추천 | 규칙만 | **규칙 + AI(Claude) 추천 복원** (근거·필요변수·예시). 규칙은 즉시 baseline |
| AI Figure Review | 제외 | **복원** — Vision 기반 Publication Score + 항목별 시각품질 피드백 |
| AI Improve + Apply | 제외 | **복원** — 개선 제안 → One-click Apply(검증된 param patch) |
| 생물·오믹스 그래프(Volcano/PCA/KM) | 제외 | **복원** — MVP 그래프에 포함(이미 계산된 컬럼/표준 입력 기준) |
| 스타일 프리셋 | 3종 | **5종으로 절충** (9 저널 → 핵심 5) |
| Conversational chat editing | 제외 | **유지 제외** → v1.1 |
| Legend Generator | 제외 | **유지 제외** → v1.1 |
| Table Generator / DOCX | 제외 | **유지 제외** → v1.1 |
| Functional/Network/Composition/오믹스 풀세트 | 제외 | **유지 제외** → 장기 |
| Celery/Redis | sync로 축소 | al_platform에서 **재사용**(렌더·AI 비동기). 단순 배포 시 sync 폴백 허용 |

---

## 1. Product Principles

1. **Visualization-first copilot** — 그래프 생성·export가 1순위. 그 위에 AI가 *시각화 품질*을 보조한다.
2. **AI assists visualization, not analysis** — AI는 (a) 데이터 형태에 맞는 차트 추천, (b) Figure의 출판 품질(폰트·범례·색·plot 선택 적절성·통계 *표현* 방식·저널 적합성) 검토, (c) 시각적 개선 제안을 한다. **통계 검정 실행, 생물학적 해석, 결론 도출은 하지 않는다.**
3. **User-controlled** — 컬럼 타입은 가볍게 추정만 하고 최종 매핑은 사용자가 결정. AI 추천/개선은 제안일 뿐 사용자가 Apply 여부를 고른다.
4. **Simple defaults** — 기본값만으로 보기 좋은 그래프. 핵심 옵션만 노출, 세부는 숨김.
5. **Reproducible output** — 모든 Figure 버전은 입력·매핑·스타일·R 코드를 저장. export된 R 코드는 로컬 R에서 그대로 재실행 가능.
6. **Safe rendering** — AI/사용자는 자유 R 코드를 실행하지 않는다. 검증된 plot 템플릿에 **스키마 검증된 파라미터(JSON patch)**만 주입해 결정론적으로 렌더한다.

---

## 2. MVP User Flow

```text
로그인
  ↓
데이터 업로드 (CSV/TSV/XLSX)
  ↓
미리보기 + 컬럼 타입 확인
  ↓
추천 차트(규칙 즉시 + AI 근거/예시) 또는 전체 차트 목록에서 선택
  ↓
필수 컬럼 매핑(x, y…) + 선택 매핑(color/group)
  ↓
스타일 프리셋 선택
  ↓
그래프 생성 (ggplot2 렌더 → 버전 저장)
  ↓
(선택) AI Figure Review → Publication Score + 개선 제안 → One-click Apply → 새 버전
  ↓
PNG/SVG/TIFF(300dpi)/PDF + R Script 다운로드
```

### UI 방향 (Codex 안 유지 + AI 패널 추가)

- 첫 화면은 대시보드가 아니라 최근 데이터셋 + 새 업로드 중심.
- 데이터셋 상세: `Preview` · `Visualize` · `Figures` 탭.
- `Visualize` 상단에 데이터 형태별 추천 차트 카드 2-4개(규칙 즉시 표시, AI 근거가 오면 카드에 보강).
- 차트 빌더는 한 화면: 왼쪽=차트타입·컬럼매핑·스타일, 오른쪽=미리보기·export.
- Figure 상세에 **AI 패널**(접이식): `Review`(점수+항목별 피드백), `Improve`(제안 목록 + Apply 버튼). 기본은 접혀 있어 시각화 흐름을 방해하지 않음.
- R 에러 원문은 그대로 노출하지 않고 사용자가 고칠 수 있는 메시지로 변환.

---

## 3. Scope

### 3.1 In Scope — MVP (v2.0)

**그래프 9종** (spec MVP 7종 + 범용 Bar/Line)

| Plot type | 용도 | 필수 매핑 | 구현(CRAN) |
|-----------|------|-----------|-----------|
| Box plot | 그룹별 분포 비교 | x=group, y=numeric | ggplot2 |
| Violin plot | 분포 형태 | x=group, y=numeric | ggplot2 |
| Scatter plot | 두 numeric 관계 | x=numeric, y=numeric | ggplot2 (+회귀선 옵션) |
| Bar plot | 그룹별 값/요약 | x=category, y=count/mean | ggplot2 |
| Line plot | time-course/순서형 | x=time/order, y=numeric | ggplot2 |
| Heatmap | matrix 값 색표현 | matrix/wide numeric | pheatmap (clustering 옵션) |
| Volcano plot | DEG 시각화 | log2FC, pvalue/padj 컬럼 | ggplot2 + ggrepel |
| PCA plot | 샘플 군집 | matrix → prcomp, 또는 PC1/PC2 컬럼 | stats::prcomp + ggplot2 |
| Kaplan-Meier | 생존 곡선 | time, status, group | survival + survminer |

> 9종 모두 **CRAN 패키지만으로 구현 가능** → MVP에서 Bioconductor 의존성 없음. Volcano/PCA는 "이미 계산된 입력"(흔한 오믹스 결과 테이블)을 기준으로 하고, 매트릭스로부터의 PCA 계산은 기본 제공.

**기능**
- [ ] 회원가입 / 로그인 / 토큰 갱신 / 로그아웃 + 사용자별 데이터·Figure 격리
- [ ] CSV/TSV/XLSX 업로드, 미리보기(첫 N행·행열수·컬럼타입)
- [ ] 컬럼 타입 추정: numeric / category / date·time / text **+ 생물 시그니처**(log2FC, pvalue·padj, survival(time+status), gene·expression matrix)
- [ ] **규칙 기반 차트 추천**(즉시) — deterministic, LLM 불필요
- [ ] **AI 그래프 추천**(Claude) — 추천도·근거·필요변수·논문 사용 예시로 규칙 추천을 보강
- [ ] 빠른 시작 템플릿: 추천 카드 클릭 시 plot type + 기본 매핑 자동 채움
- [ ] 차트 빌더(plot type, 필수 매핑, 핵심 옵션)
- [ ] 스타일 프리셋 **5종**: Nature, Science/Cell, Clinical(NEJM/Lancet), Minimal, Colorblind-safe
- [ ] ggplot2 렌더링 + Figure 버전 저장(렌더/Apply마다 새 버전)
- [ ] **AI Figure Review** — 렌더 PNG를 Claude Vision으로 평가 → Publication Score(0-100) + 시각품질/통계표현/저널적합성 피드백
- [ ] **AI Figure Improve + One-click Apply** — 개선 제안(현재→추천 + param patch) → Apply 시 검증 후 재렌더(새 버전)
- [ ] Export: PNG · SVG · **TIFF(300dpi)** · PDF · **R Script**
- [ ] Figure 크기: single column · wide · custom

### 3.2 Deferred — v1.1+ (Codex 트림 유지)

- Conversational(채팅) 기반 그래프 편집
- Figure Legend Generator
- Table Generator (Descriptive/DEG/Enrichment/Clinical/Survival) + DOCX/XLSX/PDF export
- 추가 그래프: Dot/Beeswarm, Raincloud, Histogram, Density, Ridge, Spaghetti, MA plot, Correlation, Dose-response(IC50/EC50), Grouped bar
- Bioconductor 그래프: ComplexHeatmap, EnhancedVolcano, UMAP/t-SNE
- TIFF 600dpi, EPS export
- R Markdown / Quarto / SessionInfo 다운로드
- Figure Before/After diff UI, duplicate, 프로젝트/폴더
- Figure 버전 자동 비교 고도화

### 3.3 Out of Scope — 장기 (spec §11)

Functional analysis(GO/KEGG/GSEA/Cnetplot/UpSet) · Network(pathway/gene/enrichment) · Composition(Stacked/Sankey/Alluvial) · scRNA-seq/Seurat · Proteomics/Metabolomics 파이프라인 · Multi-panel builder · Reviewer Simulation · Lab Template System · 공동 편집/댓글/승인 · S3 스토리지 · 멀티기관 SaaS · 소셜 로그인 · 자유 R 코드 실행

---

## 4. Architecture

### 4.1 확정 방향 (앞선 결정 유지)

| 영역 | 선택 | 이유 |
|------|------|------|
| Frontend | Next.js 16 + React 19 + TS + Tailwind4 + shadcn | `al_platform` 패턴 그대로 이식 |
| Backend | FastAPI + SQLAlchemy 2.0 + Alembic + Pydantic v2 (pixi) | 인증·업로드·R 호출·Claude 연동 |
| Database | PostgreSQL 16 | users/datasets/figures/AI 결과 |
| Async | **Celery + Redis** (al_platform 재사용) | 렌더·Claude 호출 비동기 → UI 응답성. *단순 배포 시 sync+timeout 폴백 허용* |
| R Engine | ggplot2 templates via `Rscript` (pixi r-viz) | 재현성 + R 코드 export, **MVP는 CRAN only** |
| AI/LLM | **Claude API (anthropic SDK)** — 텍스트 추론 + **Vision** | 추천·Review(이미지)·Improve. 필수 환경변수 |
| Storage | 로컬 디스크 (`backend/static/`) | 단일 서버 단순. S3는 장기 |
| Deploy | Docker Compose + Caddy **`:7070`** (HTTP) on EC2 | 내부망 배포 쉬움, `/api/*` 동일 origin → CORS 불필요 |

### 4.2 시스템 구성

```text
Browser ── http://<IP>:7070 ──► Caddy(:7070)
                                 ├─ /         → frontend (Next.js :3000)
                                 ├─ /api/*    → backend (FastAPI :8000)
                                 └─ /static/* → backend (렌더 SVG/PNG/TIFF/PDF)
FastAPI
  ├─ PostgreSQL
  ├─ Claude API (추천 / Review[Vision] / Improve)
  ├─ Celery → Redis → Worker → Rscript(ggplot2) → static/figures/{figure_id}/{version}/
  └─ local file storage
```

> AI는 **검증된 템플릿 + 파라미터**만 다룬다(자유 R 코드 실행 없음). Claude 응답은 structured output(tool use)로 JSON 강제 → 스키마 검증 후 적용.

---

## 5. Data Model

```text
users           id · email · hashed_password · display_name · is_active · created_at · updated_at
datasets        id · owner_id · name · original_filename · file_path · format
                n_rows · n_cols · column_profile_json · preview_json · created_at
figures         id · owner_id · dataset_id · name · plot_type · style_preset
                status(draft|rendering|ready|failed) · current_version_id · created_at · updated_at
figure_versions id · figure_id · version_number · params_json · r_code
                png_path · svg_path · tiff_path · pdf_path · render_log · change_note · created_at
recommendations id · dataset_id · plot_type · score · rationale · required_vars_json
                example_usage · source(rule|claude) · created_at
reviews         id · figure_version_id · publication_score · visual_quality_json
                statistical_json · suitability_json · raw_response · model · created_at
improvements    id · figure_version_id · suggestion_type · current_state · recommended
                param_patch_json · applied(bool) · created_at
```

### MVP 제외 테이블 (v1.1+)
`chat_messages`, `legends`, `tables` — 해당 기능 도입 시 독립 테이블로 추가.

---

## 6. API

| Method | Path | 설명 | Auth |
|--------|------|------|:----:|
| POST | `/api/auth/register` · `/login` · `/refresh` | 인증(이식) | No/Refresh |
| GET | `/api/auth/me` | 현재 사용자 | Access |
| POST | `/api/datasets` | 업로드 + 컬럼 프로파일 | Access |
| GET | `/api/datasets` · `/api/datasets/{id}` | 목록 · 상세(preview/profile) | Access |
| DELETE | `/api/datasets/{id}` | 삭제 | Access |
| GET | `/api/datasets/{id}/chart-suggestions` | **규칙 기반** 추천(즉시) | Access |
| POST | `/api/datasets/{id}/recommend` | **AI 추천**(Claude, 근거·예시) | Access |
| GET | `/api/plot-types` · `/api/styles` | 차트 타입·매핑 스키마 / 프리셋 | Access |
| POST | `/api/figures` | Figure 생성 + 렌더(버전1) | Access |
| GET | `/api/figures` · `/api/figures/{id}` | 목록 · 상세(버전 포함) | Access |
| GET | `/api/figures/{id}/status` | 렌더 상태 폴링 | Access |
| POST | `/api/figures/{id}/rerender` | 파라미터 수정 후 재렌더(새 버전) | Access |
| POST | `/api/figures/{id}/versions/{vid}/review` | **AI Review**(Vision) | Access |
| POST | `/api/figures/{id}/versions/{vid}/improve` | **AI 개선 제안** | Access |
| POST | `/api/figures/{id}/improvements/{iid}/apply` | 제안 적용 → 새 버전 | Access |
| GET | `/api/figures/{id}/versions/{vid}/export?format=png\|svg\|tiff\|pdf\|r` | 다운로드 | Access |
| GET | `/api/health` | 헬스체크 | No |

---

## 7. R Rendering Design

### 7.1 원칙
- 백엔드가 `plot_type` · `mapping` · `style` · `size`를 JSON 스키마로 검증 → 검증된 params만 R 템플릿에 전달.
- R 템플릿은 자유 코드가 아니라 plot type별 고정 스크립트.
- 렌더에 사용한 최종 R 코드를 `figure_versions.r_code`에 저장 → R Script export = 저장 코드 그대로.
- al_platform `r_plots.py` 패턴 차용: Rscript 경로 탐색, subprocess + timeout, stdout/stderr 로깅, 실패 시 직전 버전 유지 + 친화적 오류 메시지.

### 7.2 R 패키지 (MVP, CRAN only)
```text
readr · readxl · ggplot2 · dplyr · tidyr · scales · viridis · svglite · ragg
ggrepel · pheatmap · survival · survminer        # Volcano/Heatmap/KM 용
```
> Bioconductor(ComplexHeatmap, EnhancedVolcano, clusterProfiler 등)는 v1.1 도입(빌드 시간·실패 리스크 분리).

### 7.3 템플릿 구조
```text
backend/app/r_engine/
  renderer.py · schemas.py
  templates/
    boxplot.R · violin.R · scatter.R · bar.R · line.R
    heatmap.R · volcano.R · pca.R · kaplan_meier.R
    theme_labplot.R   # 5개 프리셋 theme + palette
```

### 7.4 차트 추천 (규칙 + AI 2단계)
**1단계 — 규칙(즉시, LLM 불필요):**

| 데이터 형태 | 추천 |
|-------------|------|
| category 1 + numeric 1+ | Box, Violin, Bar |
| numeric 2+ | Scatter |
| time/order + numeric | Line |
| numeric matrix | Heatmap, PCA |
| log2FC + pvalue/padj 컬럼 | Volcano |
| time + status (+group) | Kaplan-Meier |

**2단계 — AI(Claude):** 컬럼 프로파일을 보내 추천도 점수 + 근거 + 필요 변수 + *논문 사용 예시*를 보강. 규칙 추천이 즉시 뜨고, AI 결과가 도착하면 카드에 근거/예시를 채운다(점진적 향상). AI는 통계 유의성·결론을 제공하지 않는다.

---

## 8. AI Integration (Claude)

| 기능 | 입력 | 출력(structured JSON) | MVP |
|------|------|------------------------|:---:|
| 그래프 추천 | column_profile (+생물 시그니처) | `[{plot_type, score, rationale, required_vars, example_usage}]` | ✅ |
| Figure Review | 렌더 PNG(Vision) + plot_type + 매핑 컨텍스트 | `{publication_score, visual_quality{font,legend,axis,color,readability}, statistical{plot_choice, error_bars, individual_points}, suitability{clarity, journal_fit, reviewer_concern}}` | ✅ |
| Figure Improve | 현재 params + 직전 review | `[{suggestion_type, current, recommended, param_patch}]` | ✅ |

**안전 적용**: Improve의 `param_patch`는 허용 파라미터 스키마로 검증 후 템플릿에 주입 → 결정론적 재렌더. 검증 실패/렌더 실패 시 직전 버전 유지. Claude 호출은 tool use로 JSON 강제, 동일 입력 결과 캐싱, 토큰 사용량 로깅.

**Review 평가 범위(시각화 한정)**: 폰트 크기·범례·축 제목·색·가독성 / 적절한 plot 선택·오차막대(SD vs SEM) 표기·개별점 표시 여부 / Figure clarity·저널 적합성·리뷰어 우려. → 데이터 통계 검정이나 생물학적 결론은 평가하지 않는다.

---

## 9. Frontend Structure

```text
src/app/
  layout.tsx · providers.tsx(QueryClient+AuthProvider)
  login/ · register/                      ← 이식
  page.tsx (최근 데이터셋 + 업로드)
  datasets/  page.tsx · new/page.tsx · [id]/page.tsx (Preview·Visualize·Figures 탭)
  figures/   page.tsx · [id]/page.tsx (빌더 + AI 패널)
src/lib/api.ts · hooks/useAuth.ts · components/auth/AuthProvider.tsx   ← 이식
src/components/
  datasets/ DatasetUploader · DataPreview · ColumnProfile
  figures/  ChartBuilder · ChartSuggestionCards · PlotTypePicker · ColumnMappingForm
            StylePicker · FigurePreview · ExportMenu
            ReviewPanel · ImprovePanel        # 복원된 AI 패널
```

**Chart Builder 노출 옵션**: plot type, 추천 카드, x/y/group·color 매핑, title·축 라벨, style preset, figure size, plot별 핵심 옵션 1-2개(show points/legend 등).
**숨김(또는 v1.1)**: 저널 테마 세부값, p-value/stat annotation, 자동 통계검정, 채팅 편집, 복잡한 facet/grid.

---

## 10. Implementation Roadmap

| Phase | 목표 | 핵심 산출물 |
|:-----:|------|------------|
| **P0 Scaffold** | 골격 + 배포 | FastAPI·Next.js·PostgreSQL·(Redis)·Caddy `:7070`, `/api/health` |
| **P1 Auth & Data** | 로그인 + 업로드 | auth 이식, dataset CRUD, CSV/TSV/XLSX parser, **profiler(생물 시그니처)**, preview UI |
| **P2 Chart Builder** | 쉬운 시각화 흐름 | **규칙 추천 카드**, plot type picker, mapping form, style picker(5종) |
| **P3 R Rendering** | 9종 렌더 + export | ggplot2 템플릿 9종, PNG/SVG/TIFF(300)/PDF, R script 저장, figure 버전 |
| **P4 AI Recommend** | AI 추천 복원 | `claude_client.recommend`, 추천 카드에 근거·예시 보강 |
| **P5 AI Review & Improve** | AI 코파일럿 복원 | Vision Review(Score), Improve + Apply(param patch), ReviewPanel/ImprovePanel |
| **P6 Polish & Deploy** | 품질 + 배포 | 빈 상태·친화적 오류·업로드 제한, EC2 `:7070` 프로덕션 compose, E2E 성공기준 |
| **v1.1** | 트림 항목 재도입 | 채팅 편집, Legend, Table+DOCX, 추가 그래프, Bioconductor, R Markdown/Quarto, 600dpi/EPS |

> P0-P3 = "데이터→Figure→Export" 사용 가능한 시각화 도구. P4-P5 = "AI 코파일럿" 차별화 복원. 시각화 코어를 먼저 띄우고 AI를 그 위에 얹는 순서.

---

## 11. Success Criteria (MVP)

- [ ] 업로드(CSV/TSV/XLSX) → 미리보기 + 컬럼 타입(생물 시그니처 포함) 확인.
- [ ] 규칙 추천 2-4개 즉시 표시 + AI 추천이 근거·예시로 보강.
- [ ] 9종 그래프 중 선택 → 매핑 → 5개 프리셋 중 선택 → 기본값만으로 읽기 쉬운 그래프 생성.
- [ ] **AI Review가 렌더 이미지를 실제로 보고(Vision) 0-100 점수 + 항목별 피드백 반환.**
- [ ] **Improve 제안 Apply → 검증된 param patch로 새 버전 재렌더.**
- [ ] PNG/SVG/TIFF(300dpi)/PDF/R Script 다운로드, R Script 실행 시 동일 그래프 재현.
- [ ] 타 사용자의 데이터셋/Figure 접근 → 404.
- [ ] `http://<EC2-IP>:7070` 접속만으로 전체 플로우 사용. (AI 호출 실패 시에도 시각화·export는 정상 동작 = graceful degradation)

---

## 12. Risks and Mitigation

| Risk | 영향 | Mitigation |
|------|------|-----------|
| AI/사용자 R 코드 임의 실행 | 높음 | 자유 코드 금지, **검증된 템플릿 + param patch**만. R 컨테이너 격리·timeout |
| 컬럼 타입 추정 오류 | 중간 | 추정은 제안일 뿐, 사용자가 타입·매핑 변경 가능 |
| Claude 비용/지연/환각 | 중간 | Celery 비동기 + 결과 캐싱, structured output+스키마 검증, 토큰 로깅, **AI 없이도 코어 동작** |
| 미발표 데이터 외부 전송 | 높음 | 전송을 메타/요약/렌더이미지로 최소화, 전송 항목 문서화 |
| KM 통계 표기(위험표·p값·censoring) | 중간 | survminer 표준 옵션, 통계 표기 정책을 P3 설계에서 확정 |
| 옵션 과다로 UI 복잡 | 중간 | 핵심 옵션만 노출, AI 패널 기본 접힘 |
| HTTP 평문(7070) 토큰 노출 | 중간 | 내부망/VPN 권장, 도메인 확보 시 HTTPS 전환 경로 설계 |
| 큰 파일 업로드 | 중간 | 업로드 제한, preview 일부 행, 렌더 행 수 안내 |

---

## 13. Environment Variables

| Variable | Purpose | 예시 |
|----------|---------|------|
| `DATABASE_URL` | Postgres | `postgresql://labplot:***@postgres:5432/labplot` |
| `REDIS_URL` / `CELERY_BROKER_URL` / `CELERY_RESULT_BACKEND` | 큐(재사용) | `redis://redis:6379/0..2` |
| `JWT_SECRET` / `JWT_ALGORITHM` | 인증 | `openssl rand -hex 64` / `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` / `REFRESH_TOKEN_EXPIRE_DAYS` | 토큰 만료 | `30` / `7` |
| `ANTHROPIC_API_KEY` | Claude (필수) | (필수) |
| `ANTHROPIC_MODEL` | 모델(Vision 지원) | 최신 Claude |
| `MAX_UPLOAD_SIZE_MB` | 업로드 한도 | `50` |
| `NEXT_PUBLIC_API_URL` | 프론트 API base | 빈 값(상대) 또는 `http://<IP>:7070` |
| `PORT_PUBLIC` | Caddy 공개 포트 | `7070` |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-06-13 | Initial platform plan. AI 추천/Review/Improve/Chat/Legend/Table, 분석 그래프, 9 프리셋 포함(포괄) | Jaeyong Ryu |
| 1.1 | 2026-06-13 | MVP를 단순 시각화 흐름으로 축소(AI/분석 제외, 6 그래프) | Codex |
| 1.2 | 2026-06-13 | 규칙 추천·빠른시작·TIFF300 복원 | Codex |
| **2.0** | 2026-06-13 | **리밸런싱**: AI 코파일럿 코어(규칙+AI 추천, Vision Review, Improve+Apply)와 생물·오믹스 그래프(Volcano/PCA/KM) 복원, 프리셋 5종 절충. 채팅 편집·Legend·Table/DOCX·오믹스 풀세트는 v1.1+로 트림 유지. Codex의 UX·안전(템플릿 param patch)·구조는 계승 | Jaeyong Ryu |

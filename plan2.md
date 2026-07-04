# Canvas·Figure 2차 개선 계획 (U7–U11) — grilling 확정본 (2026-07-03)

**✅ 배치 전체 완료 (2026-07-04). U7 `6a9227d` → U10 `ad1e5f0` → U8 `152f39c` → U9 `53d4f08` → U11 (커밋 대기).** 5개 마일스톤 전부 Sonnet 구현 → Fable 적대 리뷰 → 확정 결함 수정 체제로 배포. Fable 리뷰 누적 확정 결함 14+7+12+6+3=42건 수정 + 구현/검증 중 발견한 프로덕션 잠재 버그 다수 근절(선택-크롬 레이아웃시프트 순간이동, 텍스트툴 mousedown-blur, AppError 위치인자 500 등).

사용자 요청 5건 → 코드 조사(AI 파이프라인 포함) → grilling 5문 확정. 1차(U1–U6, docs/01-plan/canvas-ux-improvements-2026-07.md)와 동일 프로세스: 마일스톤마다 구현 → 적대적 리뷰 워크플로 → 확정 결함 반영 → qa-e2e 전체 → 브라우저 시각 확인 → 커밋 → CI 자동배포.

## 확정 결정 (grilling 2026-07-03)

| Q | 결정 |
|---|---|
| Q1 빈 공간 드래그 | **러버밴드 다중 선택**으로 변경 (Figma/일러 표준). 팬은 **Space+드래그**(신규) + 기존 스크롤 팬. 힌트 문구 갱신 |
| Q2 다중 선택 V1 범위 | 그룹 이동(스냅 포함) · Shift+클릭 추가/제거 · 그룹 삭제 · **정렬/분배 툴바**(좌중우/상중하/가로세로 분배) · 그룹 리사이즈(멀티노드 Transformer) · 키보드 너지(1mm, Shift=5mm). 복제/잠금/캔버스 간 복붙은 V2 |
| Q3 캔버스 오브젝트 | **텍스트·화살표·직선·사각형·타원 5종**. `canvas.annotations` JSONB(mm/pt). **export 동등성 타협 불가**. 좌측 미니 툴바(V/T/화살표/선/□/○) + 우측 사이드바 인스펙터 전환. 회전은 화살표/직선만 V1 |
| Q4 캔버스 부가기능 | **mm 눈금자+그리드 토글(+그리드 스냅) · PNG/TIFF export(DPI 300/600) · 캔버스 복제 · 선택 줌+100%/Fit 단축키** 4종. 간격 배지/저널 마진 가이드/템플릿은 V2 |
| Q5 AI·피겨 편의 | AI: **(a) 패치 스키마 자동 생성 (b) 적용/불가 투명화 칩 (c) 전후 이미지 자가 검증 루프(1회 재시도, 토글 기본 ON)**. 피겨: **(d) 버전 비교 슬라이더 (e) 옵션 검색창**. 5개 전부 |
| (미결) | "반영 안 됐던" 실제 요청 문구 예시 — 받으면 U10 (c)의 회귀 테스트 케이스로 고정 |

## 요청 → 마일스톤 매핑

| 요청 | 내용 | 마일스톤 |
|---|---|---|
| 1 | 드래그 다중 선택 (빈 공간 드래그가 팬이라 충돌 → Q1) | U7 |
| 2 | 리사이즈 시 주변 정렬선 | U7 (이동 스냅을 Transformer로 확장) |
| 3 | 좌우/상하 리사이즈 | U7 (8핸들 — 그릴 없이 엔지니어링 확정) |
| 4 | 일러/Prism식 텍스트·도형·패널 + 창의 검토 | U8(오브젝트) + U9(부가기능) |
| 5 | 피겨 편의 + AI 편집 품질 | U10(AI) + U11(피겨) |

**실행 순서(제안): U7 → U10 → U8 → U9 → U11.** 근거: U7=빠른 상호작용 승리이자 U8 오브젝트가 올라탈 선택 레일, U10=사용자가 명시한 고통(캔버스와 독립이라 앞당김), U8=최대 덩어리. U10·U11은 캔버스와 독립이라 순서 조정 자유.

---

## U7 — 멀티선택 + 리사이즈 정렬 ✅ DONE (commit 6a9227d, 2026-07-04 배포·37 e2e green)

**Sonnet 구현 → Fable 검증·수정 체제 첫 적용.** Sonnet이 스펙 전체 구현+e2e 작성(자가 tsc/eslint 게이트), e2e 에이전트가 시트 Rect listening 결함을 코드리딩으로 선발견. Fable 리뷰 14발견 → **14 전건 확정(기각 0, Konva 소스 손검증)** → Fable이 전량 수정: 마키 생명주기(창밖 릴리즈·buttons 가드·화면px 임계·좌클릭 한정), EPS-스킵 멤버 노드 재동기(오프캔버스 유령), commitPanelsBatch allSettled+부분실패 undo 보존+진짜 before 복원, patchPanel 외과적 롤백, 너지 flush(undo/정렬/드래그/변형 전), panels-update 404 영구 프루닝, 그룹 리사이즈 최소 플로어 스케일, 잠금 코너 스냅 스킵, shift+drag 멤버십 유지, Space a11y, 터치 첫탭, 선택 프루닝.

`frontend/src/components/canvases/CanvasEditor.tsx` 중심.

1. **러버밴드**: Stage `draggable` 제거 → 빈 공간 mousedown-드래그로 반투명 사각형, mouseup 시 교차 패널(+U8 이후 오브젝트) 선택. **Space 누름 동안** Stage draggable 복원+grab 커서(팬). 힌트: "Drag to select · Space+drag or scroll to pan".
2. **선택 모델**: `selectedId: string|null` → `selectedIds: Set<string>`. Transformer `nodes([...])` 멀티 바인딩. 단일 선택 시 기존 툴바/컬러·텍스트 에디터 그대로, 다중 시 정렬 툴바로 전환.
3. **그룹 이동**: 선택 패널 중 하나 dragmove → 나머지에 동일 델타(Konva Group 오프셋), 스냅은 드래그 중인 패널 기준. dragend에 일괄 PATCH + **히스토리 1엔트리**(canvasHistory에 multi-panel {before[],after[]} op 추가 — 스냅샷 배열 확장).
4. **정렬/분배 툴바**: 좌/중/우, 상/중/하, 가로/세로 균등 분배 — 순수 mm 계산 → 일괄 patchPanel + 히스토리 1엔트리.
5. **키보드 너지**: 화살표 1mm, Shift+화살표 5mm (단일/다중 공통, [0, canvas−panel] 클램프, 연타는 디바운스 후 1엔트리).
6. **리사이즈 정렬선(요청 2)**: `handleTransform`(진행 중) 훅에서 드래그 중인 앵커의 엣지를 이동 스냅과 동일한 타깃(캔버스 엣지/중앙+타 패널 엣지/중앙)에 스냅 + 파란 가이드라인 + Alt 우회. 기존 SNAP_PX=6 화면px 재사용.
7. **8핸들(요청 3)**: `enabledAnchors`에 middle-left/right/top/bottom 추가. 모서리=keepRatio(잠금 기본 ON 유지), 변=단축 리사이즈(재레이아웃 계약 그대로).

e2e: 러버밴드 선택 수(서버 무관 UI+정렬 후 좌표 서버 검증), 정렬 버튼 → x_mm 일치, 너지 → 1mm 이동. 리스크: Transformer 멀티노드와 개별 재렌더(transformend에 패널별 커밋), Space 키와 텍스트 입력 충돌(입력 포커스 가드 기존 패턴).

## U8 — 캔버스 텍스트·도형 오브젝트 (요청 4 본체) ✅ DONE (2026-07-04 배포·42 e2e green)

**Sonnet 구현 → Fable 검증·수정 체제 3회차.** Sonnet 2에이전트 병렬(백엔드: 마이그레이션 0020+`_sanitize_annotations` 25하네스+`_annotation_svg` 벡터 방출·라이브 DB 업/다운 검증 ∥ 프런트: 신규 4컴포넌트+CanvasEditor ~1000줄 통합, 계약 리딩으로 빈텍스트 400 선발견) + e2e 에이전트(2회-undo UX 결함 발견). 내 게이트에서 **fresh-text 로컬-낙관 모델** 재설계(단일 'add text' 엔트리→1회 undo)와 **프로덕션 차단급 버그** 수정: mousedown 기본 포커스 동작이 방금 autoFocus된 인라인 편집기를 즉시 blur→빈값 커밋으로 텍스트 툴 전멸(3단계 계측으로 포착, `e.evt.preventDefault()`). Fable 리뷰 **12발견 12확정(기각 0)** 전량 수정: ① XML무효 제어문자 스트립(NUL→jsonb 500·BEL→export 영구파괴 차단) ② `annotations_rev` 낙관적 동시성(mig 0021, 409 ANNOTATIONS_CONFLICT — 동시 편집자 무음 클로버 차단) ③ 텍스트 줄바꿈 parity(wrap=none+측정 anchor 에뮬레이션) ④ hex fullmatch ⑤ 중복 id 400 ⑥ z 동률 codepoint 정렬 통일 ⑦ 프룬 효과 주석 포함(혼합 선택 보존) ⑧ Escape 동기 discard(유령/커밋 삼킴 차단) ⑨ 부분 hex 캐시 오염 게이트 ⑩ 빈텍스트 삭제 히스토리 오염(undo 영구 wedge) 복원 ⑪ 컬러피커 debounce(히스토리 50캡 잠식 차단) ⑫ 리페치의 fresh 텍스트 소거 가드. 덤: 기존 AppError 위치인자 오용(OWNER_ONLY 403→500) 수정. 시각 검증: 에디터↔export 벡터 렌더 5타입 WYSIWYG 확인.

1. **모델**: `canvases.annotations` JSONB 컬럼 (마이그레이션 0020). 항목: `{id, type: text|arrow|line|rect|ellipse, x_mm, y_mm, w_mm, h_mm | points_mm, rotation_deg?, text?, font_pt, stroke_hex, stroke_pt, fill_hex?, z}`. **캔버스 소유(배치 계층) — FigureVersion 무관** (계약 §1 정합). PATCH `/api/canvases/{id}` annotations 필드(서버 shape-검증: 타입 화이트리스트·mm/pt 클램프·개수 상한).
2. **에디터**: 좌측 세로 미니 툴바(선택 V·텍스트 T·화살표·선·□·○, 단축키). 도구 선택 → 캔버스 클릭/드래그로 생성 → 즉시 인라인 편집(텍스트는 dblclick 재편집). 오브젝트도 패널과 같은 레일: 러버밴드/Shift 선택·이동·리사이즈·스냅(오브젝트 엣지도 스냅 타깃)·회전(화살표/선만)·undo(annotation-add/update/delete op).
3. **인스펙터**: 오브젝트 선택 시 우측 사이드바가 속성 패널로 전환 — 색·선굵기(pt)·글꼴 크기(pt)·채움(도형)·텍스트 정렬.
4. **Export 동등성(필수)**: `_compose_canvas_svg`가 annotations를 벡터 프리미티브(`<text>`(pt)·`<line>`·`<path marker>`·`<rect>`·`<ellipse>`)로 함께 방출 — 기존 A/B/C 라벨의 pt 방출 코드 재사용. PDF는 기존 rsvg 경로 그대로.
5. V2+: 펜/자유곡선, 그룹핑, 이미지 삽입, 도형 회전 전면 허용.

e2e: 텍스트 추가→PATCH 반영→export SVG에 `<text>` 존재+문자열 일치, undo로 소멸. 리스크: 폰트 매칭(에디터 Konva vs export SVG 렌더러 — 같은 패밀리 지정), 오브젝트 z와 패널 z 인터리브(단일 z 공간 권장).

## U9 — 캔버스 부가기능 4종 (요청 4 확장) ✅ DONE (2026-07-04 배포·45 e2e green)

**Sonnet 구현 → Fable 검증·수정 체제 4회차.** Sonnet 병렬(백엔드: png/tiff+dpi export — `ceil(mm/25.4×dpi)` 컨테이너 실측, TIFF LZW+DPI 메타, `/duplicate` 권한 미러링 ∥ 프런트: 눈금자·그리드 sceneFunc·스냅 타깃 3개소·`e.code` 줌 단축키·Export 6항목·Duplicate 2개소) + e2e(래스터 치수 정밀 검증·복제 딥카피·그리드 스냅 서버 진실 — **눈금자 canvas가 `.first()` 관례 파괴하는 전 스위트 회귀 선발견** → 눈금자를 Stage 뒤 DOM으로 이동해 8개 스펙 무수정 해결). Fable 리뷰 **6/6 확정**: ① 래스터 픽셀 예산 40M(500×500@600 TIFF가 워커 1.1GB 실측→OOM 차단, 400 RASTER_TOO_LARGE)+`MAX_IMAGE_PIXELS` ② PNG pHYs 스탬핑(rsvg는 미기록→72dpi 판독 문제) ③ 복제 캔버스의 접근불가 피겨 메타 누출 ACL fail-closed ④ 눈금자 22px 오프셋 ⑤ Space+팬 라이브 동기화 ⑥ 테마 stale. **+U5부터 잠재한 프로덕션 버그 근절**: 미선택 패널 원제스처 드래그 시 선택-크롬(툴바 행/사이드바) 마운트가 컨테이너 리사이즈→pxPerMm 재적합→Konva 오프셋 무효→수십 mm 순간이동 (Konva DD 내부 추적으로 확정; `pointerGestureActive`로 크롬 5개소 마운트를 제스처 종료까지 지연). PNG pHYs 300dpi 바이트 검증·시각 확인 완료.

1. **눈금자+그리드**: 캔버스 상/좌 mm 눈금자(줌 연동), 그리드 토글(5mm 기본, 10mm 보조선), **그리드 스냅 토글**(스냅 타깃에 그리드 라인 추가). Konva 별도 레이어, export 미포함.
2. **래스터 export**: Export 메뉴에 PNG·TIFF + DPI(300/600) — 백엔드: 컴포지트 SVG → `rsvg-convert --dpi-x/y`로 PNG, TIFF는 Pillow 변환(LZW). 스냅샷 기록은 기존과 동일.
3. **캔버스 복제**: `POST /api/canvases/{id}/duplicate` — 캔버스+패널(+annotations) 복사(이름 " (copy)"), 목록/에디터에 버튼.
4. **줌 단축키**: `1`=100%, `Shift+1`=Fit, `Shift+2`=선택으로 줌(선택 bbox→setView). 도움말 팝오버 갱신.

## U10 — AI 편집 품질 (요청 5의 핵심 고통) ✅ DONE (2026-07-04 배포·38 e2e green)

**Sonnet 구현 → Fable 검증·수정 체제 2회차.** Sonnet이 (a)(b)(c) 전체 구현(+e2e 2건, 자가 게이트): 스키마 60→95키 자동생성(`ai/options_schema.py` + 순환 import 차단용 `figures/option_metadata.py` 리프 모듈), unsupported[] 투명화, 전/후 PNG 자가검증 루프(재시도≤1, 토글 기본 ON). 라이브 Gemini로 전 루프 실증 후 Fable 리뷰(13 에이전트) **11발견 → 9확정(중복 2쌍=실질 7)·2기각** → Fable이 전량 수정: ① 제로패치 캐리어 행 apply 차단(백엔드 NOTHING_TO_APPLY 400 단건+배치 + 프런트 선택/버튼 제외) ② 제안-적용 경로 `retry:false`+선택 제안 recommended 텍스트로만 verify(미승인 AI 편집 원천 차단) ③ verify#1 verdict 구제(재시도 실패 시 폐기 않음) ④ original_request 422→클라 4000자 절단+서버 20k 백스톱 ⑤ `_bounded_image` 장변 2048px 다운스케일(Pillow, verify+improve 공용 — dpi1200 8400px 도 Claude 한계 회피) ⑥ apply 엔드포인트 ai_apply 60/h rate limit + `verification.skipped` 사유(쿼터 등, 중립 칩) ⑦ Suggest 흐름 unsupported 칩 표시+캐리어 행 사유 DB 영속. 추가: VERIFY 프롬프트에 표현가능-부분만 판정 규칙(불가요청만 남으면 satisfied=true → 헛재시도 렌더 낭비 차단, 라이브 검증 attempts=1 확인).

코드 진단: IMPROVE 파이프라인은 이미지+번호 마크+현재 R코드→최소 param_patch로 정교하나, (1) `_OPTIONS_PATCH_SCHEMA`가 **수동 관리라 커버리지 드리프트**(ai/client.py:77 계약 주석), (2) sanitize 드롭·타입별 미소비 옵션 시 **무성 실패**, (3) 결과 검증 루프 부재.

1. **(a) 스키마 자동 생성**: `_OPTIONS_PATCH_SCHEMA`를 figures의 `_UNIVERSAL_OPTION_KEYS` + 타입별 옵션 메타데이터(+ 값 enum/클램프)에서 빌드타임 생성으로 교체, `scale_editable_axes`류 죽은 옵션 제외 → 렌더러가 지원하면 모델도 표현 가능 보장. 스냅샷 테스트로 드리프트 감지.
2. **(b) 투명화**: 응답 스키마에 `unsupported: [{request, reason}]` 추가(프롬프트 규칙 포함). 적용 후 UI(AiFigureEditor)에 디프 칩 — "적용됨: x_min→0, palette→journal_muted" + "반영 불가: ○○ (이유)". sanitize가 실제 드롭한 키도 서버가 응답에 명시.
3. **(c) 자가 검증 루프**: 패치 적용·재렌더 후 **전/후 PNG + 원요청**을 모델에 재투입 → `{satisfied, feedback}` → 미충족 시 feedback을 붙여 **1회 자동 재시도**. 사용자 토글(기본 ON), AI 사용량 카운트에 포함, 감사로그에 시도 횟수. 사용자 제공 실패 사례를 회귀 케이스로 고정(미결 항목).

## U11 — 피겨 편의 (요청 5 나머지) ✅ DONE (2026-07-04 배포·47 e2e green)

**Sonnet 구현 → Fable 검증·수정 체제 5회차(배치 마지막).** Sonnet: 버전 비교 다이얼로그(`FigureVersionCompare.tsx` — 2 select, clip-path 리빌, letterbox 종횡비 정합, window 포인터 드래그, role=slider 접근성 Arrow/Home/End, png 부재 폴백) + 옵션 검색(부분일치+`<mark>`+클리어). e2e 에이전트 선발견 2건 반영(DPI/Palette 검색의 거짓 공백→정직한 스코프 메시지, Close-리셋 의미론 실제화). Fable 리뷰 5발견 **3확정·1기각·1미검증(실질)**: ① 기본 선택이 최초 마운트 고정→`open` 시 재시드(라이브 검증: v2 선택 후 재오픈→compare v2) ② 한쪽 select 변경이 반대편 dims 영구삭제→종횡비 다르면 잘림, pair→사이드별 리셋 ③ 다이얼로그 내 Ctrl+Z가 숨은 편집 undo→`[role=dialog]` 가드 ④ e2e 리셋 단언 비재시도 레이스→`aria-valuenow` 재시도형. 기각: window pointerup이 창밖 릴리즈도 잡아 드래그 스턱 없음(정확). 시각 확인 완료.

1. **버전 비교 슬라이더**: 피겨 페이지에서 두 버전 선택 → 이미지 오버레이+드래그 디바이더(전/후). AI 편집 검수 동선과 직결. 순수 프런트(버전 png_url 기존재).
2. **옵션 검색창**: 편집 폼 상단 검색 — 옵션 라벨/키 매칭 필터+스크롤+하이라이트. 폼이 이미 메타데이터 기반이라 라벨 인덱스 구축 용이.

---

## 계약 가드 (1차와 동일 + 신규)

- 글꼴 pt 절대값·재레이아웃 계약(§5), SVG-DOM 편집 금지, 비트맵 스트레치 금지, ggiraph/webR 금지(§9) 유지.
- **신규**: 캔버스 annotations는 배치 계층(캔버스 소유·버전 무관·export 동등성 필수). AI 패치는 여전히 sanitize 관문 통과(스키마 자동화는 표현력 확장일 뿐 검증 완화 아님).

## 검증 프로세스

1차와 동일: 마일스톤별 tsc/lint(**CI react-compiler lint까지 push 전 로컬 실행**) → qa-e2e 전체(35+신규) → 브라우저 시각 확인 → 커밋 → CI 자동배포 green. 렌더 소모 큰 U10(c)는 admin 쿼터 무제한 상태 활용, e2e는 재시도 1회 케이스만.

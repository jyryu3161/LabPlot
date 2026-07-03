# Canvas UX 개선 U1–U6 — 완료 기록 (2026-07-03)

사용자 피드백 7건 → 코드 조사(5영역 병렬, 전 항목 file:line 검증) → grilling 7문으로 결정 확정 → **하루에 6개 마일스톤 전부 구현·리뷰·배포 완료**.
설계 계약(multipanel-canvas-design.md)의 동결 결정과 충돌 없음. 프로세스: 마일스톤마다 구현 → 적대적 리뷰 워크플로(렌즈별 발견→반박 검증) → 확정 결함 반영 → qa-e2e 전체 → 브라우저 시각 확인 → 커밋 → CI 자동배포.

## 결과 요약

| 마일스톤 | 내용 | 커밋 | 리뷰 raw→확정(반영) |
|---|---|---|---|
| U1 | 휠 팬/줌 분리·스냅 교정·무테두리·A4 기본·종횡비 잠금·에디터 링크 | 3b3b840 | 7→7 |
| U2 | 원본(native) 크기 배치 + Original size + 좌표 클램프 클래스 수정 | 341e512 | 3→3 |
| U4 | Prism식 제목/축라벨 클릭 편집(캔버스) + 복사본 체크박스 + sidecar 히트박스 | 474f1cb, ecdfcd6 | 22→6 |
| U5 | 축 틱스트립 팝오버(min/max/breaks/format/…) + scale_editable 게이트 | db28f34 | 14→2 |
| U3 | 프로젝트 캔버스(탭·생성·이동 owner-only·픽커 스코프) + export 견고화 | a21f9de | 9→3 |
| U6 | 피겨 페이지 동일 편집(드래프트 전용, 렌더 0) + 409 가드(포크 보존·재가드) | 6ccd18a, 6d9077b, 0c6ce32 | 12→5 |

최종: **qa-e2e 35/35 green**, 전 확정 결함 반영 또는 명시 수용, 라이브 시각 검증(CJK 라벨 인라인 편집→렌더까지) 완료.

## 확정 결정 (grilling 2026-07-03)

| Q | 결정 |
|---|---|
| Q1 편집 전파 | **(a) 공유 참조 유지** — 캔버스 안 편집=새 버전, 모든 사용처 동기 반영. **+ (b) "캔버스 전용 복사본으로 추가" 체크박스**를 픽커에 추가(기존 `POST /figures/{id}/duplicate` 재사용, router:193/api.ts:386 확인) |
| Q2 휠 관례 | **표준(Figma) 관례** — plain wheel=팬, Ctrl/Cmd+휠·핀치=감쇠 줌. 마우스 단독 휠 줌 포기(±버튼·빈공간 드래그 유지) |
| Q3 A4 방향 | **a4_portrait(210×297) 기본**, a4_landscape 두 번째 |
| Q4 실행 순서 | **U1 → U2 → U4 → U5 → U3 → U6** (직접 편집을 프로젝트 캔버스보다 먼저) |
| Q5 편집 undo | **(c) 절충** — 커밋 전 Escape=취소(무료), 커밋 직후 "직전 값 되돌리기" 1회 버튼(rerender 1회), Ctrl/Cmd+Z는 배치 전용 유지(도움말에 명시) |
| Q6 프로젝트 이동 권한 | **(a) owner 전용** — project_id 부착/이동/분리 모두 캔버스 소유자만 |
| Q7 픽커 스코프 | **(a) 유도만** — 프로젝트 캔버스면 픽커를 프로젝트 그림으로 기본 스코프 + 비프로젝트 그림 선택 시 "협업자에게 보이지 않음" 경고 배지. 백엔드 차단 없음 |
| (엔지니어링) | U2 클램프=캔버스의 90%(구현 중 조정 가능); rerender 60/h 한도는 텔레메트리 후 재검토 |

---

## 0. 피드백 → 원인 → 방향 요약

| # | 피드백 | 진단 | 성격 | 방향 |
|---|---|---|---|---|
| 1 | 프로젝트별 Canvases 메뉴 | **백엔드는 이미 완성** (project_id 컬럼·인덱스·list/create 파라미터·figures 미러 authz 전부 존재). 프런트가 안 쓸 뿐 | 기능 노출 | U3 |
| 2 | 두손가락 스크롤=줌(이동이어야), 핀치 과민 | `handleWheel`이 ctrlKey 무시하고 모든 wheel에 고정 1.08× 줌. 핀치는 초당 30–60 이벤트 → 1.08^N 폭주 | 버그급 UX | U1 |
| 3 | 드래그 중 특정 위치에서 위치가 저절로 변경 | 스냅 기능. 6px 밴드 내 **첫 번째**(최근접 아님) 타깃으로 워프 + Alt 우회 없음 + dragDistance=0(클릭 지터로 ~1.4mm 이동+PATCH 발생 가능) | 버그 | U1 |
| 4 | 패널 테두리 안 보이게 | 비선택 패널에도 1px `#cbd5e1` stroke 상시 표시 (에디터 전용 — export에는 없음) | UX | U1 |
| 5 | 기본 캔버스 = A4 | 프리셋이 저널 컬럼 폭 전용(첫 항목 nature_single 88.9×64mm가 기본). A4 부재. 클램프(20–500mm)는 이미 A4 허용 | UX | U1 |
| 6 | 캔버스에 넣으면 원본과 너무 다름 | **파이프라인은 충실**(옵션/프리셋 그대로, 스트레치 없음). 지배 원인 = 원본 177.8×106.7mm(wide 7×4.2in, 7pt)를 **하드코딩 60×45mm**에 넣어 ~3× 축소 + 종횡비 1.67→1.33 변화. 절대 pt 글꼴은 계약 §5의 의도된 동작 | 기본값 문제 | U2 |
| 7 | 캔버스 안에서 제목/축라벨/축 직접 편집 (Prism식) | 옵션(제목·라벨·min/max·breaks·format 등)·커밋 경로(rerender+409)·히트테스트 패턴(sidecar) **전부 존재**. 빠진 것은 sidecar 히트박스 4–6개(~30줄 R)와 UI | 신규 기능 | U4–U6 |

---

## U1 — 즉시 수정 묶음 ✅ DONE (commit 3b3b840, 2026-07-03 배포·27 e2e green)

리뷰 워크플로(3렌즈+반박검증)가 잡아낸 5건도 함께 수정: Edit-figure 새탭 후 캔버스 스테일(visibilitychange refetch), 렌더 실패 패널 비가시화(대시 테두리+문구), A4 라벨 치수 중복, Safari GestureEvent 핀치, 컬러에디터 오버레이 리사이즈 중 스트레치(meet 레터박스+클릭 가드).

### U1-a. 트랙패드 휠 분리 (피드백 2)
`CanvasEditor.tsx:652-668 handleWheel`
- deltaMode 정규화(0=px, 1=×16, 2=×viewport) 후:
  - `ctrlKey || metaKey`(=핀치/Ctrl+휠) → 포인터 앵커 줌. 감쇠식 `factor = clamp(exp(-dy·k), 0.8, 1.25)`, k≈0.002 → 줌 속도가 이벤트 빈도가 아니라 **손가락 이동량에 비례**. 전역 클램프 [0.15, 8] 유지.
  - 그 외(두손가락 스크롤) → `setView(x - dx, y - dy)` **팬**.
- 기존 포인터 앵커 수식(657-667)은 그대로 재사용. 빈 공간 드래그 팬(Stage draggable:937)도 유지.
- CanvasHints.tsx:58-59 문구 동시 수정: "Scroll to pan · pinch/Ctrl+scroll to zoom".
- 트레이드오프: 일반 마우스 휠 단독 줌이 사라짐(Figma/Miro 관례). 마우스 사용자는 Ctrl+휠 또는 ± 버튼(zoomBy:669).

### U1-b. 스냅 동작 교정 (피드백 3)
`CanvasEditor.tsx:515-552`
1. **최근접 타깃**: 축별 `find()`(첫 매치+break, :541-548) → 전 (edge,target) 쌍의 최소거리 스캔으로 교체. 밴드 겹칠 때 먼 라인으로 끌리는 현상 제거.
2. **Alt 우회**: dragmove 첫머리 `if (e.evt.altKey) { setGuides(null); return; }` — 정밀 배치용. 힌트 팝오버에 문구 추가.
3. **dragDistance=3**: 패널 Group(:132)과 Stage(:937)에 설정 → 클릭 지터가 드래그/스냅/의도치 않은 PATCH(EPS_MM=0.05 필터를 통과하는 ~1.4mm 이동)로 번지는 것 차단. onMouseDown 선택(:133)은 즉시라 UX 불변.
4. (선택) 스냅 해제 히스테리시스 thr×1.5 — 시간 남으면.
- SNAP_PX=6 화면px 유지(이미 zoom 보정 올바름, :518). 가이드라인 렌더(:971-975)는 이미 존재 → 시각 작업 없음.

### U1-c. 패널 테두리 제거 (피드백 4)
`CanvasEditor.tsx:141-147` — Rect stroke를 **hover 시에만**(`#94a3b8`). 선택 표시는 Transformer(:977-984)가 이미 담당하므로 selected stroke도 제거.
- 주의: Rect가 히트영역(이미지 listening=false:148)이므로 **fill은 유지** — transparent 모드는 `rgba(0,0,0,0)` fill로 교체(히트 유지 + 기존 캐버트 수정).
- export(backend service.py:632)에는 원래 테두리 없음 — 에디터만의 변화.

### U1-d. A4 프리셋 + 기본값 (피드백 5)
- `backend/app/canvases/service.py:502-524 list_canvas_presets`: JOURNAL_SPECS 루프 **앞에** `a4_portrait (210×297)`, `a4_landscape (297×210)` 정적 삽입. 프런트가 presets[0]을 시드(page.tsx:64,120)하므로 순서만으로 기본값이 A4 세로가 됨.
- `canvases/page.tsx:51-52` 프리페치 폴백 기본값 180/120 → 210/297.
- 클램프 전 구간(프런트 20–500, 백엔드 ge/le 20–500) 이미 통과 — 검증 완료.
- (선택) A3(297×420)·US Letter(215.9×279.4) 동시 추가 — 각 1엔트리.

### U1-e. 전환 스트레치 완화 + 종횡비 잠금 기본 ON (피드백 6의 즉효 부분)
- `lockAspect` 기본 false→true (CanvasEditor.tsx:220; 토글:914 존재).
- usePanelImage(:54-86): 패널 크기 변경 시 이전 이미지를 새 박스에 늘려 그리는 과도기 왜곡 → 레터박스(이미지 자체 종횡비로 그리기) 또는 즉시 placeholder.

### U1-f. "Open in figure editor" 링크 (피드백 7의 즉효 스톱갭)
- 현재 캔버스→figure 에디터 링크가 **전무**(grep 확인). 선택 패널 툴바(:908 부근)에 `/figures/{figure_id}` 새 탭 링크. follow-latest+쿼리 무효화로 복귀 시 자동 반영, 409 가드 기존재.

---

## U2 — 원본 크기 기본 배치 ✅ DONE (commit 341e512, 2026-07-03 배포·30 e2e green)

리뷰가 잡은 3건 반영: 좌표에 clampCanvasMm(20mm 플로어) 오용 → [0, canvas−panel] 규칙으로 pick/drag/transform 전면 교체(저널 프리셋에서 패널이 시트 밖으로 밀리고 되돌릴 수 없던 major), PANEL_MM_MIN 축별 플로어 → 균일 스케일 인상(종횡비 보존), Original size 위치 클램프. 백엔드 x/y 저장도 [0,500] 클램프.

원칙: **글꼴 pt 스케일링은 하지 않는다**(계약 §5 위반이자 WYSIWYG 붕괴). 고칠 것은 "기본 패널 크기"다.

1. **native size 노출 (S)** — 서버가 이미 아는 값: version.options의 size/width_in/height_in → renderer `_dimensions()`(_SIZES: wide=7.0×4.2in=177.8×106.7mm). 
   - figures 리스트 serializer(figures/service.py:494-502)와 `_panel_response`(canvases/service.py:292-314)에 `native_width_mm/native_height_mm` 추가(현재 버전 join 재사용, N+1 금지). types.ts 동기화.
   - layout.img_px/dpi 폴백은 불안정(DEVICE_TYPES 부재) — options 유도가 정답.
2. **handlePick 기본값 교체 (S)** — DEFAULT 60×45(:631-632) → 그림의 native mm, 캔버스의 ~90% 초과 시 종횡비 유지 균등 축소, 미상 시 60×45 폴백. A4(210×297)에 wide 원본(177.8×106.7)이 그대로 들어감 — U1-d와 상승효과.
3. **"Reset to original size" 버튼 (M→S)** — 선택 패널 툴바에 patchPanel({w,h}=native, 히스토리 'resize'). 1번 필드에 의존.

---

## U3 — 프로젝트별 Canvases ✅ DONE (commit a21f9de, 2026-07-03 배포·43 e2e 상당 green)

리뷰(9발견→확정3·기각6, 기각은 중간반영 검증) 반영: export가 접근불가 패널에서 전체 404 → 패널별 skip, Move 버튼 owner 게이트+viewer 타깃 필터+403 사유 표출+이동 경고, 감사로그 project_id 기록, NewCanvasDialog 입력 와이프/비모달 수정. U5 후속: scale_editable_axes 단일 소스(_post_layers 소비, 컨테이너 시맨틱 검증) + 프리뷰 요청시 플래그 주입 → 죽은 Ticks/Format/reverse 게이트. **운영 노트**: QA 마라톤이 admin 월 렌더쿼터(300) 소진 → 429 연쇄 실패(코드 회귀 아님), admin 계정 무제한(0) 조정.

백엔드 기완성 항목(조사로 확정): project_id 컬럼+인덱스(models.py:20, mig 0019), `GET /api/canvases?project_id=`(router.py:47), create의 require_project_write(service.py:369), get_canvas의 owner-OR-project authz(figures 미러, :264). **마이그레이션 불필요.**

1. **프로젝트 상세 탭 (M)** — projects/[id]/page.tsx(:321 Tabs)에 3번째 탭 `Canvases (n)`: `['canvases', id]` 쿼리로 `listCanvases(id)`(api.ts:544에 파라미터 기존재), /canvases 카드 마크업 재사용, canEditProject 게이트.
2. **프로젝트 내 생성 (S)** — /canvases의 생성 다이얼로그(page.tsx:220-317)를 `NewCanvasDialog` 공유 컴포넌트로 추출, projectId prop → create payload에 project_id.
3. **이동 지원 (S, 유일한 백엔드 작업)** — CanvasUpdate에 project_id 추가 + update_canvas에서 `"key" in data` 센티널 처리(대상 프로젝트 require_project_write). **확정(Q6-a): project_id 부착/이동/분리 모두 owner 전용** — 편집자의 공유 캔버스 사유화 차단.
4. **피커 스코프 (S, authz-UX)** — FigurePickerDialog가 무스코프 listFigures() 호출(:28) → 프로젝트 캔버스에 개인 그림을 올리면 **협업자에게 preview/export 404**(fail-closed라 보안은 안전, UX만 파손). **확정(Q7-a): 유도만** — canvas.project_id 있으면 `listFigures(projectId)` 기본 스코프 + 비프로젝트 그림 선택 시 "협업자에게 이 패널이 보이지 않습니다" 경고 배지. 백엔드 차단 없음(기존 혼합 캔버스 보호, 404 신고 누적 시 재검토).
5. **폴리시** — 글로벌 /canvases 카드에 프로젝트 배지, 에디터 브레드크럼 project 복귀 링크.

---

## U4 — Prism식 직접 편집 P1 ✅ DONE (commit 474f1cb, 2026-07-03 배포·31+1flaky green)

리뷰(3렌즈, 22발견)가 잡은 실결함 반영: gtable 뷰포트명 **t-r-b-l**(t-l-b-r는 facet 스팬 셀에서 조용히 실패 — 컨테이너 실측), coord_flip 시 하단 셀=Y라벨(flip-인식 매핑), 병합 기준을 conflict-guard 버전으로(스테일 prop 병합이 직전 커밋을 되돌리는 레이스), 커밋마다 base_version_id 전진(자기 409, 색상 커밋도 동일 잠복 버그), unset 복원은 null-삭제(''는 라벨 블랭크), 텍스트 전용 오버레이 pointer-events-none(색상 불가 타입 드래그 불능+흰 플래시 회귀 방지), 프리뷰 캐시 sidecar_v 도입(구캐시가 옛 사이드카 서빙), 픽커 체크박스 리셋/WCAG 2.5.3, 힌트 문구.

전부 기존 레일 위: 옵션 키(title/x_label/y_label — sanitize 통과, 200자 캡, 빈 문자열로 블랭크 처리 지원), 커밋 패턴(CanvasColorEditor.tsx:182-219: 옵션 병합→rerenderFigure+base_version_id→409 토스트→invalidate), 히트테스트(recolor.ts seriesAtPoint + preview가 sidecar layout 반환).

1. **sidecar 확장 (S, 백엔드 유일 작업)** — renderer.py layout_export에 ~30줄: legend_keys와 동일한 `grid.ls→seekViewport→.vp_box(deviceLoc)` 기법(:312-320, :365-382 기존재 검증)으로 `title_px, subtitle_px, xlab_px, ylab_px, x_axis_px, y_axis_px` 추가(각각 tryCatch, additive — 계약 §7 준수). facet은 union bbox. **스냅샷 테스트 필수**: scatter 픽스처 1개 렌더→키 존재 assert (grid viewport 이름은 ggplot2 내부 API라 업그레이드 회귀 감지용).
2. **regionAtPoint (S)** — recolor.ts 옆 regions.ts, 동일 inBox 스캔 + 얇은 라벨 박스 패딩.
3. **인라인 편집 UI (M)** — 선택 패널 오버레이(기존 overlayRect:735-740 좌표계)에서 title/xlab/ylab 클릭 → 해당 박스 위 HTML input(ylab은 CSS -90° 회전), 현 옵션 프리필 → **Enter/blur에만 커밋**(키스트로크당 렌더 금지), Escape 취소(커밋 전 무료) → 공유 훅 `useCommitFigureOptions`(CanvasColorEditor의 mutation 추출)로 커밋. 커밋 중 낙관적 텍스트 오버레이(HTML span으로 **덮기** — SVG-DOM 변형 아님) + 스피너. 커밋 직후 토스트/툴바에 **"직전 값 되돌리기" 1회 버튼**(rerender 1회, Q5-c). Ctrl/Cmd+Z는 배치 전용 유지 — 도움말 팝오버에 명시.
3b. **"캔버스 전용 복사본으로 추가" (S, Q1-b)** — FigurePickerDialog에 체크박스: 체크 시 `duplicateFigure(fig.id)` 후 사본 id로 addPanel → 이 캔버스 안 편집이 원본·타 캔버스에 전파되지 않음. 기본은 미체크(공유 참조).
4. **폴백 (S)** — sidecar 키 부재(8개 DEVICE_TYPES, network, 구버전 렌더) 시 클릭 타깃 대신 사이드패널 폼 입력으로 동일 커밋 — 타입 락 없이 우아한 강등.
- 제약: 렌더당 2–5초, figure_rerender 60/h 버킷 — Enter-only 커밋 + 429 친화 토스트. 버전 히스토리 수다("edit x label"×N)는 계약상 감수(편집=버전).

## U5 — 축 편집 팝오버 ✅ DONE (commit db28f34, 2026-07-03 배포·33 e2e green)

리뷰(2렌즈, 14발견) 반영: 팝오버를 오버레이 밖 형제로(overflow-hidden 클리핑 — e2e는 통과하는데 시각으로만 잡힘) + 공간별 위/아래 플립, 오픈 시 포커스 인입(Escape/Delete가 패널 해제·삭제로 새는 문제), min≥max·log+비양수 클라이언트 검증(유료 no-op 차단), discrete 축에서 reverse/log 게이트(reverse는 no-op 확증), flip-인식 라벨 통일, "Axis updated" 토스트, e2e 멱등 가드. **수용된 한계**(U4 #6과 동클래스): 일부 타입은 breaks/format을 렌더러가 소비하지 않아 no-op 버전 가능 — 타입별 옵션 소비 메타데이터 필요(향후).

x_axis_px/y_axis_px 클릭 → 앵커 팝오버: min/max/Auto fit/breaks(2–20)/tick format(number·comma·percent·scientific)/reverse/log/x_text_angle/axis_break — **전부 기존 옵션 키**. Apply 1회=버전 1개(배치 커밋). 이산 축은 sidecar x_discrete/y_discrete로 게이트(무의미한 min/max 숨김). 피겨 페이지의 헬퍼(numericOptionValue 등, page.tsx:103-180 module-private)를 공유 모듈로 추출.

## U6 — 피겨 페이지 직접 편집 ✅ DONE (commits 6ccd18a·6d9077b·0c6ce32, 2026-07-03 배포·35 e2e green) — **U1–U6 전체 계획 완료**

리뷰(12발견→확정5) 반영: **409 가드 1회용 결함**(성공 시 selectedVid 고정 → 409 후 재시도가 무가드 덮어쓰기 — 검증자가 전 체인 재현) → 409 시 버전 핀 해제로 재가드, 옛버전 Apply=포크 워크플로 보존(현재 버전 편집일 때만 가드 전송 — 자가 발견), flip 매핑은 렌더된 버전 기준(드래프트 토글 오매핑 방지), live-preview 리마운트 시 인라인 입력 드래프트 커밋, 짧은 프리뷰에서 팝오버 이미지 내 고정, 축 스트립을 라벨 밴드 아래로(지운 라벨 재추가 가능). **수용**: live-preview는 base_version_id 미전송(명시적 사용자 토글; 크로스탭 마스킹 가능 — 문서화). CI 전용 react-compiler lint 3연타(ref-in-render→forward-ref→conditional-hook)는 declare→assign-in-effect→guard 순서로 해결.

피겨 페이지는 sidecar를 이미 수신(version.layout→FigureAnnotationOverlay가 px 매핑:142-150). 같은 regionAtPoint+인라인 컴포넌트를 "요소 편집" 모드로 추가하되, **draft 상태만 갱신**(setOptions→기존 900ms live preview) — 렌더 추가 비용 0, Prism 감각. 주석 모드와 클릭 충돌 → 명시적 모드 토글. 이 참에 피겨 페이지 apply에도 base_version_id 추가(현재 누락:321 — 크로스탭 충돌 방어).

---

## 하지 않을 것 (계약 가드)

- 패널 크기에 따른 **글꼴 자동 스케일 금지** — §5 절대 pt가 재레이아웃 보장의 핵심.
- **SVG-DOM 편집 부활 금지** — 오버레이는 덮기만, 변형 없음.
- 비트맵 스트레치 금지(U1-e 레터박스는 과도기 표시일 뿐, 커밋 렌더는 항상 재레이아웃).
- ggiraf/webR/클라이언트 차트엔진 금지(§9).

## 실행 기록·교훈

- 실행 순서(확정대로): **U1 → U2 → U4 → U5 → U3 → U6**, 각 마일스톤 독립 배포. e2e는 26→35개로 성장(휠/네이티브 크기/텍스트·축 편집/프로젝트/피겨페이지 스펙 신설).
- **시각 확인이 자동 테스트가 못 잡는 버그를 반복해서 잡음**: export 클리핑(U1 이전), U5 팝오버 overflow-hidden 클리핑(e2e는 통과), U6 렌더 결과 검증.
- 재발 방지 장치: sidecar `sidecar_v` 캐시 버전, `scale_editable_axes` 단일 소스(_post_layers 소비), canvas-text-edit.spec의 sidecar 키 가드(ggplot2 업그레이드 회귀 감지).
- 운영 노트: QA 마라톤이 admin 월 렌더쿼터(300) 소진 → users.render_monthly_limit=0 조정. CI 전용 react-compiler lint는 로컬 `next build`가 안 잡음 — push 전 `npm run lint` 필수.

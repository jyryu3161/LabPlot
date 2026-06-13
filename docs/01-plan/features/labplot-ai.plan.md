# LabPlot AI Product Plan

> **Summary**: LabPlot AI is a laboratory visualization copilot. Researchers upload tabular data, receive deterministic and AI-assisted chart recommendations, render publication-grade ggplot2 figures, review visual quality with AI, apply safe structured improvements, and export both finished images and reproducible R code.

## 1. Product Direction

| Area | Direction |
| --- | --- |
| Problem | Researchers want publication-ready figures without spending time on R/ggplot2 mechanics. Many commercial tools do not provide reproducible code, and teams still need a way to judge whether a figure is ready for manuscript or reviewer scrutiny. |
| Solution | Upload data, inspect the preview, choose a recommended chart, map columns, select a style, render the figure, optionally run AI review and improvement, then export PNG, SVG, TIFF, PDF, and R code. |
| Positioning | AI-powered publication figure copilot, not a generic chart toy and not an automated scientific interpretation engine. |
| Core Value | Users can create reproducible, publication-grade figures quickly while keeping control over chart type, mappings, style, and final edits. |

## 2. Principles

1. Visualization first: figure creation and export are the primary workflow.
2. AI assists visualization only: AI can recommend chart types, review visual quality, suggest safer figure parameters, and draft legends. It must not perform unsupported statistical tests, infer biological conclusions, or invent findings.
3. User control: inferred column types and AI suggestions remain editable and optional.
4. Safe rendering: users and AI do not execute arbitrary R. The system renders through validated templates and schema-checked parameters.
5. Reproducible output: each figure version stores input mapping, options, style, render output, and generated R code.
6. Graceful degradation: core upload, render, and export workflows must keep working when AI providers are unavailable.

## 3. User Flow

```text
Register or log in
  -> Create or open a project
  -> Upload CSV, TSV, or XLSX data
  -> Review preview, profile, and column roles
  -> Choose a rule-based or AI-assisted chart recommendation
  -> Map required and optional columns
  -> Select style and export size
  -> Render a ggplot2 figure and save version 1
  -> Optionally run AI review, improvements, and legend generation
  -> Export image files and reproducible R code
```

## 4. MVP Scope

### Chart Types

| Plot Type | Purpose | Required Mapping | Implementation |
| --- | --- | --- | --- |
| Box plot | Compare distributions across groups | x = group, y = numeric | ggplot2 |
| Violin plot | Compare distribution shape and density | x = group, y = numeric | ggplot2 |
| Scatter plot | Inspect relationships between numeric variables | x = numeric, y = numeric | ggplot2 |
| Bar plot | Show counts or grouped summaries | x = category, y or count | ggplot2 |
| Line plot | Show ordered or time-course trends | x = time/order, y = numeric | ggplot2 |
| Heatmap | Encode numeric matrices with color | matrix/wide numeric columns | pheatmap |
| Volcano plot | Visualize differential expression tables | log2 fold change, p-value | ggplot2 and ggrepel |
| PCA plot | Inspect sample clustering | numeric matrix or PC1/PC2 columns | stats::prcomp and ggplot2 |
| Kaplan-Meier plot | Display survival curves | time, status, optional group | survival and survminer |

### Core Features

- Authentication, refresh tokens, logout, account approval, and user-level data isolation
- Project organization for datasets and figures
- CSV, TSV, and XLSX upload with preview, profiling, statistics, and column role inference
- Rule-based chart suggestions that appear immediately
- AI-assisted recommendations that enrich chart cards with rationale and examples
- Chart builder with mapping, style, key options, and export sizing
- ggplot2 rendering with saved figure versions
- AI figure review with publication score and structured visual feedback
- AI improvement suggestions with schema-checked parameter patches
- AI legend generation and prompt enhancement
- Export to PNG, SVG, TIFF, PDF, and R script
- Public gallery for selected examples
- Admin user management, AI provider configuration, and AI usage accounting

## 5. Deferred Scope

- Conversational chart editing
- Table generation and DOCX exports
- Multi-panel builder and before/after visual diffs
- Lab templates, comments, approvals, and shared review workflows
- S3 or object-storage backed file storage
- Multi-tenant institutional SaaS controls
- Additional specialized plots such as dot, beeswarm, raincloud, ridge, MA, correlation, dose-response, UMAP, and t-SNE
- Bioconductor-heavy workflows such as ComplexHeatmap, EnhancedVolcano, clusterProfiler, and Seurat integrations
- R Markdown, Quarto, EPS, and 600 dpi export profiles

## 6. Technical Architecture

| Layer | Choice | Notes |
| --- | --- | --- |
| Frontend | Next.js, React, TypeScript, Tailwind, shadcn-style components | Production deployment uses standalone Next.js output. |
| Backend | FastAPI, SQLAlchemy, Pydantic | Owns auth, data access, render orchestration, AI calls, and admin APIs. |
| Database | PostgreSQL | Stores users, projects, datasets, figures, versions, reviews, improvements, AI config, and AI usage. |
| Rendering | Rscript with ggplot2 templates | R code is generated from validated parameters and stored for reproducibility. |
| AI Providers | Anthropic Claude and Google Gemini | Admin-selectable provider and model. |
| Reverse Proxy | Caddy | Same-origin routing for frontend, API, docs, and static assets. |
| Storage | Local backend static directory | Suitable for a single-server deployment; object storage can be added later. |

## 7. Data Model

Primary tables:

- `users`: authentication, approval, active state, admin role
- `projects`: user-owned organization unit
- `datasets`: uploaded file metadata, profile, preview path, description, project link
- `figures`: user-owned chart record and current version pointer
- `figure_versions`: mapping, options, style, generated R code, rendered file paths
- `reviews`: AI figure review payloads
- `improvements`: AI improvement suggestions and applied status
- `ai_config`: runtime provider settings and encrypted or stored provider keys
- `ai_usage`: provider, model, feature, input tokens, output tokens, total tokens, and estimated cost per call

Deferred tables can be introduced for chat messages, generated tables, lab templates, comments, and approvals when those features become active.

## 8. API Surface

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/refresh` | Authentication | Mixed |
| GET | `/api/auth/me` | Current user | User |
| GET/POST | `/api/projects` | Project list and creation | User |
| GET/PATCH/DELETE | `/api/projects/{id}` | Project detail, update, delete | User |
| POST | `/api/datasets` | Upload data | User |
| GET | `/api/datasets`, `/api/datasets/{id}` | Dataset list and detail | User |
| GET | `/api/datasets/{id}/chart-suggestions` | Deterministic recommendations | User |
| POST | `/api/datasets/{id}/recommend` | AI-assisted recommendations | User |
| GET | `/api/plot-types`, `/api/styles`, `/api/palettes` | Builder metadata | User |
| POST | `/api/figures` | Create and render a figure | User |
| GET/PATCH/DELETE | `/api/figures/{id}` | Figure detail, update, delete | User |
| POST | `/api/figures/{id}/rerender` | Create a new figure version | User |
| POST | `/api/figures/{id}/versions/{vid}/review` | AI figure review | User |
| POST | `/api/figures/{id}/versions/{vid}/improve` | AI improvement suggestions | User |
| POST | `/api/figures/{id}/improvements/{iid}/apply` | Apply validated improvement | User |
| POST | `/api/figures/{id}/versions/{vid}/legend` | AI legend generation | User |
| GET | `/api/figures/{id}/versions/{vid}/export` | Export rendered assets or R code | User |
| GET | `/api/public/gallery` | Public gallery feed | Public |
| GET | `/api/admin/users` | User list with counts and AI usage | Admin |
| GET/PATCH | `/api/admin/ai-config` | AI provider settings | Admin |
| GET | `/api/health` | Health check | Public |

## 9. AI Design

All AI calls use structured outputs and schema validation. AI output can suggest values, but backend services sanitize and validate every patch before it changes a figure.

Tracked AI features:

- `chart_recommendations`
- `figure_review`
- `figure_improvements`
- `figure_legend`
- `enhanced_prompt`

Usage accounting records provider metadata and token counts per authenticated user. Admin screens aggregate requests, input tokens, output tokens, total tokens, and estimated cost for every user, including admin accounts.

## 10. Rendering Safety

- No arbitrary user-provided R is executed.
- Plot type, mappings, style, size, and options are validated before rendering.
- Render failures preserve the previous good version.
- Error messages are normalized into actionable user-facing messages.
- Generated R scripts are export artifacts, not an execution input channel.

## 11. Deployment

The production Docker Compose stack runs:

- PostgreSQL 16
- FastAPI backend with Uvicorn and no reload loop
- Next.js standalone frontend server
- Caddy with HTTPS, compression, and static asset cache headers

Production checks should include:

```bash
npm run lint
npm run build
PYTHONPYCACHEPREFIX=/tmp/labplot-pycache python -m py_compile $(find backend/app -name '*.py' -not -path '*/__pycache__/*' -print)
docker compose build
docker compose up -d
docker compose ps
curl -k https://labplotai.com/api/health
```

## 12. Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Arbitrary code execution | High | Use fixed R templates and validated parameter patches only. |
| Column inference mistakes | Medium | Treat inference as a suggestion and keep mappings editable. |
| AI cost growth | Medium | Track per-user usage and show admin aggregates. |
| AI latency or provider failure | Medium | Keep rule-based recommendations and core rendering independent from AI. |
| Sensitive unpublished data sent to providers | High | Send only the context required for the selected AI feature and document provider behavior. |
| Large uploads | Medium | Enforce upload limits and preview only a bounded subset. |
| UI complexity | Medium | Keep advanced options scoped and progressively disclosed. |

## 13. Change History

| Version | Date | Summary | Owner |
| --- | --- | --- | --- |
| 1.0 | 2026-06-13 | Initial broad platform concept with AI recommendations, review, improvements, chat, legends, tables, and broad scientific plot coverage. | Jaeyong Ryu |
| 1.1 | 2026-06-13 | Reduced MVP toward a simpler visualization workflow. | Codex |
| 1.2 | 2026-06-13 | Restored rule suggestions, quick-start flow, and TIFF 300 dpi export. | Codex |
| 2.0 | 2026-06-13 | Rebalanced around the AI publication figure copilot: deterministic and AI chart recommendations, vision review, safe improvement patches, biological and omics-oriented MVP plots, five style presets, and deferred long-tail features. | Jaeyong Ryu |

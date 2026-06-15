# Biology Figure And Statistics Review

Date: 2026-06-15

## Scope

This review checks whether LabPlot's current figure registry covers common biology manuscript needs and whether the upload-time statistics feature has obvious correctness or reliability issues.

## Current Figure Coverage

The current runtime registry exposes 22 plot types:

| Area | Supported plot types |
| --- | --- |
| Basic statistics | box, violin, scatter, bar, line, histogram, density, correlation_heatmap, heatmap |
| Omics | volcano, pca |
| Clinical/cohort | kaplan_meier, annotated_heatmap |
| Systems biology | network |
| Functional enrichment | enrichment_dot, enrichment_bar |
| Genomics | manhattan |
| Cheminformatics | chemical_space |
| Physical/engineering data | error_bar, ribbon, contour, radar |

This is enough for many common first-pass biology figures: expression distributions, differential-expression tables, PCA, cohort heatmaps, survival curves, enrichment summaries, GWAS summaries, and protein/gene interaction edge lists.

## Gaps For Biology Papers

The coverage is not complete for a polished biology paper workflow. Highest-value additions:

| Priority | Plot type | Why it matters |
| --- | --- | --- |
| High | Dot plot / feature expression dot plot | Common in single-cell and pathway summaries; encodes mean expression and percent detected. |
| High | UMAP / t-SNE embedding | Standard for single-cell and high-dimensional sample visualization. Can use precomputed coordinates first. |
| High | UpSet plot | More scalable than Venn diagrams for gene set overlap figures. |
| High | Forest plot | Common for hazard ratios, odds ratios, subgroup effects, and meta-analysis style panels. |
| Medium | MA plot | Common complement to volcano plots for differential-expression QC. |
| Medium | Lollipop / mutation landscape | Common for mutation frequency and protein-domain summaries. |
| Medium | GSEA running enrichment curve | Expected for gene set enrichment result figures, not just term ranking. |
| Medium | Beeswarm / sina / jitter summary | Better than bar-only summaries for small biological replicates. |
| Low | Venn diagram | Familiar but less scalable than UpSet; useful for 2-4 sets. |
| Low | Sequence logo | Useful for motif papers, but requires specialized sequence input. |

Recommendation: add these as explicit backlog items rather than claiming current support is exhaustive. The current set should be described as "broad biology-oriented coverage" instead of "all biology manuscript figure types."

## Statistics Review

Current implementation: `backend/app/datasets/stats.py`.

What it does well:

- Computes descriptive statistics for numeric columns.
- Computes Welch t-test for two groups and one-way ANOVA for 3-8 groups.
- Skips comparisons when group sizes are too small for the implemented tests.
- Treats results as advisory in the UI, which is appropriate.
- SciPy is present in the deployed backend container, so comparison tests are enabled.

Observed smoke check:

- A two-group numeric dataset produced descriptive statistics and a Welch t-test.
- Sparse groups with fewer than two numeric values were skipped instead of returning misleading p-values.

Limitations to keep visible:

- No multiple-testing correction across many column/group comparisons.
- No nonparametric tests such as Mann-Whitney, Wilcoxon, Kruskal-Wallis, or paired tests.
- No normality or variance diagnostics.
- No survival statistics such as log-rank p-value or Cox model.
- No effect sizes or confidence intervals.
- Upload-time statistics are not a substitute for an analysis plan.

Recommendation: keep the current UI wording as advisory. If LabPlot expands statistics, first add multiple-testing correction, nonparametric alternatives, effect sizes, confidence intervals, and survival-specific tests. Until then, AI prompts and UI copy should avoid claiming formal statistical analysis.

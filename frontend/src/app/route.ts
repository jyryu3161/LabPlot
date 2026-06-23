export const dynamic = 'force-static';

const gaId = process.env.NEXT_PUBLIC_GA_ID;

const analytics = gaId
  ? `
    <script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', '${gaId}', { anonymize_ip: true });
    </script>
  `
  : '';

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LabPlot AI</title>
  <meta name="description" content="AI-powered publication figure copilot for biology and omics data">
  <link rel="canonical" href="https://labplotai.com/">
  <link rel="stylesheet" href="/landing-static.css">
  ${analytics}
</head>
<body>
  <header class="site-header">
    <a class="brand" href="/" aria-label="LabPlot AI home">
      <span class="brand-icon" aria-hidden="true"></span>
      <span>LabPlot AI</span>
    </a>
    <nav class="nav" aria-label="Primary">
      <a href="/gallery">Gallery</a>
      <a href="/login">Login</a>
      <a class="button small primary" href="/projects">Open app</a>
    </nav>
  </header>

  <main>
    <section class="hero">
      <div class="hero-inner">
        <p class="eyebrow">AI-powered publication figure copilot</p>
        <h1>Publication-quality figures from your data, reproducible in R.</h1>
        <p class="hero-copy">Upload your data, compare ranked plot recommendations, refine the figure visually, and keep the exact R code behind every result.</p>
        <div class="actions">
          <a class="button primary" href="/register">Get started - it's free</a>
          <a class="button light" href="/gallery">Explore the gallery</a>
        </div>
        <ul class="benefits">
          <li>Ranked chart recommendations</li>
          <li>Editable SVG with version history</li>
          <li>Reproducible R code and export files</li>
        </ul>
      </div>
    </section>

    <section class="workflow section">
      <div class="section-heading">
        <p class="section-kicker">Workflow</p>
        <h2>Move from examples to final figure without leaving the workspace.</h2>
        <p>The main flow stays focused: choose a visual direction, generate from data, then edit and export the vector output.</p>
      </div>
      <div class="workflow-grid">
        <article class="preview-card">
          <div class="preview-copy">
            <h3>Gallery</h3>
            <p>Browse real rendered examples before starting.</p>
          </div>
          <img src="/landing/capture-gallery.png" alt="Gallery screenshot" width="720" height="540" loading="lazy" decoding="async" fetchpriority="low">
        </article>
        <article class="preview-card">
          <div class="preview-copy">
            <h3>Generate</h3>
            <p>Map columns, compare ranked suggestions, and render.</p>
          </div>
          <img src="/landing/capture-generate.png" alt="Generate screenshot" width="720" height="540" loading="lazy" decoding="async" fetchpriority="low">
        </article>
        <article class="preview-card">
          <div class="preview-copy">
            <h3>Edit</h3>
            <p>Polish labels, colors, layout, and AI edit requests with version history.</p>
          </div>
          <img src="/landing/capture-editing.png" alt="Edit screenshot" width="720" height="540" loading="lazy" decoding="async" fetchpriority="low">
        </article>
      </div>
      <div class="center-link"><a href="/gallery">View curated gallery examples</a></div>
    </section>

    <section class="section">
      <div class="section-heading">
        <h2>Everything you need for a figure</h2>
        <p>No R expertise required - yet every result is fully reproducible in R.</p>
      </div>
      <div class="feature-grid">
        <article><span>AI</span><h3>AI chart recommendation</h3><p>LabPlot AI reads your column types and suggests the right plot with a clear rationale.</p></article>
        <article><span>R</span><h3>Publication-quality ggplot2</h3><p>Curated chart templates, publication style presets, and colorblind-safe palettes rendered in R.</p></article>
        <article><span>QA</span><h3>AI Figure Review</h3><p>A vision model evaluates publication readiness and returns concrete fixes.</p></article>
        <article><span>TXT</span><h3>AI figure legends</h3><p>Draft journal-style figure legends grounded in study context and computed statistics.</p></article>
        <article><span>CODE</span><h3>Reproducible R code</h3><p>Every figure ships with the exact R script plus SVG, TIFF, and PDF export.</p></article>
        <article><span>VER</span><h3>Projects and versioning</h3><p>Organize datasets and figures per study, then track each version as you iterate.</p></article>
      </div>
    </section>

    <section class="trust section">
      <div class="section-heading">
        <h2>Built to be trusted in research</h2>
        <p>Transparent, reproducible, and under your control - the way research tooling should be.</p>
      </div>
      <div class="trust-grid">
        <article><h3>Reproducible by design</h3><p>Every figure includes the exact R/ggplot2 script that produced it.</p></article>
        <article><h3>No black box</h3><p>Inspect, edit, and re-render vetted templates instead of opaque code.</p></article>
        <article><h3>Publication-grade output</h3><p>Vector SVG/PDF and high-DPI TIFF are built for figure submission.</p></article>
        <article><h3>Private and self-hosted</h3><p>Runs on your own lab or institutional server so unpublished data stays controlled.</p></article>
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <h2>How it works</h2>
        <p>From raw data to a submission-ready figure in five steps.</p>
      </div>
      <ol class="steps">
        <li><span>1</span><h3>Upload</h3><p>Drop a CSV, TSV, TXT, or XLSX.</p></li>
        <li><span>2</span><h3>Recommend</h3><p>Rule-based and AI suggestions point you to the right chart.</p></li>
        <li><span>3</span><h3>Style and edit</h3><p>Adjust axes, labels, colors, size, and chart type.</p></li>
        <li><span>4</span><h3>Review</h3><p>AI reviews publication readiness and drafts your figure legend.</p></li>
        <li><span>5</span><h3>Export</h3><p>Download SVG, TIFF, PDF, and the reproducible R script.</p></li>
      </ol>
    </section>

    <section class="final-cta">
      <h2>Make your first figure today</h2>
      <p>Create an account, upload your data, and get a publication-ready figure in under a minute.</p>
      <div class="actions">
        <a class="button primary" href="/register">Get started - it's free</a>
        <a class="button outline" href="/gallery">See examples</a>
      </div>
    </section>
  </main>

  <footer class="footer">
    <span>LabPlot AI</span>
    <span>Reproducible figures with R / ggplot2 - a non-commercial research tool</span>
  </footer>
</body>
</html>`;

export function GET() {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
    },
  });
}

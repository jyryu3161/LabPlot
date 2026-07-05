# LabPlot AI backend — based on the already-built al_platform image which
# already contains Python (FastAPI stack) + the r-viz R environment
# (ggplot2/dplyr/tidyr/readr/scales/svglite/viridisLite). Fast layered build.
FROM al_platform-backend:latest

WORKDIR /app

# add the two Python deps LabPlot needs on top of the base env
# (pip isn't preinstalled in the pixi env; bootstrap it with ensurepip)
RUN pixi run python -m ensurepip --upgrade \
 && pixi run python -m pip install --no-cache-dir "anthropic>=0.39" openpyxl "cryptography>=42" "sentry-sdk[fastapi]>=2" "alembic>=1.13" "boto3>=1.34"

# professional-domain R packages (annotated heatmaps, networks, enrichment, etc.)
# NOTE: slow solve; the running image is also persisted via `docker commit`.
RUN pixi project channel add bioconda \
 && pixi add --feature r-viz r-igraph r-ggraph r-tidygraph r-ggrepel r-ggforce r-circlize bioconductor-complexheatmap r-plotly r-htmlwidgets r-ggpubr r-ggtext r-ggbreak

# CJK + broad-coverage fonts so R graphics devices can render non-ASCII
# labels (e.g. Korean column names) instead of tofu boxes. fontconfig/cairo
# substitute these automatically for glyphs missing from the default family.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      fontconfig fonts-noto-cjk fonts-noto-core fonts-dejavu-core pandoc librsvg2-bin \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# Pillow for bounded-size AI vision inputs (ai/client._bounded_image downscales
# huge renders before verify_edit/improve calls). python-pptx builds the canvas
# PPTX export (each figure a movable slide picture). Separate late layer so the
# slow r-viz solve above stays cached.
RUN pixi run python -m pip install --no-cache-dir "pillow>=10" "python-pptx>=0.6.23"

# replace AL application code with LabPlot's
RUN rm -rf backend
RUN groupadd --gid 1000 labplot \
 && useradd --uid 1000 --gid labplot --home-dir /home/labplot --create-home --shell /usr/sbin/nologin labplot
COPY --chown=1000:1000 backend/ backend/
COPY --chown=1000:1000 guide/ guide/
RUN mkdir -p /app/backend/private /app/backend/static \
 && chown -R 1000:1000 /app/backend /app/guide /home/labplot
USER 1000:1000

EXPOSE 8000
CMD ["pixi", "run", "serve"]

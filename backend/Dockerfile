# LabPlot AI backend — based on the already-built al_platform image which
# already contains Python (FastAPI stack) + the r-viz R environment
# (ggplot2/dplyr/tidyr/readr/scales/svglite/viridisLite). Fast layered build.
FROM al_platform-backend@sha256:b52c054bfb6179be47441c4a98518a30c1f92e68da8adf729ae24375817db6b7

WORKDIR /app

# add the two Python deps LabPlot needs on top of the base env
# (pip isn't preinstalled in the pixi env; bootstrap it with ensurepip)
RUN pixi run python -m ensurepip --upgrade \
 && pixi run python -m pip install --no-cache-dir \
      "anthropic==0.109.1" "openpyxl==3.1.5" "cryptography==49.0.0" \
      "sentry-sdk[fastapi]==2.62.0" "alembic==1.18.5" "boto3==1.43.29"

# professional-domain R packages (annotated heatmaps, networks, enrichment, etc.)
# NOTE: slow solve; the running image is also persisted via `docker commit`.
RUN pixi project channel add bioconda \
 && pixi add --feature r-viz \
      "r-igraph==2.3.3" "r-ggraph==2.2.2" "r-tidygraph==1.3.0" \
      "r-ggrepel==0.9.8" "r-ggforce==0.5.0" "r-circlize==0.4.18" \
      "bioconductor-complexheatmap==2.26.1" "r-plotly==4.12.0" \
      "r-htmlwidgets==1.6.4" "r-ggpubr==0.6.3" "r-ggtext==0.1.2" \
      "r-ggbreak==0.1.7"

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
RUN pixi run python -m pip install --no-cache-dir "pillow==12.3.0" "python-pptx==1.0.2"

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

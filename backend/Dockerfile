# LabPlot AI backend — based on the already-built al_platform image which
# already contains Python (FastAPI stack) + the r-viz R environment
# (ggplot2/dplyr/tidyr/readr/scales/svglite/viridisLite). Fast layered build.
FROM al_platform-backend:latest

WORKDIR /app

# add the two Python deps LabPlot needs on top of the base env
# (pip isn't preinstalled in the pixi env; bootstrap it with ensurepip)
RUN pixi run python -m ensurepip --upgrade \
 && pixi run python -m pip install --no-cache-dir "anthropic>=0.39" openpyxl "cryptography>=42" "sentry-sdk[fastapi]>=2"

# professional-domain R packages (annotated heatmaps, networks, enrichment, etc.)
# NOTE: slow solve; the running image is also persisted via `docker commit`.
RUN pixi project channel add bioconda \
 && pixi add --feature r-viz r-igraph r-ggraph r-tidygraph r-ggrepel r-circlize bioconductor-complexheatmap

# replace AL application code with LabPlot's
RUN rm -rf backend
COPY backend/ backend/

EXPOSE 8000
CMD ["pixi", "run", "serve"]

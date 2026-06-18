"""Public (no-auth) endpoints for the curated showcase gallery.

Only explicitly pinned root/admin figures are public. Rendered images are
already served by the public /static mount.
"""
import uuid
import re

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.auth.models import User
from app.common.deps import get_db
from app.common.exceptions import NotFoundError
from app.config import settings
from app.datasets import service as dataset_service
from app.figures.models import Figure, FigureVersion
from app.figures.service import _url
from app.r_engine.presets import PRESETS, list_palettes
from app.r_engine.templates import PLOT_TYPES

router = APIRouter(prefix="/api/public", tags=["public"])

PUBLIC_DOMAIN_LABELS = {
    "basic": "Basic Statistics",
    "biology": "Biology & Medicine",
    "chemistry": "Chemistry",
    "biotechnology": "Biotechnology",
    "engineering": "Engineering",
    "advanced": "Advanced & Specialized",
}


PUBLIC_GALLERY_ITEMS: list[tuple[str, str]] = [
    # Basic, widely recognized examples first. The landing page consumes this
    # same order, so keep the opening set conservative and familiar.
    ("Scatter plot with confidence interval", "basic"),
    ("Box plot with jitter", "basic"),
    ("Violin plot", "basic"),
    ("Bar chart with error bars", "basic"),
    ("Overlapped distribution bar chart", "basic"),
    ("Grouped error bar chart", "basic"),
    ("Histogram with density", "basic"),
    ("Cumulative distribution curve", "basic"),
    ("Cell viability assay", "biology"),
    ("Dose response curve", "biology"),
    ("Cell growth curve", "biology"),
    ("ELISA standard curve", "biology"),
    ("Western blot quantification", "biology"),
    ("Flow cytometry histogram", "biology"),
    ("Kaplan-Meier survival curve", "biology"),
    ("PCA sample plot", "biology"),
    ("Gene expression heatmap", "biology"),
    ("Volcano plot", "biology"),
    ("Diagnostic ROC curves", "biology"),
    ("Tumor growth curve", "biology"),
    ("Mutational signature prevalence", "biology"),
    ("Signature correlation heatmap", "biology"),
    ("Genomic score density plot", "biology"),
    ("Genomic instability by subtype", "biology"),
    ("DNA repair pathway mutations", "biology"),
    ("Clinical risk survival curve", "biology"),
    ("Clinical covariate forest plot", "biology"),
    ("Structural variant volcano plot", "biology"),
    ("Structural variant density around focal locus", "biology"),
    ("Variant burden violin plot", "biology"),
    ("Mutation signature intensity", "biology"),
    ("Permutation distance test", "biology"),
    ("Downregulated gene dot plot", "biology"),
    ("Genome-wide focal event map", "biology"),
    ("Genome-wide copy-number score", "biology"),
    ("Circular DNA marker frequency", "biology"),
    ("Pathologic response rate by biomarker status", "biology"),
    ("Treatment biomarker ROC and PR curves", "biology"),
    ("Pathway impact dot plot", "biology"),
    ("Acid-base titration curve", "chemistry"),
    ("Analytical calibration curve", "chemistry"),
    ("Michaelis-Menten kinetics", "chemistry"),
    ("Lineweaver-Burk plot", "chemistry"),
    ("Arrhenius plot", "chemistry"),
    ("HPLC chromatogram", "chemistry"),
    ("UV-Vis absorption spectrum", "chemistry"),
    ("FTIR spectrum", "chemistry"),
    ("Van't Hoff plot", "chemistry"),
    ("Phase diagram", "chemistry"),
    ("Fermentation time course", "biotechnology"),
    ("Bioreactor oxygen profile", "biotechnology"),
    ("qPCR expression fold change", "biotechnology"),
    ("SDS-PAGE densitometry", "biotechnology"),
    ("Plasmid yield optimization", "biotechnology"),
    ("Antibody titer standard curve", "biotechnology"),
    ("Protein purification chromatogram", "biotechnology"),
    ("Cell culture density curve", "biotechnology"),
    ("Enzyme activity assay", "biotechnology"),
    ("Metabolic flux radar", "biotechnology"),
    ("Stress-strain curve", "engineering"),
    ("Nyquist impedance plot", "engineering"),
    ("Bode magnitude plot", "engineering"),
    ("Solar cell I-V curve", "engineering"),
    ("Fatigue S-N curve", "engineering"),
    ("Particle size distribution", "engineering"),
    ("Creep recovery curve", "engineering"),
    ("DSC thermal analysis", "engineering"),
    ("TGA mass loss curve", "engineering"),
    ("Water treatment performance radar", "engineering"),
    ("Feature correlation heatmap", "advanced"),
    ("Q-Q plot", "advanced"),
    ("Residuals vs fitted plot", "advanced"),
    ("Forest plot", "advanced"),
    ("Bubble chart", "advanced"),
    ("Clustered sample heatmap", "advanced"),
    ("Lollipop chart", "advanced"),
    ("Composition trend chart", "advanced"),
    ("Grouped density plot", "advanced"),
    ("Sankey diagram", "advanced"),
    ("UpSet plot", "advanced"),
    ("3D surface plot", "advanced"),
    ("3D scatter plot", "advanced"),
    ("3D contour projection", "advanced"),
    ("Calibration curve", "advanced"),
    ("Chord diagram", "advanced"),
    ("Parallel coordinates plot", "advanced"),
    ("Confusion matrix heatmap", "advanced"),
    ("Tri-surface plot", "advanced"),
    ("3D wireframe plot", "advanced"),
    ("ROC and PR curves", "advanced"),
    ("MA plot", "advanced"),
    # Existing high-quality LabPlot examples that are not part of ref_data.
    ("GWAS Manhattan plot", "advanced"),
    ("PPI network", "advanced"),
    ("GO enrichment (dot)", "advanced"),
    ("Enrichment (bar)", "advanced"),
    ("Chemical space", "advanced"),
    ("Cohort annotated heatmap", "advanced"),
]

PUBLIC_GALLERY_NAMES = [name for name, _ in PUBLIC_GALLERY_ITEMS]
_PUBLIC_GALLERY_DOMAIN = {name: domain for name, domain in PUBLIC_GALLERY_ITEMS}


def _public_gallery_domain(name: str) -> str:
    return _PUBLIC_GALLERY_DOMAIN[name]


def _curated_gallery_rows(db: Session, root: User) -> list[tuple[Figure, FigureVersion]]:
    rows = (
        db.query(Figure, FigureVersion)
        .join(FigureVersion, Figure.current_version_id == FigureVersion.id)
        .filter(
            Figure.owner_id == root.id,
            Figure.status == "ready",
            Figure.name.in_(PUBLIC_GALLERY_NAMES),
            FigureVersion.png_path.isnot(None),
        )
        .order_by(Figure.updated_at.desc())
        .all()
    )
    latest_by_name: dict[str, tuple[Figure, FigureVersion]] = {}
    for figure, version in rows:
        latest_by_name.setdefault(figure.name, (figure, version))
    return [
        latest_by_name[name]
        for name in PUBLIC_GALLERY_NAMES
        if name in latest_by_name
    ]


def _curated_gallery_row(db: Session, root: User, figure_id: uuid.UUID) -> tuple[Figure, FigureVersion]:
    row = (
        db.query(Figure, FigureVersion)
        .join(FigureVersion, Figure.current_version_id == FigureVersion.id)
        .filter(
            Figure.id == figure_id,
            Figure.owner_id == root.id,
            Figure.name.in_(PUBLIC_GALLERY_NAMES),
            Figure.status == "ready",
            FigureVersion.png_path.isnot(None),
        )
        .first()
    )
    if not row:
        raise NotFoundError("Gallery figure", str(figure_id))
    return row


def _example_data_payload(figure: Figure) -> dict | None:
    dataset = figure.dataset
    if not dataset:
        return None
    return {
        "download_url": f"/api/public/gallery/{figure.id}/example-data",
        "filename": f"{_safe_filename(figure.name)}_example.csv",
        "n_rows": dataset.n_rows,
        "n_cols": dataset.n_cols,
        "columns": dataset.column_profile or [],
        "preview": dataset.preview or [],
    }


def _safe_filename(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()).strip("._-")
    return name or "gallery_template"


@router.get("/gallery")
def public_gallery(limit: int = 12, db: Session = Depends(get_db)):
    limit = max(1, min(limit, 200))
    root = db.query(User).filter(User.email == settings.ROOT_EMAIL).first()
    if not root:
        return {"figures": []}
    figures = []
    for f, v in _curated_gallery_rows(db, root)[:limit]:
        thumb = _url(v.png_path)
        dom = _public_gallery_domain(f.name)
        item = {"id": f.id, "current_version_id": f.current_version_id, "name": f.name,
                "plot_type": f.plot_type, "style_preset": f.style_preset, "thumb_url": thumb,
                "domain": dom, "domain_label": PUBLIC_DOMAIN_LABELS.get(dom, dom)}
        figures.append(item)
    return {"figures": figures}


@router.get("/gallery/{figure_id}/template")
def public_gallery_template(figure_id: uuid.UUID, db: Session = Depends(get_db)):
    root = db.query(User).filter(User.email == settings.ROOT_EMAIL).first()
    if not root:
        raise NotFoundError("Gallery figure", str(figure_id))
    figure, version = _curated_gallery_row(db, root, figure_id)
    dom = _public_gallery_domain(figure.name)
    options = {k: v for k, v in (version.options or {}).items() if k not in {"title", "subtitle"}}
    return {
        "id": figure.id,
        "name": figure.name,
        "plot_type": figure.plot_type,
        "style_preset": version.style_preset or figure.style_preset,
        "thumb_url": _url(version.png_path),
        "domain": dom,
        "domain_label": PUBLIC_DOMAIN_LABELS.get(dom, dom),
        "source_mapping": version.mapping or {},
        "options": options,
        "example_data": _example_data_payload(figure),
    }


@router.get("/gallery/{figure_id}/example-data")
def public_gallery_example_data(figure_id: uuid.UUID, db: Session = Depends(get_db)):
    root = db.query(User).filter(User.email == settings.ROOT_EMAIL).first()
    if not root:
        raise NotFoundError("Gallery figure", str(figure_id))
    figure, _ = _curated_gallery_row(db, root, figure_id)
    if not figure.dataset:
        raise NotFoundError("Gallery example data", str(figure_id))
    df = dataset_service.load_dataframe(figure.dataset)
    content = df.to_csv(index=False).encode("utf-8")
    filename = f"{_safe_filename(figure.name)}_example.csv"
    return Response(
        content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/stats")
def public_stats(db: Session = Depends(get_db)):
    return {"plot_types": len(PLOT_TYPES), "style_presets": len(PRESETS), "palettes": len(list_palettes())}

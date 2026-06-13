#!/usr/bin/env python3
"""Generate example datasets covering every LabPlot AI plot type / feature.

Run:  python3 test_data/generate.py
Writes CSVs next to this script. Deterministic (seeded).
"""
import csv
import math
import os
import random

random.seed(7)
HERE = os.path.dirname(os.path.abspath(__file__))


def w(name, header, rows):
    with open(os.path.join(HERE, name), "w", newline="") as f:
        cw = csv.writer(f)
        cw.writerow(header)
        cw.writerows(rows)
    print(f"  {name:24s} {len(rows)} rows")


# 1) gene_expression — Box / Violin / Bar / Scatter (group vs numeric)
rows = []
for g, mu, vmu in [("Control", 5.0, 92), ("Drug_A", 7.4, 80), ("Drug_B", 6.2, 86), ("Drug_C", 8.1, 71)]:
    for r in range(1, 16):
        expr = round(random.gauss(mu, 1.0), 3)
        via = round(min(100, max(0, random.gauss(vmu, 6))), 2)
        rows.append([f"{g}_{r}", g, expr, via])
w("gene_expression.csv", ["Sample", "Group", "Expression", "Viability"], rows)

# 2) dose_response — Scatter (+regression) / Line (dose-response curve)
rows = []
for comp, ec50, top in [("CompoundX", 12.0, 100), ("CompoundY", 35.0, 95)]:
    for dose in [0, 0.5, 1, 2, 5, 10, 20, 50, 100, 200]:
        for _ in range(3):
            resp = top / (1 + (ec50 / max(dose, 0.01))) + random.gauss(0, 4)
            rows.append([comp, dose, round(resp, 2)])
w("dose_response.csv", ["Compound", "Dose", "Response"], rows)

# 3) time_course — Line / time-course (group trajectories)
rows = []
for trt, k in [("Wildtype", 1.0), ("Knockout", 0.55), ("Rescue", 0.85)]:
    for t in [0, 2, 4, 8, 12, 24, 48]:
        for _ in range(3):
            val = round(12 * k * math.exp(-t / 18) + 1 + random.gauss(0, 0.35), 3)
            rows.append([trt, t, val])
w("time_course.csv", ["Treatment", "Time", "Expression"], rows)

# 4) deg_results — Volcano (DEG: log2FC + p-value/padj)
rows = []
for i in range(400):
    lfc = random.gauss(0, 1.7)
    base = round(random.uniform(5, 5000), 1)
    # more extreme fold-changes tend to be more significant
    p = max(1e-30, (random.random() ** (1 + abs(lfc) * 1.1)))
    padj = min(1.0, p * 1.4)
    rows.append([f"GENE_{i+1:04d}", base, round(lfc, 3), float(f"{p:.3e}"), float(f"{padj:.3e}")])
w("deg_results.csv", ["Gene", "baseMean", "log2FC", "pvalue", "padj"], rows)

# 5) expression_matrix — Heatmap (gene × sample matrix)
samples = ["Ctrl_1", "Ctrl_2", "Ctrl_3", "Trt_1", "Trt_2", "Trt_3"]
rows = []
for i in range(40):
    base = random.uniform(3, 11)
    up_in_trt = (i % 3 == 0)
    row = [f"GENE_{i+1:03d}"]
    for s in samples:
        v = base + random.gauss(0, 0.6) + (1.8 if (up_in_trt and s.startswith("Trt")) else 0)
        row.append(round(v, 3))
    rows.append(row)
w("expression_matrix.csv", ["Gene"] + samples, rows)

# 6) pca_samples — PCA (samples × features, grouped clusters)
feats = [f"Feature{i}" for i in range(1, 13)]
rows = []
for grp, shift in [("Tumor", 2.0), ("Normal", -2.0), ("Metastatic", 4.0)]:
    for n in range(8):
        row = [f"{grp}_{n+1}", grp]
        for j, _ in enumerate(feats):
            row.append(round(random.gauss(shift if j % 2 == 0 else -shift / 2, 1.2), 3))
        rows.append(row)
w("pca_samples.csv", ["Sample", "Group"] + feats, rows)

# 7) survival — Kaplan-Meier (time + status + group)
rows = []
for arm, scale, evp in [("Standard", 12, 0.72), ("Experimental", 24, 0.6)]:
    for n in range(45):
        t = round(min(60, random.expovariate(1 / scale)), 1)
        status = 1 if random.random() < evp else 0
        sex = random.choice(["M", "F"])
        rows.append([f"PT_{arm[:3]}_{n+1}", t, status, arm, sex])
w("survival.csv", ["PatientID", "time", "status", "arm", "sex"], rows)

print("Done.")

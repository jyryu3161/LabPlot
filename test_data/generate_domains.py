#!/usr/bin/env python3
"""Domain example datasets: cancer cohort, PPI/metabolic networks, enrichment,
GWAS, compound descriptors, and engineering response data.

Run: python3 test_data/generate_domains.py
"""
import csv, math, os, random
random.seed(11)
HERE = os.path.dirname(os.path.abspath(__file__))


def w(name, header, rows):
    with open(os.path.join(HERE, name), "w", newline="") as f:
        cw = csv.writer(f); cw.writerow(header); cw.writerows(rows)
    print(f"  {name:26s} {len(rows)} rows")


# 1) cancer_cohort — annotated heatmap (rows=patients, gene features + annotations)
genes = [f"GENE_{i}" for i in range(1, 16)]
rows = []
for i in range(60):
    grp = "Tumor" if i < 40 else "Normal"
    stage = random.choice(["I", "II", "III", "IV"]) if grp == "Tumor" else "NA"
    age = random.randint(38, 82)
    vals = []
    for j, _ in enumerate(genes):
        base = random.gauss(0, 1)
        if grp == "Tumor" and j % 3 == 0:
            base += 2.2  # upregulated module in tumors
        if grp == "Tumor" and j % 4 == 1:
            base -= 1.6
        vals.append(round(base, 3))
    rows.append([f"PT{i+1:03d}", grp, stage, age] + vals)
w("cancer_cohort.csv", ["PatientID", "Group", "Stage", "Age"] + genes, rows)

# 2) ppi_network — gene/protein interaction edges
hub_genes = ["TP53", "EGFR", "MYC", "AKT1", "PTEN", "BRCA1", "KRAS", "STAT3"]
other = [f"G{i}" for i in range(1, 22)]
nodes = hub_genes + other
rows = []
seen = set()
for _ in range(70):
    a = random.choice(hub_genes if random.random() < 0.6 else nodes)
    b = random.choice(nodes)
    if a == b:
        continue
    key = tuple(sorted((a, b)))
    if key in seen:
        continue
    seen.add(key)
    rows.append([a, b, round(random.uniform(0.2, 1.0), 2)])
w("ppi_network.csv", ["source", "target", "weight"], rows)

# 3) metabolic_network — metabolite ↔ reaction edges
mets = ["Glucose", "G6P", "F6P", "Pyruvate", "Acetyl-CoA", "Citrate", "Lactate", "ATP", "NADH", "Oxaloacetate", "Malate", "Succinate"]
rxns = ["HK", "PFK", "PK", "PDH", "CS", "LDH", "MDH", "SDH"]
edges = [("Glucose", "HK"), ("HK", "G6P"), ("G6P", "PFK"), ("PFK", "F6P"), ("F6P", "PK"), ("PK", "Pyruvate"),
         ("Pyruvate", "PDH"), ("PDH", "Acetyl-CoA"), ("Acetyl-CoA", "CS"), ("CS", "Citrate"),
         ("Pyruvate", "LDH"), ("LDH", "Lactate"), ("Oxaloacetate", "CS"), ("Citrate", "Succinate"),
         ("Succinate", "SDH"), ("SDH", "Malate"), ("Malate", "MDH"), ("MDH", "Oxaloacetate"),
         ("PK", "ATP"), ("PDH", "NADH"), ("MDH", "NADH")]
w("metabolic_network.csv", ["source", "target"], [[a, b] for a, b in edges])

# 4) enrichment — GO/KEGG-style enrichment results
terms = ["Cell cycle", "DNA replication", "Apoptosis", "p53 signaling", "Immune response",
         "Oxidative phosphorylation", "MAPK signaling", "Cell adhesion", "Angiogenesis",
         "Wnt signaling", "Inflammatory response", "Glycolysis", "Fatty acid metabolism",
         "T cell activation", "Extracellular matrix"]
rows = []
for t in terms:
    count = random.randint(5, 60)
    ratio = round(count / random.randint(120, 400), 3)
    nl = round(random.uniform(1.5, 12), 2)          # -log10(p.adjust)
    padj = float(f"{10 ** (-nl):.3e}")
    rows.append([t, ratio, count, padj, nl])
w("enrichment.csv", ["Description", "GeneRatio", "Count", "p.adjust", "neg_log10_padj"], rows)

# 5) gwas — Manhattan
rows = []
for chrom in range(1, 23):
    n = random.randint(60, 160)
    for k in range(n):
        bp = random.randint(1, 250_000_000)
        # mostly null, a few hits
        p = random.uniform(0, 1)
        if random.random() < 0.01:
            p = 10 ** (-random.uniform(8, 14))
        rows.append([f"rs{chrom}_{k}", chrom, bp, round(p, 10)])
w("gwas.csv", ["SNP", "CHR", "BP", "P"], rows)

# 6) compounds — cheminformatics descriptors
rows = []
for i in range(140):
    active = random.random() < 0.4
    mw = round(random.gauss(360 if active else 300, 70), 1)
    logp = round(random.gauss(3.2 if active else 2.1, 1.1), 2)
    tpsa = round(random.gauss(75, 25), 1)
    hbd = random.randint(0, 5)
    rows.append([f"CHEMBL{1000+i}", mw, logp, tpsa, hbd, "active" if active else "inactive"])
w("compounds.csv", ["Compound", "MW", "LogP", "TPSA", "HBD", "Activity"], rows)

# 7) response_surface — gridded x/y/z data for contour / response-surface plots
rows = []
for temperature in range(40, 101, 5):
    for pressure in range(10, 61, 5):
        peak = 82 - 0.035 * (temperature - 70) ** 2 - 0.055 * (pressure - 35) ** 2
        ripple = 2.5 * math.sin(temperature / 12) * math.cos(pressure / 9)
        rows.append([temperature, pressure, round(peak + ripple + random.gauss(0, 0.8), 3)])
w("response_surface.csv", ["Temperature", "Pressure", "Yield"], rows)

# 8) tensile_test — mean ± sd by material and strain rate
rows = []
for material, base in [("Alloy_A", 410), ("Alloy_B", 455), ("Composite_C", 520)]:
    for rate, shift in [(0.1, -18), (1.0, 0), (10.0, 25)]:
        mean = base + shift + random.gauss(0, 5)
        sd = random.uniform(8, 18)
        rows.append([material, rate, round(mean, 2), round(sd, 2), round(mean - sd, 2), round(mean + sd, 2)])
w("tensile_test.csv", ["Material", "StrainRate", "StrengthMean", "StrengthSD", "Lower", "Upper"], rows)

# 9) sensor_timeseries — mean signal with confidence ribbon
rows = []
for sensor, phase in [("Sensor_A", 0.0), ("Sensor_B", 0.8)]:
    for t in range(0, 121, 4):
        mean = 50 + 12 * math.sin(t / 18 + phase) + 0.08 * t
        band = 3.2 + 1.1 * abs(math.cos(t / 22 + phase))
        rows.append([sensor, t, round(mean, 3), round(mean - band, 3), round(mean + band, 3)])
w("sensor_timeseries.csv", ["Sensor", "Time", "SignalMean", "Lower", "Upper"], rows)

# 10) material_profile — multivariate radar profile
metrics = ["Strength", "Ductility", "Conductivity", "Thermal stability", "Corrosion resistance", "Cost efficiency"]
rows = []
for material, center in [("Alloy_A", 72), ("Alloy_B", 68), ("Composite_C", 80)]:
    for idx, metric in enumerate(metrics):
        value = max(10, min(100, center + 14 * math.sin(idx + len(material)) + random.gauss(0, 4)))
        rows.append([material, metric, round(value, 2)])
w("material_profile.csv", ["Material", "Metric", "Score"], rows)

print("Done.")

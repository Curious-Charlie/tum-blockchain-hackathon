"""Replication script for Matejka & Fitzmaurice (CHI 2017), "Same Stats, Different Graphs".

Recomputes the summary statistics the paper reports for its published datasets:
x/y mean, x/y sample standard deviation and Pearson's correlation, per dataset.

    python3 -I reproduce.py        # stdlib only, runs in well under a second

Inputs:  data/*-Long.tsv   (columns: dataset, x, y)
Outputs: results/summary_<collection>.csv, full precision, one row per dataset
"""
import csv
import hashlib
import math
import os
import platform
import sys

DATA_DIR = "data"
OUT_DIR = "results"


def summarize(xs, ys):
    n = len(xs)
    mx = math.fsum(xs) / n
    my = math.fsum(ys) / n
    sx = math.sqrt(math.fsum((x - mx) ** 2 for x in xs) / (n - 1))
    sy = math.sqrt(math.fsum((y - my) ** 2 for y in ys) / (n - 1))
    r = math.fsum((x - mx) * (y - my) for x, y in zip(xs, ys)) / ((n - 1) * sx * sy)
    return n, mx, my, sx, sy, r


def main():
    print("python", platform.python_version(), platform.machine())
    os.makedirs(OUT_DIR, exist_ok=True)
    for name in sorted(os.listdir(DATA_DIR)):
        if not name.endswith("-Long.tsv"):
            continue
        path = os.path.join(DATA_DIR, name)
        with open(path, "rb") as fh:
            print("input", path, "sha256", hashlib.sha256(fh.read()).hexdigest())
        groups = {}
        with open(path, newline="") as fh:
            reader = csv.reader(fh, delimiter="\t")
            header = next(reader)
            assert header[:3] == ["dataset", "x", "y"], header
            for row in reader:
                xs, ys = groups.setdefault(row[0], ([], []))
                xs.append(float(row[1]))
                ys.append(float(row[2]))
        collection = name[: -len("-Long.tsv")]
        out = os.path.join(OUT_DIR, "summary_%s.csv" % collection)
        with open(out, "w", newline="") as fh:
            writer = csv.writer(fh, lineterminator="\n")
            writer.writerow(["dataset", "n", "x_mean", "y_mean", "x_sd", "y_sd", "pearson_r"])
            for dataset in sorted(groups):
                stats = summarize(*groups[dataset])
                writer.writerow([dataset, stats[0]] + [repr(v) for v in stats[1:]])
        print("wrote", out, "datasets", len(groups), "rows", sum(len(g[0]) for g in groups.values()))
    return 0


if __name__ == "__main__":
    sys.exit(main())

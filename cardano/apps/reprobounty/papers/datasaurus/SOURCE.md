# Demo paper and replication package

**Paper:** Justin Matejka and George Fitzmaurice. 2017. *Same Stats, Different Graphs: Generating Datasets with Varied Appearance and Identical Statistics through Simulated Annealing.* CHI 2017, pp. 1290–1294. DOI [10.1145/3025453.3025912](https://doi.org/10.1145/3025453.3025912). Author copy: https://www.research.autodesk.com/app/uploads/2023/03/same-stats-different-graphs.pdf_rec2hRjLLGgM7Cn2T.pdf

**Claims reproduced:** Figure 6 caption: the 13 "Datasaurus Dozen" datasets share x̄ = 54.26, ȳ = 47.83, sd_x = 16.76, sd_y = 26.93, Pearson's r = -0.06 "to two decimal places". (Figure 1 makes the same kind of claim for 12 datasets seeded from a slanted cloud; its data is in the package too.)

**Why this paper:** real and well known, public data, a numeric claim the reader can check, runs in under a second with the Python standard library (no installs on stage).

| File | What | Source | License |
|---|---|---|---|
| `paper.md` | excerpt of the passages with numeric results (verbatim quotes) | the paper | © the authors, publication rights ACM; short quotation |
| `paper-altered.md` | **demo copy**, identical except Fig. 6 says r = -0.60 instead of -0.06 | ours | — |
| `package/data/DatasaurusDozen-Long.tsv` | Fig. 6 datasets (13 × 142 points) | [jumpingrivers/datasauRus](https://github.com/jumpingrivers/datasauRus) `inst/extdata/`, commit `269706b98d171fe52258e4a7288e26e1b37512f5` | MIT (`package/LICENSE-data.md`); data by Matejka & Fitzmaurice, Autodesk Research, from Alberto Cairo's Datasaurus |
| `package/data/TwelveFromSlant-Long.tsv` | Fig. 1 datasets (12 × 182 points) | same commit | MIT |
| `package/reproduce.py` | replication script (stdlib only) | ours | MIT |

sha256: `DatasaurusDozen-Long.tsv` c8c4792c3ed15238ba07dad6ab778adc79d72e3e1324ead4d8c1ae52849780f8, `TwelveFromSlant-Long.tsv` 0c6ff43ad207321e34267e4f712d272d63231fb5aad78aa58982c65373a06f4b.

**Finding on the way:** the computed statistics match the paper only if "to two decimal places" means *truncation*: sd_x is 16.7600–16.7700 across the 13 datasets (paper: 16.76), so round-half-up would give 16.77 for 12 of them. 65/65 values match when truncated, 20/65 when rounded. The checker therefore accepts |computed − claimed| < one unit in the last printed digit, which covers both conventions.

The authors' own code (the simulated annealing generator, ~10 min per dataset) is not re-run; the reproduction checks the published statistical claims against the published data.

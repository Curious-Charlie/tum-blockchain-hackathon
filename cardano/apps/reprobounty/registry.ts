/**
 * What the agents know about papers and replication packages.
 *
 * Compute and Verifier only run code from this allowlist: each package is a
 * vendored snapshot of a public repository pinned to a commit (in production
 * they would clone repo@commit themselves and compare the tree hash).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export interface ReplicationPackage {
  repo: string;
  commit: string;
  license: string;
  /** Local snapshot of repo@commit plus the replication script. */
  dir: string;
  /** Fixed entry point: Compute never runs a command sent by the buyer. */
  command: string[];
  /** Step the Verifier re-runs: input file → output file of the statistics step. */
  rerun: { input: string; output: string }[];
}

export const PACKAGES: ReplicationPackage[] = [
  {
    repo: "https://github.com/jumpingrivers/datasauRus",
    commit: "269706b98d171fe52258e4a7288e26e1b37512f5",
    license: "MIT (datasauRus authors); data by Matejka & Fitzmaurice, Autodesk Research",
    dir: here("./papers/datasaurus/package"),
    command: ["python3", "-I", "reproduce.py"],
    rerun: [
      { input: "data/DatasaurusDozen-Long.tsv", output: "results/summary_DatasaurusDozen.csv" },
      { input: "data/TwelveFromSlant-Long.tsv", output: "results/summary_TwelveFromSlant.csv" },
    ],
  },
];

export function findPackage(repo: string, commit: string): ReplicationPackage | undefined {
  const norm = (url: string) => url.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  return PACKAGES.find((p) => norm(p.repo) === norm(repo) && p.commit === commit);
}

export interface Paper {
  doi: string;
  title: string;
  manuscript: string;
}

const DATASAURUS = {
  doi: "10.1145/3025453.3025912",
  title: "Same Stats, Different Graphs (Matejka & Fitzmaurice, CHI 2017)",
};

/** The demo papers: the real excerpt, and a copy with one number changed (Fig. 6: r = -0.60 instead of -0.06). */
export function demoPaper(altered: boolean): Paper {
  const file = altered ? "./papers/datasaurus/paper-altered.md" : "./papers/datasaurus/paper.md";
  return {
    doi: DATASAURUS.doi,
    title: altered ? `${DATASAURUS.title} [altered demo copy]` : DATASAURUS.title,
    manuscript: readFileSync(here(file), "utf8"),
  };
}

export const DEMO_TARGET =
  "Figure 6: the summary statistics (x mean, y mean, x sd, y sd, Pearson's r) that every dataset of the Datasaurus Dozen shares";

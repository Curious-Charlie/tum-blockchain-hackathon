/**
 * The Verifier's independent re-implementation of the package's statistics
 * step (TypeScript, not the replicator's Python), used to re-run one step.
 */
export interface Summary {
  dataset: string;
  n: number;
  x_mean: number;
  y_mean: number;
  x_sd: number;
  y_sd: number;
  pearson_r: number;
}

/** Summary statistics per dataset of a long TSV (dataset, x, y). */
export function summarizeTsv(tsv: string): Summary[] {
  const groups = new Map<string, { xs: number[]; ys: number[] }>();
  const [header, ...lines] = tsv.trim().split("\n");
  if (!header?.startsWith("dataset\tx\ty")) throw new Error("unexpected TSV header");
  for (const line of lines) {
    const [dataset, x, y] = line.split("\t");
    const group = groups.get(dataset!) ?? { xs: [], ys: [] };
    group.xs.push(Number(x));
    group.ys.push(Number(y));
    groups.set(dataset!, group);
  }
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return [...groups].map(([dataset, { xs, ys }]) => {
    const n = xs.length;
    const mx = sum(xs) / n;
    const my = sum(ys) / n;
    const sx = Math.sqrt(sum(xs.map((x) => (x - mx) ** 2)) / (n - 1));
    const sy = Math.sqrt(sum(ys.map((y) => (y - my) ** 2)) / (n - 1));
    const r = sum(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / ((n - 1) * sx * sy);
    return { dataset, n, x_mean: mx, y_mean: my, x_sd: sx, y_sd: sy, pearson_r: r };
  });
}

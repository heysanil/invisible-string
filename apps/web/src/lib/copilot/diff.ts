/**
 * Tiny line diff for instruction previews — LCS over lines, no dependency.
 * Output is a flat list of rows the DiffView renders in order.
 */

export interface DiffRow {
  kind: "same" | "add" | "del";
  text: string;
}

export function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // LCS length table (n+1 × m+1). Instruction docs are small; O(n·m) is fine.
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      rows.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      rows.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++]! });
  while (j < m) rows.push({ kind: "add", text: b[j++]! });
  return rows;
}

/** Collapse long runs of unchanged lines to keep preview cards short. */
export function collapseContext(
  rows: readonly DiffRow[],
  context = 2,
): (DiffRow | { kind: "gap"; count: number })[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === "same") return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(rows.length - 1, index + context);
      k++
    ) {
      keep[k] = true;
    }
  });
  const out: (DiffRow | { kind: "gap"; count: number })[] = [];
  let gap = 0;
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (gap > 0) {
        out.push({ kind: "gap", count: gap });
        gap = 0;
      }
      out.push(row);
    } else {
      gap += 1;
    }
  });
  if (gap > 0) out.push({ kind: "gap", count: gap });
  return out;
}

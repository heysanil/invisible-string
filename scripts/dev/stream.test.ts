import { describe, expect, test } from "bun:test";

import { PREFIX_COLORS, createLinePrefixer } from "./stream";

// Strip ANSI escapes so assertions read plainly.
function plain(lines: string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
}

describe("createLinePrefixer", () => {
  test("prefixes each complete line with the padded tag", () => {
    const p = createLinePrefixer("api", PREFIX_COLORS.api);
    expect(plain(p.push("hello\nworld\n"))).toEqual(["api   │ hello", "api   │ world"]);
  });

  test("holds partial lines across chunks", () => {
    const p = createLinePrefixer("web", PREFIX_COLORS.web);
    expect(p.push("par")).toEqual([]);
    expect(plain(p.push("tial\nnext"))).toEqual(["web   │ partial"]);
    expect(plain(p.flush())).toEqual(["web   │ next"]);
  });

  test("flush is empty when nothing is buffered", () => {
    const p = createLinePrefixer("worker", PREFIX_COLORS.worker);
    p.push("done\n");
    expect(p.flush()).toEqual([]);
  });

  test("strips a trailing carriage return per line", () => {
    const p = createLinePrefixer("api", PREFIX_COLORS.api);
    expect(plain(p.push("crlf\r\n"))).toEqual(["api   │ crlf"]);
  });

  test("colors wrap the prefix and reset before content", () => {
    const p = createLinePrefixer("api", PREFIX_COLORS.api);
    const [line] = p.push("x\n");
    expect(line).toStartWith(PREFIX_COLORS.api);
    expect(line).toContain("\x1b[0m");
    expect(line).toEndWith("x");
  });
});

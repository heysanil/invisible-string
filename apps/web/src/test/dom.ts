/**
 * Absence assertions that never hand a DOM node to bun's `expect`.
 *
 * `expect(view.queryByText(…)).toBeNull()` is the natural way to say "gone",
 * and it is fine when it PASSES. When it fails — every poll of a `waitFor`
 * before the UI catches up — bun's `expect` renders the received value into
 * the error message, and a happy-dom element is a huge cyclic object graph
 * (owner document, parent chain, live collections): one failed poll costs
 * ~2.2 s on an M-series laptop (measured on `chat-shell-entry`'s optimistic
 * thread; RTL's own `getBy*` miss, which pretty-prints a bounded DOM slice,
 * costs 1 ms). Inside `waitFor` that turns a 50 ms poll into seconds per
 * attempt, and on a slower CI runner the test blows through bun's 5 s default
 * — the failure looked like latency; it was error formatting nobody reads.
 *
 * `expectAbsent` throws a plain Error naming the offending element instead,
 * so a `waitFor` poll fails in microseconds and the final failure message is
 * still legible.
 */
export function expectAbsent(query: () => Element | null, what = "element"): void {
  const found = query();
  if (found === null) return;
  const text = (found.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  throw new Error(
    `expected ${what} to be absent, found <${found.tagName.toLowerCase()}>${
      text.length > 0 ? ` "${text}"` : ""
    }`,
  );
}

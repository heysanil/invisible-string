import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { App } from "./App";

test("App renders the product name", () => {
  expect(renderToString(<App />)).toContain("invisible-string");
});

/**
 * WIRE PROBE — copied into a rendered agent project by `eve-build.test.ts` and
 * run there with the project's own node_modules (Node 24, so the emitted
 * `agent/agent.ts` imports directly via type stripping).
 *
 * It answers ONE question with bytes rather than a source-read: does the
 * reasoning effort the compiler emitted actually reach the OpenRouter request
 * body? It stands up a stub gateway, points the generated
 * `OPENROUTER_BASE_URL` branch at it, imports the REAL emitted agent module,
 * and calls the model it constructed.
 *
 * Two calls, deliberately:
 *  1. a plain turn — what the artifact sends;
 *  2. the same turn with `reasoning` passed as a CALL OPTION, which is exactly
 *     the route eve's tool loop uses (`new ToolLoopAgent({ …, reasoning })` →
 *     `LanguageModelV4CallOptions.reasoning`). Its body must be IDENTICAL:
 *     that is spike finding 29 — the provider drops the call option — proven
 *     empirically instead of read out of `dist/index.js`.
 *
 * The env is set HERE, before the dynamic import, because the generated
 * `resolveModel()` reads `process.env` while the module is evaluating.
 *
 * Output: one line, `__WIRE_PROBE__<json>`, so the runner can ignore whatever
 * else the process prints.
 */
import { createServer } from "node:http";

const captured = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    captured.push({ path: req.url, body });
    // Minimal OpenAI-shaped completion: enough for the provider to parse a
    // response, since a throw here would mask the body we came for.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "wire-probe",
        object: "chat.completion",
        created: 0,
        model: "wire-probe",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "ok" },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

process.env.OPENROUTER_API_KEY = "wire-probe-key";
process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:" + port + "/api/v1";

const agent = (await import("./agent/agent.ts")).default;
const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

await agent.model.doGenerate({ prompt });
// eve's own route for the effort — must change nothing.
await agent.model.doGenerate({ prompt, reasoning: "low" });

server.close();
console.log("__WIRE_PROBE__" + JSON.stringify(captured));

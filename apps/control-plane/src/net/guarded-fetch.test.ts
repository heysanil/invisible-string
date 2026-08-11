import { describe, expect, test } from "bun:test";

import {
  createGuardedFetch,
  EgressBlockedError,
  isForbiddenIp,
} from "./guarded-fetch";

describe("isForbiddenIp", () => {
  const forbidden = [
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.1.1",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
  ];
  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700:4700::1111",
  ];
  for (const ip of forbidden)
    test(`${ip} forbidden`, () => expect(isForbiddenIp(ip)).toBe(true));
  for (const ip of allowed)
    test(`${ip} allowed`, () => expect(isForbiddenIp(ip)).toBe(false));
});

describe("createGuardedFetch", () => {
  test("rejects http when private not allowed", async () => {
    const gf = createGuardedFetch({ allowPrivate: false });
    await expect(gf("http://example.com/")).rejects.toThrow(EgressBlockedError);
  });

  test("rejects a hostname resolving to loopback", async () => {
    const gf = createGuardedFetch({ allowPrivate: false });
    await expect(gf("https://localhost/")).rejects.toThrow(EgressBlockedError);
  });

  test("allowPrivate serves a local http server, and caps response size", async () => {
    using srv = Bun.serve({ port: 0, fetch: () => new Response("x".repeat(64)) });
    const gf = createGuardedFetch({ allowPrivate: true, maxResponseBytes: 16 });
    const res = await gf(`http://127.0.0.1:${srv.port}/`);
    await expect(res.text()).rejects.toThrow(/response too large/i);
  });

  test("cross-origin redirect refused", async () => {
    using srv = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/" },
        }),
    });
    const gf = createGuardedFetch({ allowPrivate: true });
    await expect(gf(`http://127.0.0.1:${srv.port}/`)).rejects.toThrow(
      EgressBlockedError,
    );
  });
});

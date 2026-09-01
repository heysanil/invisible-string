import { describe, expect, test } from "bun:test";

import { ConfigError } from "../config";
import {
  findOauthClientRegistration,
  loadOauthClientRegistrations,
  publicWebUrlFromEnv,
} from "./config";

describe("publicWebUrlFromEnv (F8 — postMessage target origin)", () => {
  test("defaults to the public app origin, so single-origin prod is unchanged", () => {
    expect(publicWebUrlFromEnv({ PUBLIC_APP_URL: "https://app.example.com" })).toBe(
      "https://app.example.com",
    );
    expect(publicWebUrlFromEnv({ BETTER_AUTH_URL: "https://app.example.com" })).toBe(
      "https://app.example.com",
    );
    expect(publicWebUrlFromEnv({})).toBe("http://localhost:3000");
  });

  test("splits the API origin from the SPA origin (the local-dev case)", () => {
    expect(
      publicWebUrlFromEnv({
        PUBLIC_APP_URL: "http://localhost:3000",
        PUBLIC_WEB_URL: "http://localhost:5173",
      }),
    ).toBe("http://localhost:5173");
  });

  test("normalizes to a bare origin — postMessage compares origins, not URLs", () => {
    expect(publicWebUrlFromEnv({ PUBLIC_WEB_URL: "https://app.example.com/app/" })).toBe(
      "https://app.example.com",
    );
    expect(publicWebUrlFromEnv({ PUBLIC_WEB_URL: " https://APP.example.com:443 " })).toBe(
      "https://app.example.com",
    );
  });

  test("rejects anything that is not an absolute http(s) origin", () => {
    for (const raw of ["/app", "app.example.com", "javascript:alert(1)", "data:,x"]) {
      expect(() => publicWebUrlFromEnv({ PUBLIC_WEB_URL: raw })).toThrow(
        /PUBLIC_WEB_URL/,
      );
    }
  });

  test("an empty value is 'unset', not an error", () => {
    expect(
      publicWebUrlFromEnv({ PUBLIC_APP_URL: "https://app.example.com", PUBLIC_WEB_URL: "  " }),
    ).toBe("https://app.example.com");
  });
});

describe("loadOauthClientRegistrations (pre-registered OAuth clients)", () => {
  test("is empty when nothing is configured", () => {
    expect(loadOauthClientRegistrations({}).size).toBe(0);
  });

  test("reads id + secret + issuer under a lower-kebab provider key", () => {
    const regs = loadOauthClientRegistrations({
      MCP_OAUTH_VERCEL_CLIENT_ID: "cl_vercel",
      MCP_OAUTH_VERCEL_CLIENT_SECRET: "sh-secret",
      MCP_OAUTH_VERCEL_ISSUER: "https://vercel.com/",
    });
    expect(regs.get("vercel")).toEqual({
      key: "vercel",
      clientId: "cl_vercel",
      clientSecret: "sh-secret",
      issuer: "https://vercel.com",
    });
  });

  test("maps underscores in the key segment to the catalog's kebab slugs", () => {
    const regs = loadOauthClientRegistrations({
      MCP_OAUTH_HUGGING_FACE_CLIENT_ID: "cl_hf",
    });
    expect([...regs.keys()]).toEqual(["hugging-face"]);
    expect(regs.get("hugging-face")).toEqual({
      key: "hugging-face",
      clientId: "cl_hf",
      clientSecret: null,
      issuer: null,
    });
  });

  test("carries more than one provider", () => {
    const regs = loadOauthClientRegistrations({
      MCP_OAUTH_VERCEL_CLIENT_ID: "cl_vercel",
      MCP_OAUTH_NOTION_CLIENT_ID: "cl_notion",
    });
    expect([...regs.keys()].sort()).toEqual(["notion", "vercel"]);
  });

  test("a secret with no client id is a boot failure that never echoes the secret", () => {
    let thrown: unknown;
    try {
      loadOauthClientRegistrations({ MCP_OAUTH_VERCEL_CLIENT_SECRET: "sh-secret" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as Error).message;
    expect(message).toContain("MCP_OAUTH_VERCEL_CLIENT_ID");
    expect(message).not.toContain("sh-secret");
  });

  test("rejects an unparseable issuer and an unknown suffix", () => {
    expect(() =>
      loadOauthClientRegistrations({
        MCP_OAUTH_VERCEL_CLIENT_ID: "cl_vercel",
        MCP_OAUTH_VERCEL_ISSUER: "vercel.com",
      }),
    ).toThrow(/MCP_OAUTH_VERCEL_ISSUER/);
    expect(() =>
      loadOauthClientRegistrations({ MCP_OAUTH_VERCEL_TOKEN_URL: "https://x.test" }),
    ).toThrow(/MCP_OAUTH_VERCEL_TOKEN_URL/);
  });
});

describe("findOauthClientRegistration", () => {
  const regs = loadOauthClientRegistrations({
    MCP_OAUTH_VERCEL_CLIENT_ID: "cl_vercel",
    MCP_OAUTH_VERCEL_ISSUER: "https://vercel.com",
    MCP_OAUTH_ACME_CLIENT_ID: "cl_acme",
  });

  test("matches on the catalog slug", () => {
    expect(findOauthClientRegistration(regs, { key: "vercel" })?.clientId).toBe(
      "cl_vercel",
    );
    expect(findOauthClientRegistration(regs, { key: "acme" })?.clientId).toBe("cl_acme");
  });

  test("accepts the catalog's env-shaped clientEnvPrefix verbatim", () => {
    const hf = loadOauthClientRegistrations({
      MCP_OAUTH_HUGGING_FACE_CLIENT_ID: "cl_hf",
    });
    expect(findOauthClientRegistration(regs, { key: "VERCEL" })?.clientId).toBe(
      "cl_vercel",
    );
    expect(findOauthClientRegistration(hf, { key: "HUGGING_FACE" })?.clientId).toBe(
      "cl_hf",
    );
    expect(findOauthClientRegistration(hf, { key: "hugging-face" })?.clientId).toBe(
      "cl_hf",
    );
  });

  test("matches on the discovered issuer, canonicalized", () => {
    expect(
      findOauthClientRegistration(regs, { issuer: "https://VERCEL.com/" })?.clientId,
    ).toBe("cl_vercel");
  });

  test("refuses to hand a pinned client id to a different authorization server", () => {
    expect(
      findOauthClientRegistration(regs, { key: "vercel", issuer: "https://evil.test" }),
    ).toBeUndefined();
  });

  test("an unpinned registration is usable against any issuer", () => {
    expect(
      findOauthClientRegistration(regs, { key: "acme", issuer: "https://acme.test" })
        ?.clientId,
    ).toBe("cl_acme");
  });

  test("an unknown key falls through to the issuer, and misses are undefined", () => {
    expect(
      findOauthClientRegistration(regs, { key: "nope", issuer: "https://vercel.com" })
        ?.clientId,
    ).toBe("cl_vercel");
    expect(findOauthClientRegistration(regs, { key: "nope" })).toBeUndefined();
    expect(findOauthClientRegistration(regs, {})).toBeUndefined();
  });
});

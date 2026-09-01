/**
 * The credential-echo defence (2026-08-31 review, finding "AS-controlled error
 * strings"). Every hop that reads a provider `error` — refresh, code exchange,
 * dynamic registration — sends a credential on the way IN, so a hostile or
 * repointed authorization server can answer with the secret it just received.
 * The resulting message is persisted to `connections.last_error` and returned
 * by `connectionDto`, so anything that survives this module is published.
 */
import { describe, expect, test } from "bun:test";

import {
  describeProviderFailure,
  isTerminalTokenError,
  providerErrorCode,
} from "./error-codes";

describe("providerErrorCode", () => {
  test("accepts the RFC vocabularies", () => {
    for (const code of [
      "invalid_grant",
      "invalid_client",
      "invalid_scope",
      "access_denied",
      "temporarily_unavailable",
      "invalid_redirect_uri", // RFC 7591 — the code Vercel actually returns
      "slow_down",
      "insufficient_scope",
    ]) {
      expect(providerErrorCode(code)).toBe(code);
    }
  });

  test("forgives case and surrounding space, which servers get wrong", () => {
    expect(providerErrorCode("  Invalid_Grant ")).toBe("invalid_grant");
  });

  test("rejects anything outside the vocabulary", () => {
    for (const junk of [
      "totally_made_up",
      "",
      "   ",
      null,
      undefined,
      42,
      { error: "invalid_grant" },
      ["invalid_grant"],
    ]) {
      expect(providerErrorCode(junk)).toBeNull();
    }
  });

  /**
   * The whole point. A character class of `[a-zA-Z0-9_-]` — the obvious
   * "machine code" shape — IS the base64url alphabet, so opaque tokens pass it
   * unchanged. These are the shapes real credentials take.
   */
  test("rejects credential-shaped values, including base64url tokens", () => {
    const credentials = [
      "1a2b3c4d5e6f7g8h9i0j", // short opaque token: passes [a-zA-Z0-9_-]+
      "ya29.a0AfB_byC-9xKq",
      "gho_16C7e42F292c69",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
      "rt_9f8e7d6c5b4a3210",
      "v1.MRjdkjw_ZmM2ZjE",
      "sk-proj-aBcDeFgHiJkLmNoP",
    ];
    for (const credential of credentials) {
      expect(providerErrorCode(credential)).toBeNull();
      // And, decisively: it cannot reach a message.
      expect(describeProviderFailure(400, credential)).not.toContain(
        credential,
      );
      expect(describeProviderFailure(400, credential)).toBe("HTTP 400");
    }
  });
});

describe("describeProviderFailure", () => {
  test("names a recognised code, and only the status otherwise", () => {
    expect(describeProviderFailure(400, "invalid_grant")).toBe(
      "HTTP 400: invalid_grant",
    );
    expect(describeProviderFailure(503, null)).toBe("HTTP 503");
    expect(describeProviderFailure(500, "internal explosion at line 42")).toBe(
      "HTTP 500",
    );
  });
});

describe("isTerminalTokenError", () => {
  test("a disowned grant or client is terminal", () => {
    for (const code of [
      "invalid_grant",
      "invalid_client",
      "unauthorized_client",
      "unsupported_grant_type",
      "invalid_scope",
    ]) {
      expect(isTerminalTokenError(code)).toBeTrue();
    }
  });

  /**
   * These previously all collapsed into one "transient" bucket alongside the
   * genuinely transient ones, so a permanently dead grant stayed `connected`,
   * retried under the row lock forever, and told the user the server was
   * merely unreachable.
   */
  test("transport trouble and unknown codes stay retryable", () => {
    for (const code of [
      "server_error",
      "temporarily_unavailable",
      "slow_down",
      "invalid_request", // indicts our request, not the grant — deliberately not terminal
      "something_unknown",
      null,
    ]) {
      expect(isTerminalTokenError(code)).toBeFalse();
    }
  });
});

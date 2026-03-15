import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { buildDigestHeader } from "../../src/utils/digest.js";

function md5(data: string): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

// RFC 2617 test vector constants
const REALM = "testrealm@host.com";
const NONCE = "dcd98b7102dd2f0e8b11d0f600bfb0c093";
const USERNAME = "Mufasa";
const PASSWORD = "Circle Of Life";

describe("buildDigestHeader – error cases", () => {
  it("throws when realm is missing from WWW-Authenticate", () => {
    expect(() =>
      buildDigestHeader("GET", "/uri", "u", "p", `Digest nonce="${NONCE}"`)
    ).toThrow("Invalid WWW-Authenticate header: missing realm or nonce");
  });

  it("throws when nonce is missing from WWW-Authenticate", () => {
    expect(() =>
      buildDigestHeader("GET", "/uri", "u", "p", `Digest realm="${REALM}"`)
    ).toThrow("Invalid WWW-Authenticate header: missing realm or nonce");
  });

  it("throws when WWW-Authenticate header is empty", () => {
    expect(() =>
      buildDigestHeader("GET", "/uri", "u", "p", "Digest ")
    ).toThrow("Invalid WWW-Authenticate header: missing realm or nonce");
  });
});

describe("buildDigestHeader – without qop (simple response)", () => {
  const wwwAuth = `Digest realm="${REALM}", nonce="${NONCE}"`;

  it("returns a header starting with Digest", () => {
    const header = buildDigestHeader("GET", "/dir/index.html", USERNAME, PASSWORD, wwwAuth);
    expect(header).toMatch(/^Digest /);
  });

  it("includes all required fields", () => {
    const header = buildDigestHeader("GET", "/dir/index.html", USERNAME, PASSWORD, wwwAuth);
    expect(header).toContain(`username="${USERNAME}"`);
    expect(header).toContain(`realm="${REALM}"`);
    expect(header).toContain(`nonce="${NONCE}"`);
    expect(header).toContain(`uri="/dir/index.html"`);
  });

  it("computes the correct response hash (RFC 2617 test vector)", () => {
    const uri = "/dir/index.html";
    const ha1 = md5(`${USERNAME}:${REALM}:${PASSWORD}`);
    const ha2 = md5(`GET:${uri}`);
    const expectedResponse = md5(`${ha1}:${NONCE}:${ha2}`);

    const header = buildDigestHeader("GET", uri, USERNAME, PASSWORD, wwwAuth);
    expect(header).toContain(`response="${expectedResponse}"`);
  });

  it("does not include cnonce or nc when qop is absent", () => {
    const header = buildDigestHeader("GET", "/dir/index.html", USERNAME, PASSWORD, wwwAuth);
    expect(header).not.toContain("cnonce");
    expect(header).not.toContain("nc=");
    expect(header).not.toContain("qop=");
  });
});

describe("buildDigestHeader – with qop=auth", () => {
  const wwwAuth = `Digest realm="${REALM}", nonce="${NONCE}", qop="auth"`;

  it("includes qop, nc, and cnonce fields", () => {
    const header = buildDigestHeader("POST", "/v1/documents", USERNAME, PASSWORD, wwwAuth);
    expect(header).toContain("qop=auth");
    expect(header).toContain("nc=00000001");
    expect(header).toMatch(/cnonce="[0-9a-f]{16}"/);
  });

  it("computes the correct response hash with qop=auth", () => {
    const uri = "/v1/documents";
    const header = buildDigestHeader("POST", uri, USERNAME, PASSWORD, wwwAuth);

    // Extract cnonce from the generated header
    const cnonceMatch = header.match(/cnonce="([0-9a-f]+)"/);
    expect(cnonceMatch).not.toBeNull();
    const cnonce = cnonceMatch![1];

    const ha1 = md5(`${USERNAME}:${REALM}:${PASSWORD}`);
    const ha2 = md5(`POST:${uri}`);
    const expectedResponse = md5(`${ha1}:${NONCE}:00000001:${cnonce}:auth:${ha2}`);

    expect(header).toContain(`response="${expectedResponse}"`);
  });

  it("produces different cnonce on each call (random)", () => {
    const wwwAuth2 = `Digest realm="${REALM}", nonce="${NONCE}", qop="auth"`;
    const header1 = buildDigestHeader("GET", "/", "u", "p", wwwAuth2);
    const header2 = buildDigestHeader("GET", "/", "u", "p", wwwAuth2);

    const c1 = header1.match(/cnonce="([^"]+)"/)?.[1];
    const c2 = header2.match(/cnonce="([^"]+)"/)?.[1];
    // With overwhelming probability these will differ
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    // They should be different (probability of collision is ~1 in 2^64)
    expect(c1).not.toBe(c2);
  });
});

describe("buildDigestHeader – optional fields", () => {
  it("includes opaque when present in challenge", () => {
    const opaque = "5ccc069c403ebaf9f0171e9517f40e41";
    const wwwAuth = `Digest realm="${REALM}", nonce="${NONCE}", opaque="${opaque}"`;
    const header = buildDigestHeader("GET", "/", "u", "p", wwwAuth);
    expect(header).toContain(`opaque="${opaque}"`);
  });

  it("does not include opaque when absent from challenge", () => {
    const wwwAuth = `Digest realm="${REALM}", nonce="${NONCE}"`;
    const header = buildDigestHeader("GET", "/", "u", "p", wwwAuth);
    expect(header).not.toContain("opaque");
  });

  it("includes algorithm when present in challenge", () => {
    const wwwAuth = `Digest realm="${REALM}", nonce="${NONCE}", algorithm="MD5"`;
    const header = buildDigestHeader("GET", "/", "u", "p", wwwAuth);
    expect(header).toContain("algorithm=MD5");
  });

  it("defaults to MD5 algorithm and includes it when challenge omits algorithm", () => {
    // The default is "MD5" assigned in parseWwwAuthenticate — it should appear in output
    const wwwAuth = `Digest realm="${REALM}", nonce="${NONCE}"`;
    const header = buildDigestHeader("GET", "/", "u", "p", wwwAuth);
    expect(header).toContain("algorithm=MD5");
  });
});

describe("buildDigestHeader – URI and method handling", () => {
  it("includes the full URI including query string in the header", () => {
    const wwwAuth = `Digest realm="${REALM}", nonce="${NONCE}"`;
    const uri = "/v1/search?q=test&pageLength=10";
    const header = buildDigestHeader("GET", uri, "u", "p", wwwAuth);
    expect(header).toContain(`uri="${uri}"`);
  });

  it("uses the method as-is for hash computation (caller controls case)", () => {
    const wwwAuth = `Digest realm="${REALM}", nonce="${NONCE}"`;
    const uri = "/v1/documents";

    // Both cases produce different headers because method is used directly in ha2
    const upperHeader = buildDigestHeader("GET", uri, "u", "p", wwwAuth);
    const lowerHeader = buildDigestHeader("get", uri, "u", "p", wwwAuth);

    // Extract the response hashes — they will differ
    const upperResponse = upperHeader.match(/response="([^"]+)"/)?.[1];
    const lowerResponse = lowerHeader.match(/response="([^"]+)"/)?.[1];
    expect(upperResponse).not.toBe(lowerResponse);
  });
});

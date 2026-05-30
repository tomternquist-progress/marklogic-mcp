import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

// SemaphoreClient logs at debug on token acquisition; mock the logger so the
// test does not depend on logger initialization.
vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  initLogger: vi.fn(),
  getLogger: vi.fn(),
}));

import nock from "nock";
import { SemaphoreClient } from "../../src/client/semaphore.js";
import type { SemaphoreConfig } from "../../src/config/schema.js";

const HOST = "semaphore-test.local";
const KMM_PORT = 5080;
const KMM_URL = `http://${HOST}:${KMM_PORT}`;

function buildConfig(): SemaphoreConfig {
  return {
    host: HOST,
    scsPort: 5058,
    kmmPort: KMM_PORT,
    username: "kmm-user",
    password: "kmm-pass",
    ssl: false,
    timeoutMs: 5000,
    url: undefined,
  };
}

// Access the private kmmApiKey() for white-box testing of the single-flight guard.
function callKmmApiKey(client: SemaphoreClient): Promise<string> {
  return (client as unknown as { kmmApiKey(): Promise<string> }).kmmApiKey();
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("SemaphoreClient KMM token single-flight", () => {
  it("performs only one login for concurrent token requests", async () => {
    let loginCount = 0;
    let tokenCount = 0;

    nock(KMM_URL)
      .post("/j_security_check")
      .reply(function () {
        loginCount += 1;
        return [200, "ok", { "set-cookie": "JSESSIONID=abc123; Path=/" }];
      })
      .get("/api/token")
      .query(true)
      .reply(() => {
        tokenCount += 1;
        return [200, { tokenId: "token-xyz" }];
      });

    const client = new SemaphoreClient(buildConfig());

    // Fire several concurrent requests against an empty token cache. With the
    // single-flight guard they should all await the same in-flight refresh.
    const tokens = await Promise.all([
      callKmmApiKey(client),
      callKmmApiKey(client),
      callKmmApiKey(client),
    ]);

    expect(tokens).toEqual(["token-xyz", "token-xyz", "token-xyz"]);
    expect(loginCount).toBe(1);
    expect(tokenCount).toBe(1);
  });

  it("reuses the cached token on a subsequent call without re-logging in", async () => {
    nock(KMM_URL)
      .post("/j_security_check")
      .reply(200, "ok", { "set-cookie": "JSESSIONID=abc123; Path=/" })
      .get("/api/token")
      .query(true)
      .reply(200, { tokenId: "token-xyz" });

    const client = new SemaphoreClient(buildConfig());

    const first = await callKmmApiKey(client);
    // No further nock interceptors are registered; a second login attempt would
    // throw on the disabled net connection. The cached token must be returned.
    const second = await callKmmApiKey(client);

    expect(first).toBe("token-xyz");
    expect(second).toBe("token-xyz");
    expect(nock.isDone()).toBe(true);
  });

  it("clears the in-flight guard after a failed refresh so a later call retries", async () => {
    nock(KMM_URL).post("/j_security_check").reply(500, "boom");

    const client = new SemaphoreClient(buildConfig());

    await expect(callKmmApiKey(client)).rejects.toThrow();

    // A fresh login interceptor — the previous failure must not have left a
    // poisoned in-flight promise behind.
    nock(KMM_URL)
      .post("/j_security_check")
      .reply(200, "ok", { "set-cookie": "JSESSIONID=def456; Path=/" })
      .get("/api/token")
      .query(true)
      .reply(200, { tokenId: "token-after-retry" });

    const token = await callKmmApiKey(client);
    expect(token).toBe("token-after-retry");
  });
});

import { describe, it, expect, vi } from "vitest";

// Mock the SDK transport so no real stdin/stdout is used
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({})),
}));

import { startStdioTransport } from "../../src/transport/stdio.js";

describe("startStdioTransport", () => {
  it("calls server.connect with the StdioServerTransport instance", async () => {
    const mockConnect = vi.fn().mockResolvedValue(undefined);
    const mockServer = { connect: mockConnect };

    await startStdioTransport(mockServer as never);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    // The argument passed to connect should be the transport object
    expect(mockConnect.mock.calls[0][0]).toBeDefined();
  });

  it("resolves without error on a successful connect", async () => {
    const mockServer = { connect: vi.fn().mockResolvedValue(undefined) };
    await expect(startStdioTransport(mockServer as never)).resolves.toBeUndefined();
  });

  it("propagates connection errors", async () => {
    const mockServer = { connect: vi.fn().mockRejectedValue(new Error("connection failed")) };
    await expect(startStdioTransport(mockServer as never)).rejects.toThrow("connection failed");
  });
});

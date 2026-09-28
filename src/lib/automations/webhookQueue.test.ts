import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const insertMock = vi.fn();
vi.mock("./store", () => ({ triggerLogStore: { insert: insertMock } }));
vi.mock("./urlValidation", () => ({ isSafeWebhookUrl: vi.fn().mockResolvedValue({ ok: true }) }));

const { enqueueDelivery } = await import("./webhookQueue"); // after the mocks above, so webhookQueue picks them up

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/hook`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("webhookQueue", () => {
  afterEach(() => {
    insertMock.mockClear();
  });

  it("delivers exactly one POST with the JSON payload when the endpoint accepts it", async () => {
    let requestCount = 0;
    let receivedBody: unknown = null;
    const { url, close } = await startServer((req, res) => {
      requestCount++;
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });

    enqueueDelivery({ ruleId: "rule-1", url, payload: { symbol: "SPX", condition: "EMA(9) crossing up EMA(20)" } });
    await new Promise((r) => setTimeout(r, 300));

    expect(requestCount).toBe(1);
    expect(receivedBody).toEqual({ symbol: "SPX", condition: "EMA(9) crossing up EMA(20)" });
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0]).toMatchObject({ ruleId: "rule-1", success: true, statusCode: 200, attempt: 1 });

    await close();
  });

  it("does not deliver anything when nothing was enqueued", async () => {
    let requestCount = 0;
    const { close } = await startServer(() => {
      requestCount++;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(requestCount).toBe(0);
    await close();
  });

  it("retries once (with backoff) after a failing response, logging both attempts", async () => {
    let requestCount = 0;
    const { url, close } = await startServer((req, res) => {
      requestCount++;
      req.resume();
      res.writeHead(500);
      res.end();
    });

    enqueueDelivery({ ruleId: "rule-2", url, payload: { symbol: "SPX" } });
    await new Promise((r) => setTimeout(r, 2500));

    expect(requestCount).toBeGreaterThanOrEqual(2);
    expect(insertMock.mock.calls.filter((c) => c[0].ruleId === "rule-2").length).toBeGreaterThanOrEqual(2);
    await close();
  }, 6000);
});

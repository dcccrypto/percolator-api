import { describe, it, expect, vi, beforeEach } from "vitest";
import { bugsRoutes } from "../../src/routes/bugs.js";

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("@percolator/shared", () => ({
  getSupabase: vi.fn(),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock auth middleware — controlled per test via process.env.API_AUTH_KEY
// (the real requireApiKey() reads the env var, so we just set/clear it)

import { getSupabase } from "@percolator/shared";

// ── Helpers ────────────────────────────────────────────────────────────────
function makeApp() {
  return bugsRoutes();
}

function jsonReq(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; apiKey?: string; ip?: string } = {}
): Request {
  const headers: Record<string, string> = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  if (opts.ip) headers["x-real-ip"] = opts.ip;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /bugs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when no API key is provided (production mode)", async () => {
    const prev = process.env.NODE_ENV;
    const prevKey = process.env.API_AUTH_KEY;
    process.env.NODE_ENV = "production";
    process.env.API_AUTH_KEY = "secret-key";
    try {
      const app = makeApp();
      const res = await app.request(jsonReq("GET", "/bugs"));
      expect(res.status).toBe(401);
    } finally {
      process.env.NODE_ENV = prev;
      process.env.API_AUTH_KEY = prevKey;
    }
  });

  it("returns bug list when valid API key provided", async () => {
    process.env.API_AUTH_KEY = "test-key";
    const mockBugs = [
      { id: 1, title: "Login bug", severity: "high", created_at: "2026-03-01" },
    ];
    const mockFrom = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: mockBugs, error: null }),
    };
    vi.mocked(getSupabase).mockReturnValue({ from: vi.fn(() => mockFrom) } as any);

    const app = makeApp();
    const res = await app.request(jsonReq("GET", "/bugs", { apiKey: "test-key" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe("Login bug");
    delete process.env.API_AUTH_KEY;
  });

  it("returns empty array when bug_reports table does not exist (42P01)", async () => {
    process.env.API_AUTH_KEY = "test-key";
    const mockFrom = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "42P01", message: "table not found" },
      }),
    };
    vi.mocked(getSupabase).mockReturnValue({ from: vi.fn(() => mockFrom) } as any);

    const app = makeApp();
    const res = await app.request(jsonReq("GET", "/bugs", { apiKey: "test-key" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    delete process.env.API_AUTH_KEY;
  });

  it("returns empty array on unexpected DB error (fail-open)", async () => {
    process.env.API_AUTH_KEY = "test-key";
    const mockFrom = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockRejectedValue(new Error("DB connection lost")),
    };
    vi.mocked(getSupabase).mockReturnValue({ from: vi.fn(() => mockFrom) } as any);

    const app = makeApp();
    const res = await app.request(jsonReq("GET", "/bugs", { apiKey: "test-key" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    delete process.env.API_AUTH_KEY;
  });
});

describe("POST /bugs", () => {
  const validBug = {
    twitter_handle: "0xSquid",
    title: "Price oracle shows stale price",
    description: "The mark price hasn't updated in 5 minutes on SOL-PERP.",
    severity: "high",
    page: "/trade",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.API_AUTH_KEY;
  });

  it("returns 201 on valid submission", async () => {
    const mockInsert = { error: null };
    const mockFrom = {
      insert: vi.fn().mockResolvedValue(mockInsert),
    };
    vi.mocked(getSupabase).mockReturnValue({ from: vi.fn(() => mockFrom) } as any);

    const app = makeApp();
    const res = await app.request(
      jsonReq("POST", "/bugs", { body: validBug, ip: "1.2.3.4" })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns 400 when twitter_handle is missing", async () => {
    const app = makeApp();
    const res = await app.request(
      jsonReq("POST", "/bugs", {
        body: { ...validBug, twitter_handle: "" },
        ip: "1.2.3.5",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when title exceeds 120 chars", async () => {
    const app = makeApp();
    const res = await app.request(
      jsonReq("POST", "/bugs", {
        body: { ...validBug, title: "a".repeat(121) },
        ip: "1.2.3.6",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid severity", async () => {
    const app = makeApp();
    const res = await app.request(
      jsonReq("POST", "/bugs", {
        body: { ...validBug, severity: "extreme" },
        ip: "1.2.3.7",
      })
    );
    expect(res.status).toBe(400);
  });

  it("sanitises XSS in string fields", async () => {
    let capturedInsert: Record<string, unknown> | null = null;
    const mockFrom = {
      insert: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        capturedInsert = data;
        return Promise.resolve({ error: null });
      }),
    };
    vi.mocked(getSupabase).mockReturnValue({ from: vi.fn(() => mockFrom) } as any);

    const app = makeApp();
    await app.request(
      jsonReq("POST", "/bugs", {
        body: {
          ...validBug,
          twitter_handle: "<script>alert(1)</script>",
          title: "XSS <test>",
        },
        ip: "1.2.3.8",
      })
    );
    // XSS brackets stripped
    expect(capturedInsert?.twitter_handle).not.toContain("<");
    expect(capturedInsert?.title).not.toContain("<");
  });

  it("returns 500 on DB insert error", async () => {
    const mockFrom = {
      insert: vi.fn().mockResolvedValue({ error: new Error("insert failed") }),
    };
    vi.mocked(getSupabase).mockReturnValue({ from: vi.fn(() => mockFrom) } as any);

    const app = makeApp();
    const res = await app.request(
      jsonReq("POST", "/bugs", { body: validBug, ip: "1.2.3.9" })
    );
    expect(res.status).toBe(500);
  });

  it("returns 400 for invalid JSON body", async () => {
    const app = makeApp();
    const res = await app.request(
      new Request("http://localhost/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("rate limits to 3 requests per hour per IP", async () => {
    const mockInsert = { error: null };
    const mockFrom = {
      insert: vi.fn().mockResolvedValue(mockInsert),
    };
    vi.mocked(getSupabase).mockReturnValue({ from: vi.fn(() => mockFrom) } as any);

    const app = makeApp();
    const ip = "5.5.5.5";

    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        jsonReq("POST", "/bugs", { body: validBug, ip })
      );
      expect(res.status).toBe(201);
    }

    // 4th should be rate-limited
    const limited = await app.request(
      jsonReq("POST", "/bugs", { body: validBug, ip })
    );
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.error).toContain("Rate limited");
  });
});

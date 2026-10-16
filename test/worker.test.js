import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, {
  DomainDO,
  buildGatewayHeaders,
  buildPrompt,
  fallbackText,
  renderPage,
  resolveXaiModel,
} from "../src/worker";

describe("prompt", () => {
  it("includes host and date", () => {
    const host = "example.com";
    const today = "2025-12-05";
    const prompt = buildPrompt(host, today);
    expect(prompt).toContain(host);
    expect(prompt).toContain(today);
    expect(prompt).toContain("220-400 words");
  });
});

describe("fallback", () => {
  it("mentions host and date", () => {
    const host = "abstract.md";
    const today = "2025-12-05";
    const text = fallbackText(host, today);
    expect(text).toContain(host);
    expect(text).toContain(today);
  });
});

describe("gateway headers", () => {
  it("sends the xAI provider key as Authorization", () => {
    expect(buildGatewayHeaders({ XAI_API_KEY: "xai-key" })).toEqual({
      "content-type": "application/json",
      authorization: "Bearer xai-key",
    });
  });

  it("sends authenticated Gateway credentials separately", () => {
    const headers = buildGatewayHeaders({
      XAI_API_KEY: "xai-key",
      GATEWAY_TOKEN: "gateway-token",
    });

    expect(headers.authorization).toBe("Bearer xai-key");
    expect(headers["cf-aig-authorization"]).toBe("Bearer gateway-token");
  });
});

describe("xAI model routing", () => {
  it("adds the provider namespace for Cloudflare's unified API", () => {
    expect(resolveXaiModel("https://gateway.ai.cloudflare.com/v1/account/default/compat")).toBe(
      "grok/grok-4.7",
    );
    expect(resolveXaiModel("https://gateway.ai.cloudflare.com/v1/account/default/compat/")).toBe(
      "grok/grok-4.7",
    );
  });

  it("keeps the public model identifier for provider-native endpoints", () => {
    expect(resolveXaiModel("https://gateway.ai.cloudflare.com/v1/account/default/grok/v1")).toBe(
      "grok-4.7",
    );
    expect(resolveXaiModel("https://api.x.ai/v1")).toBe("grok-4.7");
  });
});

describe("renderPage", () => {
  it("renders footer link and generated date", () => {
    const html = renderPage({
      host: "abstract.md",
      text: "# Title\n\nBody",
      generatedAt: "2025-12-05",
    });
    expect(html).toContain("Generated on 2025-12-05");
    expect(html).toContain("a @steipete project");
    expect(html).toContain("https://steipete.me");
  });
});

describe("DomainDO daily generation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-05T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("coalesces concurrent misses into one upstream generation", async () => {
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "# One daily page" } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const domainDO = new DomainDO(createState(), { XAI_API_KEY: "xai-key" });
    const request = new Request("https://domain-do/daily", {
      headers: { "x-md-host": "example.com", "x-md-version": "v15" },
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => domainDO.fetch(request).then((res) => res.json())),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: "grok/grok-4.7",
      reasoning_effort: "low",
      temperature: 0.6,
      top_p: 0.9,
      max_tokens: 500,
      stream: false,
    });
    expect(responses.map((response) => response.text)).toEqual(
      Array.from({ length: 5 }, () => "# One daily page"),
    );
  });

  it("stores deterministic fallback after upstream failure", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const domainDO = new DomainDO(createState(), { XAI_API_KEY: "xai-key" });
    const request = new Request("https://domain-do/daily", {
      headers: { "x-md-host": "example.com", "x-md-version": "v15" },
    });

    const first = await domainDO.fetch(request).then((res) => res.json());
    const second = await domainDO.fetch(request).then((res) => res.json());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.text).toContain("generator blinked");
    expect(second).toEqual(first);
  });

  it("stores deterministic fallback after whitespace-only upstream content", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "   \n\t  " } }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const domainDO = new DomainDO(createState(), { XAI_API_KEY: "xai-key" });
    const request = new Request("https://domain-do/daily", {
      headers: { "x-md-host": "example.com", "x-md-version": "v15" },
    });

    const record = await domainDO.fetch(request).then((res) => res.json());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(record.text).toContain("generator blinked");
  });

  it("streams the first miss while coalescing a concurrent daily miss", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          makeSseStream([
            { choices: [{ delta: { content: "# Live" } }] },
            { choices: [{ delta: { content: " page" } }] },
          ]),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const domainDO = new DomainDO(createState(), { XAI_API_KEY: "xai-key" });
    const streamRequest = new Request("https://domain-do/stream", {
      headers: { "x-md-host": "example.com", "x-md-version": "v15" },
    });
    const dailyRequest = new Request("https://domain-do/daily", {
      headers: { "x-md-host": "example.com", "x-md-version": "v15" },
    });

    const streamResponse = await domainDO.fetch(streamRequest);
    const streamBodyPromise = streamResponse.text();
    const dailyRecord = await domainDO.fetch(dailyRequest).then((res) => res.json());
    const streamBody = await streamBodyPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(streamBody).toContain("# Live page");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: "grok/grok-4.7",
      reasoning_effort: "low",
      temperature: 0.6,
      top_p: 0.9,
      max_tokens: 500,
      stream: true,
    });
    expect(streamResponse.headers.get("content-type")).toContain("text/html");
    expect(streamResponse.headers.get("x-generated-on")).toBe("2025-12-05");
    expect(dailyRecord.text).toBe("# Live page");
  });

  it("stores the daily record when the first stream client does not read", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          makeSseStream([
            { choices: [{ delta: { content: "# Unread" } }] },
            { choices: [{ delta: { content: " page" } }] },
          ]),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const domainDO = new DomainDO(createState(), { XAI_API_KEY: "xai-key" });
    const headers = { "x-md-host": "example.com", "x-md-version": "v15" };
    const streamResponse = await domainDO.fetch(
      new Request("https://domain-do/stream", { headers }),
    );

    const dailyRecord = await domainDO
      .fetch(new Request("https://domain-do/daily", { headers }))
      .then((res) => res.json());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dailyRecord.text).toBe("# Unread page");
    await streamResponse.body.cancel();
  });

  it("stores fallback instead of partial output after a midstream failure", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(makeFailingSseStream({ choices: [{ delta: { content: "# Partial page" } }] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const domainDO = new DomainDO(createState(), { XAI_API_KEY: "xai-key" });
    const headers = { "x-md-host": "example.com", "x-md-version": "v15" };
    const streamResponse = await domainDO.fetch(
      new Request("https://domain-do/stream", { headers }),
    );
    const streamBody = await streamResponse.text();
    const dailyRecord = await domainDO
      .fetch(new Request("https://domain-do/daily", { headers }))
      .then((res) => res.json());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(streamBody).toContain("# Partial page");
    expect(streamBody).toContain("Generation interrupted");
    expect(dailyRecord.text).toContain("generator blinked");
    expect(dailyRecord.text).not.toContain("# Partial page");
  });

  it("rejects a cleanly truncated SSE response without a done marker", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(makeSseStream([{ choices: [{ delta: { content: "# Truncated" } }] }], false)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const domainDO = new DomainDO(createState(), { XAI_API_KEY: "xai-key" });
    const headers = { "x-md-host": "example.com", "x-md-version": "v15" };
    const streamResponse = await domainDO.fetch(
      new Request("https://domain-do/stream", { headers }),
    );
    await streamResponse.text();
    const dailyRecord = await domainDO
      .fetch(new Request("https://domain-do/daily", { headers }))
      .then((res) => res.json());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dailyRecord.text).toContain("generator blinked");
    expect(dailyRecord.text).not.toContain("# Truncated");
  });

  it("overwrites one bounded storage slot on the next UTC day", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: `# Page ${fetchMock.mock.calls.length}` } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const state = createState();
    const domainDO = new DomainDO(state, { XAI_API_KEY: "xai-key" });
    const request = new Request("https://domain-do/daily", {
      headers: { "x-md-host": "example.com", "x-md-version": "v15" },
    });

    await domainDO.fetch(request);
    vi.setSystemTime(new Date("2025-12-06T12:00:00Z"));
    await domainDO.fetch(request);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...state.values.keys()]).toEqual(["v15-daily"]);
    expect(state.values.get("v15-daily").generatedAt).toBe("2025-12-06");
  });

  it("does not let a slow previous-day generation overwrite the new day", async () => {
    vi.setSystemTime(new Date("2025-12-05T23:59:59Z"));
    const oldDay = createDeferred();
    const newDay = createDeferred();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => oldDay.promise)
      .mockImplementationOnce(() => newDay.promise);
    vi.stubGlobal("fetch", fetchMock);

    const state = createState();
    const domainDO = new DomainDO(state, { XAI_API_KEY: "xai-key" });
    const request = new Request("https://domain-do/daily", {
      headers: { "x-md-host": "example.com", "x-md-version": "v15" },
    });

    const oldRecordPromise = domainDO.fetch(request).then((res) => res.json());
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2025-12-06T00:00:01Z"));
    const newRecordPromise = domainDO.fetch(request).then((res) => res.json());
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    newDay.resolve(Response.json({ choices: [{ message: { content: "# New day" } }] }));
    expect((await newRecordPromise).text).toBe("# New day");

    oldDay.resolve(Response.json({ choices: [{ message: { content: "# Old day" } }] }));
    expect((await oldRecordPromise).text).toBe("# Old day");

    const current = await domainDO.fetch(request).then((res) => res.json());
    expect(current).toEqual({ text: "# New day", generatedAt: "2025-12-06" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("migrates today's legacy version-date record without regenerating", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const record = { text: "# Existing page", generatedAt: "2025-12-05" };
    const state = createState([["v15-2025-12-05", record]]);
    const domainDO = new DomainDO(state, { XAI_API_KEY: "xai-key" });

    const response = await domainDO.fetch(
      new Request("https://domain-do/daily", {
        headers: { "x-md-host": "example.com", "x-md-version": "v15" },
      }),
    );

    expect(await response.json()).toEqual(record);
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...state.values.entries()]).toEqual([["v15-daily", record]]);
  });

  it("keeps a new model cache version separate from the previous daily record", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: "# New model page" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const previous = { text: "# Previous model page", generatedAt: "2025-12-05" };
    const state = createState([["v17-daily", previous]]);
    const domainDO = new DomainDO(state, { XAI_API_KEY: "xai-key" });

    const response = await domainDO.fetch(
      new Request("https://domain-do/daily", {
        headers: { "x-md-host": "example.com", "x-md-version": "v18" },
      }),
    );

    expect(await response.json()).toEqual({
      text: "# New model page",
      generatedAt: "2025-12-05",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...state.values.entries()]).toEqual([
      ["v17-daily", previous],
      ["v18-daily", { text: "# New model page", generatedAt: "2025-12-05" }],
    ]);
  });
});

describe("worker fetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-05T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("routes normal cold misses through the daily DO path", async () => {
    const cache = createCache();
    vi.stubGlobal("caches", { default: cache });
    const doFetch = vi.fn(async () =>
      Response.json({ text: "# Daily page", generatedAt: "2025-12-05" }),
    );
    const env = createEnv(doFetch);
    const ctx = createContext();

    const response = await worker.fetch(
      new Request("https://example.com/", { headers: { host: "example.com" } }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("# Daily page");
    expect(doFetch).toHaveBeenCalledWith("https://domain-do/daily", {
      headers: { "x-md-host": "example.com", "x-md-version": "v18" },
    });
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(response.headers.get("x-md-version")).toBe("v18");
    expect(response.headers.get("x-generated-on")).toBe("2025-12-05");
  });

  it("routes stream cold misses through the streaming DO path", async () => {
    const cache = createCache();
    vi.stubGlobal("caches", { default: cache });
    const doFetch = vi.fn(async () => new Response("<!doctype html><pre># Live page</pre>"));
    const env = createEnv(doFetch);
    const ctx = createContext();

    const response = await worker.fetch(
      new Request("https://example.com/stream", { headers: { host: "example.com" } }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("# Live page");
    expect(doFetch).toHaveBeenCalledWith("https://domain-do/stream", {
      headers: { "x-md-host": "example.com", "x-md-version": "v18" },
    });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("renders and caches fallback when the DO request throws", async () => {
    const cache = createCache();
    vi.stubGlobal("caches", { default: cache });
    const doFetch = vi.fn(async () => {
      throw new Error("DO unavailable");
    });
    const env = createEnv(doFetch);
    const ctx = createContext();

    const response = await worker.fetch(new Request("https://example.com/"), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("generator blinked");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("renders and caches fallback when the DO response is malformed", async () => {
    const cache = createCache();
    vi.stubGlobal("caches", { default: cache });
    const doFetch = vi.fn(async () => new Response("{", { headers: { "content-type": "json" } }));
    const env = createEnv(doFetch);
    const ctx = createContext();

    const response = await worker.fetch(new Request("https://example.com/"), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("generator blinked");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cache.put).not.toHaveBeenCalled();
  });
});

function createState(entries = []) {
  const values = new Map(entries);

  return {
    values,
    storage: {
      get: vi.fn(async (key) => values.get(key)),
      put: vi.fn(async (key, value) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key) => values.delete(key)),
    },
  };
}

function createEnv(fetch) {
  return {
    DOMAIN_DO: {
      idFromName: vi.fn((name) => name),
      get: vi.fn(() => ({ fetch })),
    },
    XAI_API_KEY: "xai-key",
  };
}

function createCache() {
  return {
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
  };
}

function createContext() {
  return {
    waitUntil: vi.fn(),
  };
}

function makeSseStream(payloads, includeDone = true) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      if (includeDone) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function makeFailingSseStream(payload) {
  const encoder = new TextEncoder();
  let sentChunk = false;
  return new ReadableStream({
    pull(controller) {
      if (!sentChunk) {
        sentChunk = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        return;
      }
      controller.error(new Error("upstream stream failed"));
    },
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

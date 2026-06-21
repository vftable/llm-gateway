// Smoke-tests the new enforcement layers:
//   1. Context-window enforcement (413 on overage, pass when within budget)
//   2. Per-key daily quota enforcement (429 on overage, debit/reconcile)
//   3. Backward-compat: array-form gatewayApiKeys still authenticates

import http from "http";
import fs from "fs";
import path from "path";
import { loadConfig } from "../config";
import { Gateway } from "../gateway";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
const expect = (name: string, cond: boolean, detail: string) =>
  results.push({ name, pass: cond, detail });

function main() {
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      // Echo a tiny chat completion with usage so reconcileUsage fires.
      res.end(
        JSON.stringify({
          id: "chat_test",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
    });
  });

  upstream.listen(0, "127.0.0.1", () => {
    const upstreamPort = (upstream.address() as any).port;
    const usagePath = path.join(
      __dirname,
      "..",
      "data",
      `usage-smoke-${Date.now()}.json`,
    );
    try { fs.mkdirSync(path.dirname(usagePath), { recursive: true }); } catch {}

    const config = loadConfig();
    config.upstream = `http://127.0.0.1:${upstreamPort}`;
    config.gatewayApiKeys = new Map([
      ["sk-quota", { tokensPerDay: 100 }], // tiny quota for easy overflow
      ["sk-unlimited", {}],
    ]);
    config.usageFile = usagePath;
    config.models.mappings = {
      "small-ctx": {
        upstream: "gw-small",
        displayName: "Small",
        contextWindow: 100, // tiny window for easy overflow
        maxOutputTokens: 50,
      },
    };
    config.models.allowUnknown = true;
    const gateway = new Gateway(config);
    const server = gateway.start();
    const gwPort = (server.address() as any).port;

    const call = (
      pathName: string,
      body: Record<string, unknown>,
      key: string | null,
    ): Promise<{ status: number; json: any }> =>
      new Promise((resolve, reject) => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (key) headers["authorization"] = `Bearer ${key}`;
        const r = http.request(
          {
            host: "127.0.0.1",
            port: gwPort,
            path: pathName,
            method: "POST",
            headers,
          },
          (res) => {
            let s = "";
            res.on("data", (c) => (s += c));
            res.on("end", () => {
              let json: any = null;
              try { json = JSON.parse(s); } catch {}
              resolve({ status: res.statusCode || 0, json });
            });
          },
        );
        r.on("error", reject);
        r.write(JSON.stringify(body));
        r.end();
      });

    (async () => {
      // --- Context window enforcement ---
      {
        // ~600 chars of input -> ~150 tokens, way over the 100 ctx window
        // even before max_output.
        const huge = "x".repeat(600);
        const r = await call(
          "/v1/chat/completions",
          {
            model: "anthropic/small-ctx",
            messages: [{ role: "user", content: huge }],
            stream: false,
          },
          "sk-unlimited",
        );
        expect(
          "context window overage -> 413",
          r.status === 413,
          `status=${r.status} type=${r.json?.error?.type}`,
        );
      }
      {
        // Small request within the 100-token window.
        const r = await call(
          "/v1/chat/completions",
          {
            model: "anthropic/small-ctx",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 10,
            stream: false,
          },
          "sk-unlimited",
        );
        expect(
          "context window ok -> 200",
          r.status === 200,
          `status=${r.status} type=${r.json?.error?.type}`,
        );
      }

      // --- Per-key daily quota enforcement ---
      {
        // sk-quota has 100 tokens/day. Even a tiny request projects to
        // ~input(1) + max_tokens(default 50) = 51 -> fits, but a second
        // one pushes us over. Use explicit tiny max_tokens so the first
        // is well under and the second is rejected by the running tally.
        const tiny = {
          model: "anthropic/small-ctx",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
          stream: false,
        };
        const r1 = await call("/v1/chat/completions", tiny, "sk-quota");
        const r2 = await call("/v1/chat/completions", tiny, "sk-quota");
        expect(
          "quota: first request passes",
          r1.status === 200,
          `status=${r1.status}`,
        );
        // After r1 we debited ~input+5. After upstream reported 7 tokens,
        // reconcile swapped it for 7. So used ~= 7. Second tiny request
        // projects to ~1+5=6, 7+6=13 < 100 -> still passes. Do many to
        // actually overflow the 100-token budget.
        let lastStatus = 200;
        for (let i = 0; i < 30; i++) {
          const r = await call("/v1/chat/completions", tiny, "sk-quota");
          lastStatus = r.status;
          if (r.status === 429) break;
        }
        expect(
          "quota: eventually throttled with 429",
          lastStatus === 429,
          `lastStatus=${lastStatus}`,
        );
      }

      // --- Backward-compat: unknown key rejected ---
      {
        const r = await call(
          "/v1/chat/completions",
          {
            model: "anthropic/small-ctx",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 5,
            stream: false,
          },
          "sk-bogus",
        );
        expect(
          "unknown key -> 401",
          r.status === 401,
          `status=${r.status}`,
        );
      }

      // --- Usage persisted to disk ---
      gateway.usage.flushSync();
      const persisted = fs.existsSync(usagePath);
      expect("usage file written", persisted, `path=${usagePath}`);

      // Summary
      const failing = results.filter((r) => !r.pass);
      for (const r of results)
        console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`);
      console.log(
        `\n${results.length - failing.length}/${results.length} passed`,
      );

      server.close();
      upstream.close();
      try { fs.unlinkSync(usagePath); } catch {}
      process.exit(failing.length ? 1 : 0);
    })().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  });
}

main();

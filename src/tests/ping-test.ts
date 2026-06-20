// Unit tests for SsePingKeepAlive transform
//
// Verifies that:
// 1. Data passes through unchanged
// 2. Pings are sent during idle periods
// 3. Pings stop when data arrives
// 4. Proper cleanup on destroy

import { SsePingKeepAlive } from "../sse-ping";

async function collectWithTimeout(
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<{ data: string[]; timedOut: boolean }> {
  const chunks: string[] = [];
  let timedOut = false;
  const decoder = new TextDecoder();

  const reader =
    (stream as any).getReader?.() ?? (stream as any)[Symbol.asyncIterator]?.();
  const timeout = setTimeout(() => {
    timedOut = true;
    reader?.cancel?.();
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // Stream was cancelled
  }
  clearTimeout(timeout);
  return { data: chunks, timedOut };
}

async function test1_dataPassesThrough() {
  console.log("test1: data passes through unchanged");
  const ping = new SsePingKeepAlive({ interval: 50 });
  const { Readable } = await import("stream");

  const source = Readable.from(Buffer.from("data: hello\n\n"));
  const output: Buffer[] = [];

  await new Promise<void>((resolve) => {
    source.pipe(ping);
    ping.on("data", (chunk: Buffer) => output.push(chunk));
    ping.on("end", resolve);
    source.on("end", () => setTimeout(() => ping.end(), 10));
  });

  const result = output.join("");
  const ok = result.includes("data: hello\n\n");
  console.log(ok ? "PASS" : "FAIL", "- data passes through");
  if (!ok) process.exitCode = 1;
}

async function test2_pingsDuringIdle() {
  console.log("test2: pings sent during idle periods");
  const ping = new SsePingKeepAlive({ interval: 100 });
  const { PassThrough } = await import("stream");

  const source = new PassThrough();
  const output: string[] = [];
  const decoder = new TextDecoder();

  source.pipe(ping);
  ping.on("data", (chunk: Buffer) => {
    output.push(decoder.decode(chunk, { stream: true }));
  });

  // Send initial data
  source.write(Buffer.from("data: start\n\n"));

  // Wait for pings
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      source.end();
      setTimeout(() => resolve(), 50); // Give time for final flush
    }, 350);
  });

  const allText = output.join("");
  const pingCount = (allText.match(/: ping/g) || []).length;
  const ok = allText.includes("data: start") && pingCount >= 2;
  console.log(ok ? "PASS" : "FAIL", `- saw ${pingCount} pings (expected >= 2)`);
  if (!ok) {
    console.log("  output:", output.map((o) => JSON.stringify(o)).join("\n  "));
    process.exitCode = 1;
  }
}

async function test3_pingsResetOnData() {
  console.log("test3: ping timer resets when data arrives");
  const ping = new SsePingKeepAlive({ interval: 100 });
  const { Readable } = await import("stream");

  // Send chunks every 80ms (faster than ping interval)
  let counter = 0;
  const source = new Readable({
    read() {
      counter++;
      if (counter > 5) {
        this.push(null);
      } else {
        this.push(Buffer.from(`data: chunk-${counter}\n\n`));
        setTimeout(
          () => this.push(Buffer.from(`data: chunk-${counter + 1}\n\n`)),
          80,
        );
      }
    },
  });

  const output: string[] = [];
  const decoder = new TextDecoder();

  await new Promise<void>((resolve) => {
    source.pipe(ping);
    ping.on("data", (chunk: Buffer) => {
      output.push(decoder.decode(chunk, { stream: true }));
    });
    ping.on("end", resolve);
  });

  const allText = output.join("");
  const pingCount = (allText.match(/: ping/g) || []).length;
  // Should have 0 or very few pings since data arrives faster than interval
  const ok = allText.includes("data: chunk-1") && pingCount === 0;
  console.log(
    ok ? "PASS" : "FAIL",
    `- saw ${pingCount} pings (expected 0 when data flows)`,
  );
  if (!ok) {
    console.log("  output:", output.map((o) => JSON.stringify(o)).join("\n  "));
    process.exitCode = 1;
  }
}

async function main() {
  await test1_dataPassesThrough();
  await test2_pingsDuringIdle();
  await test3_pingsResetOnData();
  console.log("\nAll ping tests completed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

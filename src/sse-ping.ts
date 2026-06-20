// SSE Ping Keep-Alive Transform
//
// Cloudflare tunnels and some proxies have idle timeouts (~100s for Cloudflare).
// When an LLM is "thinking" for a long time, no data flows, and the connection
// appears idle — causing a 504 error.
//
// This transform sits on the output side of the SSE stream and periodically
// sends SSE comment lines (`: ping\n\n`) during idle periods. Clients ignore
// SSE comments (lines starting with `:`), but they keep the TCP connection
// alive and prevent proxy timeouts.
//
// Usage:
//   upstream.pipe(thinkingTransform).pipe(pingTransform).pipe(res)
//
// The ping interval is configurable (default 30 seconds). The first ping is
// sent after `interval` seconds of inactivity, and subsequent pings repeat
// every `interval` seconds until real data arrives again.

import { Transform, type TransformCallback } from "stream";

export interface PingKeepAliveOptions {
  /** Interval in milliseconds between ping comments when idle. Default: 30000 (30s). */
  interval?: number;
  /** The ping comment to send. Default: ': ping\n\n' */
  pingMessage?: string;
}

export class SsePingKeepAlive extends Transform {
  private readonly interval: number;
  private readonly pingMessage: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDataTime: number = 0;
  private finished = false;

  constructor(opts?: PingKeepAliveOptions) {
    super();
    this.interval = opts?.interval ?? 30_000;
    this.pingMessage = opts?.pingMessage ?? ": ping\n\n";
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    this.lastDataTime = Date.now();
    this.resetTimer();
    this.push(chunk);
    callback();
  }

  _flush(callback: TransformCallback): void {
    this.finished = true;
    this.clearTimer();
    callback();
  }

  _destroy(err: Error | null, callback: (error: Error | null) => void): void {
    this.finished = true;
    this.clearTimer();
    callback(err);
  }

  private resetTimer(): void {
    this.clearTimer();
    if (this.finished) return;
    this.timer = setTimeout(() => {
      if (this.finished) return;
      // Send a ping comment and schedule the next one
      this.push(this.pingMessage);
      this.resetTimer();
    }, this.interval);
    // Allow the timer to not keep the process alive
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// SSE Ping Keep-Alive Transform
//
// Cloudflare tunnels and many proxies/clients drop a connection that's been
// idle for ~90-100s. When an LLM is "thinking" for a long time, no bytes flow
// and the connection looks dead — the client times out (often before a single
// token arrives).
//
// This transform sits on the output side of the SSE stream and periodically
// emits SSE comment lines (`: ping\n\n`) whenever the stream has been idle for
// `interval` ms. Clients ignore SSE comments (lines starting with `:`), but the
// bytes keep the TCP connection alive and reset idle timers along the path.
//
// Critically, the idle timer is armed immediately (on construction), NOT only
// after the first upstream chunk — the longest idle gap is usually BEFORE the
// first token, so a timer that only starts on first data would never fire in
// exactly the case that causes a timeout.
//
// Usage:
//   upstream.pipe(thinkingTransform).pipe(pingTransform).pipe(res)

import { Transform, type TransformCallback } from "stream";

export interface PingKeepAliveOptions {
  /** Interval in milliseconds between ping comments when idle. Default: 15000. */
  interval?: number;
  /** The ping comment to send. Default: ': ping\n\n' */
  pingMessage?: string;
}

// 15s: comfortably under the common ~90-100s proxy/client idle ceilings, with
// margin for several missed pings.
const DEFAULT_INTERVAL = 15_000;

export class SsePingKeepAlive extends Transform {
  private readonly interval: number;
  private readonly pingMessage: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();
  private finished = false;

  constructor(opts?: PingKeepAliveOptions) {
    super();
    this.interval = opts?.interval ?? DEFAULT_INTERVAL;
    this.pingMessage = opts?.pingMessage ?? ": ping\n\n";
    // Arm immediately so pings flow during the initial (pre-first-token) gap,
    // which is where timeouts actually happen.
    this.startTimer();
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    // Real data resets the idle clock (but the interval timer keeps running).
    this.lastActivity = Date.now();
    this.push(chunk);
    callback();
  }

  _flush(callback: TransformCallback): void {
    this.stop();
    callback();
  }

  _destroy(err: Error | null, callback: (error: Error | null) => void): void {
    this.stop();
    callback(err);
  }

  private startTimer(): void {
    if (this.finished || this.timer) return;
    // A single fixed-rate interval that checks idleness on each tick — simpler
    // and more robust than re-scheduling a one-shot on every chunk (which can
    // race with backpressure).
    this.timer = setInterval(() => {
      if (this.finished) return;
      if (Date.now() - this.lastActivity < this.interval) return;
      // Idle long enough — send a ping. If the readable side is full, push()
      // returns false; we simply skip this tick rather than buffer unboundedly.
      const ok = this.push(this.pingMessage);
      this.lastActivity = Date.now();
      if (!ok) {
        // Backpressure — the client is already receiving data, so a missed
        // ping is harmless; the next tick retries.
      }
    }, this.interval);
    // Don't let the ping timer keep the event loop / process alive on its own.
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  private stop(): void {
    this.finished = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

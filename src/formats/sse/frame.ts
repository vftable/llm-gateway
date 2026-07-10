// Shared SSE framing — the byte-level plumbing every streaming transform repeats.
//
// An SSE stream is a sequence of events separated by a blank line (`\n\n`). Bytes
// arrive in arbitrary chunks, so an event can be split across chunk boundaries
// (and a UTF-8 multi-byte sequence must not be split). Every streaming transform
// in this codebase had its own copy of: concat the chunk, strip invisible chars,
// walk complete `\n\n`-terminated blocks, hold the remainder. `SseFrameReader`
// owns exactly that, so each transform keeps only its own per-event state machine.
//
// `parseSseData` extracts the `data:` payload (and optional `event:` name) from
// one raw event block, using the standard "concat data lines, strip one optional
// leading space" convention. (Two transforms join multi-line `data:` with `\n`
// instead and keep their own loop — see thinking/messages-stream.ts +
// thinking/chat-stream.ts.)

import { stripInvisible } from "../thinking";

// Accumulates SSE bytes and yields complete raw event blocks (the text between
// blank-line separators, exclusive of the separator). Stateless beyond its buffer.
export class SseFrameReader {
  private buf = Buffer.alloc(0);

  // Feed one incoming chunk; returns every complete event block it completed
  // (possibly none). Invisible characters are stripped as the bytes arrive.
  feed(chunk: Buffer): string[] {
    this.buf = Buffer.concat([
      this.buf,
      Buffer.from(stripInvisible(chunk.toString("utf8")), "utf8"),
    ]);
    const events: string[] = [];
    while (true) {
      const idx = this.buf.indexOf("\n\n");
      if (idx === -1) break;
      events.push(this.buf.slice(0, idx).toString("utf8"));
      this.buf = this.buf.slice(idx + 2);
    }
    return events;
  }

  // Any trailing bytes (a final event with no closing blank line), consumed and
  // cleared. Returns null when the buffer is empty. Call from `_flush`.
  flush(): string | null {
    if (this.buf.length === 0) return null;
    const raw = this.buf.toString("utf8");
    this.buf = Buffer.alloc(0);
    return raw;
  }
}

// Parsed view of one raw SSE event block. `data` is null when the block carried
// no `data:` line (a comment/keepalive/out-of-band event). `event` is the SSE
// `event:` name (Anthropic Messages uses it; OpenAI does not) or null.
export interface ParsedSse {
  data: string | null;
  event: string | null;
}

// Pull the `data:` payload + optional `event:` name out of a raw event block.
// Concatenates multiple `data:` lines with no separator (the convention used by
// the chat/responses transforms), trimming one optional leading space per line.
export function parseSseData(raw: string): ParsedSse {
  let data = "";
  let hadData = false;
  let event: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) {
      hadData = true;
      const p = line.slice(5);
      data += p.startsWith(" ") ? p.slice(1) : p;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
  }
  return { data: hadData ? data : null, event };
}

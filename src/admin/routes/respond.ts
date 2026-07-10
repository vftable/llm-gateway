// Shared error-response helper used by every route module.

import type { Response } from "express";

export function bad(res: Response, err: unknown, code = 400): void {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Bad request";
  res.status(code).json({ error: { type: "bad_request", message: msg } });
}

// Upstream URL construction helpers.

import { URL } from "url";
import type { Provider } from "../types";

// Compose the upstream URL as origin + basePath + forwardPath by concatenation
// (not `new URL(path, base)`, which discards path prefixes in the origin). This
// is the single place upstream URLs are built; both the main proxy path and the
// web-tool loop call it, so a Gemini-style `basePath` layout works everywhere.
// forwardPath always begins with "/". For legacy providers basePath is "" and
// forwardPath is a full "/v1/…" path, reproducing the original URL exactly.
export function buildUpstreamUrl(provider: Provider, forwardPath: string): URL {
  const origin = provider.baseUrl.replace(/\/+$/, "");
  const basePath = provider.basePath || "";
  return new URL(origin + basePath + forwardPath);
}

// Host header derived from a base URL (empty string when the URL is malformed).
export function hostFromUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

import type { IncomingHttpHeaders } from "http";
import type { Logger } from "../../logger";

export function logUpstreamNon2xx(
  logger: Logger,
  input: {
    status: number;
    provider: string;
    upstreamModel: string;
    path?: string | null;
    keyMask?: string | null;
    requestHeaders: Record<string, string | string[] | undefined>;
    responseHeaders:
      IncomingHttpHeaders | Record<string, string | string[] | undefined>;
    body: string;
    category?: string;
    details?: Record<string, unknown>;
  },
): void {
  logger.upstreamError({
    ...input,
    requestHeaders: { ...input.requestHeaders },
    responseHeaders: { ...input.responseHeaders },
  });
}

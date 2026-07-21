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
    headers:
      IncomingHttpHeaders | Record<string, string | string[] | undefined>;
    body: string;
    category?: string;
    details?: Record<string, unknown>;
  },
): void {
  logger.upstreamError({
    ...input,
    headers: { ...input.headers },
  });
}

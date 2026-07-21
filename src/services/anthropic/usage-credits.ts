import { SONNET_46_RE } from "../../formats/model-version";

export const LONG_CONTEXT_USAGE_CREDITS_MESSAGE =
  "Usage credits are required for long context requests.";

export function isClaudeCodeUsageCreditsError(input: {
  status: number;
  catalogId: string | null | undefined;
  upstreamModel: string;
  body: string;
}): boolean {
  if (
    input.status !== 429 ||
    input.catalogId !== "claude-code" ||
    !SONNET_46_RE.test(input.upstreamModel)
  )
    return false;

  try {
    const parsed = JSON.parse(input.body) as {
      error?: { type?: unknown; message?: unknown };
    };
    return (
      parsed.error?.type === "rate_limit_error" &&
      parsed.error.message === LONG_CONTEXT_USAGE_CREDITS_MESSAGE
    );
  } catch {
    return false;
  }
}

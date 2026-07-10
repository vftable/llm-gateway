// Built-in transform library.
//
// A registry of named, parameterized, PURE body transforms that a user picks and
// configures per model in the UI (no code needed for the common cases). Each
// definition declares its param specs (so the UI can render a form) and a
// `build(params)` that returns the actual body function. Custom code transforms
// can register in this same map for advanced needs.

import type { Json, BodyXform } from "../pipeline";
import type { ParamSpec, TransformPhase, TransformDefInfo } from "../../types";
import {
  anthropicCache,
  systemPrepend,
  sanitizeToolArgs,
} from "./builtins-extra";

// Body-shape ops apply equally to the request or the buffered response.
const BOTH: TransformPhase[] = ["request", "response"];
const REQUEST: TransformPhase[] = ["request"];
const RESPONSE: TransformPhase[] = ["response"];

export interface TransformDef {
  id: string;
  label: string;
  blurb: string;
  phases: TransformPhase[];
  params: ParamSpec[];
  build: (params: Record<string, unknown>) => BodyXform;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}
function numOr(v: unknown, d: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

// Resolve a dotted path ("a.b.c") to [parent, key], creating intermediate
// objects for set-style ops. Returns null if the path traverses a non-object.
function resolvePath(
  body: Json,
  path: string,
  create: boolean,
): [Json, string] | null {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return null;
  let obj: Json = body;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const cur = obj[k];
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      obj = cur as Json;
    } else if (create) {
      const next: Json = {};
      obj[k] = next;
      obj = next;
    } else {
      return null;
    }
  }
  return [obj, parts[parts.length - 1]];
}

// Parse a "value" param as JSON when possible (so "true"/"42"/'{"a":1}' become
// real types), else keep the raw string.
function coerceValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const LIBRARY: TransformDef[] = [
  {
    id: "set-field",
    label: "Set field",
    blurb: "Set a body field to a fixed value (JSON-parsed when possible).",
    phases: BOTH,
    params: [
      {
        key: "path",
        label: "Field path",
        type: "string",
        required: true,
        placeholder: "e.g. temperature or metadata.tag",
      },
      {
        key: "value",
        label: "Value",
        type: "string",
        required: true,
        placeholder: 'e.g. 0.7 or "x" or true',
      },
    ],
    build: (p) => {
      const path = str(p.path);
      const value = coerceValue(p.value);
      return (b) => {
        if (!path) return b;
        const r = resolvePath(b, path, true);
        if (r) r[0][r[1]] = value;
        return b;
      };
    },
  },
  {
    id: "set-default",
    label: "Set default",
    blurb:
      "Set a field only if it is missing (won't overwrite a client value).",
    phases: BOTH,
    params: [
      { key: "path", label: "Field path", type: "string", required: true },
      { key: "value", label: "Default value", type: "string", required: true },
    ],
    build: (p) => {
      const path = str(p.path);
      const value = coerceValue(p.value);
      return (b) => {
        if (!path) return b;
        const r = resolvePath(b, path, true);
        if (r && r[0][r[1]] === undefined) r[0][r[1]] = value;
        return b;
      };
    },
  },
  {
    id: "delete-field",
    label: "Delete field",
    blurb: "Remove a body field entirely.",
    phases: BOTH,
    params: [
      {
        key: "path",
        label: "Field path",
        type: "string",
        required: true,
        placeholder: "e.g. logprobs",
      },
    ],
    build: (p) => {
      const path = str(p.path);
      return (b) => {
        if (!path) return b;
        const r = resolvePath(b, path, false);
        if (r) delete r[0][r[1]];
        return b;
      };
    },
  },
  {
    id: "rename-field",
    label: "Rename field",
    blurb: "Move a field's value from one key to another.",
    phases: BOTH,
    params: [
      { key: "from", label: "From path", type: "string", required: true },
      { key: "to", label: "To path", type: "string", required: true },
    ],
    build: (p) => {
      const from = str(p.from);
      const to = str(p.to);
      return (b) => {
        if (!from || !to) return b;
        const src = resolvePath(b, from, false);
        if (!src || src[0][src[1]] === undefined) return b;
        const val = src[0][src[1]];
        delete src[0][src[1]];
        const dst = resolvePath(b, to, true);
        if (dst) dst[0][dst[1]] = val;
        return b;
      };
    },
  },
  {
    id: "clamp-number",
    label: "Clamp number",
    blurb: "Cap a numeric field to a max (e.g. max_tokens ≤ 8192).",
    phases: BOTH,
    params: [
      {
        key: "path",
        label: "Field path",
        type: "string",
        required: true,
        placeholder: "e.g. max_tokens",
      },
      {
        key: "max",
        label: "Maximum",
        type: "number",
        required: true,
        placeholder: "8192",
      },
    ],
    build: (p) => {
      const path = str(p.path);
      const max = numOr(p.max, Infinity);
      return (b) => {
        if (!path) return b;
        const r = resolvePath(b, path, false);
        if (r) {
          const cur = r[0][r[1]];
          if (typeof cur === "number" && cur > max) r[0][r[1]] = max;
        }
        return b;
      };
    },
  },
  {
    id: "anthropic-cache",
    label: "Anthropic prompt caching",
    blurb:
      "Add ephemeral cache_control breakpoints to the stable prefix (last system block, last tool, last message) for Anthropic prompt caching. Request phase; only affects Anthropic-shaped bodies.",
    phases: REQUEST,
    params: [
      {
        key: "ttl",
        label: "Cache TTL",
        type: "string",
        required: false,
        placeholder: "5m",
        hint: "5m (default) or 1h",
      },
    ],
    build: (p) => anthropicCache(str(p.ttl) ?? "5m"),
  },
  {
    id: "system-prepend",
    label: "Prepend system text",
    blurb:
      "Prepend a fixed system instruction (works for Anthropic system + chat system message). The text is yours — not any client-impersonation prompt.",
    phases: REQUEST,
    params: [
      {
        key: "text",
        label: "System text",
        type: "string",
        required: true,
        placeholder: "e.g. Always answer concisely.",
      },
    ],
    build: (p) => systemPrepend(str(p.text) ?? ""),
  },
  {
    id: "sanitize-tool-args",
    label: "Sanitize tool-call arguments",
    blurb:
      "Fix malformed tool-call arguments from non-Claude models (numeric strings → numbers, clamp Read.limit ≤ 2000, drop negative offsets / invalid pdf pages). Response phase.",
    phases: RESPONSE,
    params: [],
    build: () => sanitizeToolArgs(),
  },
];

export const TRANSFORM_LIBRARY: Record<string, TransformDef> =
  Object.fromEntries(LIBRARY.map((d) => [d.id, d]));

export function getTransformDef(id: string): TransformDef | undefined {
  return TRANSFORM_LIBRARY[id];
}

// The UI-facing catalog (no build fn), served by GET /api/transforms.
export function listTransformDefs(): TransformDefInfo[] {
  return LIBRARY.map((d) => ({
    id: d.id,
    label: d.label,
    blurb: d.blurb,
    phases: d.phases,
    params: d.params,
  }));
}

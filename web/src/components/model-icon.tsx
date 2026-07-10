// Brand icon library for model aliases.
//
// Maps a model alias (e.g. "glm-5.2", "claude-fable-5", "gpt-5.5") to the
// vendor's logo. SVGs come from @lobehub/icons-static-svg (dev dependency),
// imported as raw strings and inlined so `fill="currentColor"` picks up the
// surrounding text color in both themes. First matching rule wins; when no
// rule matches we fall back to the model's wire type (anthropic/openai logo)
// and only then to a generic chip icon.

import { useEffect, useState } from "react";
import { Cpu, Boxes } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

import anthropicSvg from "@lobehub/icons-static-svg/icons/anthropic.svg?raw";
import claudeSvg from "@lobehub/icons-static-svg/icons/claude.svg?raw";
import openaiSvg from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import zaiSvg from "@lobehub/icons-static-svg/icons/zai.svg?raw";
import deepseekSvg from "@lobehub/icons-static-svg/icons/deepseek.svg?raw";
import geminiSvg from "@lobehub/icons-static-svg/icons/gemini.svg?raw";
import googleSvg from "@lobehub/icons-static-svg/icons/google.svg?raw";
import kimiSvg from "@lobehub/icons-static-svg/icons/kimi.svg?raw";
import mistralSvg from "@lobehub/icons-static-svg/icons/mistral.svg?raw";
import minimaxSvg from "@lobehub/icons-static-svg/icons/minimax.svg?raw";
import qwenSvg from "@lobehub/icons-static-svg/icons/qwen.svg?raw";
import mimoSvg from "@lobehub/icons-static-svg/icons/xiaomimimo.svg?raw";
import grokSvg from "@lobehub/icons-static-svg/icons/grok.svg?raw";
import metaSvg from "@lobehub/icons-static-svg/icons/meta.svg?raw";
import cohereSvg from "@lobehub/icons-static-svg/icons/cohere.svg?raw";
import huggingfaceSvg from "@lobehub/icons-static-svg/icons/huggingface.svg?raw";
import microsoftSvg from "@lobehub/icons-static-svg/icons/microsoft.svg?raw";
import nvidiaSvg from "@lobehub/icons-static-svg/icons/nvidia.svg?raw";
import openrouterSvg from "@lobehub/icons-static-svg/icons/openrouter.svg?raw";
import opencodeSvg from "@lobehub/icons-static-svg/icons/opencode.svg?raw";

// Ordered: more specific patterns before broader ones (e.g. "gemini" before
// a generic "google", "kimi" before "k2").
const BRAND_RULES: Array<{ pattern: RegExp; svg: string; label: string }> = [
  { pattern: /claude/i, svg: claudeSvg, label: "Claude" },
  { pattern: /anthropic/i, svg: anthropicSvg, label: "Anthropic" },
  {
    pattern: /gpt|davinci|o[134](-mini)?\b|codex|openai/i,
    svg: openaiSvg,
    label: "OpenAI",
  },
  { pattern: /glm|zhipu|z\.?ai|chatglm/i, svg: zaiSvg, label: "Z.ai" },
  { pattern: /deepseek/i, svg: deepseekSvg, label: "DeepSeek" },
  { pattern: /gemini|gemma|palm|bard/i, svg: geminiSvg, label: "Gemini" },
  { pattern: /google/i, svg: googleSvg, label: "Google" },
  { pattern: /kimi|moonshot|k\d+(\.\d+)?-/i, svg: kimiSvg, label: "Kimi" },
  {
    pattern: /mistral|mixtral|codestral|ministral|magistral/i,
    svg: mistralSvg,
    label: "Mistral",
  },
  { pattern: /minimax|abab/i, svg: minimaxSvg, label: "MiniMax" },
  { pattern: /qwen|qwq|qvq/i, svg: qwenSvg, label: "Qwen" },
  { pattern: /mimo|xiaomi/i, svg: mimoSvg, label: "MiMo" },
  { pattern: /grok|xai/i, svg: grokSvg, label: "Grok" },
  { pattern: /llama|meta\b/i, svg: metaSvg, label: "Meta" },
  { pattern: /command-?r|cohere|aya\b/i, svg: cohereSvg, label: "Cohere" },
  { pattern: /phi-?\d|microsoft/i, svg: microsoftSvg, label: "Microsoft" },
  { pattern: /nemotron|nvidia/i, svg: nvidiaSvg, label: "NVIDIA" },
  { pattern: /huggingface|smol/i, svg: huggingfaceSvg, label: "Hugging Face" },
];

// Fallback per gateway wire type when no alias rule matched.
const TYPE_FALLBACK: Record<string, { svg: string; label: string }> = {
  anthropic: { svg: anthropicSvg, label: "Anthropic" },
  openai: { svg: openaiSvg, label: "OpenAI" },
};

export function brandForModel(
  alias: string | null | undefined,
  type?: string | null,
): { svg: string; label: string } | null {
  if (alias) {
    for (const rule of BRAND_RULES) {
      if (rule.pattern.test(alias)) return { svg: rule.svg, label: rule.label };
    }
  }
  return (type && TYPE_FALLBACK[type]) || null;
}

// Provider brand catalog, keyed by a ProviderTemplate's `brand` field. Used by
// the provider browser + Add-Provider wizard to show a vendor logo per provider.
// `proxy` and unknown brands fall back to a generic icon (handled by ProviderIcon).
const PROVIDER_BRANDS: Record<string, { svg: string; label: string }> = {
  openai: { svg: openaiSvg, label: "OpenAI" },
  anthropic: { svg: anthropicSvg, label: "Anthropic" },
  nvidia: { svg: nvidiaSvg, label: "NVIDIA" },
  openrouter: { svg: openrouterSvg, label: "OpenRouter" },
  opencode: { svg: opencodeSvg, label: "OpenCode" },
  mimo: { svg: mimoSvg, label: "MiMo" },
  deepseek: { svg: deepseekSvg, label: "DeepSeek" },
  gemini: { svg: geminiSvg, label: "Gemini" },
  zai: { svg: zaiSvg, label: "Z.ai" },
};

// Resolve a provider's icon. Prefers an explicit catalog brand key; if absent
// (older providers, or a name typed by hand), falls back to the alias-brand
// rules using the provider name (so "OpenAI proxy" still shows the OpenAI mark).
export function brandForProvider(
  brand: string | null | undefined,
  name?: string | null,
): { svg: string; label: string } | null {
  if (brand && PROVIDER_BRANDS[brand]) return PROVIDER_BRANDS[brand];
  if (name) {
    for (const rule of BRAND_RULES) {
      if (rule.pattern.test(name)) return { svg: rule.svg, label: rule.label };
    }
  }
  return null;
}

export function ProviderIcon({
  brand,
  name,
  className,
}: {
  brand?: string | null;
  name?: string | null;
  className?: string;
}) {
  const b = brandForProvider(brand, name);
  if (!b) {
    return (
      <Boxes
        className={cn("size-4 shrink-0 opacity-70", className)}
        aria-label="Provider"
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center text-base leading-none [&>svg]:size-full",
        className,
      )}
      role="img"
      aria-label={b.label}
      title={b.label}
      dangerouslySetInnerHTML={{ __html: b.svg }}
    />
  );
}

// alias -> wire type lookup for pages that only have the alias string (logs,
// usage). Fetched once per app lifetime and shared across all subscribers.
let typeMapCache: Record<string, string> | null = null;
let typeMapPromise: Promise<Record<string, string>> | null = null;

function fetchTypeMap(): Promise<Record<string, string>> {
  if (typeMapCache) return Promise.resolve(typeMapCache);
  if (!typeMapPromise) {
    typeMapPromise = api
      .listModels()
      .then((models) => {
        typeMapCache = Object.fromEntries(models.map((m) => [m.alias, m.type]));
        return typeMapCache;
      })
      .catch(() => {
        typeMapPromise = null; // retry on next mount
        return {};
      });
  }
  return typeMapPromise;
}

// Returns { alias: "anthropic" | "openai" } so ModelIcon call sites without a
// Model object can still fall back to the provider-type icon.
export function useModelTypes(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>(typeMapCache ?? {});
  useEffect(() => {
    let alive = true;
    fetchTypeMap().then((m) => alive && setMap(m));
    return () => {
      alive = false;
    };
  }, []);
  return map;
}

export function ModelIcon({
  alias,
  type,
  className,
}: {
  alias: string | null | undefined;
  // Wire type ("anthropic" | "openai") used as the icon fallback.
  type?: string | null;
  className?: string;
}) {
  const brand = brandForModel(alias, type);
  if (!brand) {
    return (
      <Cpu
        className={cn("size-4 shrink-0 opacity-70", className)}
        aria-label="Model"
      />
    );
  }
  return (
    <span
      className={cn(
        // The SVGs are 1em square — size via font-size on the wrapper.
        "inline-flex size-4 shrink-0 items-center justify-center text-base leading-none [&>svg]:size-full",
        className,
      )}
      role="img"
      aria-label={brand.label}
      title={brand.label}
      dangerouslySetInnerHTML={{ __html: brand.svg }}
    />
  );
}

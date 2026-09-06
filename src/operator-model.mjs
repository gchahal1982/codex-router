import { existsSync, readFileSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { OPERATOR_MODEL_PATH } from "./paths.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";

export function isNativeOpenAIRoute(route) {
  if (!route) return true;
  if (canonicalProviderId(route.provider) === "openai") return true;
  return !String(route.slug || "").includes("/");
}

export function readOperatorModel() {
  if (!existsSync(OPERATOR_MODEL_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(OPERATOR_MODEL_PATH, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.slug !== "string" || !parsed.slug.trim()) {
      return undefined;
    }
    return {
      slug: parsed.slug.trim(),
      native: parsed.native === true,
    };
  } catch {
    return undefined;
  }
}

export function rememberOperatorModel(route) {
  if (!route?.slug || isNativeOpenAIRoute(route)) return;
  writePrivateJson(
    OPERATOR_MODEL_PATH,
    {
      version: 1,
      slug: route.slug,
      native: isNativeOpenAIRoute(route),
      updatedAt: new Date().toISOString(),
    },
    { directoryMode: 0o700 },
  );
}

export function followOperatorModel(currentRoute, { modelsBySlug, enabledProviders, fallbackSlug } = {}) {
  const remembered = readOperatorModel();
  const targetSlug = remembered && !remembered.native ? remembered.slug : fallbackSlug;
  if (!targetSlug) return currentRoute;
  if (currentRoute && !isNativeOpenAIRoute(currentRoute)) return currentRoute;
  const next = modelsBySlug?.get?.(targetSlug);
  if (!next || isNativeOpenAIRoute(next)) return currentRoute;
  if (Array.isArray(enabledProviders) && !enabledProviders.includes(next.provider)) {
    return currentRoute;
  }
  return next;
}

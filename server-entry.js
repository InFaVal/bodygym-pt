const nativeFetch = globalThis.fetch;

// Prefer a free, capable multimodal model and transparently fall back when
// Google returns model-not-found, quota pressure, or temporary high demand.
const PRIMARY_MODEL = "gemini-3.5-flash";
const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash"];
const RETRYABLE_STATUSES = new Set([404, 429, 503]);

process.env.GEMINI_MODEL = PRIMARY_MODEL;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanGenerationBody(body) {
  if (typeof body !== "string") return body;
  try {
    const payload = JSON.parse(body);
    if (payload?.generationConfig) {
      // Gemini 3.x no longer needs legacy sampling parameters.
      delete payload.generationConfig.temperature;
      delete payload.generationConfig.topP;
      delete payload.generationConfig.topK;
    }
    return JSON.stringify(payload);
  } catch (_) {
    return body;
  }
}

function replaceModel(url, model) {
  return url.replace(/\/models\/[^/:]+:generateContent/, `/models/${encodeURIComponent(model)}:generateContent`);
}

globalThis.fetch = async function bodyGymGeminiFetch(input, init = {}) {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input?.url || "";

  if (!url.includes("generativelanguage.googleapis.com") || !url.includes(":generateContent")) {
    return nativeFetch(input, init);
  }

  const models = [...new Set([PRIMARY_MODEL, ...FALLBACK_MODELS])];
  const patchedInit = { ...init, body: cleanGenerationBody(init?.body) };
  let lastResponse = null;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const retryUrl = replaceModel(url, model);
    const response = await nativeFetch(retryUrl, patchedInit);
    lastResponse = response;

    if (response.ok) {
      if (i > 0) console.log(`Gemini fallback succeeded with ${model}`);
      return response;
    }

    const canFallback = RETRYABLE_STATUSES.has(response.status) && i < models.length - 1;
    if (!canFallback) return response;

    console.warn(`Gemini ${model} returned HTTP ${response.status}; trying ${models[i + 1]}`);
    await sleep(350 * (i + 1));
  }

  return lastResponse;
};

await import("./server.js");

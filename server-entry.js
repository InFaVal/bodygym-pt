const nativeFetch = globalThis.fetch;

// Prefer a free, capable multimodal model and transparently fall back when
// Google returns model-not-found, quota pressure, temporary high demand,
// or a successful response whose generated JSON is malformed.
const PRIMARY_MODEL = "gemini-3.5-flash";
const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash"];
const RETRYABLE_STATUSES = new Set([404, 429, 503]);

process.env.GEMINI_MODEL = PRIMARY_MODEL;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPantryRequest(payload) {
  const text = (payload?.contents || [])
    .flatMap(c => c?.parts || [])
    .map(p => p?.text || "")
    .join("\n");
  return /Analiza esta foto de nevera|CATÁLOGO:/i.test(text);
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

    // Pantry vision only needs inventory. Recipe generation is a separate API call.
    // Keeping the vision response short substantially reduces malformed/truncated JSON.
    if (isPantryRequest(payload)) {
      const schema = payload?.generationConfig?.responseSchema;
      if (schema?.properties?.meal_ideas) {
        delete schema.properties.meal_ideas;
        if (Array.isArray(schema.required)) schema.required = schema.required.filter(x => x !== "meal_ideas");
      }
      if (payload?.generationConfig?.maxOutputTokens) {
        payload.generationConfig.maxOutputTokens = Math.min(Number(payload.generationConfig.maxOutputTokens) || 1200, 1200);
      }
      for (const content of payload.contents || []) {
        for (const part of content?.parts || []) {
          if (typeof part?.text !== "string") continue;
          part.text = part.text
            .replace(/Devuelve un objeto con foods, extra_foods, meal_ideas y note\./gi, "Devuelve un objeto con foods, extra_foods y note.")
            .replace(/Propón hasta 3 ideas sencillas y altas en proteína usando prioritariamente lo visible\.\s*/gi, "");
        }
      }
    }
    return JSON.stringify(payload);
  } catch (_) {
    return body;
  }
}

function replaceModel(url, model) {
  return url.replace(/\/models\/[^/:]+:generateContent/, `/models/${encodeURIComponent(model)}:generateContent`);
}

function asJsonObjectText(candidate) {
  const source = String(candidate || "").replace(/^\uFEFF/, "").trim();
  if (!source) return null;

  const variants = [source];
  const withoutFence = source
    .replace(/^```(?:json|javascript|js)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (withoutFence !== source) variants.push(withoutFence);

  const accept = text => {
    const attempts = [String(text || "").trim()];
    const noTrailingCommas = attempts[0].replace(/,\s*([}\]])/g, "$1");
    if (noTrailingCommas !== attempts[0]) attempts.push(noTrailingCommas);
    for (const attempt of attempts) {
      try {
        let value = JSON.parse(attempt);
        // Occasionally a model returns a JSON string containing the actual JSON.
        if (typeof value === "string") {
          try { value = JSON.parse(value); } catch (_) { continue; }
        }
        if (value && typeof value === "object") return JSON.stringify(value);
      } catch (_) {}
    }
    return null;
  };

  for (const variant of variants) {
    const parsed = accept(variant);
    if (parsed) return parsed;
  }

  // Extract the first balanced JSON object/array from prose or markdown.
  for (const variant of variants) {
    for (let start = 0; start < variant.length; start += 1) {
      const first = variant[start];
      if (first !== "{" && first !== "[") continue;
      const stack = [];
      let inString = false;
      let escaped = false;

      for (let i = start; i < variant.length; i += 1) {
        const ch = variant[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") {
          if (!stack.length) break;
          const open = stack.pop();
          if ((open === "{" && ch !== "}") || (open === "[" && ch !== "]")) break;
          if (!stack.length) {
            const parsed = accept(variant.slice(start, i + 1));
            if (parsed) return parsed;
            break;
          }
        }
      }

      // Last-resort repair for a response cut off near the end by the model.
      if (stack.length) {
        let repaired = variant.slice(start).trim();
        if (inString) repaired += '"';
        repaired = repaired.replace(/,\s*$/, "");
        for (let j = stack.length - 1; j >= 0; j -= 1) repaired += stack[j] === "{" ? "}" : "]";
        const parsed = accept(repaired);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

async function normalizeSuccessfulGeminiResponse(response) {
  const raw = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (_) {
    return { response: rebuildResponse(response, raw), validJson: false };
  }

  let foundText = false;
  let allJsonValid = true;
  for (const candidate of envelope?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text !== "string" || !part.text.trim()) continue;
      foundText = true;
      const normalized = asJsonObjectText(part.text);
      if (normalized) part.text = normalized;
      else allJsonValid = false;
    }
  }

  const body = JSON.stringify(envelope);
  return {
    response: rebuildResponse(response, body),
    validJson: foundText && allJsonValid
  };
}

function rebuildResponse(original, body) {
  const headers = new Headers(original.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers
  });
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

    if (response.ok) {
      const normalized = await normalizeSuccessfulGeminiResponse(response);
      lastResponse = normalized.response;
      if (normalized.validJson) {
        if (i > 0) console.log(`Gemini fallback succeeded with ${model}`);
        return normalized.response;
      }
      if (i < models.length - 1) {
        console.warn(`Gemini ${model} returned malformed generated JSON; trying ${models[i + 1]}`);
        await sleep(250 * (i + 1));
        continue;
      }
      return normalized.response;
    }

    lastResponse = response;
    const canFallback = RETRYABLE_STATUSES.has(response.status) && i < models.length - 1;
    if (!canFallback) return response;

    console.warn(`Gemini ${model} returned HTTP ${response.status}; trying ${models[i + 1]}`);
    await sleep(350 * (i + 1));
  }

  return lastResponse;
};

await import("./server.js");
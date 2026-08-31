const nativeFetch = globalThis.fetch;

// Prefer a free, capable multimodal model and transparently fall back when
// Google returns model-not-found, quota pressure, temporary high demand,
// or a successful response whose generated JSON is malformed.
const PRIMARY_MODEL = "gemini-3.5-flash";
const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash"];
const RETRYABLE_STATUSES = new Set([404, 429, 503]);
const DAY_ORDER = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

process.env.GEMINI_MODEL = PRIMARY_MODEL;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestText(payload) {
  return (payload?.contents || [])
    .flatMap(c => c?.parts || [])
    .map(p => p?.text || "")
    .join("\n");
}

function isPantryRequest(payload) {
  return /Analiza esta foto de nevera|CATÁLOGO:/i.test(requestText(payload));
}

function weeklyChunkMeta(payload) {
  const text = requestText(payload);
  const match = text.match(/Diseña exactamente\s+(\d+)\s+días\s+\(([^)]+)\)/i);
  if (!match || Number(match[1]) <= 1) return null;
  const dayNames = match[2].split(",").map(x => x.trim()).filter(Boolean);
  if (dayNames.length <= 1) return null;
  return { dayNames };
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

async function fetchGeminiWithFallback(url, init, models) {
  let lastResponse = null;
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const retryUrl = replaceModel(url, model);
    const response = await nativeFetch(retryUrl, init);

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
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function perishableInstruction(dayName) {
  const idx = DAY_ORDER.indexOf(dayName);
  if (idx <= 2 && idx >= 0) {
    return "Este día está al principio de la semana: prioriza claramente productos de perecibilidad ALTA que encajen, para no dejarlos estropearse.";
  }
  if (idx <= 4 && idx >= 0) {
    return "A estas alturas prioriza perecederos de prioridad MEDIA y no reserves innecesariamente productos frescos para el final de semana.";
  }
  return "Es final de semana: usa sobre todo productos duraderos o los perecederos que aún tenga sentido terminar; no inventes que queda stock de un producto concreto.";
}

function patchDailyPayload(basePayload, originalDayNames, dayName, usedTitles) {
  const payload = clone(basePayload);
  const schema = payload?.generationConfig?.responseSchema;
  const daysSchema = schema?.properties?.days;
  if (daysSchema) {
    daysSchema.minItems = 1;
    daysSchema.maxItems = 1;
  }
  if (payload?.generationConfig) {
    payload.generationConfig.maxOutputTokens = Math.min(Number(payload.generationConfig.maxOutputTokens) || 2200, 2200);
  }

  const originalList = originalDayNames.join(", ");
  for (const content of payload.contents || []) {
    for (const part of content?.parts || []) {
      if (typeof part?.text !== "string") continue;
      part.text = part.text
        .replace(new RegExp(`Diseña exactamente\\s+${originalDayNames.length}\\s+días\\s+\\(${originalList.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "i"), `Diseña exactamente 1 día (${dayName})`)
        .replace(/Incluye recipe_steps en\s+(?:2-3|2)\s+comidas de este bloque/gi, "Incluye recipe_steps en 2 comidas de este día, preferentemente Comida y Cena");
      part.text += `\n\nINSTRUCCIÓN ESPECÍFICA PARA ${dayName}: ${perishableInstruction(dayName)}\n`;
      if (usedTitles.length) {
        part.text += `Ya se han generado estas preparaciones en días anteriores de esta misma semana: ${usedTitles.slice(-14).join("; ")}. Evita repetirlas literalmente y rota ingredientes cuando sea razonable.\n`;
      }
      part.text += "Devuelve exactamente UN objeto en days, con 4 comidas completas y totals del día. Mantén la respuesta compacta para evitar cortes.";
    }
  }
  return payload;
}

function extractGeneratedObjectFromEnvelope(raw) {
  const envelope = JSON.parse(raw);
  const text = (envelope?.candidates || [])
    .flatMap(c => c?.content?.parts || [])
    .map(p => p?.text || "")
    .join("")
    .trim();
  const normalized = asJsonObjectText(text);
  if (!normalized) throw new Error("Gemini devolvió JSON semanal no interpretable");
  return JSON.parse(normalized);
}

function syntheticGeminiResponse(days, notes) {
  const generated = JSON.stringify({ days, note: notes.filter(Boolean).join(" ") });
  const envelope = {
    candidates: [{
      content: { role: "model", parts: [{ text: generated }] },
      finishReason: "STOP"
    }]
  };
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function splitWeeklyChunkRequest(url, init, payload, meta, models) {
  const days = [];
  const notes = [];
  const usedTitles = [];

  for (const dayName of meta.dayNames) {
    const dailyPayload = patchDailyPayload(payload, meta.dayNames, dayName, usedTitles);
    const dailyInit = { ...init, body: JSON.stringify(dailyPayload) };
    let dailyResponse = await fetchGeminiWithFallback(url, dailyInit, models);

    // A single small day should normally be reliable. Give just that day one
    // extra attempt before failing the whole week.
    if (!dailyResponse.ok) {
      await sleep(400);
      dailyResponse = await fetchGeminiWithFallback(url, dailyInit, models);
    }
    if (!dailyResponse.ok) return dailyResponse;

    const raw = await dailyResponse.text();
    let data;
    try {
      data = extractGeneratedObjectFromEnvelope(raw);
    } catch (err) {
      console.warn(`Weekly ${dayName} parse failed; retrying once`, err.message);
      await sleep(300);
      const retry = await fetchGeminiWithFallback(url, dailyInit, models);
      if (!retry.ok) return retry;
      data = extractGeneratedObjectFromEnvelope(await retry.text());
    }

    const day = Array.isArray(data?.days) ? data.days[0] : null;
    if (!day || !Array.isArray(day.meals) || day.meals.length !== 4) {
      throw new Error(`Gemini no devolvió las 4 comidas de ${dayName}`);
    }
    day.day = dayName;
    days.push(day);
    if (data.note) notes.push(data.note);
    for (const meal of day.meals) if (meal?.title) usedTitles.push(meal.title);
  }

  console.log(`Weekly chunk generated day-by-day: ${meta.dayNames.join(", ")}`);
  return syntheticGeminiResponse(days, notes);
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
  const cleanedBody = cleanGenerationBody(init?.body);
  const patchedInit = { ...init, body: cleanedBody };

  let payload = null;
  try { payload = typeof cleanedBody === "string" ? JSON.parse(cleanedBody) : null; } catch (_) {}
  const weekly = payload ? weeklyChunkMeta(payload) : null;
  if (weekly) {
    try {
      return await splitWeeklyChunkRequest(url, patchedInit, payload, weekly, models);
    } catch (err) {
      console.error("Day-by-day weekly generation failed", err.message);
      return new Response(JSON.stringify({ error: { code: 502, message: err.message || "Weekly generation failed" } }), {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  }

  return fetchGeminiWithFallback(url, patchedInit, models);
};

await import("./server.js");
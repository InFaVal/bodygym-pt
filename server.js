import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || "https://infaval.github.io")
  .split(",")
  .map(x => x.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const KITCHEN_STAPLES = [
  "sal",
  "pimienta",
  "especias secas comunes (pimentón, curry, comino, orégano, ajo/cebolla en polvo, etc.)",
  "hierbas aromáticas",
  "vinagre",
  "agua"
];

app.disable("x-powered-by");
app.use(express.json({ limit: "12mb" }));

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "").replace(/\/+$/, "");
  const allowed = !origin || FRONTEND_ORIGINS.includes(origin);
  if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return allowed ? res.sendStatus(204) : res.sendStatus(403);
  if (!allowed) return res.status(403).json({ error: `Origen no permitido: ${origin}` });
  next();
});

const rate = new Map();
app.use("/api", (req, res, next) => {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const current = rate.get(ip);
  if (!current || current.reset < now) {
    rate.set(ip, { count: 1, reset: now + windowMs });
    return next();
  }
  current.count += 1;
  if (current.count > 40) return res.status(429).json({ error: "Límite temporal de IA alcanzado. Prueba más tarde." });
  next();
});

const FOOD_CATALOG = [
  ["pollo", "Pechuga de pollo"], ["lomo", "Lomo fresco"], ["sardinas", "Sardinas en lata"],
  ["atun", "Atún al natural"], ["salmon", "Salmón ahumado"], ["garbanzos", "Garbanzos"],
  ["avena", "Avena"], ["leche", "Leche semidesnatada"], ["whey", "Proteína whey"],
  ["yogur", "Yogur griego 0 %"], ["cottage", "Queso cottage"], ["canela", "Canela"],
  ["patata", "Patata"], ["pasta", "Pasta"], ["arandanos", "Arándanos"],
  ["pina", "Piña"], ["kiwi", "Kiwi"], ["ensalada", "Lechuga o rúcula"],
  ["tomate", "Tomate o cebolla"], ["aguacate", "Aguacate"], ["aove", "Aceite de oliva virgen extra"]
];
const FOOD_IDS = FOOD_CATALOG.map(x => x[0]);
const FOOD_TEXT = FOOD_CATALOG.map(([id, name]) => `${id}: ${name}`).join("\n");

function requireKey(res) {
  if (!GEMINI_API_KEY) {
    res.status(503).json({ error: "El servidor IA no tiene configurada GEMINI_API_KEY." });
    return false;
  }
  return true;
}

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function perishability(name) {
  const n = normalizeText(name);
  if (/pollo|lomo|carne fresca|pavo|ternera|pescado fresco|salmon ahumado|marisco|cottage|queso fresco|lechuga|rucula|espinaca|arandano|frambuesa|fresa/.test(n)) return "alta";
  if (/huevo|leche|yogur|kefir|aguacate|tomate|melon|sandia|pina|kiwi|fruta|verdura|seta|champinon|brocoli|calabacin|pimiento/.test(n)) return "media";
  return "baja";
}

function dataUrlToInlinePart(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) throw new Error("Formato de imagen no válido");
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

function toLegacyResponseSchema(value) {
  if (Array.isArray(value)) return value.map(toLegacyResponseSchema);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "additionalProperties") continue;
    out[k] = toLegacyResponseSchema(v);
  }
  return out;
}

function geminiError(raw, status) {
  let message = "";
  let code = status;
  try {
    const parsed = JSON.parse(raw);
    message = parsed?.error?.message || "";
    code = parsed?.error?.code || status;
  } catch (_) {}
  const err = new Error(message || `Gemini HTTP ${status}`);
  err.status = Number(code) || status;
  err.raw = raw;
  return err;
}

function parseGeneratedJson(text) {
  let source = String(text || "").replace(/^\uFEFF/, "").trim();
  source = source.replace(/^```(?:json|javascript|js)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(source); } catch (_) {}
  const firstObj = source.indexOf("{");
  const lastObj = source.lastIndexOf("}");
  if (firstObj >= 0 && lastObj > firstObj) {
    try { return JSON.parse(source.slice(firstObj, lastObj + 1)); } catch (_) {}
  }
  throw new Error("Gemini respondió, pero el JSON generado no se pudo interpretar.");
}

async function requestGemini({ parts, schema, maxOutputTokens, useSchema }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const generationConfig = {
    responseMimeType: "application/json",
    maxOutputTokens,
    temperature: 0.2
  };
  if (useSchema && schema) generationConfig.responseSchema = toLegacyResponseSchema(schema);

  const requestParts = useSchema || !schema
    ? parts
    : [...parts, { text: `Devuelve EXCLUSIVAMENTE JSON válido ajustado a esta estructura aproximada: ${JSON.stringify(schema)}` }];

  const response = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: requestParts }], generationConfig })
  });

  const raw = await response.text();
  if (!response.ok) throw geminiError(raw, response.status);

  let envelope;
  try { envelope = JSON.parse(raw); }
  catch (_) { throw new Error("Gemini devolvió una respuesta HTTP válida pero no JSON."); }

  const text = (envelope.candidates || [])
    .flatMap(c => c?.content?.parts || [])
    .map(p => p?.text || "")
    .join("")
    .trim();
  if (!text) {
    const block = envelope?.promptFeedback?.blockReason || envelope?.candidates?.[0]?.finishReason || "sin contenido";
    throw new Error(`Gemini no devolvió contenido (${block}).`);
  }
  return parseGeneratedJson(text);
}

async function gemini({ parts, schema, maxOutputTokens = 1600 }) {
  try {
    return await requestGemini({ parts, schema, maxOutputTokens, useSchema: true });
  } catch (firstErr) {
    console.warn("Gemini structured request failed; retrying JSON-only", firstErr.status || "", firstErr.message);
    if ([401, 403, 404, 429, 503].includes(Number(firstErr.status))) throw firstErr;
    try {
      return await requestGemini({ parts, schema, maxOutputTokens, useSchema: false });
    } catch (secondErr) {
      console.error("Gemini fallback failed", secondErr.status || "", secondErr.message);
      throw secondErr;
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(GEMINI_API_KEY),
    provider: "gemini",
    model: MODEL,
    pantryVision: true,
    mealAdaptation: true,
    weeklyMenus: true,
    recipes: true,
    perishablePriority: true,
    backendVersion: "weekly-menu-v1"
  });
});

app.post("/api/analyze-pantry", async (req, res) => {
  if (!requireKey(res)) return;
  const image = req.body?.image;
  const currentPantry = Array.isArray(req.body?.currentPantry) ? req.body.currentPantry.slice(0, 80) : [];
  if (typeof image !== "string" || !image.startsWith("data:image/")) return res.status(400).json({ error: "Falta una imagen válida." });
  if (image.length > 10_000_000) return res.status(413).json({ error: "La imagen es demasiado grande." });

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["foods", "extra_foods", "meal_ideas", "note"],
    properties: {
      foods: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "confidence", "quantity"], properties: { id: { type: "string", enum: FOOD_IDS }, name: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }, quantity: { type: "string" } } } },
      extra_foods: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "confidence", "quantity"], properties: { name: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }, quantity: { type: "string" } } } },
      meal_ideas: { type: "array", maxItems: 1, items: { type: "object", additionalProperties: false, required: ["title", "ingredients", "reason"], properties: { title: { type: "string" }, ingredients: { type: "array", items: { type: "string" } }, reason: { type: "string" } } } },
      note: { type: "string" }
    }
  };

  try {
    const data = await gemini({
      maxOutputTokens: 1100,
      schema,
      parts: [
        { text: `Analiza esta foto de nevera, despensa, compra o alimentos. Identifica solo alimentos visibles con prudencia. Para los que encajen en el catálogo usa foods. Si ves claramente un alimento que no está en el catálogo, inclúyelo en extra_foods. No incluyas utensilios ni objetos. No inventes cantidades exactas: usa una cantidad aproximada o \"visible\". Que un alimento no salga en la foto NO significa que ya no esté en casa. Los alimentos ya marcados eran: ${currentPantry.join(", ") || "ninguno"}.\n\nCATÁLOGO:\n${FOOD_TEXT}\n\nDevuelve foods, extra_foods, meal_ideas (vacío o como máximo una idea muy breve) y note. La prioridad es INVENTARIO, no recetas.` },
        dataUrlToInlinePart(image)
      ]
    });
    if (!Array.isArray(data.foods)) data.foods = [];
    if (!Array.isArray(data.extra_foods)) data.extra_foods = [];
    if (!Array.isArray(data.meal_ideas)) data.meal_ideas = [];
    if (typeof data.note !== "string") data.note = "";
    res.json(data);
  } catch (err) {
    const status = Number(err.status) || 502;
    const friendly = status === 429
      ? "Gemini ha rechazado la petición por cuota/límite (429). Revisa el nivel gratuito o espera unos minutos."
      : status === 403
        ? "Gemini ha rechazado la clave o el proyecto (403)."
        : status === 401
          ? "La clave de Gemini no es válida (401)."
          : status === 404
            ? `El modelo ${MODEL} no está disponible para esta clave/proyecto (404).`
            : status === 503
              ? "Gemini está temporalmente saturado (503)."
              : err.message || "error desconocido";
    res.status(502).json({ error: `No he podido analizar la foto con Gemini: ${friendly}` });
  }
});

const MACRO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kcal", "protein_g", "carbs_g", "fat_g"],
  properties: {
    kcal: { type: "number" },
    protein_g: { type: "number" },
    carbs_g: { type: "number" },
    fat_g: { type: "number" }
  }
};

const MEAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slot", "title", "items", "macros", "recipe_steps", "seasoning", "uses_perishable"],
  properties: {
    slot: { type: "string", enum: ["Desayuno", "Comida", "Merienda", "Cena"] },
    title: { type: "string" },
    items: {
      type: "array", minItems: 2, maxItems: 8,
      items: {
        type: "object", additionalProperties: false,
        required: ["food_id", "name", "quantity"],
        properties: { food_id: { type: "string" }, name: { type: "string" }, quantity: { type: "string" } }
      }
    },
    macros: MACRO_SCHEMA,
    recipe_steps: { type: "array", maxItems: 4, items: { type: "string" } },
    seasoning: { type: "string" },
    uses_perishable: { type: "boolean" }
  }
};

app.post("/api/suggest-meal", async (req, res) => {
  if (!requireKey(res)) return;
  const target = req.body?.target || {};
  const currentMeal = req.body?.currentMeal || {};
  const pantry = Array.isArray(req.body?.pantry) ? req.body.pantry.slice(0, 80) : [];
  const customFoods = Array.isArray(req.body?.customFoods) ? req.body.customFoods.slice(0, 40) : [];
  if (!pantry.length && !customFoods.length) return res.status(400).json({ error: "Marca primero alimentos en Despensa." });

  const kcal = Math.max(100, Math.min(1400, Number(target.kcal) || 500));
  const protein = Math.max(10, Math.min(120, Number(target.protein_g) || 35));
  const carbs = Math.max(0, Math.min(250, Number(target.carbs_g) || 40));
  const fat = Math.max(0, Math.min(100, Number(target.fat_g) || 15));
  const availableNames = pantry.map(x => x.name || x.id).concat(customFoods);
  const priority = availableNames.map(name => `${name}: perecibilidad ${perishability(name)}`).join("\n");

  const schema = {
    type: "object", additionalProperties: false,
    required: ["meal", "note"],
    properties: { meal: MEAL_SCHEMA, note: { type: "string" } }
  };

  try {
    const data = await gemini({
      maxOutputTokens: 1500,
      schema,
      parts: [{ text: `Crea UNA alternativa realista para ${currentMeal.title || "esta comida"} usando únicamente alimentos marcados como disponibles más los básicos de cocina permitidos.\n\nALIMENTOS DISPONIBLES:\n${pantry.map(x => `${x.id}: ${x.name}`).join("\n") || "ninguno"}\n\nOTROS DISPONIBLES:\n${customFoods.join("\n") || "ninguno"}\n\nPERECIBILIDAD ORIENTATIVA:\n${priority}\n\nBÁSICOS SIEMPRE DISPONIBLES (no hace falta que aparezcan en la despensa): ${KITCHEN_STAPLES.join(", ")}. No asumas aceite ni otros ingredientes calóricos si no están marcados.\n\nCOMIDA ACTUAL:\n${JSON.stringify(currentMeal)}\n\nOBJETIVO APROXIMADO: ${kcal} kcal; proteína ${protein} g; hidratos ${carbs} g; grasa ${fat} g.\n\nDa cantidades concretas. Intenta ±10% kcal y no más de 5 g por debajo en proteína. Si hay un perecedero de prioridad alta adecuado, úsalo antes que una conserva o alimento seco. Incluye 2-4 pasos de receta cuando la comida requiera cocinar; si es muy simple, recipe_steps puede estar vacío. seasoning puede usar sal y especias comunes. No añadas alimentos no disponibles.` }]
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `No he podido crear una alternativa con Gemini: ${err.message || "error desconocido"}` });
  }
});

function weekChunkSchema(dayCount) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["days", "note"],
    properties: {
      days: {
        type: "array", minItems: dayCount, maxItems: dayCount,
        items: {
          type: "object", additionalProperties: false,
          required: ["day", "meals", "totals"],
          properties: {
            day: { type: "string" },
            meals: { type: "array", minItems: 4, maxItems: 4, items: MEAL_SCHEMA },
            totals: MACRO_SCHEMA
          }
        }
      },
      note: { type: "string" }
    }
  };
}

async function generateWeekChunk({ dayNames, availableText, priorityText, observedText, target, avoidText, firstChunk }) {
  const kcal = Number(target.kcal) || 2450;
  const protein = Number(target.protein_g) || 160;
  const carbsMin = Number(target.carbs_min) || 250;
  const carbsMax = Number(target.carbs_max) || 290;
  const fatMin = Number(target.fat_min) || 70;
  const fatMax = Number(target.fat_max) || 75;
  const recipeCount = firstChunk ? "2-3" : "2";

  return gemini({
    maxOutputTokens: firstChunk ? 4200 : 3400,
    schema: weekChunkSchema(dayNames.length),
    parts: [{ text: `Diseña exactamente ${dayNames.length} días (${dayNames.join(", ")}) de un menú de 4 comidas diarias: Desayuno, Comida, Merienda y Cena.\n\nOBJETIVO DIARIO ACTUAL: alrededor de ${kcal} kcal; proteína ${protein} g (ideal 155-165 g); hidratos ${carbsMin}-${carbsMax} g; grasa ${fatMin}-${fatMax} g. Mantén cada día aproximadamente dentro de esos rangos, sin compensaciones extremas entre días.\n\nALIMENTOS MARCADOS COMO DISPONIBLES:\n${availableText}\n\nPERECIBILIDAD ORIENTATIVA:\n${priorityText}\n\nÚLTIMA FOTO (solo pista de cantidad, puede no estar completa):\n${observedText || "sin datos de cantidad"}\n\nBÁSICOS DE COCINA SIEMPRE DISPONIBLES: ${KITCHEN_STAPLES.join(", ")}. Puedes usarlos en seasoning/receta sin exigir que estén marcados. No asumas AOVE, frutos secos, salsas u otros ingredientes calóricos si no están en la lista disponible.\n\nREGLAS IMPORTANTES:\n- Usa SOLO los alimentos disponibles y los básicos indicados.\n- Los alimentos de perecibilidad ALTA deben aparecer prioritariamente en los primeros 1-3 días; los de MEDIA preferentemente antes del día 5.\n- Intenta rotar por la mayor parte de la despensa durante la semana, pero NO fuerces a usar absolutamente todo si empeora el menú o los macros.\n- Prioriza perecederos antes que conservas/secos cuando sean intercambiables.\n- Varía fuentes de proteína e hidratos para no repetir exactamente la misma comida.\n- Da cantidades concretas en gramos, unidades o latas.\n- Incluye recipe_steps en ${recipeCount} comidas de este bloque, preferentemente Comida/Cena; el resto puede llevar recipe_steps=[]. Las recetas deben ser sencillas, realistas y usar únicamente lo disponible + sal/especias/agua/vinagre.\n- Las especias no necesitan aparecer como item ni contar macros.\n- No des consejos médicos.\n${avoidText ? `- Evita repetir demasiado estas preparaciones ya usadas: ${avoidText}.` : ""}\n\nDevuelve days y note.` }]
  });
}

app.post("/api/generate-week", async (req, res) => {
  if (!requireKey(res)) return;
  const pantry = Array.isArray(req.body?.pantry) ? req.body.pantry.slice(0, 80) : [];
  const customFoods = Array.isArray(req.body?.customFoods) ? req.body.customFoods.slice(0, 60) : [];
  const observed = Array.isArray(req.body?.observed) ? req.body.observed.slice(0, 80) : [];
  const target = req.body?.target || {};

  const available = [];
  for (const x of pantry) {
    const name = String(x?.name || x?.id || "").trim();
    if (name) available.push({ id: String(x?.id || "custom"), name });
  }
  for (const nameRaw of customFoods) {
    const name = String(nameRaw || "").trim();
    if (name && !available.some(x => normalizeText(x.name) === normalizeText(name))) available.push({ id: "custom", name });
  }
  if (available.length < 3) return res.status(400).json({ error: "Marca al menos varios alimentos en Despensa antes de generar la semana." });

  const availableText = available.map(x => `${x.id}: ${x.name}`).join("\n");
  const priorityRows = available.map(x => ({ name: x.name, priority: perishability(x.name) }));
  const priorityText = priorityRows.map(x => `${x.name}: ${x.priority}`).join("\n");
  const observedText = observed.map(x => `${x.name || "alimento"}: ${x.quantity || "visible"}`).join("\n");

  try {
    const first = await generateWeekChunk({
      dayNames: ["Lunes", "Martes", "Miércoles", "Jueves"],
      availableText, priorityText, observedText, target, avoidText: "", firstChunk: true
    });
    const usedTitles = (first.days || []).flatMap(d => (d.meals || []).map(m => m.title)).filter(Boolean).slice(0, 16).join("; ");
    const second = await generateWeekChunk({
      dayNames: ["Viernes", "Sábado", "Domingo"],
      availableText, priorityText, observedText, target, avoidText: usedTitles, firstChunk: false
    });

    const days = [...(first.days || []), ...(second.days || [])].slice(0, 7);
    if (days.length !== 7) throw new Error("Gemini no devolvió los 7 días completos.");

    const high = priorityRows.filter(x => x.priority === "alta").map(x => x.name);
    const medium = priorityRows.filter(x => x.priority === "media").map(x => x.name);
    res.json({
      days,
      target: {
        kcal: Number(target.kcal) || 2450,
        protein_g: Number(target.protein_g) || 160,
        carbs_min: Number(target.carbs_min) || 250,
        carbs_max: Number(target.carbs_max) || 290,
        fat_min: Number(target.fat_min) || 70,
        fat_max: Number(target.fat_max) || 75
      },
      perishable_priority: { high, medium },
      staples: KITCHEN_STAPLES,
      note: [first.note, second.note].filter(Boolean).join(" ")
    });
  } catch (err) {
    console.error("Weekly menu generation failed", err.status || "", err.message);
    res.status(502).json({ error: `No he podido generar la semana completa con Gemini: ${err.message || "error desconocido"}` });
  }
});

app.post("/api/coach-review", async (req, res) => {
  if (!requireKey(res)) return;
  const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(-60) : [];
  const measures = Array.isArray(req.body?.measures) ? req.body.measures.slice(-20) : [];
  if (!logs.length && !measures.length) return res.status(400).json({ error: "Aún no hay datos suficientes para revisar." });
  const schema = {
    type: "object", additionalProperties: false,
    required: ["status", "summary", "training", "nutrition", "watchouts", "next_review"],
    properties: {
      status: { type: "string", enum: ["bien", "vigilar", "revisar"] },
      summary: { type: "string" },
      training: { type: "array", maxItems: 5, items: { type: "string" } },
      nutrition: { type: "array", maxItems: 4, items: { type: "string" } },
      watchouts: { type: "array", maxItems: 4, items: { type: "string" } },
      next_review: { type: "string" }
    }
  };
  try {
    const data = await gemini({
      maxOutputTokens: 1700,
      schema,
      parts: [{ text: `Actúa como revisor conservador de hipertrofia. No cambies automáticamente ejercicios, series, cargas ni calorías. Señala tendencias, estancamientos y dolor. Una sesión mala aislada no justifica cambios.\n\nDevuelve status, summary, training, nutrition, watchouts y next_review.\n\nENTRENAMIENTO:\n${JSON.stringify(logs)}\n\nMEDIDAS:\n${JSON.stringify(measures)}` }]
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `No he podido completar la revisión: ${err.message || "error desconocido"}` });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BodyGym PT AI (Gemini + visión + macros + semana + recetas) escuchando en puerto ${PORT}`);
});

import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || "https://infaval.github.io")
  .split(",")
  .map(x => x.trim().replace(/\/+$/, ""))
  .filter(Boolean);

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
  if (!allowed) {
    console.warn("CORS blocked origin:", origin, "allowed:", FRONTEND_ORIGINS);
    return res.status(403).json({ error: `Origen no permitido: ${origin}` });
  }
  next();
});

const rate = new Map();
app.use("/api", (req, res, next) => {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  const now = Date.now(), windowMs = 60 * 60 * 1000;
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
    : [...parts, { text: `Devuelve EXCLUSIVAMENTE JSON válido. Debe respetar esta estructura aproximada: ${JSON.stringify(schema)}` }];

  const response = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: requestParts }],
      generationConfig
    })
  });

  const raw = await response.text();
  if (!response.ok) throw geminiError(raw, response.status);

  let json;
  try { json = JSON.parse(raw); }
  catch (_) { throw new Error("Gemini devolvió una respuesta HTTP válida pero no JSON."); }

  const text = (json.candidates || [])
    .flatMap(c => c?.content?.parts || [])
    .map(p => p?.text || "")
    .join("")
    .trim();
  if (!text) {
    const block = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || "sin contenido";
    throw new Error(`Gemini no devolvió contenido (${block}).`);
  }
  try { return JSON.parse(text); }
  catch (_) { throw new Error("Gemini respondió, pero el JSON generado no se pudo interpretar."); }
}

async function gemini({ parts, schema, maxOutputTokens = 1600 }) {
  try {
    return await requestGemini({ parts, schema, maxOutputTokens, useSchema: true });
  } catch (firstErr) {
    console.warn("Gemini structured request failed; retrying JSON-only", firstErr.status || "", firstErr.message);
    if ([401, 403, 404, 429].includes(Number(firstErr.status))) throw firstErr;
    try {
      return await requestGemini({ parts, schema, maxOutputTokens, useSchema: false });
    } catch (secondErr) {
      console.error("Gemini fallback failed", secondErr.status || "", secondErr.message);
      throw secondErr;
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(GEMINI_API_KEY), provider: "gemini", model: MODEL, pantryVision: true, mealAdaptation: true, backendVersion: "vision-fallback-v2" });
});

app.post("/api/analyze-pantry", async (req, res) => {
  if (!requireKey(res)) return;
  const image = req.body?.image;
  const currentPantry = Array.isArray(req.body?.currentPantry) ? req.body.currentPantry.slice(0, 80) : [];
  if (typeof image !== "string" || !image.startsWith("data:image/")) return res.status(400).json({ error: "Falta una imagen válida." });
  if (image.length > 10_000_000) return res.status(413).json({ error: "La imagen es demasiado grande." });

  const schema = {
    type: "object", additionalProperties: false,
    required: ["foods", "extra_foods", "meal_ideas", "note"],
    properties: {
      foods: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "confidence", "quantity"], properties: { id: { type: "string", enum: FOOD_IDS }, name: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }, quantity: { type: "string" } } } },
      extra_foods: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "confidence", "quantity"], properties: { name: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }, quantity: { type: "string" } } } },
      meal_ideas: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["title", "ingredients", "reason"], properties: { title: { type: "string" }, ingredients: { type: "array", items: { type: "string" } }, reason: { type: "string" } } } },
      note: { type: "string" }
    }
  };

  try {
    const data = await gemini({
      maxOutputTokens: 1500,
      schema,
      parts: [
        { text: `Analiza esta foto de nevera, despensa, compra o alimentos. Identifica los alimentos visibles con prudencia. Para los que encajen en el catálogo usa foods. Si ves claramente un ALIMENTO que no está en el catálogo, inclúyelo en extra_foods; no incluyas utensilios, envases vacíos ni objetos no alimentarios. No inventes marcas ni cantidades exactas: usa cantidad aproximada o \"visible\". Que un alimento no salga en la foto NO significa que ya no esté en casa. Los alimentos ya marcados eran: ${currentPantry.join(", ") || "ninguno"}.\n\nCATÁLOGO:\n${FOOD_TEXT}\n\nDevuelve un objeto con foods, extra_foods, meal_ideas y note. Propón hasta 3 ideas sencillas y altas en proteína usando prioritariamente lo visible. No des consejos médicos.` },
        dataUrlToInlinePart(image)
      ]
    });
    if (!Array.isArray(data.foods)) data.foods = [];
    if (!Array.isArray(data.extra_foods)) data.extra_foods = [];
    if (!Array.isArray(data.meal_ideas)) data.meal_ideas = [];
    if (typeof data.note !== "string") data.note = "";
    console.log("Pantry analyzed", { foods: data.foods.length, extra: data.extra_foods.length });
    res.json(data);
  } catch (err) {
    console.error("Pantry analysis failed", err.status || "", err.message);
    const status = Number(err.status) || 502;
    const friendly = status === 429
      ? "Gemini ha rechazado la petición por cuota/límite (429). Revisa el nivel gratuito o espera unos minutos."
      : status === 403
        ? "Gemini ha rechazado la clave o el proyecto (403). Revisa que la API key pertenezca al proyecto correcto y tenga acceso a Gemini API."
        : status === 401
          ? "La clave de Gemini no es válida (401)."
          : status === 404
            ? `El modelo ${MODEL} no está disponible para esta clave/proyecto (404).`
            : err.message || "error desconocido";
    res.status(502).json({ error: `No he podido analizar la foto con Gemini: ${friendly}` });
  }
});

app.post("/api/suggest-meal", async (req, res) => {
  if (!requireKey(res)) return;
  const target = req.body?.target || {}, currentMeal = req.body?.currentMeal || {};
  const pantry = Array.isArray(req.body?.pantry) ? req.body.pantry.slice(0, 80) : [];
  const customFoods = Array.isArray(req.body?.customFoods) ? req.body.customFoods.slice(0, 40) : [];
  if (!pantry.length && !customFoods.length) return res.status(400).json({ error: "Marca primero alimentos en Despensa." });
  const kcal = Math.max(100, Math.min(1400, Number(target.kcal) || 500));
  const protein = Math.max(10, Math.min(120, Number(target.protein_g) || 35));
  const carbs = Math.max(0, Math.min(250, Number(target.carbs_g) || 40));
  const fat = Math.max(0, Math.min(100, Number(target.fat_g) || 15));
  const schema = { type: "object", additionalProperties: false, required: ["meal", "note"], properties: { meal: { type: "object", additionalProperties: false, required: ["title", "items", "macros"], properties: { title: { type: "string" }, items: { type: "array", minItems: 2, maxItems: 7, items: { type: "object", additionalProperties: false, required: ["food_id", "name", "quantity"], properties: { food_id: { type: "string" }, name: { type: "string" }, quantity: { type: "string" } } } }, macros: { type: "object", additionalProperties: false, required: ["kcal", "protein_g", "carbs_g", "fat_g"], properties: { kcal: { type: "number" }, protein_g: { type: "number" }, carbs_g: { type: "number" }, fat_g: { type: "number" } } } } }, note: { type: "string" } } };
  try {
    const data = await gemini({ maxOutputTokens: 1200, schema, parts: [{ text: `Crea UNA alternativa realista para ${currentMeal.title || "esta comida"} usando ÚNICAMENTE alimentos disponibles.\n\nCATÁLOGO DISPONIBLE:\n${pantry.map(x => `${x.id}: ${x.name}`).join("\n") || "ninguno"}\n\nOTROS ALIMENTOS DISPONIBLES:\n${customFoods.join("\n") || "ninguno"}\n\nCOMIDA ACTUAL:\n${JSON.stringify(currentMeal)}\n\nOBJETIVO APROXIMADO: ${kcal} kcal; proteína ${protein} g; hidratos ${carbs} g; grasa ${fat} g.\n\nDevuelve un objeto con meal y note. Da cantidades concretas. Intenta ±10% kcal y no más de 5 g por debajo en proteína. No añadas alimentos no disponibles. Las macros son aproximadas.` }] });
    res.json(data);
  } catch (err) {
    console.error("Meal suggestion failed", err.status || "", err.message);
    res.status(502).json({ error: `No he podido crear una alternativa con Gemini: ${err.message || "error desconocido"}` });
  }
});

app.post("/api/coach-review", async (req, res) => {
  if (!requireKey(res)) return;
  const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(-60) : [];
  const measures = Array.isArray(req.body?.measures) ? req.body.measures.slice(-20) : [];
  if (!logs.length && !measures.length) return res.status(400).json({ error: "Aún no hay datos suficientes para revisar." });
  const schema = { type: "object", additionalProperties: false, required: ["status", "summary", "training", "nutrition", "watchouts", "next_review"], properties: { status: { type: "string", enum: ["bien", "vigilar", "revisar"] }, summary: { type: "string" }, training: { type: "array", maxItems: 5, items: { type: "string" } }, nutrition: { type: "array", maxItems: 4, items: { type: "string" } }, watchouts: { type: "array", maxItems: 4, items: { type: "string" } }, next_review: { type: "string" } } };
  try {
    const data = await gemini({ maxOutputTokens: 1700, schema, parts: [{ text: `Actúa como revisor conservador de hipertrofia. No cambies automáticamente ejercicios, series, cargas ni calorías. Señala tendencias, estancamientos y dolor. Una sesión mala aislada no justifica cambios.\n\nDevuelve un objeto con status, summary, training, nutrition, watchouts y next_review.\n\nENTRENAMIENTO:\n${JSON.stringify(logs)}\n\nMEDIDAS:\n${JSON.stringify(measures)}` }] });
    res.json(data);
  } catch (err) {
    console.error("Coach review failed", err.status || "", err.message);
    res.status(502).json({ error: `No he podido completar la revisión: ${err.message || "error desconocido"}` });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BodyGym PT AI (Gemini + visión + macros + fallback) escuchando en puerto ${PORT}`);
});

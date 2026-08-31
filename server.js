import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || "https://infaval.github.io")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.use(express.json({ limit: "12mb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && FRONTEND_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    if (origin && !FRONTEND_ORIGINS.includes(origin)) return res.sendStatus(403);
    return res.sendStatus(204);
  }
  if (origin && !FRONTEND_ORIGINS.includes(origin)) return res.status(403).json({ error: "Origen no permitido" });
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
  if (current.count > 30) return res.status(429).json({ error: "Límite temporal de IA alcanzado. Prueba más tarde." });
  next();
});

const FOOD_CATALOG = [
  ["pollo", "Pechuga de pollo"], ["lomo", "Lomo fresco"], ["sardinas", "Sardinas"],
  ["atun", "Atún"], ["salmon", "Salmón ahumado"], ["garbanzos", "Garbanzos"],
  ["avena", "Avena"], ["leche", "Leche semidesnatada"], ["whey", "Proteína whey"],
  ["yogur", "Yogur griego"], ["cottage", "Queso cottage"], ["canela", "Canela"],
  ["patata", "Patata"], ["pasta", "Pasta"], ["arandanos", "Arándanos"],
  ["pina", "Piña"], ["kiwi", "Kiwi"], ["ensalada", "Lechuga o rúcula"],
  ["tomate", "Tomate o cebolla"], ["aguacate", "Aguacate"], ["aove", "Aceite de oliva virgen extra"]
];
const FOOD_IDS = FOOD_CATALOG.map(x => x[0]);
const FOOD_TEXT = FOOD_CATALOG.map(([id, name]) => `${id}: ${name}`).join("\n");

function requireKey(res) {
  if (!GEMINI_API_KEY) {
    res.status(503).json({ error: "El servidor IA todavía no tiene configurada GEMINI_API_KEY." });
    return false;
  }
  return true;
}

function dataUrlToInlinePart(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) throw new Error("Formato de imagen no válido");
  return {
    inline_data: {
      mime_type: match[1],
      data: match[2]
    }
  };
}

async function gemini({ parts, schema, maxOutputTokens = 1600 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        maxOutputTokens,
        temperature: 0.2
      }
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    console.error("Gemini error", response.status, raw.slice(0, 1600));
    throw new Error(`Gemini ${response.status}`);
  }

  const json = JSON.parse(raw);
  const text = (json.candidates || [])
    .flatMap(c => c?.content?.parts || [])
    .map(p => p?.text || "")
    .join("")
    .trim();

  if (!text) {
    console.error("Gemini empty response", raw.slice(0, 1600));
    throw new Error("Gemini no devolvió contenido");
  }
  return JSON.parse(text);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(GEMINI_API_KEY), provider: "gemini", model: MODEL });
});

app.post("/api/analyze-pantry", async (req, res) => {
  if (!requireKey(res)) return;
  const image = req.body?.image;
  const currentPantry = Array.isArray(req.body?.currentPantry) ? req.body.currentPantry.slice(0, 50) : [];
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    return res.status(400).json({ error: "Falta una imagen válida." });
  }
  if (image.length > 10_000_000) return res.status(413).json({ error: "La imagen es demasiado grande." });

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["foods", "unknown_items", "meal_ideas", "note"],
    properties: {
      foods: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "confidence", "quantity"],
          properties: {
            id: { type: "string", enum: FOOD_IDS },
            name: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            quantity: { type: "string" }
          }
        }
      },
      unknown_items: { type: "array", items: { type: "string" } },
      meal_ideas: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "ingredients", "reason"],
          properties: {
            title: { type: "string" },
            ingredients: { type: "array", items: { type: "string" } },
            reason: { type: "string" }
          }
        }
      },
      note: { type: "string" }
    }
  };

  try {
    const data = await gemini({
      maxOutputTokens: 1400,
      schema,
      parts: [
        {
          text: `Analiza esta foto de nevera, despensa, compra o alimentos. Identifica SOLO los alimentos del catálogo cuando sean razonablemente visibles. No inventes marcas ni cantidades exactas: usa cantidad aproximada o \"visible\". Los alimentos del catálogo que ya estaban marcados son: ${currentPantry.join(", ") || "ninguno"}.\n\nCATÁLOGO:\n${FOOD_TEXT}\n\nLos objetos visibles que no encajen en el catálogo van en unknown_items. Propón hasta 3 comidas sencillas, altas en proteína y realistas usando prioritariamente lo detectado. No des consejos médicos.`
        },
        dataUrlToInlinePart(image)
      ]
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "No he podido analizar la foto con Gemini." });
  }
});

app.post("/api/coach-review", async (req, res) => {
  if (!requireKey(res)) return;
  const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(-60) : [];
  const measures = Array.isArray(req.body?.measures) ? req.body.measures.slice(-20) : [];
  if (!logs.length && !measures.length) return res.status(400).json({ error: "Aún no hay datos suficientes para revisar." });

  const schema = {
    type: "object",
    additionalProperties: false,
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
      parts: [{
        text: `Actúa como revisor conservador de un programa de hipertrofia. Analiza únicamente los datos suministrados. No cambies automáticamente ejercicios, series, cargas ni calorías. Señala tendencias útiles, estancamientos y señales de dolor. Una sesión mala aislada no justifica cambios. Si hay dolor alto o persistente, recomienda revisar técnica/rango y valoración profesional si procede, sin diagnosticar. Para peso y cintura, evita conclusiones por una sola medición.\n\nREGISTROS DE ENTRENAMIENTO:\n${JSON.stringify(logs)}\n\nMEDIDAS:\n${JSON.stringify(measures)}`
      }]
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "No he podido completar la revisión con Gemini." });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BodyGym PT AI (Gemini) escuchando en puerto ${PORT}`);
});

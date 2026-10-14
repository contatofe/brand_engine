import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
const TEXT_MODEL = "gemini-flash-latest";
const IMAGE_MODEL = "gemini-3.1-flash-image";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const GUIDELINES_BUCKET = "generation-guidelines";
const GUIDELINES_PATH = "guidelines.md";
const GUIDELINES_URL = `${SUPABASE_URL}/storage/v1/object/public/${GUIDELINES_BUCKET}/${GUIDELINES_PATH}`;
const GUIDELINES_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_GUIDELINES =
  "Tom direto, sem emojis. Prompts de imagem em inglês, estilo fotográfico realista, sem texto ou logos embutidos.";

let cachedGuidelines: { text: string; fetchedAt: number } | null = null;

async function loadGuidelines(): Promise<string> {
  const now = Date.now();
  if (
    cachedGuidelines &&
    now - cachedGuidelines.fetchedAt < GUIDELINES_CACHE_TTL_MS
  ) {
    return cachedGuidelines.text;
  }

  try {
    const res = await fetch(GUIDELINES_URL);
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    cachedGuidelines = { text, fetchedAt: now };
    return text;
  } catch {
    return DEFAULT_GUIDELINES;
  }
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    headlines: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 2,
    },
    image_prompts: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 2,
    },
  },
  required: ["headlines", "image_prompts"],
};

type DraftResponse = { headlines: string[]; image_prompts: string[] };

async function generateText(brief: string): Promise<DraftResponse> {
  const guidelines = await loadGuidelines();

  const prompt = `${guidelines}

Briefing: "${brief}"

A partir do briefing e das diretrizes acima, gere:
- 2 opções de headline curto (até 6 palavras) seguindo o tom de voz descrito acima.
- 2 prompts de geração de imagem em inglês, seguindo as diretrizes fotográficas descritas acima (identifique a editoria mais adequada ao briefing e combine briefing + diretrizes da editoria + diretrizes gerais). Nunca inclua texto ou logos nas imagens.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_KEY ?? "",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: DRAFT_SCHEMA,
        },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini text error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini não retornou texto.");
  return JSON.parse(text) as DraftResponse;
}

async function generateImage(prompt: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_KEY ?? "",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini image error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find(
    (part: { inlineData?: { data?: string } }) => part.inlineData?.data,
  );

  if (!imagePart?.inlineData) {
    throw new Error("Gemini não retornou imagem.");
  }

  const mime = imagePart.inlineData.mimeType ?? "image/png";
  return `data:${mime};base64,${imagePart.inlineData.data}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  if (!GEMINI_KEY) {
    return new Response(
      JSON.stringify({
        error: "GEMINI_API_KEY não configurada nos secrets da function.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }

  try {
    const { brief } = await req.json();
    if (!brief || typeof brief !== "string") {
      return new Response(JSON.stringify({ error: "brief é obrigatório." }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const { headlines, image_prompts } = await generateText(brief);
    const images = await Promise.all(
      image_prompts.slice(0, 2).map(generateImage),
    );

    return new Response(
      JSON.stringify({ headlines: headlines.slice(0, 2), images }),
      {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
});

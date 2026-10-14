import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
const TEXT_MODEL = "gemini-flash-latest";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KNOWLEDGE_BUCKET = "brand-knowledge";
const KNOWLEDGE_PATH = "puc-rio.md";
const KNOWLEDGE_URL = `${SUPABASE_URL}/storage/v1/object/public/${KNOWLEDGE_BUCKET}/${KNOWLEDGE_PATH}`;

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedKnowledge: { text: string; fetchedAt: number } | null = null;

async function loadBrandKnowledge(): Promise<string> {
  const now = Date.now();
  if (cachedKnowledge && now - cachedKnowledge.fetchedAt < CACHE_TTL_MS) {
    return cachedKnowledge.text;
  }

  const res = await fetch(KNOWLEDGE_URL);

  if (!res.ok) {
    const body = await res.text();
    let notFound = res.status === 404;
    try {
      const parsed = JSON.parse(body);
      if (parsed.statusCode === "404" || parsed.code === "NoSuchKey")
        notFound = true;
    } catch {}

    if (notFound) {
      throw new Error(
        `Documento de conhecimento da marca ainda não foi enviado. Suba o arquivo "${KNOWLEDGE_PATH}" no bucket "${KNOWLEDGE_BUCKET}" do Supabase Storage.`,
      );
    }
    throw new Error(`Erro ao buscar documento da marca: ${res.status} ${body}`);
  }

  const text = await res.text();
  cachedKnowledge = { text, fetchedAt: now };
  return text;
}

type ChatTurn = { role: "user" | "model"; text: string };

function buildSystemInstruction(knowledge: string) {
  return {
    parts: [
      {
        text:
          "Você é um assistente que conversa sobre a marca PUC-Rio, respondendo " +
          "com base exclusivamente no documento de conhecimento abaixo. Se a resposta " +
          "não estiver no documento, diga isso claramente em vez de inventar. " +
          "Responda em português, tom direto e consultivo.\n\n" +
          "--- DOCUMENTO DA MARCA ---\n" +
          knowledge,
      },
    ],
  };
}

function buildContents(history: ChatTurn[] | undefined, message: string) {
  const turns = (history ?? []).map((h) => ({
    role: h.role,
    parts: [{ text: h.text }],
  }));
  turns.push({ role: "user", parts: [{ text: message }] });
  return turns;
}

async function callGemini(
  systemInstruction: unknown,
  contents: unknown,
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_KEY ?? "",
      },
      body: JSON.stringify({ systemInstruction, contents }),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini chat error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini não retornou resposta.");
  return text;
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
    const { message, history } = await req.json();

    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "message é obrigatório." }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }
    if (history !== undefined && !Array.isArray(history)) {
      return new Response(
        JSON.stringify({ error: "history precisa ser um array." }),
        {
          status: 400,
          headers: CORS_HEADERS,
        },
      );
    }

    const knowledge = await loadBrandKnowledge();
    const reply = await callGemini(
      buildSystemInstruction(knowledge),
      buildContents(history, message),
    );

    return new Response(JSON.stringify({ reply }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
});

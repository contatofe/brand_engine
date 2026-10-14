import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "hero-images";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if (!match) throw new Error("image precisa ser um data URL base64.");

  const mime = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime };
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

  try {
    const { headline, image, source } = await req.json();

    if (!headline || typeof headline !== "string") {
      return new Response(JSON.stringify({ error: "headline é obrigatório." }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }
    if (!image || typeof image !== "string") {
      return new Response(JSON.stringify({ error: "image (data URL) é obrigatória." }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const { bytes, mime } = dataUrlToBytes(image);
    const ext = mime.split("/")[1] ?? "png";
    const path = `${crypto.randomUUID()}.${ext}`;

    const upload = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: mime,
      upsert: false,
    });
    if (upload.error) throw upload.error;

    const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(path);

    const insert = await supabase
      .from("jobs")
      .insert({
        headline,
        image_url: publicUrlData.publicUrl,
        source: source === "ai" ? "ai" : "manual",
        status: "pending",
      })
      .select()
      .single();

    if (insert.error) throw insert.error;

    return new Response(JSON.stringify({ job: insert.data }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "renders";

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

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "frame"
  );
}

type RenderInput = { name: string; image: string };

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
    const { jobId, renders } = await req.json();

    if (!jobId || typeof jobId !== "string") {
      return new Response(JSON.stringify({ error: "jobId é obrigatório." }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }
    if (!Array.isArray(renders) || renders.length === 0) {
      return new Response(JSON.stringify({ error: "renders é obrigatório." }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const urls: Record<string, string> = {};

    for (const render of renders as RenderInput[]) {
      const { bytes, mime } = dataUrlToBytes(render.image);
      const ext = mime.split("/")[1] ?? "png";
      const path = `${jobId}/${slugify(render.name)}.${ext}`;

      const upload = await supabase.storage.from(BUCKET).upload(path, bytes, {
        contentType: mime,
        upsert: true,
      });
      if (upload.error) throw upload.error;

      const { data: publicUrlData } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(path);
      urls[render.name] = publicUrlData.publicUrl;
    }

    const update = await supabase
      .from("jobs")
      .update({ renders: urls })
      .eq("id", jobId)
      .select()
      .single();
    if (update.error) throw update.error;

    return new Response(JSON.stringify({ renders: urls }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
});

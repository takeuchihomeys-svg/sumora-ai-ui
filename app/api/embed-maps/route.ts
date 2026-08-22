import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

export const maxDuration = 300;

const BATCH = 100; // OpenAI embedding API 1回あたりの上限

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.data.map((d: any) => d.embedding);
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-internal-secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const results = { station_map: 0, region_map: 0, errors: 0 };

  // ── station_map: embedding が null の行を処理 ─────────────────────────────
  {
    const { data: rows } = await db
      .from("station_map")
      .select("token")
      .is("embedding", null)
      .limit(2000);

    const tokens = (rows ?? []).map((r: { token: string }) => r.token);

    for (let i = 0; i < tokens.length; i += BATCH) {
      const chunk = tokens.slice(i, i + BATCH);
      try {
        const embeddings = await embedTexts(chunk);
        for (let j = 0; j < chunk.length; j++) {
          const { error } = await db
            .from("station_map")
            .update({ embedding: JSON.stringify(embeddings[j]) })
            .eq("token", chunk[j]);
          if (error) {
            console.error("[embed-maps] station_map update error:", error.message);
            results.errors++;
          } else {
            results.station_map++;
          }
        }
      } catch (e) {
        console.error("[embed-maps] station_map embed error:", e);
        results.errors++;
      }
    }
  }

  // ── region_map: embedding が null の行を処理 ──────────────────────────────
  {
    const { data: rows } = await db
      .from("region_map")
      .select("token")
      .is("embedding", null)
      .limit(2000);

    const tokens = (rows ?? []).map((r: { token: string }) => r.token);

    for (let i = 0; i < tokens.length; i += BATCH) {
      const chunk = tokens.slice(i, i + BATCH);
      try {
        const embeddings = await embedTexts(chunk);
        for (let j = 0; j < chunk.length; j++) {
          const { error } = await db
            .from("region_map")
            .update({ embedding: JSON.stringify(embeddings[j]) })
            .eq("token", chunk[j]);
          if (error) {
            console.error("[embed-maps] region_map update error:", error.message);
            results.errors++;
          } else {
            results.region_map++;
          }
        }
      } catch (e) {
        console.error("[embed-maps] region_map embed error:", e);
        results.errors++;
      }
    }
  }

  return NextResponse.json({ ok: true, ...results });
}

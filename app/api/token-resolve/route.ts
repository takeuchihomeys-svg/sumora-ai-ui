import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

type ResolvedToken = {
  type: "station" | "region" | "unknown";
  ward: string | null;
  realpro_lines: string[];
  itandi_lines: string[];
  reins_line: string | null;
  source: "db" | "web_search" | "ai";
};

export async function POST(req: NextRequest) {
  let tokens: string[];
  try {
    const body = await req.json();
    tokens = body.tokens as string[];
    if (!Array.isArray(tokens) || tokens.length === 0) throw new Error("empty");
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const db = getDb();
  const result: Record<string, ResolvedToken> = {};

  // ── DBキャッシュを先に確認 ─────────────────────────────────────────
  const [{ data: cachedRegions }, { data: cachedStations }] = await Promise.all([
    db.from("region_map").select("token, ward").in("token", tokens),
    db.from("station_map").select("token, ward, realpro_lines, itandi_lines, reins_line").in("token", tokens),
  ]);

  const resolvedTokens = new Set<string>();

  for (const row of cachedRegions ?? []) {
    result[row.token] = { type: "region", ward: row.ward, realpro_lines: [], itandi_lines: [], reins_line: null, source: "db" };
    resolvedTokens.add(row.token);
  }
  for (const row of cachedStations ?? []) {
    result[row.token] = {
      type: "station",
      ward: row.ward,
      realpro_lines: (row.realpro_lines as string[]) ?? [],
      itandi_lines: (row.itandi_lines as string[]) ?? [],
      reins_line: row.reins_line ?? null,
      source: "db",
    };
    resolvedTokens.add(row.token);
  }

  const unknown = tokens.filter((t) => !resolvedTokens.has(t));
  if (unknown.length === 0) return NextResponse.json({ result });

  // ── 1日30回のレート制限（Web検索コスト保護）──────────────────────────
  const DAILY_LIMIT = 30;
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: dateRow }, { data: countRow }] = await Promise.all([
    db.from("hanbancyo_settings").select("value").eq("key", "token_resolve_date").maybeSingle(),
    db.from("hanbancyo_settings").select("value").eq("key", "token_resolve_count").maybeSingle(),
  ]);
  const savedDate  = dateRow?.value as string | null;
  const savedCount = savedDate === today ? parseInt(countRow?.value ?? "0", 10) : 0;
  const webSearchAllowed = savedCount < DAILY_LIMIT;

  if (!webSearchAllowed) {
    console.warn(`[token-resolve] 1日${DAILY_LIMIT}回制限に達した。AI知識のみで解決。`);
  }

  // ── Web検索部隊: Claude + web_search でトークンを解決 ──────────────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let dailyCount = savedCount;

  for (const token of unknown) {
    let resolved: ResolvedToken = { type: "unknown", ward: null, realpro_lines: [], itandi_lines: [], reins_line: null, source: "web_search" };

    try {
      // Web検索を使って調査（レート制限内の場合のみ）
      if (!webSearchAllowed || dailyCount >= DAILY_LIMIT) throw new Error("rate_limit");
      const searchRes = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305" as "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `大阪府の「${token}」について調べてください。
以下を確認してください：
1. 駅名かどうか（路線名・大阪府内の所在市区）
2. 地名かどうか（どの市区に属するか）

調査後、以下のJSON形式のみで回答してください（説明不要）:
{
  "type": "station" または "region" または "unknown",
  "ward": "大阪市〇〇区" または "〇〇市" または null,
  "realpro_lines": ["リアプロ内部路線名（大阪市高速軌道〇〇線 等）"],
  "itandi_lines": ["itandi正式路線名（高速電気軌道第N号線(大阪メトロ〇〇線) 等）"],
  "reins_line": "REINS路線名（大阪メトロ〇〇線 等）または null"
}`,
        }],
      });

      // toolUseブロックとtextブロック両方からJSON抽出
      let jsonText = "";
      for (const block of searchRes.content) {
        if (block.type === "text") jsonText += block.text;
      }
      const match = jsonText.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as Partial<ResolvedToken>;
        resolved = {
          type: parsed.type ?? "unknown",
          ward: parsed.ward ?? null,
          realpro_lines: parsed.realpro_lines ?? [],
          itandi_lines: parsed.itandi_lines ?? [],
          reins_line: parsed.reins_line ?? null,
          source: "web_search",
        };
        // Web検索成功 → カウンターをインクリメント
        dailyCount++;
        await Promise.all([
          db.from("hanbancyo_settings").upsert({ key: "token_resolve_date",  value: today },      { onConflict: "key" }),
          db.from("hanbancyo_settings").upsert({ key: "token_resolve_count", value: String(dailyCount) }, { onConflict: "key" }),
        ]);
      }
    } catch {
      // web_searchが使えない・制限超過の場合はAI知識のみでフォールバック
      try {
        const fallbackRes = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          messages: [{
            role: "user",
            content: `大阪府の「${token}」は駅名ですか、地名ですか？
JSONのみ返してください:
{"type":"station"または"region"または"unknown","ward":"大阪市〇〇区など または null","realpro_lines":[],"itandi_lines":[],"reins_line":null}`,
          }],
        });
        const raw = fallbackRes.content[0].type === "text" ? fallbackRes.content[0].text : "";
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          const p = JSON.parse(m[0]) as Partial<ResolvedToken>;
          resolved = { type: p.type ?? "unknown", ward: p.ward ?? null, realpro_lines: p.realpro_lines ?? [], itandi_lines: p.itandi_lines ?? [], reins_line: p.reins_line ?? null, source: "ai" };
        }
      } catch { /* 完全失敗 */ }
    }

    result[token] = resolved;

    // ── Supabaseに保存 ─────────────────────────────────────────────
    if (resolved.type === "region" && resolved.ward) {
      await db.from("region_map").upsert(
        { token, ward: resolved.ward, confidence: 80, source: resolved.source },
        { onConflict: "token" },
      );
    } else if (resolved.type === "station") {
      await db.from("station_map").upsert(
        {
          token,
          ward: resolved.ward,
          realpro_lines: resolved.realpro_lines,
          itandi_lines: resolved.itandi_lines,
          reins_line: resolved.reins_line,
          confidence: 80,
          source: resolved.source,
        },
        { onConflict: "token" },
      );
    }
  }

  return NextResponse.json({ result });
}

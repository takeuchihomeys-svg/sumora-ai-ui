import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

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

// ── ① DeepSeek-V3 で判定（安い・速い）─────────────────────────────────
// 解決できたら ResolvedToken、unknown・失敗時は null（Claudeにフォールバック）
async function callDeepSeek(token: string): Promise<ResolvedToken | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 512,
        messages: [{
          role: "user",
          content: `大阪府の「${token}」は駅名ですか、地名ですか？確信がなければ"unknown"にしてください。
JSONのみ返してください（説明不要）:
{"type":"station"または"region"または"unknown","ward":"大阪市〇〇区など または null","realpro_lines":["リアプロ内部路線名"],"itandi_lines":["itandi正式路線名"],"reins_line":"REINS路線名またはnull"}

リアプロ内部路線名の例：「大阪市高速軌道御堂筋線」「阪急電鉄阪急神戸線」
itandi正式路線名の例：「高速電気軌道第1号線(大阪メトロ御堂筋線)」「阪急電鉄神戸本線」
REINS路線名の例：「大阪メトロ御堂筋線」「阪急神戸線」`,
        }],
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const text = data.choices[0]?.message?.content ?? "";
    const match = text.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<ResolvedToken>;
    // unknown なら null を返す（Claudeにフォールバック）
    if (!parsed.type || parsed.type === "unknown") return null;
    return {
      type: parsed.type,
      ward: parsed.ward ?? null,
      realpro_lines: parsed.realpro_lines ?? [],
      itandi_lines: parsed.itandi_lines ?? [],
      reins_line: parsed.reins_line ?? null,
      source: "ai", // DeepSeekはAI知識なので"ai"
    };
  } catch {
    return null; // タイムアウト・エラー時はClaudeにフォールバック
  }
}

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

  // ── ② pg_trgm 類似検索（完全一致しなかったトークンの表記ゆれを吸収）──────────
  // station_map → region_map → line_stations の順で類似検索
  // ヒットすれば DeepSeek/Claude を呼ばずに解決できる（コスト0）
  const fuzzyUnresolved: string[] = [];
  await Promise.all(unknown.map(async (token) => {
    // station_map で fuzzy search（すでに3サイト分の路線名が入っている）
    const { data: simStations } = await db.rpc("find_similar_station", {
      query_text: token, threshold: 0.35,
    });
    if (simStations && simStations.length > 0) {
      const best = simStations[0] as { token: string; ward: string | null; realpro_lines: string[]; itandi_lines: string[]; reins_line: string | null; similarity_score: number };
      result[token] = {
        type: "station", ward: best.ward,
        realpro_lines: best.realpro_lines ?? [],
        itandi_lines: best.itandi_lines ?? [],
        reins_line: best.reins_line ?? null,
        source: "db",
      };
      resolvedTokens.add(token);
      console.log(`[token-resolve] fuzzy station: "${token}"→"${best.token}" (${best.similarity_score.toFixed(2)})`);
      return;
    }

    // region_map で fuzzy search
    const { data: simRegions } = await db.rpc("find_similar_region", {
      query_text: token, threshold: 0.35,
    });
    if (simRegions && simRegions.length > 0) {
      const best = simRegions[0] as { token: string; ward: string | null; similarity_score: number };
      result[token] = { type: "region", ward: best.ward, realpro_lines: [], itandi_lines: [], reins_line: null, source: "db" };
      resolvedTokens.add(token);
      console.log(`[token-resolve] fuzzy region: "${token}"→"${best.token}" (${best.similarity_score.toFixed(2)})`);
      return;
    }

    // line_stations で fuzzy search（station_mapにない525駅もカバー）
    const { data: simLineStations } = await db.rpc("find_similar_line_station", {
      query_text: token, threshold: 0.35,
    });
    if (simLineStations && simLineStations.length > 0) {
      const best = simLineStations[0] as { station_name: string; line_name: string; token: string | null; ward: string | null; realpro_lines: string[] | null; itandi_lines: string[] | null; reins_line: string | null; similarity_score: number };
      result[token] = {
        type: "station",
        ward: best.ward ?? null,
        realpro_lines: best.realpro_lines ?? [best.line_name],
        itandi_lines: best.itandi_lines ?? [],
        reins_line: best.reins_line ?? null,
        source: "db",
      };
      resolvedTokens.add(token);
      console.log(`[token-resolve] fuzzy line_station: "${token}"→"${best.station_name}" (${best.similarity_score.toFixed(2)})`);
      return;
    }

    fuzzyUnresolved.push(token);
  }));

  const trulyUnknown = fuzzyUnresolved;
  if (trulyUnknown.length === 0) return NextResponse.json({ result });

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
    console.warn(`[token-resolve] 1日${DAILY_LIMIT}回制限に達した。DeepSeekのみで解決（Claude web_searchスキップ）。`);
  }

  // ── Web検索部隊: Claude + web_search でトークンを解決 ──────────────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let dailyCount = savedCount;

  for (const token of trulyUnknown) {
    let resolved: ResolvedToken = { type: "unknown", ward: null, realpro_lines: [], itandi_lines: [], reins_line: null, source: "web_search" };

    // ── ① DeepSeek で判定（成功したらClaudeスキップ・dailyCountも消費しない）──
    const deepseekResult = await callDeepSeek(token);
    if (deepseekResult) {
      resolved = deepseekResult;
    } else try {
      // ── ② Claude + web_search で調査（レート制限内の場合のみ）──
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
      }, { signal: AbortSignal.timeout(25_000) });

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
      // 制限超過・web_search失敗時は unknown のまま保存（DeepSeekで安価に処理済みのためフォールバックなし）
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

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

// ── リアプロ路線名 → itandi 路線名（popup-maps.js から移設）──────────────
const ITANDI_LINE_MAP: Record<string, string | string[]> = {
  "大阪市高速軌道御堂筋線": "高速電気軌道第1号線(大阪メトロ御堂筋線)",
  "大阪市高速軌道谷町線": "高速電気軌道第2号線(大阪メトロ谷町線)",
  "大阪市高速軌道四つ橋線": "高速電気軌道第3号線(大阪メトロ四つ橋線)",
  "大阪市高速軌道中央線": "高速電気軌道第4号線(大阪メトロ中央線)",
  "大阪市高速軌道千日前線": "高速電気軌道第5号線(大阪メトロ千日前線)",
  "大阪市高速軌道堺筋線": "高速電気軌道第6号線(大阪メトロ堺筋線)",
  "大阪市高速軌道長堀鶴見緑地線": "高速電気軌道第7号線(大阪メトロ長堀鶴見緑地線)",
  "大阪市高速軌道今里筋線": "高速電気軌道第8号線(大阪メトロ今里筋線)",
  "大阪市高速軌道南港ポートタウン線": "大阪市高速電気軌道南港ポートタウン線(大阪メトロ南港ポートタウン線)",
  "北大阪急行南北線": "北大阪急行電鉄",
  "阪急電鉄神戸線": "阪急神戸本線",
  "阪急電鉄宝塚線": "阪急宝塚本線",
  "阪急電鉄京都線": "阪急京都本線",
  "阪急電鉄千里線": "阪急千里線",
  "阪急電鉄箕面線": "阪急箕面線",
  "阪神電鉄本線": "阪神本線",
  "阪神電鉄阪神なんば線": "阪神なんば線",
  "南海電鉄南海本線": "南海本線",
  "南海電鉄南本線": "南海本線",
  "南海電鉄高野線": "南海高野線",
  "南海電鉄泉北線": "南海泉北線(泉北線)",
  "南海電鉄空港線": "南海空港線",
  "南海電鉄汐見橋線": "南海汐見橋線",
  "南海電鉄多奈川線": "南海多奈川線",
  "南海電鉄高師浜線": "南海高師浜線",
  "京阪電気鉄道京阪線": "京阪本線",
  "京阪電気鉄道中之島線": "京阪中之島線",
  "京阪電気鉄道交野線": "京阪交野線",
  "大阪環状線": "大阪環状線",
  "JR東西線": "JR東西線",
  "片町線": "JR片町線(学研都市線)",
  "桜島線": "JR桜島線(JRゆめ咲線)",
  "阪和線": "阪和線(天王寺～和歌山)",
  "福知山線": "JR福知山線(新大阪～篠山口)(JR宝塚線)",
  "東海道本線": [
    "JR東海道本線(京都～大阪)(JR京都線)",
    "JR東海道本線(大阪～神戸)(JR神戸線(大阪～神戸))",
  ],
  "おおさか東線": "おおさか東線",
  "関西本線": "JR関西本線(加茂～ＪＲ難波)(大和路線)",
  "近鉄難波・奈良線": [
    "近鉄難波線",
    "近鉄奈良線",
  ],
  "近鉄南大阪線": "近鉄南大阪線",
  "近鉄大阪線": "近鉄大阪線",
  "近鉄長野線": "近鉄長野線",
  "近鉄道明寺線": "近鉄道明寺線",
  "近鉄けいはんな線": "近鉄けいはんな線",
  "阪堺電気軌道阪堺線": "阪堺電軌阪堺線",
  "阪堺電気軌道上町線": "阪堺電軌上町線",
  "大阪モノレール本線": "大阪モノレール線",
  "大阪モノレール彩都線": "国際文化公園都市線(大阪モノレール彩都線)",
  "能勢電鉄": "能勢電鉄妙見線",
  "水間鉄道水間線": "水間鉄道水間線",
  "関西空港線": "JR関西空港線",
};

// ── リアプロ路線名 → レインズ 路線名（popup-maps.js から移設）─────────────
const REINS_LINE_MAP: Record<string, string> = {
  "大阪市高速軌道御堂筋線": "大阪メトロ御堂筋線",
  "大阪市高速軌道谷町線": "大阪メトロ谷町線",
  "大阪市高速軌道中央線": "大阪メトロ中央線",
  "大阪市高速軌道堺筋線": "大阪メトロ堺筋線",
  "大阪市高速軌道四つ橋線": "大阪メトロ四つ橋線",
  "大阪市高速軌道千日前線": "大阪メトロ千日前線",
  "大阪市高速軌道長堀鶴見緑地線": "大阪メトロ長堀鶴見線",
  "大阪市高速軌道今里筋線": "大阪メトロ今里筋線",
  "大阪市高速軌道南港ポートタウン線": "南港ポートタウン線",
  "阪急電鉄神戸線": "阪急神戸線",
  "阪急電鉄宝塚線": "阪急宝塚線",
  "阪急電鉄京都線": "阪急京都線",
  "阪急電鉄千里線": "阪急千里線",
  "阪急電鉄箕面線": "阪急箕面線",
  "阪神電鉄本線": "阪神本線",
  "阪神電鉄阪神なんば線": "阪神なんば線",
  "南海電鉄南海本線": "南海本線",
  "南海電鉄南本線": "南海本線",
  "南海電鉄高野線": "南海高野線",
  "南海電鉄空港線": "南海空港線",
  "南海電鉄多奈川線": "南海多奈川線",
  "南海電鉄汐見橋線": "南海汐見橋線",
  "南海電鉄高師浜線": "南海高師浜線",
  "京阪電気鉄道京阪線": "京阪本線",
  "京阪電気鉄道中之島線": "京阪中之島線",
  "京阪電気鉄道交野線": "京阪交野線",
  "北大阪急行南北線": "北大阪急行",
  "JR東西線": "東西線",
  "大阪環状線": "大阪環状線",
  "おおさか東線": "おおさか東線",
  "片町線": "片町線",
  "阪和線": "阪和線",
  "福知山線": "福知山線",
  "関西線": "関西線",
  "関西本線": "関西線",
  "関西空港線": "関西空港線",
  "桜島線": "桜島線",
  "大阪モノレール本線": "大阪モノレール本線",
  "大阪モノレール彩都線": "大阪モノレール彩都線",
  "近鉄難波・奈良線": "近鉄奈良線",
  "近鉄南大阪線": "近鉄南大阪線",
  "近鉄大阪線": "近鉄大阪線",
  "近鉄けいはんな線": "近鉄けいはんな線",
  "近鉄信貴線": "近鉄信貴線",
  "近鉄道明寺線": "近鉄道明寺線",
  "近鉄長野線": "近鉄長野線",
  "能勢電鉄": "能勢電鉄",
  "水間鉄道": "水間鉄道",
  "泉北高速鉄道線": "泉北線",
  "阪堺電気軌道上町線": "阪堺電気軌道上町線",
  "阪堺電気軌道阪堺線": "阪堺電気軌道阪堺線",
};

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

// ── 解決不能トークンのネガティブキャッシュ有効期間（7日）──────────────────
// station_map に source="unknown"・confidence=0 で保存し、期間内はAI再呼び出しをスキップ
const NEGATIVE_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

// ── ① DeepSeek-V3 で判定（安い・速い）─────────────────────────────────
// line_stations の登録駅一覧から「検索」させる方式（路線名の自由生成は禁止）。
// 解決できたら ResolvedToken、該当なし・失敗時は null（Claudeにフォールバック）
type LineStation = { station_name: string; line_name: string };

async function callDeepSeek(token: string, lineStations: LineStation[]): Promise<ResolvedToken | null> {
  // line_stations が空の場合のみ従来の自由生成方式にフォールバック
  if (lineStations.length === 0) return callDeepSeekLegacy(token);

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    const stationList = lineStations.map((s) => `${s.station_name}（${s.line_name}）`).join("\n");
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 64,
        messages: [{
          role: "user",
          content: `以下は登録済みの大阪府の駅名一覧です。
「${token}」が指す駅を一覧の中から1つだけ選んでください。
一覧にない場合は「該当なし」と答えてください。
絶対に一覧にない駅名を作らないでください。

【登録済み駅名一覧】
${stationList}

回答形式：駅名のみ（例：梅田）または「該当なし」`,
        }],
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const raw = (data.choices[0]?.message?.content ?? "").trim();
    if (!raw || raw.includes("該当なし")) return null; // 該当なし → Claudeにフォールバック

    // 「梅田（阪急電鉄神戸線）」のような回答でも駅名部分だけ取り出す
    const stationName = raw.replace(/^["'「『]+|["'」』]+$/g, "").split(/[（(]/)[0].trim();
    if (!stationName) return null;

    // line_stations に実在する駅のみ採用（ハルシネーション防止）
    const matched = lineStations.filter((s) => s.station_name === stationName);
    if (matched.length === 0) return null; // 一覧にない駅名 → Claudeにフォールバック

    // 同じ駅名が複数路線にある場合（例：梅田）は全路線を配列で返す
    const lines = Array.from(new Set(matched.map((s) => s.line_name)));
    const itandiLines = Array.from(new Set(lines.flatMap((l) => {
      const mapped = ITANDI_LINE_MAP[l] ?? l;
      return Array.isArray(mapped) ? mapped : [mapped];
    })));
    const reinsLine = REINS_LINE_MAP[lines[0]] ?? lines[0];

    return {
      type: "station",
      ward: null, // line_stations に区情報はないため null
      realpro_lines: lines,
      itandi_lines: itandiLines,
      reins_line: reinsLine,
      source: "ai", // DeepSeek経由なので"ai"（路線名自体はDB由来）
    };
  } catch (e) {
    console.warn("[token-resolve] DeepSeek呼び出し失敗:", e instanceof Error ? e.message : e);
    return null; // タイムアウト・エラー時はClaudeにフォールバック
  }
}

// ── ①' 従来のDeepSeek自由生成方式（line_stationsが空の時だけ使用）─────────
async function callDeepSeekLegacy(token: string): Promise<ResolvedToken | null> {
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
  } catch (e) {
    console.warn("[token-resolve] DeepSeek呼び出し失敗:", e instanceof Error ? e.message : e);
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
  const [{ data: cachedRegions }, { data: cachedStations }, { data: blockedRows }] = await Promise.all([
    db.from("region_map").select("token, ward").in("token", tokens),
    db.from("station_map").select("token, ward, realpro_lines, itandi_lines, reins_line, source, created_at").in("token", tokens),
    db.from("token_block").select("token").in("token", tokens),
  ]);

  const resolvedTokens = new Set<string>();

  // ── ブロック済みトークン（「✗ 間違い」で永久ブロック）──────────────────────────
  // token_block に登録されているトークンは AI による再解決を永久にスキップ
  const blocked = new Set((blockedRows ?? []).map((r: { token: string }) => r.token));
  for (const t of tokens) {
    if (blocked.has(t)) {
      result[t] = { type: "unknown", ward: null, realpro_lines: [], itandi_lines: [], reins_line: null, source: "db" };
      resolvedTokens.add(t);
    }
  }

  for (const row of cachedRegions ?? []) {
    result[row.token] = { type: "region", ward: row.ward, realpro_lines: [], itandi_lines: [], reins_line: null, source: "db" };
    resolvedTokens.add(row.token);
  }
  for (const row of cachedStations ?? []) {
    // ── ネガティブキャッシュ（解決不能トークン）──────────────────────
    if (row.source === "unknown") {
      const age = Date.now() - new Date(row.created_at as string).getTime();
      if (age < NEGATIVE_CACHE_MS) {
        // 7日以内 → AI再呼び出しをスキップして unknown を返す
        result[row.token] = { type: "unknown", ward: null, realpro_lines: [], itandi_lines: [], reins_line: null, source: "db" };
        resolvedTokens.add(row.token);
      }
      // 7日以上前 → resolvedTokens に入れず再試行させる（自動リセット）
      continue;
    }
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
    // ネガティブキャッシュ行（ward/路線が全て空）は fuzzy マッチ対象から除外
    // （find_similar_station は source を返さないためフィールドで判定）
    type SimStation = { token: string; ward: string | null; realpro_lines: string[]; itandi_lines: string[]; reins_line: string | null; similarity_score: number };
    const best = ((simStations ?? []) as SimStation[]).find(
      (r) => r.ward || (r.realpro_lines?.length ?? 0) > 0 || (r.itandi_lines?.length ?? 0) > 0 || r.reins_line,
    );
    if (best) {
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

  // ── DeepSeek検索用: line_stations を1回だけ取得（全トークンで使い回す）──
  const { data: lineStationsData } = await db
    .from("line_stations")
    .select("station_name, line_name")
    .order("line_name");
  const lineStations: LineStation[] = (lineStationsData ?? []) as LineStation[];

  // ── Web検索部隊: Claude + web_search でトークンを解決 ──────────────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // 新しい日の場合、DBのカウントをリセット（楽観的ロックが正しく機能するよう事前に同期）
  // savedDate !== today の間は DB の token_resolve_count が昨日の値のまま残っているため
  // eq("value", "0") の optimistic UPDATE が必ず失敗してしまう。先に 0 に揃えておく。
  if (savedDate !== today) {
    await Promise.all([
      db.from("hanbancyo_settings").upsert({ key: "token_resolve_date",  value: today }, { onConflict: "key" }),
      db.from("hanbancyo_settings").upsert({ key: "token_resolve_count", value: "0"   }, { onConflict: "key" }),
    ]);
  }
  let dailyCount = savedCount;

  for (const token of trulyUnknown) {
    let resolved: ResolvedToken = { type: "unknown", ward: null, realpro_lines: [], itandi_lines: [], reins_line: null, source: "web_search" };
    let webSearchAttempted = false; // レート制限でClaude未実行の場合はネガティブキャッシュしない

    // ── ① DeepSeek で判定（line_stationsから検索・成功したらClaudeスキップ・dailyCountも消費しない）──
    const deepseekResult = await callDeepSeek(token, lineStations);
    if (deepseekResult) {
      resolved = deepseekResult;
    } else try {
      // ── ② Claude + web_search で調査（楽観的ロックで競合を防ぐ）──
      webSearchAttempted = true; // レート制限・競合でもネガティブキャッシュを書くため、チェックの前に設定
      if (!webSearchAllowed || dailyCount >= DAILY_LIMIT) throw new Error("rate_limit");
      // 楽観的ロック: Claudeを呼ぶ前にカウンターをアトミックにインクリメントする。
      // 同時リクエストが同じ dailyCount を読んでいても、eq("value", String(dailyCount)) により
      // 片方しか UPDATE できない（0行更新 = 別リクエストが先に書いた → スキップ）。
      // これにより「両者が webSearchAllowed=true と判断して両方 Claude を呼ぶ」二重課金を防ぐ。
      const { count: claimed } = await db
        .from("hanbancyo_settings")
        .update({ value: String(dailyCount + 1) })
        .eq("key", "token_resolve_count")
        .eq("value", String(dailyCount))
        .select();
      if (!claimed || claimed === 0) throw new Error("rate_limit_concurrent");
      dailyCount++;
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
        // カウンターは楽観的ロックで呼び出し前にインクリメント済み（再書き込み不要）
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
    } else if (resolved.type === "unknown" && webSearchAttempted) {
      // ── ネガティブキャッシュ: 全段階（DeepSeek＋Claude web_search）で解決不能 ──
      // 7日間はAI再呼び出しをスキップ（created_at を更新して期限をリセット）
      await db.from("station_map").upsert(
        {
          token,
          ward: null,
          realpro_lines: [],
          itandi_lines: [],
          reins_line: null,
          source: "unknown",
          confidence: 0,
          created_at: new Date().toISOString(),
        },
        { onConflict: "token" },
      );
    }
  }

  return NextResponse.json({ result });
}

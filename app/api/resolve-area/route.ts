import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await _openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return res.data[0].embedding;
  } catch (e) {
    console.warn("[resolve-area] embedding error:", e instanceof Error ? e.message : e);
    return null;
  }
}

export const maxDuration = 30;

// ── 路線マスタ（line_meta テーブルからDB取得・1時間キャッシュ）────────────
interface LineMaps {
  routeMap: Record<string, string>;     // internal_name → realpro_route_id
  aliasMap: Record<string, string>;     // alias → internal_name
  itandiMap: Record<string, string[]>;  // internal_name → itandi_names[]
  reinsMap: Record<string, string>;     // internal_name → reins_name
}
let _lineMapsCache: { maps: LineMaps; expiresAt: number } | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLineMaps(db: any): Promise<LineMaps> {
  if (_lineMapsCache && Date.now() < _lineMapsCache.expiresAt) return _lineMapsCache.maps;
  const { data: rows } = await db
    .from("line_meta")
    .select("internal_name, realpro_route_id, itandi_names, reins_name, aliases");
  const maps: LineMaps = { routeMap: {}, aliasMap: {}, itandiMap: {}, reinsMap: {} };
  for (const row of (rows ?? []) as Array<{
    internal_name: string; realpro_route_id: string | null;
    itandi_names: string[]; reins_name: string | null; aliases: string[];
  }>) {
    const name = row.internal_name;
    if (row.realpro_route_id) maps.routeMap[name] = row.realpro_route_id;
    if (row.itandi_names?.length) maps.itandiMap[name] = row.itandi_names;
    if (row.reins_name) maps.reinsMap[name] = row.reins_name;
    for (const alias of (row.aliases ?? [])) maps.aliasMap[alias] = name;
  }
  _lineMapsCache = { maps, expiresAt: Date.now() + 60 * 60 * 1000 };
  return maps;
}


const WARD_CODE_MAP: Record<string, string> = {
  "大阪市都島区":"27102","大阪市福島区":"27103","大阪市此花区":"27104",
  "大阪市西区":"27106","大阪市港区":"27107","大阪市大正区":"27108",
  "大阪市天王寺区":"27109","大阪市浪速区":"27111","大阪市西淀川区":"27113",
  "大阪市東淀川区":"27114","大阪市東成区":"27115","大阪市生野区":"27116",
  "大阪市旭区":"27117","大阪市城東区":"27118","大阪市阿倍野区":"27119",
  "大阪市住吉区":"27120","大阪市東住吉区":"27121","大阪市西成区":"27122",
  "大阪市淀川区":"27123","大阪市鶴見区":"27124","大阪市住之江区":"27125",
  "大阪市平野区":"27126","大阪市北区":"27127","大阪市中央区":"27128",
  "堺市堺区":"27141","堺市中区":"27142","堺市東区":"27143",
  "堺市西区":"27144","堺市南区":"27145","堺市北区":"27146","堺市美原区":"27147",
  "豊中市":"27203","池田市":"27204","吹田市":"27205","高槻市":"27207",
  "守口市":"27209","枚方市":"27210","茨木市":"27211","八尾市":"27212",
  "寝屋川市":"27215","東大阪市":"27227","門真市":"27223","摂津市":"27224",
  "岸和田市":"27202","泉大津市":"27206","貝塚市":"27208","泉佐野市":"27213",
  "富田林市":"27214","河内長野市":"27216","松原市":"27217","大東市":"27218",
  "和泉市":"27219","箕面市":"27220","柏原市":"27221","羽曳野市":"27222",
  "藤井寺市":"27226","大阪狭山市":"27231","泉南市":"27228",
  "四條畷市":"27229","交野市":"27230","阪南市":"27232",
};



// ── 概念的広域地名 → 大阪府の市区名（resolve-search-conditions/route.ts と同期維持）──
const CONCEPT_AREA_MAP: Record<string, string[]> = {
  "北摂": ["豊中市","吹田市","茨木市","高槻市","池田市","箕面市","摂津市"],
  "河内": ["東大阪市","八尾市","大東市","四條畷市","柏原市","松原市","大阪狭山市","富田林市","河内長野市","羽曳野市","藤井寺市"],
  "南河内": ["富田林市","河内長野市","羽曳野市","藤井寺市","大阪狭山市","柏原市"],
  "泉州": ["堺市堺区","堺市北区","堺市西区","堺市中区","堺市東区","堺市南区","堺市美原区","岸和田市","泉大津市","貝塚市","泉佐野市","泉南市","阪南市","和泉市"],
  "なんば": ["大阪市中央区","大阪市浪速区","大阪市西区"],
  "難波":   ["大阪市中央区","大阪市浪速区","大阪市西区"],
  "ミナミ": ["大阪市中央区","大阪市浪速区","大阪市西区"],
  "梅田":   ["大阪市北区","大阪市福島区"],
  "キタ":   ["大阪市北区","大阪市福島区"],
  "心斎橋": ["大阪市中央区"],
  "本町":   ["大阪市中央区"],
  "天王寺": ["大阪市天王寺区","大阪市阿倍野区"],
  "新大阪": ["大阪市淀川区","大阪市東淀川区"],
  "大阪市内": [
    "大阪市都島区","大阪市福島区","大阪市此花区","大阪市西区","大阪市港区","大阪市大正区",
    "大阪市天王寺区","大阪市浪速区","大阪市西淀川区","大阪市東淀川区","大阪市東成区",
    "大阪市生野区","大阪市旭区","大阪市城東区","大阪市阿倍野区","大阪市住吉区",
    "大阪市東住吉区","大阪市西成区","大阪市淀川区","大阪市鶴見区","大阪市住之江区",
    "大阪市平野区","大阪市北区","大阪市中央区",
  ],
};

// 路線名を内部正式名に解決（line_meta.internal_name 形式に変換）
function resolveLineInternal(name: string, maps: LineMaps): string | null {
  if (maps.routeMap[name]) return name;
  if (maps.aliasMap[name]) return maps.aliasMap[name];
  const normalized = name
    .replace(/^大阪メトロ/, "大阪市高速軌道")
    .replace(/^地下鉄/, "大阪市高速軌道")
    .replace("大阪市高速電気軌道", "大阪市高速軌道");
  if (maps.routeMap[normalized]) return normalized;
  const hit = Object.keys(maps.routeMap).find(
    k => k.endsWith(name) || name.endsWith(k) || (name.length >= 4 && k.includes(name.slice(-3)))
  );
  return hit || null;
}

// エリア文字列を駅名・地名トークンに分解（parseAreaTokens の簡易版）
function parseTokens(area: string): string[] {
  return area
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/第[一二三]希望[：:]/g, " ")
    .split(/[、・,\/\s　]+|又は|もしくは/)
    .map(t =>
      t.replace(/^[^:]+:/, "")
        .replace(/駅|周辺|付近|近く|近辺|沿線|エリア|あたり/g, "")
        .replace(/以南$|以北$|以西$|以東$/, "")
        .trim()
    )
    .filter(t => t.length >= 2);
}

// 路線→itandi路線名リストに変換
function toItandiNames(internal: string, maps: LineMaps): string[] {
  return maps.itandiMap[internal] ?? [];
}

// DeepSeek に「〜まで〜分で行ける駅」を問い合わせ、駅名リストを返す
// タイムアウト 15_000ms（Claude NL抽出と合わせた最大処理時間に対応）
async function resolveNearbyWithDeepSeek(station: string, minutes: number): Promise<string[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 300,
        messages: [{ role: "user", content:
          `大阪府で「${station}駅」から電車で${minutes}分以内（乗り換え含む）に行ける主要な駅を列挙してください。\n大阪府内の駅のみ対象。JSONの配列形式のみで返してください: ["駅名1", "駅名2", ...]\n駅名には「駅」を付けないでください。10〜20駅程度。`,
        }],
        temperature: 0,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const raw = (data.choices[0]?.message?.content ?? "").trim();
    const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as unknown[];
    return parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch (e) {
    console.warn("[resolve-area] DeepSeek nearby error:", e instanceof Error ? e.message : e);
    return [];
  }
}

// 自転車N分圏内の駅・区名をDeepSeekで取得（電車路線に依存しない距離ベース展開）
async function resolveNearbyByBicycle(
  baseStation: string,
  minutes: number,
): Promise<{ stations: string[]; wards: string[] }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return { stations: [], wards: [] };
  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 300,
        messages: [{ role: "user", content:
          `大阪府で「${baseStation}駅」から自転車で${minutes}分以内に行ける大阪府内の駅・エリアを列挙してください。\n自転車移動のため路線ではなく距離・時間で判断してください。\nJSONのみ: {"stations":["駅名（駅なし）"],"wards":["大阪市〇〇区"]}\n駅名5〜15件・区名3〜8件程度。架空の駅・区は含めないこと。` }],
      }),
    });
    if (!res.ok) return { stations: [], wards: [] };
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? "").trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { stations: [], wards: [] };
    const parsed = JSON.parse(match[0]) as { stations?: unknown[]; wards?: unknown[] };
    return {
      stations: (parsed.stations ?? []).filter((s): s is string => typeof s === "string" && s.length > 0),
      wards:    (parsed.wards    ?? []).filter((w): w is string => typeof w === "string" && w.length > 0),
    };
  } catch (e) {
    console.warn("[resolve-area] DeepSeek bicycle error:", e instanceof Error ? e.message : e);
    return { stations: [], wards: [] };
  }
}

// 乗り換え制約 → DeepSeek で路線名リストを取得し resolveLineInternal フィルタ適用
// ハルシネーション耐性: 返ってきた路線名を resolveLineInternal で既知マップと照合し、
// 解決できない名称（架空路線）は除外する。
async function resolveTransferLinesWithDeepSeek(baseStation: string, maxTransfers: number, maps: LineMaps): Promise<string[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return [];
  try {
    const condition = maxTransfers === 0 ? "乗り換えなし（直通のみ）" : `乗り換え${maxTransfers}回以内`;
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(12_000),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 200,
        messages: [{ role: "user", content:
          `大阪府で「${baseStation}駅」から${condition}で行ける路線名を列挙してください。\n大阪府内の路線のみ対象。JSONの配列形式のみで返してください: ["路線名1", "路線名2", ...]\n10路線程度。`,
        }],
        temperature: 0,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const raw = (data.choices[0]?.message?.content ?? "").trim();
    const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as unknown[];
    const lineNames = parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
    // resolveLineInternal でフィルタリング（ハルシネーション耐性）
    return lineNames.map(n => resolveLineInternal(n, maps)).filter((n): n is string => n !== null);
  } catch (e) {
    if (process.env.NODE_ENV !== "production") console.warn("[resolve-area] DeepSeek transfer error:", e instanceof Error ? e.message : e);
    return [];
  }
}

// ひらがな・略称・口語表現 → 正式駅名/市区名に正規化（スペース/「・」区切りで返す）
// 例: "なんば" → "難波", "天六" → "天神橋筋六丁目", "北摂あたり" → "豊中市・吹田市・茨木市"
async function normalizeAreaWithDeepSeek(desired_area: string): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 100,
        messages: [{ role: "user", content:
          `大阪府の不動産検索用エリア入力を正規化してください。\n` +
          `ひらがな・略称・口語表現を正式な駅名または行政地名に変換し、スペースまたは「・」区切りで出力してください。\n` +
          `変換できない部分（通勤時間等）はそのまま保持してください。\n` +
          `変換例: "なんば"→"難波", "天六"→"天神橋筋六丁目", "うめだ"→"梅田", "てんのうじ"→"天王寺"\n` +
          `テキストのみ出力（説明不要）。\n\nエリア: "${desired_area}"`,
        }],
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const text = (data.choices[0]?.message?.content ?? "").trim();
    return text || null;
  } catch (e) {
    console.warn("[resolve-area] DeepSeek normalize error:", e instanceof Error ? e.message : e);
    return null;
  }
}

// 駅名リスト → station_map / line_stations 一括照合（最大2往復固定）
// → result に route_ids / itandi.line_names+station_names / reins.station_pairs を全反映
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveStationsFromList(
  stations: string[],
  result: ResolveAreaResponse,
  db: any,
  maps: LineMaps
): Promise<void> {
  const unresolved = stations.filter(s => !result.realpro.station_names.includes(s));
  if (unresolved.length === 0) return;

  // 1往復目: station_map 一括取得
  const { data: smRows } = await db
    .from("station_map")
    .select("token, ward, realpro_lines, itandi_lines, reins_line")
    .in("token", unresolved)
    .neq("source", "unknown");

  const resolved = new Set<string>();
  for (const row of (smRows || [])) {
    if ((row.realpro_lines?.length ?? 0) === 0) continue;
    result.realpro.station_names.push(row.token);
    resolved.add(row.token);

    // realpro: route_ids
    for (const line of (row.realpro_lines ?? [])) {
      const rid = maps.routeMap[line];
      if (rid && !result.realpro.route_ids.includes(rid)) result.realpro.route_ids.push(rid);
    }

    // itandi: itandi_linesカラムが空の場合は realpro_lines → maps.itandiMap でリアルタイム変換
    if (!result.itandi.station_names.includes(row.token)) result.itandi.station_names.push(row.token);
    const itandiLines: string[] = (row.itandi_lines?.length ?? 0) > 0
      ? row.itandi_lines
      : (row.realpro_lines ?? []).flatMap((l: string) => maps.itandiMap[l] ?? []);
    for (const line of itandiLines) {
      if (!result.itandi.line_names.includes(line)) result.itandi.line_names.push(line);
    }

    // reins: reins_lineカラムが空の場合は realpro_lines → maps.reinsMap でリアルタイム変換
    const reinsLine: string | null = row.reins_line
      ?? (row.realpro_lines ?? []).map((l: string) => maps.reinsMap[l]).find(Boolean)
      ?? null;
    if (reinsLine && !result.reins.station_pairs.some((p: { station: string | null }) => p.station === row.token)) {
      const nullIdx = result.reins.station_pairs.findIndex(
        (p: { line: string; station: string | null }) => p.line === reinsLine && p.station === null
      );
      if (nullIdx >= 0) {
        result.reins.station_pairs[nullIdx] = { line: reinsLine, station: row.token };
      } else {
        result.reins.station_pairs.push({ line: reinsLine, station: row.token });
      }
    }
  }

  // 2往復目: line_stations フォールバック（station_map 未登録）
  const stillUnresolved = unresolved.filter(s => !resolved.has(s));
  if (stillUnresolved.length === 0) return;

  const { data: lsFallback } = await db
    .from("line_stations")
    .select("line_name, station_name")
    .in("station_name", stillUnresolved)
    .limit(stillUnresolved.length * 5);

  const byStation: Record<string, string[]> = {};
  for (const row of (lsFallback || [])) {
    if (!byStation[row.station_name]) byStation[row.station_name] = [];
    byStation[row.station_name].push(row.line_name);
  }

  const toUpsert: Array<{
    token: string; ward: string; realpro_lines: string[];
    itandi_lines: string[]; reins_line: string | null; confidence: number; source: string;
  }> = [];
  for (const [stName, lines] of Object.entries(byStation)) {
    const uniqueLines = [...new Set(lines)];
    result.realpro.station_names.push(stName);
    if (!result.itandi.station_names.includes(stName)) result.itandi.station_names.push(stName);
    for (const line of uniqueLines) {
      const rid = maps.routeMap[line];
      if (rid && !result.realpro.route_ids.includes(rid)) result.realpro.route_ids.push(rid);
    }
    const iLines = uniqueLines.flatMap(l => toItandiNames(l, maps));
    iLines.forEach(n => { if (!result.itandi.line_names.includes(n)) result.itandi.line_names.push(n); });
    const rLine = maps.reinsMap[uniqueLines[0]] ?? null;
    if (rLine && !result.reins.station_pairs.some(p => p.station === stName)) {
      result.reins.station_pairs.push({ line: rLine, station: stName });
    }
    const newSt = { token: stName, ward: "", realpro_lines: uniqueLines, itandi_lines: iLines, reins_line: rLine };
    result.new_stations.push(newSt);
    toUpsert.push({ ...newSt, confidence: 80, source: "resolve-area-nl" });
  }
  if (toUpsert.length > 0) {
    await db.from("station_map").upsert(toUpsert, { onConflict: "token" });
  }
}

// ベクトル類似度検索: station_map / region_map から最近傍を返す
// embedding が null の行はスキップされる（バッチ済み行のみヒット）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function vectorSearchStation(query: string, db: any, maps: LineMaps, result: ResolveAreaResponse): Promise<void> {
  const vec = await getEmbedding(query);
  if (!vec) return;

  const vecStr = JSON.stringify(vec);

  // station_map ベクトル検索（コサイン類似度 >= 0.82）
  const { data: smHits } = await db.rpc("match_station_map", {
    query_embedding: vecStr,
    match_threshold: 0.82,
    match_count: 5,
  });

  for (const row of (smHits ?? []) as Array<{
    token: string; ward: string | null;
    realpro_lines: string[]; itandi_lines: string[]; reins_line: string | null;
    similarity: number;
  }>) {
    if (result.realpro.station_names.includes(row.token)) continue;
    if ((row.realpro_lines?.length ?? 0) === 0) continue;
    result.realpro.station_names.push(row.token);
    if (!result.itandi.station_names.includes(row.token)) result.itandi.station_names.push(row.token);
    for (const line of (row.realpro_lines ?? [])) {
      const rid = maps.routeMap[line];
      if (rid && !result.realpro.route_ids.includes(rid)) result.realpro.route_ids.push(rid);
    }
    // itandi: itandi_linesカラムが空の場合は realpro_lines → maps.itandiMap でリアルタイム変換
    const vsItandiLines: string[] = (row.itandi_lines?.length ?? 0) > 0
      ? row.itandi_lines
      : (row.realpro_lines ?? []).flatMap((l: string) => maps.itandiMap[l] ?? []);
    for (const line of vsItandiLines) {
      if (!result.itandi.line_names.includes(line)) result.itandi.line_names.push(line);
    }
    // reins: reins_lineカラムが空の場合は realpro_lines → maps.reinsMap でリアルタイム変換
    const vsReinsLine: string | null = row.reins_line
      ?? (row.realpro_lines ?? []).map((l: string) => maps.reinsMap[l]).find(Boolean)
      ?? null;
    if (vsReinsLine && !result.reins.station_pairs.some((p: { station: string | null }) => p.station === row.token)) {
      result.reins.station_pairs.push({ line: vsReinsLine, station: row.token });
    }
  }

  // region_map ベクトル検索（コサイン類似度 >= 0.82）
  const { data: rmHits } = await db.rpc("match_region_map", {
    query_embedding: vecStr,
    match_threshold: 0.82,
    match_count: 3,
  });

  for (const row of (rmHits ?? []) as Array<{ token: string; ward: string; similarity: number }>) {
    if (!row.ward) continue;
    const code = WARD_CODE_MAP[row.ward];
    if (code && !result.realpro.city_codes.includes(code)) result.realpro.city_codes.push(code);
    if (!result.itandi.ward_names.includes(row.ward)) result.itandi.ward_names.push(row.ward);
    if (!result.reins.ward_names.includes(row.ward))  result.reins.ward_names.push(row.ward);
  }
}

interface ResolveAreaResponse {
  realpro: { route_ids: string[]; city_codes: string[]; station_names: string[] };
  itandi:  { line_names: string[]; station_names: string[]; ward_names: string[] };
  reins:   { station_pairs: Array<{ line: string; station: string | null }>; ward_names: string[] };
  new_stations: Array<{ token: string; ward: string; realpro_lines: string[]; itandi_lines: string[]; reins_line: string | null }>;
  new_regions:  Array<{ token: string; ward: string }>;
  suggested_walk_minutes?: number | null;  // walk/bicycle制約から抽出した徒歩分数
  normalized_area?: string | null;         // DeepSeekが正規化した表記（ひらがな・略称→正式名）
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const desired_area: string = body.desired_area || "";

    const empty: ResolveAreaResponse = {
      realpro:      { route_ids: [], city_codes: [], station_names: [] },
      itandi:       { line_names: [], station_names: [], ward_names: [] },
      reins:        { station_pairs: [], ward_names: [] },
      new_stations: [],
      new_regions:  [],
    };
    if (!desired_area.trim()) return NextResponse.json(empty);

    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // line_stations を取得して route→stations マップを構築
    const { data: lsRows } = await db
      .from("line_stations")
      .select("line_name, station_name, order_idx")
      .order("line_name")
      .order("order_idx");

    const lineStations: Record<string, string[]> = {};
    for (const row of lsRows || []) {
      if (!lineStations[row.line_name]) lineStations[row.line_name] = [];
      lineStations[row.line_name].push(row.station_name);
    }

    const maps = await getLineMaps(db);
    const tokens = parseTokens(desired_area);
    const result: ResolveAreaResponse = {
      realpro:      { route_ids: [], city_codes: [], station_names: [] },
      itandi:       { line_names: [], station_names: [], ward_names: [] },
      reins:        { station_pairs: [], ward_names: [] },
      new_stations: [],
      new_regions:  [],
    };

    for (const tok of tokens) {
      if (tok.length < 2) continue;

      // ── 路線名（「〜線」で終わるトークン）──────────────────────────────
      if (tok.endsWith("線")) {
        const internal = resolveLineInternal(tok, maps);
        if (internal) {
          const routeId = maps.routeMap[internal];
          if (routeId && !result.realpro.route_ids.includes(routeId))
            result.realpro.route_ids.push(routeId);

          const stations = lineStations[internal] || [];
          stations.forEach(s => {
            if (!result.realpro.station_names.includes(s)) result.realpro.station_names.push(s);
            if (!result.itandi.station_names.includes(s))  result.itandi.station_names.push(s);
          });

          toItandiNames(internal, maps).forEach(n => {
            if (!result.itandi.line_names.includes(n)) result.itandi.line_names.push(n);
          });

          const rName = maps.reinsMap[internal];
          if (rName && !result.reins.station_pairs.some(p => p.line === rName))
            result.reins.station_pairs.push({ line: rName, station: null });
        }
        // 未解決の路線名はClaudeのNL抽出（全文）で処理されるためスキップのみ
        continue;
      }

      // ── 市区名（WARD_CODE_MAP に完全一致） ─────────────────────────────
      const wardKey = WARD_CODE_MAP[tok]
        ? tok
        : WARD_CODE_MAP[tok + "市"]
        ? tok + "市"
        : null;
      if (wardKey) {
        const code = WARD_CODE_MAP[wardKey];
        if (!result.realpro.city_codes.includes(code)) result.realpro.city_codes.push(code);
        if (!result.itandi.ward_names.includes(wardKey)) result.itandi.ward_names.push(wardKey);
        if (!result.reins.ward_names.includes(wardKey))  result.reins.ward_names.push(wardKey);
        continue;
      }

      // ── それ以外: 数字始まり・都道府県市区郡含みはスキップ ────────────────
      // 残りトークンは Claude NL抽出（全文渡し）で処理される
      if (/^[0-9０-９]/.test(tok) || /[都道府県市区郡]/.test(tok)) continue;
    }

    // エリア正規化（ひらがな・略称→正式名）: Haiku NL抽出と並行して実行
    const _normalizePromise = desired_area.trim()
      ? normalizeAreaWithDeepSeek(desired_area)
      : Promise.resolve(null);

    // ── Claude Haiku: 生テキストからNL entity extraction ────────────────────────
    // 旧: unknownForAI トークンを route/ward/station に分類
    // 新: desired_area 全文を渡して stations/lines/areas/commute_constraints を抽出
    // 理由: parseTokens が自然言語構造を破壊するため「阪急茨木市まで30分で通える沿線」の
    //       commute制約が失われていた。全文渡しで自然言語の意味を正確に取得する。
    if (desired_area.trim()) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" } });

      const systemPrompt = `あなたは大阪府の不動産検索システムの自然言語解析エンジンです。
エリア希望文字列から不動産検索に必要な情報を構造化して抽出してください。

【出力形式】JSONのみ（説明文不要）:
{"stations":[],"lines":[],"areas":[],"commute_constraints":[]}

【フィールド定義】
stations: 駅名の配列（「駅」を付けない。例: "茨木市","梅田","天王寺"）
  - 「〜まで〜分」の基準駅もここに含める
  - 実在が確実な駅名のみ（推測禁止）

lines: 以下のリストから選択のみ（自由記述禁止）:
  御堂筋線,谷町線,四つ橋線,中央線,千日前線,堺筋線,長堀鶴見緑地線,今里筋線,
  阪急京都線,阪急千里線,阪急神戸線,阪急宝塚線,阪急箕面線,
  阪神本線,阪神なんば線,南海本線,南海高野線,南海空港線,南海泉北線,
  京阪本線,京阪中之島線,京阪交野線,
  大阪環状線,JR東西線,片町線,阪和線,おおさか東線,関西本線,福知山線,桜島線,
  近鉄南大阪線,近鉄大阪線,近鉄奈良線,近鉄けいはんな線,近鉄長野線,近鉄道明寺線,
  北大阪急行,大阪モノレール本線,大阪モノレール彩都線,能勢電鉄,
  南海汐見橋線,南海多奈川線,南海高師浜線,阪堺阪堺線,阪堺上町線,水間鉄道,ニュートラム

areas: 駅名・路線名に還元できない純粋な行政地名・概念エリア名
  例: "北摂","大阪市内","梅北エリア"
  ※ 「〇〇から△分以内」などの通勤時間パターンを含む場合は必ず commute_constraints を使い、areas には入れないこと
  ※ "梅田" は御堂筋線の駅名のため station_names に含める（areas には入れない）
  ※ "難波" "天王寺" "心斎橋" "本町" "福島" "新大阪" も駅名として station_names に含める

commute_constraints: 通勤・通学・乗り換え制約
  形式: {"base_station":"駅名（駅なし）","max_minutes":数値または省略,"max_transfers":回数または省略,"transport_mode":"bicycle"/"walk"または省略}
  対象:
    「〜まで〜分」「〜駅から〜分圏内」→ max_minutes を設定
    「乗り換えなし」「直通」「乗り換え0回」→ max_transfers:0（max_minutesは省略）
    「乗り換え1回以内」→ max_transfers:1
    「自転車〜分」「徒歩〜分」→ transport_mode:"bicycle"/"walk"（max_minutesと併用可）
  ルール: base_stationは勤務地・通勤先の最寄り駅。transport_mode=walkはDeepSeek展開不要。transport_mode=bicycleかつbase_stationがある場合はDeepSeek展開で圏内エリアを取得。

【重要ルール】
・「路線名 + 駅名」の形式（例: "阪急電鉄京都線 摂津市"）は、駅名のみ stations に含める。路線名は lines に含めない。
  → 路線名は駅名を特定するための文脈情報であり、路線全体を検索する意図ではない。
・「阪急京都本線」「阪急電鉄京都線」「阪急京都線」はすべて同じ路線を指す別称。

【例】
入力: "阪急電鉄京都線 摂津市"
出力: {"stations":["摂津市"],"lines":[],"areas":[],"commute_constraints":[]}

入力: "阪急京都本線 摂津市"
出力: {"stations":["摂津市"],"lines":[],"areas":[],"commute_constraints":[]}

入力: "おおさか東線 野江"
出力: {"stations":["野江"],"lines":[],"areas":[],"commute_constraints":[]}

入力: "JR東海道本線 茨木"
出力: {"stations":["茨木"],"lines":[],"areas":[],"commute_constraints":[]}

入力: "阪急茨木市駅まで30分で通える沿線"
出力: {"stations":["茨木市"],"lines":[],"areas":[],"commute_constraints":[{"base_station":"茨木市","max_minutes":30}]}

入力: "梅田か御堂筋線沿い"
出力: {"stations":[],"lines":["御堂筋線"],"areas":["梅田"],"commute_constraints":[]}

入力: "難波・心斎橋"
出力: {"stations":["難波","心斎橋"],"lines":[],"areas":[],"commute_constraints":[]}

入力: "梅田から20分圏内"
出力: {"stations":["梅田"],"lines":[],"areas":[],"commute_constraints":[{"base_station":"梅田","max_minutes":20}]}

入力: "北摂エリアで阪急沿線"
出力: {"stations":[],"lines":["阪急京都線","阪急宝塚線","阪急神戸線","阪急千里線","阪急箕面線"],"areas":["北摂"],"commute_constraints":[]}

入力: "梅田まで乗り換えなし"
出力: {"stations":["梅田"],"lines":[],"areas":[],"commute_constraints":[{"base_station":"梅田","max_transfers":0}]}

入力: "梅田直通で行ける場所"
出力: {"stations":["梅田"],"lines":[],"areas":[],"commute_constraints":[{"base_station":"梅田","max_transfers":0}]}

入力: "駅から自転車10分圏内"
出力: {"stations":[],"lines":[],"areas":[],"commute_constraints":[{"base_station":"","max_minutes":10,"transport_mode":"bicycle"}]}

入力: "梅田まで30分・野田阪神まで乗り換え1回"
出力: {"stations":["梅田","野田阪神"],"lines":[],"areas":[],"commute_constraints":[{"base_station":"梅田","max_minutes":30},{"base_station":"野田阪神","max_transfers":1}]}

入力: "難波から自転車15分以内"
出力: {"stations":["難波"],"lines":[],"areas":[],"commute_constraints":[{"base_station":"難波","max_minutes":15,"transport_mode":"bicycle"}]}`;

      try {
        const msg = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          temperature: 0,
          // prompt cache: systemPrompt は完全に静的（駅名・路線リスト等）のためキャッシュする。
          // 動的なユーザー入力（desired_area）は messages 側のみに置く。
          system: [
            { type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
          messages: [{ role: "user", content: `エリア: "${desired_area}"` }],
        });

        const text = msg.content[0].type === "text" ? msg.content[0].text : "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const ai = JSON.parse(jsonMatch[0]) as {
            stations?: string[];
            lines?: string[];
            areas?: string[];
            commute_constraints?: Array<{
              base_station: string;
              max_minutes?: number | null;
              max_transfers?: number;
              transport_mode?: string;
            }>;
          };

          // ── Step 1: lines → route_ids ──────────────────────────────────────
          for (const lineName of ai.lines ?? []) {
            const internal = resolveLineInternal(lineName, maps);
            if (!internal) continue;
            const routeId = maps.routeMap[internal];
            if (routeId && !result.realpro.route_ids.includes(routeId))
              result.realpro.route_ids.push(routeId);
            const stationsOnLine = lineStations[internal] ?? [];
            stationsOnLine.forEach(s => {
              if (!result.realpro.station_names.includes(s)) result.realpro.station_names.push(s);
              if (!result.itandi.station_names.includes(s))  result.itandi.station_names.push(s);
            });
            toItandiNames(internal, maps).forEach(n => {
              if (!result.itandi.line_names.includes(n)) result.itandi.line_names.push(n);
            });
            const rName = maps.reinsMap[internal];
            if (rName && !result.reins.station_pairs.some(p => p.line === rName))
              result.reins.station_pairs.push({ line: rName, station: null });
          }

          // ── Step 2: stations → station_map / line_stations 照合（バッチ化）──
          // 旧: 駅ごとにシリアルDB往復（15駅×0.5s=7.5s）
          // 新: 既解決駅のreins補完を1往復にまとめ、未解決駅はresolveStationsFromListに委譲（計2往復）
          const allAiStations = ai.stations ?? [];
          const needReinsCheck: string[] = [];
          const unresolvedStations: string[] = [];

          for (const stName of allAiStations) {
            if (result.realpro.station_names.includes(stName)) {
              // ローカル解決済みでも station_pairs に特定駅エントリがなければ補完候補に追加
              if (!result.reins.station_pairs.some(p => p.station === stName)) {
                needReinsCheck.push(stName);
              }
            } else {
              unresolvedStations.push(stName);
            }
          }

          // 既解決駅のreins補完: 一括取得（シリアルDB往復を1往復に圧縮）
          if (needReinsCheck.length > 0) {
            const { data: reinsRows } = await db
              .from("station_map")
              .select("token, reins_line")
              .in("token", needReinsCheck)
              .neq("source", "unknown");
            for (const row of (reinsRows || [])) {
              if (!row.reins_line) continue;
              const nullIdx = result.reins.station_pairs.findIndex(
                p => p.line === row.reins_line && p.station === null
              );
              if (nullIdx >= 0) {
                result.reins.station_pairs[nullIdx] = { line: row.reins_line, station: row.token };
              } else {
                result.reins.station_pairs.push({ line: row.reins_line, station: row.token });
              }
            }
          }

          // 未解決駅: resolveStationsFromList で一括解決（station_map + line_stations 2往復）
          await resolveStationsFromList(unresolvedStations, result, db, maps);

          // ── Step 2.5: ベクトル検索フォールバック ────────────────────────────
          // station_map / line_stations でも解決できなかった駅・エリア名をベクトル検索で補完
          // 表記ゆれ・未登録・口語表現に対応（embedding が null の行はスキップされる）
          const stillUnresolvedVec = unresolvedStations.filter(
            s => !result.realpro.station_names.includes(s)
          );
          await Promise.all(
            stillUnresolvedVec.map(s => vectorSearchStation(s, db, maps, result))
          );

          // ── Step 3: areas → CONCEPT_AREA_MAP / WARD_CODE_MAP / ベクトル検索 ─
          for (const area of ai.areas ?? []) {
            const stripped = area.replace(/エリア$/, "").trim();
            const wards = CONCEPT_AREA_MAP[area] ?? CONCEPT_AREA_MAP[stripped] ?? null;
            if (wards) {
              for (const w of wards) {
                const code = WARD_CODE_MAP[w];
                if (code && !result.realpro.city_codes.includes(code)) result.realpro.city_codes.push(code);
              }
            } else {
              // 直接 WARD_CODE_MAP に存在する市区名
              const code = WARD_CODE_MAP[area] ?? WARD_CODE_MAP[area + "市"] ?? null;
              if (code) {
                if (!result.realpro.city_codes.includes(code)) result.realpro.city_codes.push(code);
              } else {
                // ハードコードで解決できない → ベクトル検索で region_map / station_map を検索
                await vectorSearchStation(area, db, maps, result);
              }
            }
          }

          // ── Step 4: commute_constraints → DeepSeek展開 + 全システム反映 ────────
          // max_transfers → resolveTransferLinesWithDeepSeek → route_ids/itandi/reins全展開
          // max_minutes   → resolveNearbyWithDeepSeek → resolveStationsFromList（全システム反映）
          // transport_mode=bicycle/walk → DeepSeek呼び出しスキップ
          if ((ai.commute_constraints ?? []).length > 0) {
            await Promise.all(
              (ai.commute_constraints ?? []).map(async (constraint) => {
                const { base_station, max_minutes, max_transfers, transport_mode } = constraint;
                // 徒歩はDeepSeek展開不要（walk_minutesとして記録するのみ）
                if (transport_mode === "walk") {
                  if (max_minutes && !result.suggested_walk_minutes) {
                    result.suggested_walk_minutes = max_minutes;
                  }
                  if (base_station && !result.realpro.station_names.includes(base_station)) {
                    result.realpro.station_names.push(base_station);
                  }
                  return;
                }
                // 自転車: base_station + max_minutes がある場合はDeepSeekで圏内駅・区名を展開
                if (transport_mode === "bicycle") {
                  if (base_station && max_minutes) {
                    const nearby = await resolveNearbyByBicycle(base_station, max_minutes);
                    await resolveStationsFromList(nearby.stations, result, db, maps);
                    for (const ward of nearby.wards) {
                      if (!result.itandi.ward_names.includes(ward)) result.itandi.ward_names.push(ward);
                    }
                    // base_station自体も追加
                    if (!result.realpro.station_names.includes(base_station)) {
                      result.realpro.station_names.push(base_station);
                    }
                  } else {
                    // base_station なし（「駅から自転車10分」のみ）→ suggested_walk_minutesに記録
                    if (max_minutes && !result.suggested_walk_minutes) {
                      result.suggested_walk_minutes = max_minutes;
                    }
                  }
                  return;
                }

                if (max_transfers !== undefined && max_transfers !== null) {
                  // 乗り換え制約: 路線名ベースで展開（resolveLineInternalフィルタ済み）
                  const lineNames = await resolveTransferLinesWithDeepSeek(base_station, max_transfers, maps);
                  for (const internal of lineNames) {
                    const routeId = maps.routeMap[internal];
                    if (routeId && !result.realpro.route_ids.includes(routeId)) result.realpro.route_ids.push(routeId);
                    const stationsOnLine = lineStations[internal] ?? [];
                    stationsOnLine.forEach(s => {
                      if (!result.realpro.station_names.includes(s)) result.realpro.station_names.push(s);
                      if (!result.itandi.station_names.includes(s)) result.itandi.station_names.push(s);
                    });
                    toItandiNames(internal, maps).forEach(n => {
                      if (!result.itandi.line_names.includes(n)) result.itandi.line_names.push(n);
                    });
                    const rName = maps.reinsMap[internal];
                    if (rName && !result.reins.station_pairs.some(p => p.line === rName)) {
                      result.reins.station_pairs.push({ line: rName, station: null });
                    }
                  }
                } else if (max_minutes !== undefined && max_minutes !== null) {
                  // 時間制約: 近隣駅展開 + resolveStationsFromList で route_ids/itandi/reins全反映
                  const nearbyStations = await resolveNearbyWithDeepSeek(base_station, max_minutes);
                  await resolveStationsFromList(nearbyStations, result, db, maps);
                  if (process.env.NODE_ENV !== "production") {
                    console.log("[resolve-area] commute expanded stations:", nearbyStations);
                  }
                }
              })
            );
          }
        }
      } catch (aiErr) {
        console.warn("[resolve-area] Claude NL抽出失敗:", aiErr);
        // フォールバック: ローカルトークン解決（上の for ループ）の結果のみで継続
      }
    }

    const normalized_area = await _normalizePromise.catch(() => null);
    return NextResponse.json({ ...result, normalized_area });
  } catch (e) {
    console.error("[resolve-area] error:", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

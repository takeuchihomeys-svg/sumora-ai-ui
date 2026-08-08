import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

// ── 埋め込みマップ（popup-maps.js と同期維持）──────────────────────────────
const LINE_ROUTE_MAP: Record<string, string> = {
  "大阪市高速軌道御堂筋線":"6701","大阪市高速軌道谷町線":"6702",
  "大阪市高速軌道四つ橋線":"6703","大阪市高速軌道中央線":"6704",
  "大阪市高速軌道千日前線":"6705","大阪市高速軌道堺筋線":"6706",
  "大阪市高速軌道南港ポートタウン線":"6707","大阪市高速軌道今里筋線":"6699",
  "大阪市高速軌道長堀鶴見緑地線":"6768","北大阪急行南北線":"6711",
  "大阪環状線":"6603","JR東西線":"6767","ＪＲ東西線":"6767",
  "片町線":"6645","桜島線":"6604","おおさか東線":"6650",
  "関西本線":"6426","阪和線":"6647","福知山線":"6605","東海道本線":"6171",
  "近鉄大阪線":"6541","近鉄難波・奈良線":"6551","近鉄奈良線":"6551",
  "近鉄南大阪線":"6555","近鉄長野線":"6557","近鉄道明寺線":"6558","近鉄けいはんな線":"6563",
  "京阪電気鉄道京阪線":"6651","京阪電気鉄道中之島線":"6658","京阪電気鉄道交野線":"6652",
  "阪急電鉄京都線":"6661","阪急電鉄千里線":"6662","阪急電鉄神戸線":"6664",
  "阪急電鉄宝塚線":"6668","阪急電鉄箕面線":"6669",
  "阪神電鉄本線":"6671","阪神電鉄阪神なんば線":"6673",
  "南海電鉄南海本線":"6681","南海電鉄南本線":"6681",
  "南海電鉄高野線":"6686","南海電鉄泉北線":"6694",
  "南海電鉄空港線":"6691","南海電鉄汐見橋線":"6766",
  "南海電鉄多奈川線":"6684","南海電鉄高師浜線":"6683",
  "阪堺電気軌道阪堺線":"6689","阪堺電気軌道上町線":"6690",
  "大阪モノレール本線":"6709","大阪モノレール彩都線":"6772",
  "能勢電鉄":"6676","水間鉄道水間線":"6713","関西空港線":"6648",
};

const LINE_ALIAS_MAP: Record<string, string> = {
  "御堂筋線":"大阪市高速軌道御堂筋線",
  "谷町線":"大阪市高速軌道谷町線",
  "四つ橋線":"大阪市高速軌道四つ橋線",
  "中央線":"大阪市高速軌道中央線",
  "千日前線":"大阪市高速軌道千日前線",
  "堺筋線":"大阪市高速軌道堺筋線",
  "長堀鶴見緑地線":"大阪市高速軌道長堀鶴見緑地線",
  "今里筋線":"大阪市高速軌道今里筋線",
  "南港ポートタウン線":"大阪市高速軌道南港ポートタウン線",
  "阪急千里線":"阪急電鉄千里線",
  "阪急京都線":"阪急電鉄京都線",
  "阪急神戸線":"阪急電鉄神戸線",
  "阪急宝塚線":"阪急電鉄宝塚線",
  "阪急箕面線":"阪急電鉄箕面線",
  "阪神本線":"阪神電鉄本線",
  "阪神なんば線":"阪神電鉄阪神なんば線",
  "南海本線":"南海電鉄南海本線",
  "南海高野線":"南海電鉄高野線",
  "南海空港線":"南海電鉄空港線",
  "南海多奈川線":"南海電鉄多奈川線",
  "南海汐見橋線":"南海電鉄汐見橋線",
  "南海高師浜線":"南海電鉄高師浜線",
  "京阪本線":"京阪電気鉄道京阪線",
  "京阪中之島線":"京阪電気鉄道中之島線",
  "京阪交野線":"京阪電気鉄道交野線",
};

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

const ITANDI_LINE_MAP_FILL: Record<string, string | string[]> = {
  "大阪市高速軌道御堂筋線":"高速電気軌道第1号線(大阪メトロ御堂筋線)",
  "大阪市高速軌道谷町線":"高速電気軌道第2号線(大阪メトロ谷町線)",
  "大阪市高速軌道四つ橋線":"高速電気軌道第3号線(大阪メトロ四つ橋線)",
  "大阪市高速軌道中央線":"高速電気軌道第4号線(大阪メトロ中央線)",
  "大阪市高速軌道千日前線":"高速電気軌道第5号線(大阪メトロ千日前線)",
  "大阪市高速軌道堺筋線":"高速電気軌道第6号線(大阪メトロ堺筋線)",
  "大阪市高速軌道長堀鶴見緑地線":"高速電気軌道第7号線(大阪メトロ長堀鶴見緑地線)",
  "大阪市高速軌道今里筋線":"高速電気軌道第8号線(大阪メトロ今里筋線)",
  "大阪市高速軌道南港ポートタウン線":"大阪市高速電気軌道南港ポートタウン線(大阪メトロ南港ポートタウン線)",
  "北大阪急行南北線":"北大阪急行電鉄",
  "阪急電鉄神戸線":"阪急神戸本線",
  "阪急電鉄宝塚線":"阪急宝塚本線",
  "阪急電鉄京都線":"阪急京都本線",
  "阪急電鉄千里線":"阪急千里線",
  "阪急電鉄箕面線":"阪急箕面線",
  "阪神電鉄本線":"阪神本線",
  "阪神電鉄阪神なんば線":"阪神なんば線",
  "南海電鉄南海本線":"南海本線",
  "南海電鉄南本線":"南海本線",
  "南海電鉄高野線":"南海高野線",
  "南海電鉄泉北線":"南海泉北線(泉北線)",
  "南海電鉄空港線":"南海空港線",
  "南海電鉄汐見橋線":"南海汐見橋線",
  "南海電鉄多奈川線":"南海多奈川線",
  "南海電鉄高師浜線":"南海高師浜線",
  "京阪電気鉄道京阪線":"京阪本線",
  "京阪電気鉄道中之島線":"京阪中之島線",
  "京阪電気鉄道交野線":"京阪交野線",
  "大阪環状線":"大阪環状線",
  "JR東西線":"JR東西線",
  "片町線":"JR片町線(学研都市線)",
  "桜島線":"JR桜島線(JRゆめ咲線)",
  "阪和線":"阪和線(天王寺～和歌山)",
  "福知山線":"JR福知山線(新大阪～篠山口)(JR宝塚線)",
  "東海道本線":["JR東海道本線(京都～大阪)(JR京都線)","JR東海道本線(大阪～神戸)(JR神戸線(大阪～神戸))"],
  "おおさか東線":"おおさか東線",
  "関西本線":"JR関西本線(加茂～ＪＲ難波)(大和路線)",
  "近鉄難波・奈良線":["近鉄難波線","近鉄奈良線"],
  "近鉄南大阪線":"近鉄南大阪線",
  "近鉄大阪線":"近鉄大阪線",
  "近鉄長野線":"近鉄長野線",
  "近鉄道明寺線":"近鉄道明寺線",
  "近鉄けいはんな線":"近鉄けいはんな線",
  "大阪モノレール本線":"大阪モノレール線",
  "大阪モノレール彩都線":"国際文化公園都市線(大阪モノレール彩都線)",
  "能勢電鉄":"能勢電鉄妙見線",
  "水間鉄道水間線":"水間鉄道水間線",
  "関西空港線":"JR関西空港線",
};

const REINS_LINE_MAP: Record<string, string> = {
  "大阪市高速軌道御堂筋線":"大阪メトロ御堂筋線",
  "大阪市高速軌道谷町線":"大阪メトロ谷町線",
  "大阪市高速軌道中央線":"大阪メトロ中央線",
  "大阪市高速軌道堺筋線":"大阪メトロ堺筋線",
  "大阪市高速軌道四つ橋線":"大阪メトロ四つ橋線",
  "大阪市高速軌道千日前線":"大阪メトロ千日前線",
  "大阪市高速軌道長堀鶴見緑地線":"大阪メトロ長堀鶴見線",
  "大阪市高速軌道今里筋線":"大阪メトロ今里筋線",
  "大阪市高速軌道南港ポートタウン線":"南港ポートタウン線",
  "阪急電鉄神戸線":"阪急神戸線",
  "阪急電鉄宝塚線":"阪急宝塚線",
  "阪急電鉄京都線":"阪急京都線",
  "阪急電鉄千里線":"阪急千里線",
  "阪急電鉄箕面線":"阪急箕面線",
  "阪神電鉄本線":"阪神本線",
  "阪神電鉄阪神なんば線":"阪神なんば線",
  "南海電鉄南海本線":"南海本線",
  "南海電鉄南本線":"南海本線",
  "南海電鉄高野線":"南海高野線",
  "南海電鉄空港線":"南海空港線",
  "南海電鉄多奈川線":"南海多奈川線",
  "南海電鉄汐見橋線":"南海汐見橋線",
  "南海電鉄高師浜線":"南海高師浜線",
  "京阪電気鉄道京阪線":"京阪本線",
  "京阪電気鉄道中之島線":"京阪中之島線",
  "京阪電気鉄道交野線":"京阪交野線",
  "北大阪急行南北線":"北大阪急行",
  "JR東西線":"東西線",
  "大阪環状線":"大阪環状線",
  "おおさか東線":"おおさか東線",
  "片町線":"片町線",
  "阪和線":"阪和線",
  "福知山線":"福知山線",
  "関西本線":"関西線",
  "関西空港線":"関西空港線",
  "桜島線":"桜島線",
  "大阪モノレール本線":"大阪モノレール本線",
  "大阪モノレール彩都線":"大阪モノレール彩都線",
  "近鉄難波・奈良線":"近鉄奈良線",
  "近鉄南大阪線":"近鉄南大阪線",
  "近鉄大阪線":"近鉄大阪線",
  "近鉄けいはんな線":"近鉄けいはんな線",
  "近鉄信貴線":"近鉄信貴線",
  "近鉄道明寺線":"近鉄道明寺線",
  "近鉄長野線":"近鉄長野線",
  "能勢電鉄":"能勢電鉄",
  "水間鉄道水間線":"水間鉄道",
  "阪堺電気軌道上町線":"阪堺電気軌道上町線",
  "阪堺電気軌道阪堺線":"阪堺電気軌道阪堺線",
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

// 路線名を内部正式名に解決（LINE_ROUTE_MAP のキー形式に変換）
function resolveLineInternal(name: string): string | null {
  if (LINE_ROUTE_MAP[name]) return name;
  if (LINE_ALIAS_MAP[name]) return LINE_ALIAS_MAP[name];
  const normalized = name
    .replace(/^大阪メトロ/, "大阪市高速軌道")
    .replace(/^地下鉄/, "大阪市高速軌道")
    .replace("大阪市高速電気軌道", "大阪市高速軌道");
  if (LINE_ROUTE_MAP[normalized]) return normalized;
  const hit = Object.keys(LINE_ROUTE_MAP).find(
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
function toItandiNames(internal: string): string[] {
  const v = ITANDI_LINE_MAP_FILL[internal];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
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

interface ResolveAreaResponse {
  realpro: { route_ids: string[]; city_codes: string[]; station_names: string[] };
  itandi:  { line_names: string[]; station_names: string[]; ward_names: string[] };
  reins:   { station_pairs: Array<{ line: string; station: string | null }>; ward_names: string[] };
  new_stations: Array<{ token: string; ward: string; realpro_lines: string[]; itandi_lines: string[]; reins_line: string | null }>;
  new_regions:  Array<{ token: string; ward: string }>;
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
        const internal = resolveLineInternal(tok);
        if (internal) {
          const routeId = LINE_ROUTE_MAP[internal];
          if (routeId && !result.realpro.route_ids.includes(routeId))
            result.realpro.route_ids.push(routeId);

          const stations = lineStations[internal] || [];
          stations.forEach(s => {
            if (!result.realpro.station_names.includes(s)) result.realpro.station_names.push(s);
            if (!result.itandi.station_names.includes(s))  result.itandi.station_names.push(s);
          });

          toItandiNames(internal).forEach(n => {
            if (!result.itandi.line_names.includes(n)) result.itandi.line_names.push(n);
          });

          const rName = REINS_LINE_MAP[internal];
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

    // ── Claude Haiku: 生テキストからNL entity extraction ────────────────────────
    // 旧: unknownForAI トークンを route/ward/station に分類
    // 新: desired_area 全文を渡して stations/lines/areas/commute_constraints を抽出
    // 理由: parseTokens が自然言語構造を破壊するため「阪急茨木市まで30分で通える沿線」の
    //       commute制約が失われていた。全文渡しで自然言語の意味を正確に取得する。
    if (desired_area.trim()) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  南海汐見橋線,南海多奈川線,南海高師浜線,阪堺阪堺線,阪堺上町線,水間鉄道

areas: 駅名・路線名に還元できない地名・概念エリア名
  例: "梅田","難波","北摂","大阪市内","心斎橋","天王寺"

commute_constraints: 通勤・通学時間制約
  形式: {"base_station":"駅名（駅なし）","max_minutes":数値}
  対象: 「〜まで〜分」「〜駅から〜分圏内」「〜まで通える」等

【例】
入力: "阪急茨木市駅まで30分で通える沿線"
出力: {"stations":["茨木市"],"lines":[],"areas":[],"commute_constraints":[{"base_station":"茨木市","max_minutes":30}]}

入力: "梅田か御堂筋線沿い"
出力: {"stations":[],"lines":["御堂筋線"],"areas":["梅田"],"commute_constraints":[]}

入力: "難波・心斎橋"
出力: {"stations":[],"lines":[],"areas":["難波","心斎橋"],"commute_constraints":[]}

入力: "梅田から20分圏内"
出力: {"stations":["梅田"],"lines":[],"areas":[],"commute_constraints":[{"base_station":"梅田","max_minutes":20}]}

入力: "北摂エリアで阪急沿線"
出力: {"stations":[],"lines":["阪急京都線","阪急宝塚線","阪急神戸線","阪急千里線","阪急箕面線"],"areas":["北摂"],"commute_constraints":[]}`;

      try {
        const msg = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: "user", content: `エリア: "${desired_area}"` }],
        });

        const text = msg.content[0].type === "text" ? msg.content[0].text : "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const ai = JSON.parse(jsonMatch[0]) as {
            stations?: string[];
            lines?: string[];
            areas?: string[];
            commute_constraints?: Array<{ base_station: string; max_minutes: number }>;
          };

          // ── Step 1: lines → route_ids ──────────────────────────────────────
          for (const lineName of ai.lines ?? []) {
            const internal = resolveLineInternal(lineName);
            if (!internal) continue;
            const routeId = LINE_ROUTE_MAP[internal];
            if (routeId && !result.realpro.route_ids.includes(routeId))
              result.realpro.route_ids.push(routeId);
            const stationsOnLine = lineStations[internal] ?? [];
            stationsOnLine.forEach(s => {
              if (!result.realpro.station_names.includes(s)) result.realpro.station_names.push(s);
              if (!result.itandi.station_names.includes(s))  result.itandi.station_names.push(s);
            });
            toItandiNames(internal).forEach(n => {
              if (!result.itandi.line_names.includes(n)) result.itandi.line_names.push(n);
            });
            const rName = REINS_LINE_MAP[internal];
            if (rName && !result.reins.station_pairs.some(p => p.line === rName))
              result.reins.station_pairs.push({ line: rName, station: null });
          }

          // ── Step 2: stations → station_map / line_stations 照合 ─────────────
          for (const stName of ai.stations ?? []) {
            if (result.realpro.station_names.includes(stName)) continue; // ローカル解決済みはスキップ

            // station_map で検索
            const { data: stRow } = await db
              .from("station_map")
              .select("token, ward, realpro_lines, itandi_lines, reins_line, source")
              .eq("token", stName)
              .neq("source", "unknown")
              .maybeSingle();

            if (stRow && (stRow.realpro_lines?.length ?? 0) > 0) {
              result.realpro.station_names.push(stName);
              for (const line of stRow.realpro_lines ?? []) {
                const rid = LINE_ROUTE_MAP[line];
                if (rid && !result.realpro.route_ids.includes(rid)) result.realpro.route_ids.push(rid);
              }
              for (const line of stRow.itandi_lines ?? []) {
                if (!result.itandi.line_names.includes(line)) result.itandi.line_names.push(line);
              }
              if (stRow.reins_line && !result.reins.station_pairs.some(p => p.station === stName))
                result.reins.station_pairs.push({ line: stRow.reins_line, station: stName });
              continue;
            }

            // line_stations でフォールバック（station_map 未登録の場合）
            const { data: lsStRows } = await db
              .from("line_stations")
              .select("line_name, station_name")
              .eq("station_name", stName)
              .limit(5);

            if (lsStRows && lsStRows.length > 0) {
              result.realpro.station_names.push(stName);
              const uniqueLines = [...new Set(lsStRows.map((r: { line_name: string }) => r.line_name))];
              for (const line of uniqueLines) {
                const rid = LINE_ROUTE_MAP[line];
                if (rid && !result.realpro.route_ids.includes(rid)) result.realpro.route_ids.push(rid);
              }
              const iLines = uniqueLines.flatMap(l => toItandiNames(l));
              const rLine = REINS_LINE_MAP[uniqueLines[0]] ?? null;
              const newSt = { token: stName, ward: "", realpro_lines: uniqueLines, itandi_lines: iLines, reins_line: rLine };
              result.new_stations.push(newSt);
              await db.from("station_map").upsert(
                { ...newSt, confidence: 80, source: "resolve-area-nl" },
                { onConflict: "token" }
              );
            }
            // line_stations にもなければ無視（AI hallucination）
          }

          // ── Step 3: areas → CONCEPT_AREA_MAP / WARD_CODE_MAP ────────────────
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
              if (code && !result.realpro.city_codes.includes(code)) result.realpro.city_codes.push(code);
            }
          }

          // ── Step 4: commute_constraints → DeepSeek で近隣駅展開 ─────────────
          if ((ai.commute_constraints ?? []).length > 0) {
            const nearbyResults = await Promise.all(
              (ai.commute_constraints ?? []).map(({ base_station, max_minutes }) =>
                resolveNearbyWithDeepSeek(base_station, max_minutes)
              )
            );
            for (const nearbyStations of nearbyResults) {
              for (const s of nearbyStations) {
                if (!result.realpro.station_names.includes(s)) result.realpro.station_names.push(s);
              }
            }
            console.log("[resolve-area] commute expanded stations:", nearbyResults.flat());
          }
        }
      } catch (aiErr) {
        console.warn("[resolve-area] Claude NL抽出失敗:", aiErr);
        // フォールバック: ローカルトークン解決（上の for ループ）の結果のみで継続
      }
    }

    return NextResponse.json(result);
  } catch (e) {
    console.error("[resolve-area] error:", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

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

    const unknownForAI: string[] = [];

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

          continue;
        }
        // 未解決の路線名 → Claude に問い合わせ
        if (!unknownForAI.includes(tok)) unknownForAI.push(tok);
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
      if (/^[0-9０-９]/.test(tok) || /[都道府県市区郡]/.test(tok)) continue;

      if (!unknownForAI.includes(tok)) unknownForAI.push(tok);
    }

    // ── Claude Haiku で未解決トークンを処理 ────────────────────────────────
    if (unknownForAI.length > 0) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const knownRoutes = [
        "御堂筋線","谷町線","四つ橋線","中央線","千日前線","堺筋線","長堀鶴見緑地線","今里筋線",
        "阪急千里線","阪急宝塚線","阪急京都線","阪急神戸線","阪急箕面線",
        "阪神本線","阪神なんば線","南海本線","南海高野線","南海空港線",
        "京阪本線","京阪中之島線","大阪環状線","阪和線","おおさか東線","福知山線","片町線",
        "近鉄南大阪線","近鉄大阪線","近鉄奈良線","近鉄けいはんな線","近鉄長野線",
        "北大阪急行","大阪モノレール本線",
      ].join("、");

      const prompt = `大阪府の不動産検索システムです。以下のトークンを分類してJSON返却してください。

トークン: ${JSON.stringify(unknownForAI)}

既知路線（短縮名）の例: ${knownRoutes}
市区名の例: 大阪市北区、大阪市中央区、東大阪市、豊中市、吹田市、堺市

各トークンの分類:
- 路線名 → type:"route", internal_name: 内部正式名(「大阪市高速軌道〜」「阪急電鉄〜」「南海電鉄〜」等)
- 地域/市区名 → type:"ward", ward: 正式市区名(例:「大阪市城東区」「豊中市」)
- 駅名 → type:"station", ward: 最寄り市区, realpro_lines:[内部路線名], reins_line:REINS路線名
- 不明 → type:"unknown"

JSONのみ返却（改行なし）:
{"results":[{"raw":"...","type":"route|ward|station|unknown","internal_name":"...","ward":"...","realpro_lines":[],"reins_line":"..."}]}`;

      try {
        const msg = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        });

        const text = msg.content[0].type === "text" ? msg.content[0].text : "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const aiResult = JSON.parse(jsonMatch[0]);
          for (const item of (aiResult.results || []) as Array<Record<string, unknown>>) {
            const itemType = item.type as string;
            if (itemType === "route") {
              const internal = resolveLineInternal((item.internal_name as string) || "");
              if (!internal) continue;
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

            } else if (itemType === "ward") {
              const ward = item.ward as string;
              if (!ward) continue;
              const code = WARD_CODE_MAP[ward];
              if (code && !result.realpro.city_codes.includes(code)) result.realpro.city_codes.push(code);
              if (!result.itandi.ward_names.includes(ward)) result.itandi.ward_names.push(ward);
              if (!result.reins.ward_names.includes(ward))  result.reins.ward_names.push(ward);
              result.new_regions.push({ token: item.raw as string, ward });
              await db.from("region_map").upsert(
                { token: item.raw, ward, confidence: 75, source: "resolve-area" },
                { onConflict: "token" }
              );

            } else if (itemType === "station") {
              const ward = item.ward as string;
              const rLines = (item.realpro_lines as string[]) || [];
              const iLines = rLines.flatMap(l => toItandiNames(l));
              const reinsLine = (item.reins_line as string) || null;
              const rawToken = item.raw as string;
              if (!ward || rawToken.endsWith("線")) continue; // 路線名の誤学習を防止
              const newSt = {
                token: item.raw as string,
                ward,
                realpro_lines: rLines,
                itandi_lines: iLines,
                reins_line: reinsLine,
              };
              result.new_stations.push(newSt);
              // API解決駅をautofill用station_namesにも追加（Break 4 fix）
              if (!result.realpro.station_names.includes(newSt.token)) {
                result.realpro.station_names.push(newSt.token);
              }
              await db.from("station_map").upsert(
                { ...newSt, confidence: 75, source: "resolve-area" },
                { onConflict: "token" }
              );
            }
          }
        }
      } catch (aiErr) {
        console.warn("[resolve-area] Claude呼び出し失敗:", aiErr);
      }
    }

    return NextResponse.json(result);
  } catch (e) {
    console.error("[resolve-area] error:", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

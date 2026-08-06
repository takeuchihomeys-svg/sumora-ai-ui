import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ── 市区名 → リアプロ city_code（popup-maps.js の WARD_CODE_MAP と同期）──────
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

// ── リアプロ路線名 → route_id（popup-maps.js の LINE_ROUTE_MAP と同期）─────
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

// 短縮線名 → 正式名（popup-maps.js の LINE_ALIAS_MAP と同期）
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
};

// 市サフィックス補完（「富田林」→「富田林市」など）
const ALL_WARD_NAMES = new Set(Object.keys(WARD_CODE_MAP));
function resolveCityToken(token: string): string | null {
  if (ALL_WARD_NAMES.has(token)) return token;
  if (ALL_WARD_NAMES.has(token + "市")) return token + "市";
  return null;
}

// リアプロ路線名 → route_id変換（LINE_ALIAS_MAP → LINE_ROUTE_MAP の順で解決）
function lineToRouteId(lineName: string): string | null {
  const canonical = LINE_ALIAS_MAP[lineName] ?? lineName;
  return LINE_ROUTE_MAP[canonical] ?? LINE_ROUTE_MAP[lineName] ?? null;
}

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

// ── 「〜まで〜分の駅」パターン解析 ────────────────────────────────────────
type NearbyQuery = { token: string; station: string; minutes: number };

function parseNearbyQuery(token: string): NearbyQuery | null {
  // 「江坂まで20分くらいの駅」「梅田から15分の駅」「天王寺駅へ20分以内の駅」など
  const m = token.match(/^(.+?)(?:まで|から|へ|駅まで|駅から|駅へ)(\d+)分/);
  if (!m) return null;
  const station = m[1].replace(/駅$/, "").trim();
  const minutes = parseInt(m[2]);
  if (!station || !minutes) return null;
  return { token, station, minutes };
}

// DeepSeekに「〜まで〜分で行ける駅」を問い合わせ、駅名リストを返す
async function resolveNearbyWithDeepSeek(station: string, minutes: number): Promise<string[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `大阪府で「${station}駅」から電車で${minutes}分以内（乗り換え含む）に行ける主要な駅を列挙してください。
大阪府内の駅のみ対象。JSONの配列形式のみで返してください: ["駅名1", "駅名2", ...]
駅名には「駅」を付けないでください。10〜20駅程度。`,
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
    console.warn("[resolve-conditions] DeepSeek nearby error:", e instanceof Error ? e.message : e);
    return [];
  }
}

export type ResolvedSearchConditions = {
  station_names: string[];
  route_ids: string[];
  city_codes: string[];
  detail_ward: string | null;
  detail_area: string | null;
  unknown_tokens: string[];
};

export async function POST(req: NextRequest) {
  let desired_area: string;
  try {
    const body = await req.json() as { desired_area?: string };
    desired_area = body.desired_area?.trim() ?? "";
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  if (!desired_area) {
    return NextResponse.json<ResolvedSearchConditions>({
      station_names: [], route_ids: [], city_codes: [],
      detail_ward: null, detail_area: null, unknown_tokens: [],
    });
  }

  // desired_area を「・」「、」「,」で分割してトークン化（スペースは近隣クエリ内部にあるので除外）
  const rawTokens = desired_area
    .split(/[・、,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 「〜まで〜分の駅」パターンを分離
  const nearbyQueries: NearbyQuery[] = [];
  const tokens: string[] = [];
  for (const t of rawTokens) {
    const nearby = parseNearbyQuery(t);
    if (nearby) {
      nearbyQueries.push(nearby);
    } else {
      // スペースでも分割（通常のエリア・駅名トークン）
      const subs = t.split(/\s+/).filter(Boolean);
      tokens.push(...subs);
    }
  }

  const db = getDb();

  // ── ① 市名ルール解決（DBアクセス不要・コスト0）──────────────────────────
  const resolvedCity = new Map<string, string>(); // token → ward name
  const remaining: string[] = [];
  for (const token of tokens) {
    const city = resolveCityToken(token);
    if (city) {
      resolvedCity.set(token, city);
    } else {
      remaining.push(token);
    }
  }

  // ── ② DBキャッシュ（station_map / region_map）で一致解決 ──────────────────
  type StationRow = { token: string; ward: string | null; realpro_lines: string[]; source: string };
  type RegionRow  = { token: string; ward: string | null };

  const resolvedStation = new Map<string, StationRow>();
  const resolvedRegion  = new Map<string, RegionRow>();

  if (remaining.length > 0) {
    const [{ data: stationRows }, { data: regionRows }] = await Promise.all([
      db.from("station_map")
        .select("token, ward, realpro_lines, source")
        .in("token", remaining),
      db.from("region_map")
        .select("token, ward")
        .in("token", remaining),
    ]);

    for (const row of (stationRows ?? []) as StationRow[]) {
      // ネガティブキャッシュ（source="unknown"）は解決済み扱いにしない
      if (row.source !== "unknown") resolvedStation.set(row.token, row);
    }
    for (const row of (regionRows ?? []) as RegionRow[]) {
      resolvedRegion.set(row.token, row);
    }
  }

  // ── ③ 未解決トークンは fuzzy検索で補完 ──────────────────────────────────
  const unresolved = remaining.filter(
    (t) => !resolvedStation.has(t) && !resolvedRegion.has(t),
  );

  if (unresolved.length > 0) {
    await Promise.all(unresolved.map(async (token) => {
      // station_map fuzzy
      const { data: simSt } = await db.rpc("find_similar_station", {
        query_text: token, threshold: 0.35,
      });
      type SimSt = { token: string; ward: string | null; realpro_lines: string[]; source: string; similarity_score: number };
      const bestSt = ((simSt ?? []) as SimSt[]).find(
        (r) => (r.realpro_lines?.length ?? 0) > 0 && r.source !== "unknown",
      );
      if (bestSt) { resolvedStation.set(token, bestSt); return; }

      // region_map fuzzy
      const { data: simRg } = await db.rpc("find_similar_region", {
        query_text: token, threshold: 0.35,
      });
      type SimRg = { token: string; ward: string | null; similarity_score: number };
      const bestRg = ((simRg ?? []) as SimRg[])[0];
      if (bestRg?.ward) { resolvedRegion.set(token, bestRg); return; }
    }));
  }

  // ── ④ 結果を station_names / route_ids / city_codes に変換 ────────────────
  const station_names: string[] = [];
  const route_id_set = new Set<string>();
  const city_code_set = new Set<string>();
  let detail_ward: string | null = null;
  const unknown_tokens: string[] = [];

  for (const token of tokens) {
    // 市名ルールで解決済み
    if (resolvedCity.has(token)) {
      const ward = resolvedCity.get(token)!;
      const code = WARD_CODE_MAP[ward];
      if (code) city_code_set.add(code);
      if (!detail_ward) detail_ward = ward;
      continue;
    }

    // station_map で解決済み
    if (resolvedStation.has(token)) {
      const st = resolvedStation.get(token)!;
      station_names.push(token);
      for (const line of st.realpro_lines ?? []) {
        const rid = lineToRouteId(line);
        if (rid) route_id_set.add(rid);
      }
      continue;
    }

    // region_map で解決済み
    if (resolvedRegion.has(token)) {
      const rg = resolvedRegion.get(token)!;
      if (rg.ward) {
        const code = WARD_CODE_MAP[rg.ward];
        if (code) city_code_set.add(code);
        if (!detail_ward) detail_ward = rg.ward;
      }
      continue;
    }

    // 完全未解決
    unknown_tokens.push(token);
  }

  // ── ⑤ 近隣駅クエリ（「江坂まで20分の駅」等）をDeepSeekで解決 ──────────────
  if (nearbyQueries.length > 0) {
    const nearbyResults = await Promise.all(
      nearbyQueries.map((q) => resolveNearbyWithDeepSeek(q.station, q.minutes))
    );
    for (const stations of nearbyResults) {
      for (const s of stations) {
        if (!station_names.includes(s)) station_names.push(s);
      }
    }
    console.log("[resolve-conditions] nearby stations resolved:", nearbyResults.flat());
  }

  const result: ResolvedSearchConditions = {
    station_names,
    route_ids: Array.from(route_id_set),
    city_codes: Array.from(city_code_set),
    detail_ward,
    detail_area: null, // 町丁目ピンポイントは今後対応
    unknown_tokens,
  };

  return NextResponse.json(result);
}

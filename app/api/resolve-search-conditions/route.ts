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

// ── 概念的広域地名 → 大阪府の市区名（静的マップ・コスト0）───────────────────
// 注意: ここに載せる名前は必ず WARD_CODE_MAP に登録済みのものだけにする
// （未登録名は city_code に変換できず黙って落ちるため。三島郡島本町・太子町・河南町・千早赤阪村は
//   WARD_CODE_MAP に無いため削除済み。堺市は区単位に展開済み）
const CONCEPT_AREA_MAP: Record<string, string[]> = {
  "北摂": ["豊中市", "吹田市", "茨木市", "高槻市", "池田市", "箕面市", "摂津市"],
  "河内": ["東大阪市", "八尾市", "大東市", "四條畷市", "柏原市", "松原市", "大阪狭山市", "富田林市", "河内長野市", "羽曳野市", "藤井寺市"],
  "南河内": ["富田林市", "河内長野市", "羽曳野市", "藤井寺市", "大阪狭山市", "柏原市"],
  "泉州": ["堺市堺区", "堺市北区", "堺市西区", "堺市中区", "堺市東区", "堺市南区", "堺市美原区", "岸和田市", "泉大津市", "貝塚市", "泉佐野市", "泉南市", "阪南市", "和泉市"],
  "なんば": ["大阪市中央区", "大阪市浪速区", "大阪市西区"],
  "難波": ["大阪市中央区", "大阪市浪速区", "大阪市西区"],
  "ミナミ": ["大阪市中央区", "大阪市浪速区", "大阪市西区"],
  "梅田": ["大阪市北区", "大阪市福島区"],
  "キタ": ["大阪市北区", "大阪市福島区"],
  "南": ["大阪市中央区", "大阪市浪速区", "大阪市西区"],
  "北": ["大阪市北区", "大阪市福島区"],
  "堀江": ["大阪市西区"],
  "南堀江": ["大阪市西区"],
  "御堂筋": ["大阪市北区", "大阪市中央区"],
  "心斎橋": ["大阪市中央区"],
  "本町": ["大阪市中央区"],
  "南船場": ["大阪市中央区"],
  "西天満": ["大阪市北区"],
  "福島": ["大阪市福島区"],
  "靭": ["大阪市西区"],
  "靭公園": ["大阪市西区"],
  "肥後橋": ["大阪市西区", "大阪市北区"],
  "天王寺": ["大阪市天王寺区", "大阪市阿倍野区"],
  "新大阪": ["大阪市淀川区", "大阪市東淀川区"],
  "大阪市内": ["大阪市都島区", "大阪市福島区", "大阪市此花区", "大阪市西区", "大阪市港区", "大阪市大正区", "大阪市天王寺区", "大阪市浪速区", "大阪市西淀川区", "大阪市東淀川区", "大阪市東成区", "大阪市生野区", "大阪市旭区", "大阪市城東区", "大阪市阿倍野区", "大阪市住吉区", "大阪市東住吉区", "大阪市西成区", "大阪市淀川区", "大阪市鶴見区", "大阪市住之江区", "大阪市平野区", "大阪市北区", "大阪市中央区"],
};

// 市サフィックス補完（「富田林」→「富田林市」など）
const ALL_WARD_NAMES = new Set(Object.keys(WARD_CODE_MAP));
function resolveCityToken(token: string): string | null {
  if (ALL_WARD_NAMES.has(token)) return token;
  if (ALL_WARD_NAMES.has(token + "市")) return token + "市";
  // 短縮形サフィックスマッチ（例: "西淀川区" → "大阪市西淀川区"）
  // 区・市の完全名がWARD_CODE_MAPに登録されているが、顧客入力は短縮形が多い
  // 境界チェック必須: プレフィックスが「市」で終わる場合のみ採用する。
  // これがないと「淀川区」→大阪市西淀川区（誤・正は大阪市淀川区）、
  // 「東区」→大阪市城東区（誤・正は堺市東区）、「大阪市」→東大阪市（誤）になる
  for (const name of ALL_WARD_NAMES) {
    if (name.endsWith(token) && name !== token) {
      const prefix = name.slice(0, name.length - token.length);
      if (prefix.endsWith("市")) return name;
    }
  }
  return null;
}

// リアプロ路線名 → route_id変換（LINE_ALIAS_MAP → LINE_ROUTE_MAP の順で解決）
function lineToRouteId(lineName: string): string | null {
  const canonical = LINE_ALIAS_MAP[lineName] ?? lineName;
  return LINE_ROUTE_MAP[canonical] ?? LINE_ROUTE_MAP[lineName] ?? null;
}

function getDb() {
  // 書き込み（unknown_tokens 学習キャッシュ等）があるため SERVICE_ROLE を優先し、無ければ anon にフォールバック
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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

// ── 「〜線沿い」「〜沿線」パターン → route_ids 変換 ──────────────────────────
// 「御堂筋線沿い」→ [6701]、「阪急線沿い」「阪急沿い」→ 阪急全路線に展開
function parseLineSoiQuery(token: string): string[] | null {
  const m = token.match(/^(.+?)(?:線?沿い|沿線)$/);
  if (!m) return null;
  const linePart = m[1].trim(); // 「阪急」「御堂筋線」「阪急神戸線」など
  if (!linePart) return null;
  // 完全路線名（〜線）で一致確認
  const fullLine = linePart.endsWith("線") ? linePart : linePart + "線";
  const rid = lineToRouteId(fullLine) ?? lineToRouteId(linePart);
  if (rid) return [rid];
  // 「阪急神戸線」→「阪急電鉄神戸線」のような 電鉄/電気鉄道 省略形を正規化して照合
  for (const [name, id] of Object.entries(LINE_ROUTE_MAP)) {
    const normalized = name.replace(/(電気軌道|電気鉄道|電鉄)/, "");
    if (normalized === fullLine || normalized === linePart) return [id];
  }
  // 会社名のみ（「阪急」「南海」「近鉄」等）→ その会社の全路線 route_id に展開
  // 1文字プレフィックスは過剰マッチ（「阪」→阪急+阪神+阪堺）するため2文字以上のみ
  if (linePart.length >= 2) {
    const rids = new Set<string>();
    for (const [name, id] of Object.entries(LINE_ROUTE_MAP)) {
      if (name.startsWith(linePart)) rids.add(id);
    }
    if (rids.size > 0) return Array.from(rids);
  }
  return null;
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

// ── 概念的地域名 → 市区名リスト（段1: 静的マップ・コスト0）──────────────────
function resolveConceptAreaStatic(token: string): string[] | null {
  // 完全一致 + 末尾「エリア」除去して再試行
  const stripped = token.replace(/エリア$/, "").trim();
  return CONCEPT_AREA_MAP[token] ?? CONCEPT_AREA_MAP[stripped] ?? null;
}

// ── unknown_tokens 3段フォールバック用の型 ─────────────────────────────────
// resolved_as の JSON 形式: {"type":"station","names":[...]} | {"type":"ward","names":[...]}
type TokenResolution = { type: "station" | "ward"; names: string[] };
type UnknownTokenRow = {
  token: string;
  resolution_type: string | null;
  resolved_as: TokenResolution | null;
  attempt_count: number | null;
  last_attempt_at: string | null;
};

// 文字化け・記号混入トークンをDB保存前に弾く（region_map 文字化け行事故の再発防止）
const TOKEN_CHARSET_RE = /^[　-鿿゠-ヿA-Za-z0-9ー・]+$/;

// ── 段3: DeepSeek 統合問い合わせ（駅名 or 市区名を1回で判定）──────────────────
async function resolveTokenWithDeepSeek(token: string): Promise<TokenResolution | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  try {
    const wardNames = Object.keys(WARD_CODE_MAP).join("、");
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
          content: `「${token}」は大阪府のどの駅名または市区名に対応しますか？
駅名の場合: {"type":"station","names":["駅名1","駅名2"]}
市区名の場合: {"type":"ward","names":["大阪市◯◯区","△△市"]}
どちらでもない場合: {"type":"unknown"}
JSONのみ返してください。
駅名には「駅」を付けず、実在する駅の正式名のみ使ってください。
市区名は次のリストにある名前のみ使用してください: ${wardNames}`,
        }],
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const raw = (data.choices[0]?.message?.content ?? "").trim();
    const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { type?: unknown; names?: unknown };
    const names = Array.isArray(parsed.names)
      ? parsed.names.filter((n): n is string =>
          typeof n === "string" && n.length > 0 && TOKEN_CHARSET_RE.test(n))
      : [];
    if (parsed.type === "station" && names.length > 0) {
      // 「線」で終わる名前は駅として扱わない（御堂筋線汚染事故の再発防止ガード）
      const stationNames = names.filter((n) => !n.endsWith("線"));
      return stationNames.length > 0 ? { type: "station", names: stationNames } : null;
    }
    if (parsed.type === "ward" && names.length > 0) {
      const validWards = names.filter((n) => WARD_CODE_MAP[n] !== undefined);
      return validWards.length > 0 ? { type: "ward", names: validWards } : null;
    }
    return null;
  } catch (e) {
    console.warn("[resolve-conditions] DeepSeek token resolve error:", e instanceof Error ? e.message : e);
    return null;
  }
}

export type ResolvedSearchConditions = {
  station_names: string[];
  route_ids: string[];           // リアプロ用 route_id
  itandi_line_names: string[];   // itandi 用路線名（正式形式）
  reins_line_names: string[];    // レインズ用路線名
  city_codes: string[];
  detail_ward: string | null;
  detail_area: string | null;
  unknown_tokens: string[];
  is_wide: boolean;
  rent_max_resolved: number | null;
  building_age_resolved: number | null;
};

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let desired_area: string;
  let lines: string[];
  let stations: string[];
  let is_wide: boolean;
  let rent_max: number | undefined;
  let building_age: number | undefined;

  try {
    const body = await req.json() as {
      desired_area?: string;
      lines?: string[];
      stations?: string[];
      is_wide?: boolean;
      rent_max?: number;
      building_age?: number;
    };
    desired_area = body.desired_area?.trim() ?? "";
    lines = Array.isArray(body.lines) ? body.lines : [];
    stations = Array.isArray(body.stations) ? body.stations : [];
    is_wide = body.is_wide === true;
    rent_max = typeof body.rent_max === "number" ? body.rent_max : undefined;
    building_age = typeof body.building_age === "number" ? body.building_age : undefined;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  // ── is_wide による賃料・築年数の拡張 ───────────────────────────────────────
  let rent_max_resolved: number | null = null;
  let building_age_resolved: number | null = null;

  if (is_wide) {
    if (rent_max !== undefined) {
      rent_max_resolved = rent_max <= 100000 ? rent_max + 5000 : rent_max + 10000;
    }
    if (building_age !== undefined) {
      building_age_resolved = building_age + 5;
    }
  }

  // desired_area が空かつ lines/stations も空なら早期リターン
  if (!desired_area && lines.length === 0 && stations.length === 0) {
    return NextResponse.json<ResolvedSearchConditions>({
      station_names: [], route_ids: [], itandi_line_names: [], reins_line_names: [],
      city_codes: [], detail_ward: null, detail_area: null, unknown_tokens: [],
      is_wide, rent_max_resolved, building_age_resolved,
    });
  }

  // desired_area を「・」「、」「,」で分割してトークン化（スペースは近隣クエリ内部にあるので除外）
  const rawTokens = desired_area
    ? desired_area.split(/[・、,]+/).map((s) => s.trim()).filter(Boolean)
    : [];

  // 「〜まで〜分の駅」パターンを分離
  const nearbyQueries: NearbyQuery[] = [];
  const lineSoiRouteIds: string[] = [];
  const tokens: string[] = [];
  for (const t of rawTokens) {
    const nearby = parseNearbyQuery(t);
    if (nearby) {
      nearbyQueries.push(nearby);
      continue;
    }
    // 「〜線沿い」「〜沿線」パターン → route_ids に直接変換（駅名解決には回さない）
    const soiRouteIds = parseLineSoiQuery(t);
    if (soiRouteIds) {
      lineSoiRouteIds.push(...soiRouteIds);
      console.log("[resolve-conditions] line-soi resolved:", t, "->", soiRouteIds);
      continue;
    }
    // スペースでも分割（通常のエリア・駅名トークン）
    const subs = t.split(/\s+/).filter(Boolean);
    tokens.push(...subs);
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
  type StationRow = { token: string; ward: string | null; realpro_lines: string[]; itandi_lines: string[] | null; reins_line: string | null; source: string; created_at?: string | null };
  type RegionRow  = { token: string; ward: string | null };

  const resolvedStation = new Map<string, StationRow>();
  const resolvedRegion  = new Map<string, RegionRow>();
  // ネガティブキャッシュTTL: source="unknown" 行が7日以内なら fuzzy/DeepSeek をスキップ
  const knownUnknown = new Set<string>();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  if (remaining.length > 0) {
    const [{ data: stationRows }, { data: regionRows }] = await Promise.all([
      db.from("station_map")
        .select("token, ward, realpro_lines, itandi_lines, reins_line, source, created_at")
        .in("token", remaining),
      db.from("region_map")
        .select("token, ward")
        .in("token", remaining),
    ]);

    const expiredUnknown: string[] = [];
    for (const row of (stationRows ?? []) as StationRow[]) {
      // ネガティブキャッシュ（source="unknown"）は解決済み扱いにしない
      if (row.source === "unknown") {
        const ageMs = Date.now() - new Date(row.created_at ?? 0).getTime();
        if (ageMs < SEVEN_DAYS_MS) {
          // 7日以内 → fuzzy/DeepSeek 再試行を抑制（コスト対策）
          knownUnknown.add(row.token);
        } else {
          // 7日以上古い → unresolved のまま再試行。期限切れ負キャッシュは削除
          // （再試行後も未解決なら末尾の upsert が新しい created_at で再挿入 = TTL更新）
          expiredUnknown.push(row.token);
        }
        continue;
      }
      // M15: realpro_lines が空の行は（deepseek_nearby 等の半完成行）resolvedStation に入れず fuzzy に回す
      // ignoreDuplicates:true で既存の正常行は保護済みだが、新規挿入された空行がブロックするため
      if (!row.realpro_lines || row.realpro_lines.length === 0) {
        continue;
      }
      resolvedStation.set(row.token, row);
    }
    if (expiredUnknown.length > 0) {
      void db.from("station_map")
        .delete().in("token", expiredUnknown).eq("source", "unknown")
        .then(
          () => { console.log("[resolve-conditions] expired negative cache deleted:", expiredUnknown); },
          (e: unknown) => { console.warn("[resolve-conditions] expired negative cache delete failed:", e); }
        );
    }
    for (const row of (regionRows ?? []) as RegionRow[]) {
      resolvedRegion.set(row.token, row);
    }
  }

  // ── ③ 未解決トークンは fuzzy検索で補完（TTL内ネガティブキャッシュは除外）──
  const unresolved = remaining.filter(
    (t) => !resolvedStation.has(t) && !resolvedRegion.has(t) && !knownUnknown.has(t),
  );

  if (unresolved.length > 0) {
    await Promise.all(unresolved.map(async (token) => {
      // station_map fuzzy
      const { data: simSt } = await db.rpc("find_similar_station", {
        query_text: token, threshold: 0.35,
      });
      type SimSt = { token: string; ward: string | null; realpro_lines: string[]; itandi_lines: string[] | null; reins_line: string | null; source: string; similarity_score: number };
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
  const itandi_line_set = new Set<string>();
  const reins_line_set = new Set<string>();
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
      for (const line of st.itandi_lines ?? []) {
        itandi_line_set.add(line);
      }
      if (st.reins_line) reins_line_set.add(st.reins_line);
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
    for (const nearbyStations of nearbyResults) {
      for (const s of nearbyStations) {
        if (!station_names.includes(s)) station_names.push(s);
      }
    }
    console.log("[resolve-conditions] nearby stations resolved:", nearbyResults.flat());

    // DeepSeekで解決した近隣駅をDBにキャッシュ（以降はDBから返せる）
    const nearbyFlat = nearbyResults.flat();
    if (nearbyFlat.length > 0) {
      void db.from("station_map")
        .upsert(
          nearbyFlat.map((s) => ({ token: s, ward: null, realpro_lines: [] as string[], source: "deepseek_nearby" })),
          { onConflict: "token", ignoreDuplicates: true }
        )
        .then(() => {}, (e: unknown) => { console.error("[resolve-conditions] deepseek_nearby upsert failed:", e); });
    }
  }

  // ── ⑤.5 「〜線沿い」パターンで解決した route_ids を反映 ─────────────────────
  for (const rid of lineSoiRouteIds) {
    route_id_set.add(rid);
  }

  // ── ⑥ lines フィールド → route_ids に変換 ──────────────────────────────────
  for (const lineName of lines) {
    const rid = lineToRouteId(lineName);
    if (rid) {
      route_id_set.add(rid);
    } else {
      console.warn("[resolve-conditions] unknown line name:", lineName);
    }
  }

  // ── ⑦ stations フィールド → station_names に追加（重複除去）─────────────────
  for (const stName of stations) {
    if (stName && !station_names.includes(stName)) {
      station_names.push(stName);
    }
  }

  // ── ⑧ unknown_tokens の3段フォールバック解決 ──────────────────────────────
  // 段1: CONCEPT_AREA_MAP（静的・コスト0）
  // 段2: unknown_tokens テーブルの過去解決キャッシュ（DeepSeek/手動登録の再利用）
  // 段3: DeepSeek 統合問い合わせ（駅名 or 市区名を1回で判定）→ 結果を unknown_tokens に保存
  const conceptResolved = new Set<string>();
  if (unknown_tokens.length > 0) {
    // 市区名リストを city_code_set / detail_ward に適用（WARD_CODE_MAP 未登録名は黙殺せず警告）
    const applyWards = (token: string, wardNames: string[]): boolean => {
      let applied = false;
      for (const wardName of wardNames) {
        const code = WARD_CODE_MAP[wardName];
        if (code) {
          city_code_set.add(code);
          if (!detail_ward) detail_ward = wardName;
          applied = true;
        } else {
          console.warn("[resolve-conditions] WARD_CODE_MAP 未登録の市区名をスキップ:", wardName, "(token:", token, ")");
        }
      }
      return applied;
    };

    // 駅名リストを station_map で実在検証してから station_names / 路線系Setに適用
    // （source='unknown' や realpro_lines 空の行は検証NG = ハルシネーション防止）
    // 戻り値: 検証通過した駅名リスト
    const applyStations = async (names: string[]): Promise<string[]> => {
      const candidates = names.filter((n) => n && !n.endsWith("線"));
      if (candidates.length === 0) return [];
      const { data, error } = await db
        .from("station_map")
        .select("token, ward, realpro_lines, itandi_lines, reins_line, source")
        .in("token", candidates);
      if (error) {
        console.warn("[resolve-conditions] station validation query failed:", error.message);
        return [];
      }
      const valid: string[] = [];
      for (const row of (data ?? []) as StationRow[]) {
        if (row.source === "unknown") continue;
        if (!row.realpro_lines || row.realpro_lines.length === 0) continue;
        if (!station_names.includes(row.token)) station_names.push(row.token);
        for (const line of row.realpro_lines) {
          const rid = lineToRouteId(line);
          if (rid) route_id_set.add(rid);
        }
        for (const line of row.itandi_lines ?? []) itandi_line_set.add(line);
        if (row.reins_line) reins_line_set.add(row.reins_line);
        valid.push(row.token);
      }
      return valid;
    };

    // resolved_as（キャッシュ/DeepSeek結果）を実際の検索条件に適用
    const applyResolution = async (token: string, res: TokenResolution): Promise<boolean> => {
      if (res.type === "station" && Array.isArray(res.names)) {
        const valid = await applyStations(res.names);
        return valid.length > 0;
      }
      if (res.type === "ward" && Array.isArray(res.names)) {
        return applyWards(token, res.names);
      }
      return false;
    };

    // ── 段1: CONCEPT_AREA_MAP ──────────────────────────────────────────────
    const afterStage1: string[] = [];
    for (const token of unknown_tokens) {
      const fromMap = resolveConceptAreaStatic(token);
      if (fromMap && applyWards(token, fromMap)) {
        conceptResolved.add(token);
        console.log("[resolve-conditions] concept area resolved (static):", token, "->", fromMap);
      } else if (!knownUnknown.has(token)) {
        // TTL内ネガティブキャッシュは段2/3（DeepSeek）へ回さない
        afterStage1.push(token);
      }
    }

    // ── 段2: unknown_tokens テーブルキャッシュ + 段3: DeepSeek ─────────────
    // エラーが出てもメイン処理を止めない（テーブル未作成時なども検索自体は続行）
    if (afterStage1.length > 0) {
      try {
        const { data: cachedRows, error: cacheErr } = await db
          .from("unknown_tokens")
          .select("token, resolution_type, resolved_as, attempt_count, last_attempt_at")
          .in("token", afterStage1);
        if (cacheErr) {
          console.warn("[resolve-conditions] unknown_tokens cache lookup failed:", cacheErr.message);
        }
        const cacheMap = new Map<string, UnknownTokenRow>();
        for (const row of (cachedRows ?? []) as UnknownTokenRow[]) cacheMap.set(row.token, row);

        const needsDeepSeek: string[] = [];
        for (const token of afterStage1) {
          const row = cacheMap.get(token);
          if (row?.resolved_as) {
            // 段2: 過去のDeepSeek/手動解決を再利用（DeepSeek呼び出し不要）
            const applied = await applyResolution(token, row.resolved_as);
            if (applied) {
              conceptResolved.add(token);
              console.log("[resolve-conditions] token resolved (unknown_tokens cache):", token, "->", row.resolved_as);
              // station_map / region_map にも書き戻す（Chrome拡張の起動時ロードに反映させる）
              const res = row.resolved_as;
              if (res.type === "ward" && res.names[0]) {
                void db.from("region_map").upsert(
                  { token, ward: res.names[0], confidence: 70, source: "deepseek" },
                  { onConflict: "token" }
                ).then(() => {}, (e: unknown) => console.warn("[resolve-conditions] region_map write-back (cache) failed:", e));
              } else if (res.type === "station" && !token.endsWith("線")) {
                const { data: stRows } = await db.from("station_map")
                  .select("realpro_lines, itandi_lines, reins_line")
                  .in("token", res.names).neq("source", "unknown");
                if (stRows && stRows.length > 0) {
                  type StRow = { realpro_lines: string[]; itandi_lines: string[] | null; reins_line: string | null };
                  const cRealpro = [...new Set((stRows as StRow[]).flatMap(r => r.realpro_lines ?? []))];
                  const cItandi  = [...new Set((stRows as StRow[]).flatMap(r => r.itandi_lines ?? []))];
                  const cReins   = (stRows as StRow[]).find(r => r.reins_line)?.reins_line ?? null;
                  if (cRealpro.length > 0) {
                    void db.from("station_map").upsert(
                      { token, realpro_lines: cRealpro, itandi_lines: cItandi, reins_line: cReins, confidence: 70, source: "deepseek" },
                      { onConflict: "token" }
                    ).then(() => {}, (e: unknown) => console.warn("[resolve-conditions] station_map write-back (cache) failed:", e));
                  }
                }
              }
              continue;
            }
            // キャッシュ内容が現在のマップで適用不能 → 再解決へ
            needsDeepSeek.push(token);
            continue;
          }
          if (row && !row.resolved_as && row.last_attempt_at &&
              Date.now() - new Date(row.last_attempt_at).getTime() < SEVEN_DAYS_MS) {
            // 未解決キャッシュの7日TTL内 → DeepSeek再呼び出し抑制（コスト対策）
            continue;
          }
          needsDeepSeek.push(token);
        }

        // 段3: DeepSeek（1リクエストあたり最大3トークンに cap。残りは次回リクエストで再試行）
        // 文字化けトークンは結果を保存できず毎回呼ばれてしまうため、DeepSeek呼び出し前に除外
        const cleanTargets = needsDeepSeek.filter((t) => TOKEN_CHARSET_RE.test(t));
        const deepSeekTargets = cleanTargets.slice(0, 3);
        if (cleanTargets.length > deepSeekTargets.length) {
          console.log("[resolve-conditions] DeepSeek cap: 残り", cleanTargets.length - deepSeekTargets.length, "トークンは次回へ");
        }
        await Promise.all(deepSeekTargets.map(async (token) => {
          try {
            const prevAttempts = cacheMap.get(token)?.attempt_count ?? 0;
            let resolution = await resolveTokenWithDeepSeek(token);

            // 「線」で終わるトークンは station として保存しない（汚染事故ガード）
            if (resolution?.type === "station" && token.endsWith("線")) resolution = null;

            // station は station_map 実在検証を通過した駅のみ採用・保存
            let applied = false;
            let validatedResolution: TokenResolution | null = null;
            if (resolution?.type === "station") {
              const valid = await applyStations(resolution.names);
              if (valid.length > 0) {
                applied = true;
                validatedResolution = { type: "station", names: valid };
              }
            } else if (resolution?.type === "ward") {
              applied = applyWards(token, resolution.names);
              if (applied) validatedResolution = resolution;
            }

            if (applied && validatedResolution) {
              conceptResolved.add(token);
              console.log("[resolve-conditions] token resolved (deepseek):", token, "->", validatedResolution);
              // 解決結果を unknown_tokens に保存（次回以降はDBキャッシュで解決）
              const { error: upErr } = await db.from("unknown_tokens").upsert({
                token,
                resolution_type: "deepseek",
                resolved_as: validatedResolution,
                to_review: false,
                attempt_count: prevAttempts + 1,
                last_attempt_at: new Date().toISOString(),
              }, { onConflict: "token" });
              if (upErr) console.error("[resolve-conditions] unknown_tokens upsert failed:", token, upErr.message);
              // station_map / region_map にも書き戻す（Chrome拡張の起動時ロードに反映させる）
              if (validatedResolution.type === "ward" && validatedResolution.names[0]) {
                void db.from("region_map").upsert(
                  { token, ward: validatedResolution.names[0], confidence: 70, source: "deepseek" },
                  { onConflict: "token" }
                ).then(() => {}, (e: unknown) => console.warn("[resolve-conditions] region_map write-back failed:", e));
              } else if (validatedResolution.type === "station" && !token.endsWith("線")) {
                const { data: stRows } = await db.from("station_map")
                  .select("realpro_lines, itandi_lines, reins_line")
                  .in("token", validatedResolution.names).neq("source", "unknown");
                if (stRows && stRows.length > 0) {
                  type StRow = { realpro_lines: string[]; itandi_lines: string[] | null; reins_line: string | null };
                  const cRealpro = [...new Set((stRows as StRow[]).flatMap(r => r.realpro_lines ?? []))];
                  const cItandi  = [...new Set((stRows as StRow[]).flatMap(r => r.itandi_lines ?? []))];
                  const cReins   = (stRows as StRow[]).find(r => r.reins_line)?.reins_line ?? null;
                  if (cRealpro.length > 0) {
                    void db.from("station_map").upsert(
                      { token, realpro_lines: cRealpro, itandi_lines: cItandi, reins_line: cReins, confidence: 70, source: "deepseek" },
                      { onConflict: "token" }
                    ).then(() => {}, (e: unknown) => console.warn("[resolve-conditions] station_map write-back failed:", e));
                  }
                }
              }
              // 旧ネガティブキャッシュ（station_map source='unknown'）を掃除
              const { error: delErr } = await db.from("station_map")
                .delete().eq("token", token).eq("source", "unknown");
              if (delErr) console.warn("[resolve-conditions] negative cache cleanup failed:", token, delErr.message);
            } else {
              // 未解決として記録（7日TTLでDeepSeek再呼び出しを抑制・to_review で人間レビュー対象に）
              const { error: upErr } = await db.from("unknown_tokens").upsert({
                token,
                resolution_type: "unresolved",
                resolved_as: null,
                to_review: true,
                attempt_count: prevAttempts + 1,
                last_attempt_at: new Date().toISOString(),
              }, { onConflict: "token" });
              if (upErr) console.error("[resolve-conditions] unknown_tokens (unresolved) upsert failed:", token, upErr.message);
            }
          } catch (e) {
            console.error("[resolve-conditions] token fallback error:", token, e instanceof Error ? e.message : e);
          }
        }));
      } catch (e) {
        console.error("[resolve-conditions] unknown_tokens fallback pipeline error:", e instanceof Error ? e.message : e);
      }
    }
  }

  // 概念地域として解決できたもの・TTL内ネガティブキャッシュ済みのものを unknown_tokens から除去
  const filteredUnknownTokens = unknown_tokens.filter(
    (t) => !conceptResolved.has(t) && !knownUnknown.has(t),
  );

  // 完全未解決トークンを station_map にネガティブキャッシュ（次回以降のDeepSeek呼び出し抑制）
  // ignoreDuplicates: true により既存レコードは上書きしない（created_at は初回挿入時のまま）
  // token-resolve の 7日TTL ロジックが created_at を参照するため、新規挿入時のみ created_at を付与する
  if (filteredUnknownTokens.length > 0) {
    void db.from("station_map")
      .upsert(
        filteredUnknownTokens.map((t) => ({
          token: t,
          ward: null,
          realpro_lines: [] as string[],
          source: "unknown",
          created_at: new Date().toISOString(),
        })),
        { onConflict: "token", ignoreDuplicates: true }
      )
      .then(
        () => { console.log("[resolve-conditions] unknown tokens cached:", filteredUnknownTokens); },
        (e: unknown) => { console.error("[resolve-conditions] failed to cache unknown tokens:", e); }
      );
  }

  const result: ResolvedSearchConditions = {
    station_names,
    route_ids: Array.from(route_id_set),
    itandi_line_names: Array.from(itandi_line_set),
    reins_line_names: Array.from(reins_line_set),
    city_codes: Array.from(city_code_set),
    detail_ward,
    detail_area: null, // 町丁目ピンポイントは今後対応
    unknown_tokens: filteredUnknownTokens,
    is_wide,
    rent_max_resolved,
    building_age_resolved,
  };

  return NextResponse.json(result);
}

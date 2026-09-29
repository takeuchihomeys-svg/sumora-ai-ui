// app/lib/screen-watch-expect.ts（純関数・静的データ・DB 依存なし。osaka-geo の表が大きいので画面から import しない）
// 見張りの「決め方のズレ」: ブレインの意図（intent）と、それとは別の道で出した期待（expect）を比べる。
//
// 2026-09-29 竹内「画面開いているのも目で見ることができるのが理想」→ 見張り（screen-watch.ts）の④の材料。
// 「ブレインの意図」は1か所で決まっていない（4か所の合成）:
//   お客様の言葉 → 登録の条件（line-webhook-text・brain-core の condition_change_scope・rent-raise → property_condition_history）／
//   今回だけの上書き（search-override → payload.search_override）／希望エリアの文 → 駅・区・沿線（/api/resolve-area）／
//   通勤 → 駅（commute-reach-core）／ピンポイントか広げてか（search-widen-chain.decideWiden）／実際に入れようとした値（search_audits.intended）
// → 点検の記録が始まった時（recordStarted）にサーバーで1つの形（buildSearchIntent）にまとめて search_audits.intent に残す。
// 確かめる側（independentExpectation）は resolve-area とブレインを通らない別の道で作る:
//   osaka-geo の文の駅・区の読み（stationsInText・wardsInText・normWard）／通勤の到達時間の表（commute-reach）／要望の項目（customer-wants）
import { stationsInText, wardsInText, normStation, normWard, wardOfStation, wardsAdjacent, isKnownStation, MULTI_WARD_MAP } from "./osaka-geo";
import { WARD_CODE_NAMES } from "./search-condition-drift";
import { commuteReachPlan } from "./commute-reach";
import { itemizeWants, type WantsCustomerLike } from "./customer-wants";

export type ExpectCustomer = WantsCustomerLike & {
  desired_area?: string | null;
  commute_station?: string | null;
  commute_minutes?: number | null;
  rent_max?: number | null;
  floor_plan?: string | null;
  area_mode?: string | null;
  adjacent_ok?: boolean | null;
};

export type SearchExpect = {
  v: 1;
  /** 希望エリアの文で名指しした駅（そろえた名前・「以外」の節は除く） */
  named_stations: string[];
  /** 名指しした区・市 */
  named_wards: string[];
  /** 文の駅・地名から分かる区（名指しの区＋駅の区＋町名の区）＝ピンポイントで入ってよい区 */
  area_wards: string[];
  /** 除外の語（「鶴見区以外」「南方では無く」） */
  excluded: string[];
  /** 駅にも区にも読めなかった語（「谷町」「日本橋1.2丁目」）。ある時は「希望に無い区」を言わない */
  unresolved: string[];
  /** 隣の区も可（列 adjacent_ok） */
  adjacent_ok: boolean;
  commute: { targets: Array<{ target: string; minutes: number }>; stations: string[]; total: number; capped: boolean; skipped: string | null } | null;
  rent_max: number | null;
  floor_plan: string | null;
  area_mode: string | null;
  /** 検索の入力に入る要望（ペット・バストイレ別・構造） */
  wants_search: string[];
};

const EXCLUDE_RE = /以外|除く|除いて|NG|ＮＧ|不可|嫌|無理|避け|では?無く|ではなく|じゃなく/;
const SEP_RE = /[、,，・/／\s　()（）「」]+/;
/** 会社・路線の名前（「大阪メトロ」の「大阪」を駅と読まない） */
const COMPANY_RE = /大阪メトロ|Osaka\s*Metro|OsakaMetro|地下鉄/gi;
const VAGUE_TAIL_RE = /(?:周辺|付近|近辺|あたり|辺り|エリア|沿線|沿い|方面)$/;
/** 駅の語の後ろが「1.2丁目」「3丁目」なら町名（駅ではない・実物「日本橋1.2丁目」） */
const CHOME_AFTER_RE = /^\s*[0-9一二三四五六七八九十.．・、,]+\s*丁目/;

function uniq<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }
function nfkc(s: unknown): string { return String(s ?? "").normalize("NFKC"); }

/** 希望エリアの文を「使う語」と「除外の語」に分ける（語＝区切り・括弧の間。実物「なんば駅まで30分圏内(南方では無く大阪市内に近い方)」） */
export function splitExcluded(text: string): { use: string; excluded: string[] } {
  const parts = nfkc(text).replace(COMPANY_RE, " ").split(/[。\n]/).flatMap((x) => x.split(/[、,，・/／()（）]+/));
  const use: string[] = [], excluded: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (EXCLUDE_RE.test(t)) excluded.push(t); else use.push(t);
  }
  return { use: use.join("、"), excluded };
}

/** お客様の登録の条件から、ブレインを通らずに期待を作る */
export function independentExpectation(c: ExpectCustomer | null | undefined): SearchExpect {
  const area = nfkc(c?.desired_area);
  const { use, excluded } = splitExcluded(area);
  const st = stationsInText(use).filter((s) => !CHOME_AFTER_RE.test(use.slice(s.index + s.word.length)));
  const spans = st.map((s) => [s.index, s.index + s.word.length] as const);
  const named_stations = uniq(st.map((s) => s.station).filter(Boolean));
  // 駅の名前の中の区・市（「枚方市光善寺駅」の枚方市・「神戸三宮」の神戸）は区の名指しにしない
  const named_wards = uniq(wardsInText(use).filter((w) => !spans.some(([a, b]) => w.index < b && w.index + w.word.length > a)).map((w) => w.ward).filter(Boolean));
  const tokens = use.split(SEP_RE).map((t) => t.replace(VAGUE_TAIL_RE, "").replace(/駅$/, "").trim()).filter((t) => t.length >= 2);
  // 広域名（大阪市内・北摂・河内・泉州・南河内）は中の区・市を全部入ってよい区に
  const region = (t: string) => MULTI_WARD_MAP[t === "大阪市" ? "大阪市内" : t] ?? null;
  const tokenWards = tokens.flatMap((t) => region(t) ?? [normWard(t)]).filter((w): w is string => !!w);
  const unresolved = tokens.filter((t) => !region(t) && !normWard(t) && !isKnownStation(t) && !stationsInText(t).length && !wardsInText(t).length
    && !/線|まで|分|通勤|通学|圏内|市内|どこでも|こだわ|特に|なし|無し|未定|希望/.test(t));
  const stationWards = named_stations.map((s) => wardOfStation(s)).filter((w): w is string => !!w);
  let commute: SearchExpect["commute"] = null;
  try {
    const plan = commuteReachPlan({ commute_station: c?.commute_station ?? null, commute_minutes: c?.commute_minutes ?? null, desired_area: c?.desired_area ?? null });
    if (plan) commute = { targets: plan.targets.map((t) => ({ target: t.target, minutes: t.minutes })), stations: uniq(plan.stations.map((s) => s.station)), total: plan.total, capped: plan.capped, skipped: plan.skipped };
  } catch { commute = null; }
  let wants: string[] = [];
  try { wants = itemizeWants(c ?? null).filter((w) => w.search).map((w) => w.label); } catch { wants = []; }
  return {
    v: 1, named_stations, named_wards, area_wards: uniq([...named_wards, ...tokenWards, ...stationWards]), excluded, unresolved: uniq(unresolved).slice(0, 10),
    adjacent_ok: c?.adjacent_ok === true, commute,
    rent_max: typeof c?.rent_max === "number" ? c.rent_max : null, floor_plan: c?.floor_plan ?? null, area_mode: c?.area_mode ?? null, wants_search: wants,
  };
}

// ─── ブレインの意図（1つの形） ──────────────────────────────────────────────

export type SearchIntent = {
  v: 1;
  site: string | null;
  is_wide: boolean | null;
  area_mode: string | null;
  /** 入れようとした駅（そろえた名前） */
  stations: string[];
  /** 拡張の点検の記録が駅の数で切った（300）＝足りないとは言えない */
  stations_capped: boolean;
  wards: string[];
  /** 知らない市区のコードがあった（区の比べはしない） */
  wards_unknown: boolean;
  commute: { targets?: Array<{ target?: string | null; minutes?: number | null }> | null; stations?: number | null; skipped?: string | null } | null;
  override: Record<string, unknown> | null;
  source: string | null;
  chain: boolean;
  rent_max: number | null;
  floor_plan: string | null;
  rp_update_days: number | null;
  last_change: { field: string; at: string; source_message_id: string | null } | null;
};

/** 拡張の点検の記録の駅の数の上限（search-audit.js pickIntended の station_names・v2.5.40 から。それより前は 80） */
export const INTENT_STATION_CAP = 300;
export const INTENT_STATION_CAP_OLD = 80;

type AuditRowLike = {
  site?: string | null; is_wide?: boolean | null; area_mode?: string | null; trigger?: string | null;
  intended?: Record<string, unknown> | null; customer_snapshot?: Record<string, unknown> | null;
};
type PayloadLike = { source?: unknown; search_override?: unknown; chain?: unknown; is_wide?: unknown; rp_update_days?: unknown } | null | undefined;
type HistoryLike = Array<{ changed_field?: string | null; created_at?: string | null; source_message_id?: string | null }> | null | undefined;

/** 点検の記録が始まった時の材料（started の行・コマンドの payload・最新の条件の履歴）から意図を1つの形に */
export function buildSearchIntent(row: AuditRowLike, payload?: PayloadLike, history?: HistoryLike): SearchIntent {
  const i = (row.intended ?? {}) as Record<string, unknown>;
  const names = Array.isArray(i.station_names) ? (i.station_names as unknown[]).map(String) : [];
  const pairs = Array.isArray(i.reins_station_pairs) ? (i.reins_station_pairs as Array<{ station?: string }>).map((p) => String(p?.station ?? "")).filter(Boolean) : [];
  const stations = uniq([...names, ...pairs].map((s) => normStation(s)).filter(Boolean));
  const codes = Array.isArray(i.city_codes) ? (i.city_codes as unknown[]).map(String) : [];
  const wardNames = [...(Array.isArray(i.ward_names) ? (i.ward_names as unknown[]).map(String) : []), ...(typeof i.ward_name === "string" ? [i.ward_name] : [])];
  let unknown = false;
  const wards: string[] = [];
  for (const cd of codes) { const n = WARD_CODE_NAMES[cd]; if (n) wards.push(n); else unknown = true; }
  for (const n of wardNames) { const w = normWard(n); if (w) wards.push(w); }
  const snap = (row.customer_snapshot ?? {}) as Record<string, unknown>;
  const ov = (snap._search_override && typeof snap._search_override === "object" ? snap._search_override : payload && typeof payload.search_override === "object" ? payload.search_override : null) as Record<string, unknown> | null;
  const h = (history ?? [])[0];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    v: 1,
    site: row.site ?? null,
    is_wide: typeof row.is_wide === "boolean" ? row.is_wide : typeof i.is_wide === "boolean" ? (i.is_wide as boolean) : null,
    area_mode: (typeof i.area_mode === "string" ? i.area_mode : row.area_mode) ?? null,
    stations,
    stations_capped: names.length >= INTENT_STATION_CAP || names.length === INTENT_STATION_CAP_OLD,
    wards: uniq(wards),
    wards_unknown: unknown,
    commute: i.commute && typeof i.commute === "object" ? (i.commute as SearchIntent["commute"]) : null,
    override: ov,
    source: typeof payload?.source === "string" ? payload.source : row.trigger ?? null,
    chain: !!payload?.chain,
    rent_max: num(i.rent_max),
    floor_plan: typeof i.floor_plan === "string" ? i.floor_plan : null,
    rp_update_days: num(i.rp_update_days),
    last_change: h?.changed_field ? { field: String(h.changed_field), at: String(h.created_at ?? ""), source_message_id: h.source_message_id ?? null } : null,
  };
}

// ─── 決め方のズレ ────────────────────────────────────────────────────────────

export type DecisionItem = { kind: "named_station_missing" | "named_ward_missing" | "commute_missing" | "ward_extra"; severity: "warn" | "bad"; title: string; names: string[] };
export type DecisionDrift = { severity: "ok" | "warn" | "bad"; items: DecisionItem[]; missing: string[]; extra: string[]; screen: { stations: number | null } };

/** 通勤の到達駅の半分以上が入っていなければ「抜けた」 */
export const COMMUTE_COVERAGE_MIN = 0.5;

/**
 * 意図（intent）と期待（expect）を比べる。filled は画面の読み戻し（数だけ要約に使う）。
 *   ・名指しの駅が intent に無い → bad（区で入れた回は駅の区が入っていれば良い）
 *   ・名指しの区が intent に無い → bad（駅で入れた回は、その区の駅が1つも無い時だけ warn）
 *   ・通勤の条件があり、表で出した駅の半分以上が intent に無い／intent.commute が空 → warn（skipped=concrete_area は ok）
 *   ・intent にだけある区（広げてでない回） → warn
 *   スタッフのメモの一時調整（override の場所）がある回・スタッフの手の個別の検索（single）は比べない（人が決めた範囲）。場所が1つも入っていない回も比べない（既存の点検が言う）
 */
export function decisionDrift(intent: SearchIntent | null | undefined, expect: SearchExpect | null | undefined, filled?: { form?: { stations?: unknown[] | null } | null } | null): DecisionDrift {
  const items: DecisionItem[] = [];
  const screen = { stations: Array.isArray(filled?.form?.stations) ? filled!.form!.stations!.length : null };
  const done = (): DecisionDrift => {
    const sev = items.some((x) => x.severity === "bad") ? "bad" : items.length ? "warn" : "ok";
    return {
      severity: sev, items,
      missing: uniq(items.filter((x) => x.kind !== "ward_extra").flatMap((x) => x.names)).slice(0, 20),
      extra: uniq(items.filter((x) => x.kind === "ward_extra").flatMap((x) => x.names)).slice(0, 20),
      screen,
    };
  };
  if (!intent || !expect) return done();
  const ovLoc = intent.override && typeof intent.override === "object" ? (intent.override as { location?: unknown }).location : null;
  if (ovLoc) return done();
  // スタッフの手の個別の検索（一時調整で駅を直した回）は人が決めた範囲＝比べない（実物: 大国町のお客様を九条・大正で個別に検索した回）
  if (intent.source === "single") return done();
  const I = new Set(intent.stations);
  const W = new Set(intent.wards);
  const hasLoc = I.size > 0 || W.size > 0 || intent.wards_unknown;
  if (!hasLoc) return done();

  // 名指しの駅
  if (!intent.stations_capped) {
    const miss = expect.named_stations.filter((s) => {
      if (I.has(s)) return false;
      if ([...W].some((w) => w.replace(/市$/, "") === s)) return false; // 「茨木」を茨木市で入れた
      if (W.size) { const w = wardOfStation(s); if (w && W.has(w)) return false; if (intent.wards_unknown) return false; }
      if (!I.size && intent.wards_unknown) return false;
      return true;
    });
    if (miss.length) items.push({ kind: "named_station_missing", severity: "bad", title: `名指しの駅（${miss.slice(0, 4).join("・")}）が検索に入っていない`, names: miss });
  }
  // 名指しの区
  if (!intent.wards_unknown) {
    const missBad: string[] = [], missWarn: string[] = [];
    for (const w of expect.named_wards) {
      if (W.has(w)) continue;
      if (W.size) { missBad.push(w); continue; }
      const known = intent.stations.filter((s) => !!wardOfStation(s));
      if (!known.length) continue; // 入れた駅の区が1つも分からない（神戸の元町など）→ 比べない
      const anyIn = known.some((s) => wardOfStation(s) === w);
      if (!anyIn && !intent.stations_capped) missWarn.push(w);
    }
    if (missBad.length) items.push({ kind: "named_ward_missing", severity: "bad", title: `名指しの区（${missBad.slice(0, 4).join("・")}）が検索に入っていない`, names: missBad });
    if (missWarn.length) items.push({ kind: "named_ward_missing", severity: "warn", title: `名指しの区（${missWarn.slice(0, 4).join("・")}）の駅が1つも入っていない`, names: missWarn });
  }
  // 通勤の到達駅
  const ec = expect.commute;
  if (ec && !ec.skipped && ec.stations.length >= 10) {
    const tg = ec.targets.map((t) => `${t.target}まで${t.minutes}分`).join("・");
    const ic = intent.commute;
    const icHas = !!ic && !ic.skipped && (ic.stations ?? 0) > 0;
    if (String(intent.site ?? "") === "reins") {
      if (!icHas) items.push({ kind: "commute_missing", severity: "warn", title: `通勤の到達駅が抜けた（${tg}・レインズは区間で入れる）`, names: ec.targets.map((t) => t.target) });
    } else {
      const hit = ec.stations.filter((s) => I.has(s)).length;
      const cov = hit / ec.stations.length;
      if (!icHas || (!intent.stations_capped && cov < COMMUTE_COVERAGE_MIN)) {
        items.push({ kind: "commute_missing", severity: "warn", title: `通勤の到達駅が抜けた（${tg}: 期待 ${ec.stations.length}駅・入った ${hit}駅）`, names: ec.targets.map((t) => t.target) });
      }
    }
  }
  // intent にだけある区（広げてでない回）
  if (intent.is_wide !== true && W.size && !expect.unresolved.length && (expect.area_wards.length || expect.named_stations.length)) {
    const allowed = new Set(expect.area_wards);
    const extra = intent.wards.filter((w) => !allowed.has(w) && !(expect.adjacent_ok && expect.area_wards.some((a) => wardsAdjacent(a, w))));
    if (extra.length) items.push({ kind: "ward_extra", severity: "warn", title: `希望に無い区（${extra.slice(0, 4).join("・")}）で検索した`, names: extra });
  }
  return done();
}

/** 裁定・画面に出す短い要約 */
export function intentSummary(i: SearchIntent | null | undefined): string {
  if (!i) return "-";
  const parts = [
    i.stations.length ? `駅 ${i.stations.length}（${i.stations.slice(0, 6).join("・")}${i.stations.length > 6 ? "…" : ""}）` : "",
    i.wards.length ? `区 ${i.wards.join("・")}` : i.wards_unknown ? "区（コードが読めない）" : "",
    i.commute?.targets?.length ? `通勤 ${(i.commute.targets ?? []).map((t) => `${t.target}${t.minutes}分`).join("・")}→${i.commute.stations ?? "?"}駅${i.commute.skipped ? `（広げない: ${i.commute.skipped}）` : ""}` : "",
    i.is_wide === true ? "広げて" : i.is_wide === false ? "ピンポイント" : "",
    i.override ? "メモの一時調整あり" : "",
  ].filter(Boolean);
  return parts.join("・") || "場所なし";
}
export function expectSummary(e: SearchExpect | null | undefined): string {
  if (!e) return "-";
  const parts = [
    e.named_stations.length ? `名指しの駅 ${e.named_stations.slice(0, 6).join("・")}` : "",
    e.named_wards.length ? `名指しの区 ${e.named_wards.join("・")}` : "",
    e.commute ? `通勤 ${e.commute.targets.map((t) => `${t.target}${t.minutes}分`).join("・")}→${e.commute.skipped ? `広げない（${e.commute.skipped}）` : `${e.commute.stations.length}駅${e.commute.capped ? `（${e.commute.total}駅を上限で切った）` : ""}`}` : "",
    e.excluded.length ? `除外 ${e.excluded.slice(0, 3).join("・")}` : "",
  ].filter(Boolean);
  return parts.join("・") || "場所の手がかりなし";
}

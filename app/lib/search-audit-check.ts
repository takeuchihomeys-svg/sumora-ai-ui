// app/lib/search-audit-check.ts
// 検索の点検（決定論）: 拡張がブレインモードで検索した1回（search_audits の1行）を見て、
// 「ちゃんと検索できていたか・お客様の条件とずれていないか」の札を付ける純関数（DB・画面の依存なし＝画面からも使える）。
//
// 2026-09-25 竹内「ブレインモードで物件自動検索や一括検索した際に、検索がちゃんとされていなかったら原因を見つけられるようにする。
//   0件だった場合ちゃんと検索されていない可能性があるし、お客さんの条件とずれた検索をしていた可能性がある」
//
// 3つの材料を並べて比べる:
//   customer_snapshot … お客様の条件（DB の欄の写し・名前と電話は入れない）
//   intended          … 拡張が入れようとした条件（popup.js が page-script に渡した conditions）
//   filled            … 実際に画面に入った値（page-script が検索ボタンを押す直前にフォームから読み戻した物・押せなかった駅など）
//   result            … 検索の結果（件数表示の生の文字・ページ数・読んだ行数・送れる行数・送った数・0件と決めた理由）
// 札（code）と原因の鍵（cause_key）の形: station_missing:itandi:JR京都線:東三国（同じ原因を週ごとに数える単位）。
//
// 線の引き方（誤検知を増やさない）:
//   ・読み戻しが無い（古い版の拡張・page-script が audit を載せなかった）欄は比べない（＝札を付けない）
//   ・駅が押せなかったかは page-script 自身の判定（stations_missing）を第一に使う。フォームの読み戻しとの比較は読み戻しがある時だけ
//   ・0件は「件数表示が 0 と読めた」時だけ確かめ済み（warn）。それ以外の0件（25秒ボタンが出なかった等）は確かめていない（bad）
import { effectiveRpUpdateDays, type RpUpdateDaysCustomer } from "./rp-update-days";
import { conditionDrift } from "./search-condition-drift";
import { agesOutside, coversGap, fmtGap, hoursSince, neededDays, planFor, type UpdateAges } from "./search-update-days";
import { buildSentRoomIndex, isSentRoom } from "./sent-room-match";
import { SEARCH_MAX_PAGES } from "./auto-search-schedule";

export type AuditSeverity = "ok" | "warn" | "bad";
export type AuditSite = "realpro" | "itandi" | "reins";

export type CheckCode =
  | "STATION_MISSING" | "ROUTE_MISSING" | "AREA_UNRESOLVED" | "CONDITION_MISREAD" | "RENT_MISMATCH"
  | "FLOOR_PLAN_DROPPED" | "UPDATE_DAYS" | "LOCATION_MODE" | "RESET_FAILED" | "UI_NOT_FOUND" | "CONDITION_DRIFT" | "CONDITION_STALE"
  | "ZERO_UNCONFIRMED" | "ZERO_CONFIRMED" | "SENT_LT_READ" | "STALLED" | "COMMUTE_REACH"
  // 2026-09-30 v2.5.42 送付済みの部屋を選んだ・ダウンロードした（見張り）／ITANDI の条件が効いていない検索（止めた・入れ直し）
  | "SENT_SELECTED" | "ITANDI_GUARD" | `ERROR_${string}`;

export type AuditCheck = {
  code: CheckCode;
  severity: AuditSeverity;
  cause_key: string;
  /** 画面に出す短い見出し（例「東三国が入っていない」） */
  title: string;
  /** 根拠（入れようとした値・入った値など） */
  detail: string;
};

/** お客様の条件の写し（search_audits.customer_snapshot）。名前・電話は入れない */
export type CustomerSnapshot = RpUpdateDaysCustomer & {
  desired_area?: string | null;
  area_mode?: string | null;
  rent_max?: number | null;
  max_rent?: number | null;
  rent_min?: number | null;
  floor_plan?: string | null;
  layout?: string | null;
  walk_minutes?: number | null;
  building_age?: number | null;
  commute_station?: string | null;
  commute_minutes?: number | null;
};

/** 2026-09-29 v2.5.39 通勤の到達時間で選んだ駅（拡張の commute-reach reachAudit の形・駅名は載せず数だけ） */
export type IntendedCommute = {
  targets?: Array<{ target?: string | null; minutes?: number | null; source?: string | null }> | null;
  stations?: number | null;
  total?: number | null;
  capped?: boolean | null;
  lines?: number | null;
  transfers?: number | null;
  /** concrete_area＝希望エリアが具体的なので広げなかった */
  skipped?: string | null;
};

/** 拡張が入れようとした条件（popup の conditions・background の _buildBatchConditions の写し） */
export type Intended = {
  area_mode?: string | null;
  rent_max?: number | null;
  rent_min?: number | null;
  walk_minutes?: number | null;
  building_age?: number | null;
  floor_plan?: string | null;
  rp_update_days?: number | null;
  station_names?: string[] | null;
  route_ids?: Array<number | string> | null;
  city_codes?: Array<number | string> | null;
  detail_ward?: string | null;
  detail_area?: string | null;
  itandi_lines?: string[] | null;
  ward_names?: string[] | null;
  ward_name?: string | null;
  reins_station_pairs?: Array<{ line?: string; station?: string }> | null;
  reins_line?: string | null;
  unknown_tokens?: string[] | null;
  is_wide?: boolean | null;
  select_all_line_stations?: boolean | null;
  commute?: IntendedCommute | null;
};

export type FormReadback = {
  rent_max?: string | null;
  rent_min?: string | null;
  update_days?: string | null;
  walk?: string | null;
  age?: string | null;
  layouts?: string[] | null;
  stations?: string[] | null;
  lines?: string[] | null;
  wards?: string[] | null;
};

export type MissingItem = { name: string; line?: string | null; label_count?: number | null; sample?: string[] | null };

/** page-script が fill-done に載せた audit（実際に画面に入った値・押せなかった物） */
export type Filled = {
  v?: number;
  search_clicked?: boolean | null;
  form?: FormReadback | null;
  stations_ok?: string[] | null;
  stations_missing?: MissingItem[] | null;
  lines_missing?: MissingItem[] | null;
  click_fails?: Array<{ what: string; text?: string | null; sample?: string[] | null }> | null;
  reset_fail?: string | null;
  /** 2026-09-27 v2.5.34 itandi: 「募集条件更新 N日以内」の欄に入れた結果（itandi-update-days.js の run の返り）。
   *  status: kept／set（一覧から選んだ）／set_typed（打っただけ・確定は未確認）／cleared／out_of_range（一覧に無い日数→なしで検索）／
   *  not_accepted（欄が日数を受け付けず空で検索）／stuck（前の値が残り検索しなかった）／
   *  field_missing（欄が見つからない・名前だけで見つけた欄には打たない）／no_field（入れる日数が無く欄も無い）／module_missing／error */
  update_days?: { status?: string | null; want?: number | null; before?: string | null; got?: string | null; how?: string | null; name?: string | null; how_set?: string | null } | null;
  /** 場所の入れ方（station / route / area / none）。page-script の判定のまま */
  area_path?: string | null;
  /** 条件を外して検索した（例: 駅が選べず駅なしで検索） */
  fallback?: string | null;
  /** 2026-09-27 v2.5.31: クリックの列の1件ごとの時刻（t＝入力を始めてからの ms・p＝予定の間・w＝実際の間） */
  ops?: Array<{ t: number; k: string; p: number; w: number }> | null;
  late_max?: number | null;
  late_over_1s?: number | null;
  /** 2026-09-27 v2.5.31: 見張り（85秒）で止まった時の様子（どの段で・列の残り・タブが見えていたか・タイマーの遅れ） */
  stall?: {
    stage?: string | null; stage_detail?: string | null; since_stage_ms?: number | null; elapsed_ms?: number | null;
    visibility?: string | null; has_focus?: boolean | null; hidden_ms?: number | null;
    queue_len?: number | null; queue_busy?: boolean | null; queue_next?: string | null; ops_done?: number | null;
    late_max?: number | null; late_over_1s?: number | null; modal_open?: boolean | null; city_checked?: number | null;
    form?: FormReadback | null; error?: string | null;
  } | null;
};

export type AuditResult = {
  property_count?: number | null;
  pages?: number | null;
  read_rows?: number | null;
  sendable_rows?: number | null;
  sent_count?: number | null;
  zero_reason?: string | null;
  count_text?: string | null;
  count_number?: number | null;
  url?: string | null;
  batch_timed_out?: boolean | null;
  fill_timed_out?: boolean | null;
  /** 2026-09-29 v2.5.41 ページの上限（max_pages）で打ち切った時のページ数（bulk-dl tryNext）。無ければ最後まで見た */
  page_limit?: number | null;
  /** 2026-09-29 v2.5.41 一覧の行の更新日の経過（リアプロの「309 4日前」・bulk-dl が読んだ行だけ） */
  update_ages?: UpdateAges | null;
  /** 2026-09-29 v2.5.41 そのお客様に送付済みの部屋として選ばなかった（ダウンロードしなかった）行の数 */
  sent_skipped?: number | null;
  /** 2026-09-30 v2.5.42 一覧で実際にチェックが入っていた部屋（建物名 n・号室 r・150件まで） */
  picked_rooms?: Array<{ n?: string | null; r?: string | null }> | null;
  /** 2026-09-30 v2.5.42 ITANDI の1回の物件数の上限で打ち切った（上限の数） */
  row_limit?: number | null;
  /** 2026-09-30 v2.5.42 ITANDI の条件が効いていない形の見分け（itandi-guard.js・background の入れ直しの記録） */
  guard?: ItandiGuardRecord | null;
  /** 2026-09-30 v2.5.42 見分けで止めたまま（資料をダウンロードしていない） */
  guard_stopped?: boolean | null;
  /** 2026-09-30 v2.5.42 サーバーが数えた「送付済みの部屋を選んだ・ダウンロードした」数（recordFinished が足す） */
  sent_selected?: number | null;
};

export type ItandiGuardRecord = {
  suspect?: boolean;
  reasons?: string[];
  judged?: number | null;
  outside?: { rent?: number; layout?: number; area?: number; any?: number } | null;
  count?: number | null;
  count_text?: string | null;
  samples?: string[];
  attempt?: number;
  first?: { reasons?: string[]; judged?: number | null; outside?: Record<string, number> | null; count?: number | null; count_text?: string | null; samples?: string[] } | null;
  /** 1回目の読み戻し（入れ直すと上書きされるので控えた物） */
  first_fill?: Filled | null;
  retry?: { tried?: boolean; fixed?: boolean; reasons?: string[]; judged?: number | null; outside?: Record<string, number> | null; count?: number | null; gap_ms?: number | null } | null;
};

export type AuditStep = { at?: number | string | null; k: string; d?: string | null };

export type AuditInput = {
  site?: string | null;
  status?: string | null;
  trigger?: string | null;
  is_wide?: boolean | null;
  area_mode?: string | null;
  customer_snapshot?: CustomerSnapshot | null;
  intended?: Intended | null;
  filled?: Filled | null;
  steps?: AuditStep[] | null;
  result?: AuditResult | null;
  error?: string | null;
  error_kind?: string | null;
  /** 検索を始めた時刻（更新日の決まりを当てる基準）。無ければ now */
  created_at?: string | null;
  /**
   * 2026-09-29 v2.5.41 その回の命令の payload（source・mode・rp_update_days・update_days_plan）。
   *   更新日の「決まり」は出どころで違う（午後の便＝1・web_brain／午前の便＝サーバーが積んだ値・計画があれば計画）。無ければお客様の写しから
   */
  command_payload?: Record<string, unknown> | null;
  /** 2026-09-29 v2.5.41 前回の検索（同じお客様×サイトで、この回より前に最後まで終わった回）の時刻。分からなければ null */
  last_search_at?: string | null;
  /** 2026-09-29 v2.5.41 その回のお客様の id（payload の計画を引く） */
  customer_id?: string | null;
  /**
   * 2026-09-30 v2.5.42 そのお客様にこの回より前に送付済みの部屋（sent_properties・/api/automation/sent-rooms と同じ出所）。
   *   無い（読めない）時は SENT_SELECTED を見ない
   */
  sent_rooms?: Array<{ name: string; room: string }> | null;
  /** 2026-09-30 v2.5.42 この回でダウンロードした部屋（property_candidate_pools＝資料を取りに行った候補） */
  downloaded_rooms?: Array<{ name: string | null; room: string | null }> | null;
};

export type AuditVerdict = {
  checks: AuditCheck[];
  severity: AuditSeverity;
  /** 一番重い札の原因の鍵（無ければ null） */
  cause_key: string | null;
  /** 数える原因の鍵（重複なし・最大10） */
  cause_keys: string[];
  /** 0件だったか（DeepSeek に回すかの判断に使う） */
  zero: boolean;
};

const SEV_RANK: Record<AuditSeverity, number> = { ok: 0, warn: 1, bad: 2 };

/** 札の優先順（同じ重さなら先の物が cause_key になる） */
const CODE_ORDER: string[] = [
  "STALLED", "ERROR_", "UI_NOT_FOUND", "STATION_MISSING", "ROUTE_MISSING", "AREA_UNRESOLVED", "LOCATION_MODE",
  "CONDITION_STALE", "RENT_MISMATCH", "FLOOR_PLAN_DROPPED", "CONDITION_DRIFT", "UPDATE_DAYS", "CONDITION_MISREAD", "RESET_FAILED", "ZERO_UNCONFIRMED",
  "SENT_LT_READ", "ZERO_CONFIRMED", "ITANDI_GUARD", "SENT_SELECTED",
];

function codeRank(code: string): number {
  const i = CODE_ORDER.findIndex((c) => (c.endsWith("_") ? code.startsWith(c) : code === c));
  return i < 0 ? CODE_ORDER.length : i;
}

export function normalizeSite(s: string | null | undefined): AuditSite | null {
  const v = String(s ?? "").toLowerCase();
  if (v === "realpro" || v === "realnetpro" || v === "リアプロ") return "realpro";
  if (v === "itandi") return "itandi";
  if (v === "reins" || v === "レインズ") return "reins";
  return null;
}

/** 原因の鍵の1部分（: を含めない・空白を詰める・40字まで） */
export function keyPart(s: string | null | undefined): string {
  const t = String(s ?? "").normalize("NFKC").replace(/[:\s]+/g, "").slice(0, 40);
  return t || "-";
}

/** 駅名の比べ方（NFKC・空白・末尾の「駅」・括弧の中を外す） */
export function normStation(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFKC").replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, "").replace(/駅$/, "");
}

function sameStation(a: string, b: string): boolean {
  const x = normStation(a), y = normStation(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 表記ゆれ（JR 付き・「前」の有無など）は1〜2字の差まで同じと見る
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 2 && l.includes(s) && l.length - s.length <= 2;
}

/** 金額の生の値 → 万円（"80000"・"8万円"・8・80000 のどれでも）。読めなければ null。-1・空は null */
export function parseMan(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw > 1000 ? raw / 10000 : raw;
  }
  const s = String(raw).normalize("NFKC").replace(/,/g, "").trim();
  if (!s || s === "-1") return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/万/.test(s)) return n;
  return n > 1000 ? n / 10000 : n;
}

function parseIntLoose(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  const s = String(raw).normalize("NFKC").trim();
  if (!s || s === "-1") return null;
  const m = s.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return n > 0 ? n : null;
}

/** 更新日の欄の文字 → 日数（itandi 用: "0" は当日＝0 のまま・""／「なし」は null）。数字が無ければ null */
function parseDaysKeepZero(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : null;
  const s = String(raw).normalize("NFKC").replace(/\s+/g, "");
  if (!s || s === "-1" || /なし/.test(s)) return null;
  const m = s.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 間取りの文字 → 間取りの札（1K・1LDK…）。「ワンルーム」は 1R、「5K以上」は 5K_OVER */
export function planTokens(text: string | null | undefined): string[] {
  const s = String(text ?? "").normalize("NFKC").toUpperCase();
  const out: string[] = [];
  if (/ワンルーム/.test(s)) out.push("1R");
  if (/5K以上|5K_OVER/.test(s)) out.push("5K_OVER");
  const re = /(\d)\s*(SLDK|LDK|SDK|SK|DK|K|R)(?![A-Z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const t = `${m[1]}${m[2]}`;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function normPlanLabel(s: string): string {
  const t = s.normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  if (/ワンルーム/.test(t)) return "1R";
  if (/5K以上/.test(t)) return "5K_OVER";
  return t;
}

function uniq<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }
function arr<T>(x: T[] | null | undefined): T[] { return Array.isArray(x) ? x : []; }

function hasAnyArea(i: Intended | null | undefined): boolean {
  if (!i) return false;
  return arr(i.station_names).length > 0 || arr(i.route_ids).length > 0 || arr(i.city_codes).length > 0 ||
    arr(i.itandi_lines).length > 0 || arr(i.ward_names).length > 0 || !!i.ward_name || !!i.detail_ward ||
    arr(i.reins_station_pairs).length > 0 || !!i.reins_line;
}

/** 失敗の文 → 種類（error_kind が無い時の推定） */
export function classifyError(error: string | null | undefined): string | null {
  const e = String(error ?? "").trim();
  if (!e) return null;
  if (/__BATCH_STOPPED__|ストップ/.test(e)) return "stopped";
  // 2026-09-29 v2.5.40 拡張の見張り（1回の検索の上限・snapshot-core PASS_DEADLINE_MS）で閉じて次のお客様へ進んだ回
  if (/見張りの時間切れ|__PASS_DEADLINE__/.test(e)) return "pass_deadline";
  if (/watchdog/i.test(e)) return "watchdog";
  if (/fill-done|検索完了シグナル/.test(e)) return "fill_timeout";
  if (/全ページ送信完了|5分/.test(e)) return "batch_timeout";
  if (/エリア条件を解決できません|所在地または路線・駅の情報がありません/.test(e)) return "no_area";
  // 2026-09-25 本番の通し確認で見つけた: 未ログインの文（background.js「リアプロのセッションが見つかりません。リアプロにログインしてください。」
  //   「リアプロが未ログインです（main.php 以外へリダイレクト）…」）が「見つかりません」で ui（画面の部品が見つからない）や exception に落ちていた。
  //   直し方がまるで違う（ログインし直すだけ）ので ui より先に分ける。「ログインしているか確認してください」は他の原因もあるヒントなので入れない
  if (/未ログイン|ログインしてください|ログインしてから|セッションが見つかりません/.test(e)) return "not_logged_in";
  if (/見つかりません|ボタンが見つか|not found/i.test(e)) return "ui";
  if (/duplicate/i.test(e)) return "duplicate";
  if (/顧客データ取得失敗|HTTP \d|fetch/i.test(e)) return "network";
  return "exception";
}

function stepSummary(steps: AuditStep[] | null | undefined): string {
  const s = arr(steps);
  return s.length ? s[s.length - 1].k : "none";
}

/** 写しの日時が伏せ字になっている（v2.5.40 までの拡張の maskDigits が「2026-09-26T…」を電話番号の形として伏せた） */
function maskedDate(v: unknown): boolean {
  return typeof v === "string" && /＊/.test(v);
}

/**
 * 2026-09-29 v2.5.41 その回の更新日の「決まり」（出どころごと）。known=false は決まりが分からない（言わない）。
 *   ①命令の計画（payload.update_days_plan・前回の検索から空いた日数で広げた値）②午後の便＝1（PM_LATEST）
 *   ③サーバーが積んだ値（web_brain・午前の便の payload.rp_update_days）④お客様の写しから rp-update-days（手の一括・個別の検索）
 *   写しの日時が伏せ字の古い行は④が読めない → 分からない
 */
export function expectedUpdateDays(a: Pick<AuditInput, "command_payload" | "customer_snapshot" | "created_at" | "customer_id">, nowMs: number = Date.now()): { known: boolean; days: number | null; from: string } {
  const p = a.command_payload ?? null;
  const plan = planFor(p, a.customer_id ?? null);
  if (plan) return { known: true, days: plan.days ?? null, from: plan.widened ? "前回の検索から空いた日数で広げた計画" : "計画" };
  const src = typeof p?.source === "string" ? p.source : null;
  if (src === "auto_schedule" && p?.mode === "pm") return { known: true, days: 1, from: "午後の便（本日の更新日付）" };
  if ((src === "web_brain" || src === "auto_schedule") && p && "rp_update_days" in p) {
    const v = p.rp_update_days;
    return { known: true, days: typeof v === "number" && v > 0 ? v : null, from: src === "web_brain" ? "AIXツールの一括検索が積んだ値" : "午前の便が積んだ値" };
  }
  const c = a.customer_snapshot ?? null;
  if (!c) return { known: false, days: null, from: "写しなし" };
  const manual = typeof c.rp_update_days === "number" && c.rp_update_days > 0 ? c.rp_update_days : null;
  if (manual == null && (maskedDate(c.last_property_sent_at) || maskedDate(c.property_viewed_at))) return { known: false, days: null, from: "写しの日時が伏せ字（v2.5.40 まで）" };
  const base = a.created_at ? Date.parse(a.created_at) : nowMs;
  return { known: true, days: effectiveRpUpdateDays(c, Number.isFinite(base) ? base : nowMs), from: manual != null ? "手で決めた値" : "前回物件を出した日から" };
}

/**
 * 1回の検索を点検する（純関数）。札の一覧・重さ・原因の鍵を返す。
 */
export function runSearchAuditChecks(a: AuditInput, nowMs: number = Date.now()): AuditVerdict {
  const site = normalizeSite(a.site) ?? "realpro";
  const siteKey = normalizeSite(a.site) ?? keyPart(a.site);
  const checks: AuditCheck[] = [];
  const add = (code: CheckCode, severity: AuditSeverity, key: string, title: string, detail: string) =>
    checks.push({ code, severity, cause_key: key, title, detail: detail.slice(0, 300) });
  const i = a.intended ?? null;
  const f = a.filled ?? null;
  const form = f?.form ?? null;
  const c = a.customer_snapshot ?? null;
  const r = a.result ?? null;

  // ── 止まった・失敗した ──
  if (a.status === "abandoned") {
    const last = stepSummary(a.steps);
    add("STALLED", "bad", `stalled:${siteKey}:${keyPart(last)}`, "検索が最後まで終わらなかった", `20分たっても終わりの合図が無い（最後の段: ${last}）`);
  }
  const kind = a.error_kind || classifyError(a.error);
  if (kind === "stopped") {
    // スタッフが止めた＝問題ではない（札は付けない）
  } else if (kind) {
    const code = kind === "ui" ? "UI_NOT_FOUND" : (`ERROR_${kind.toUpperCase()}` as CheckCode);
    const title = kind === "watchdog" ? "条件を入れ終わる前に時間切れ"
      : kind === "fill_timeout" ? "検索の完了の合図が届かなかった"
      : kind === "batch_timeout" ? "結果を読み終わる合図が5分届かなかった"
      : kind === "no_area" ? "場所の条件が作れず検索をやめた"
      : kind === "ui" ? "画面の部品が見つからなかった"
      : kind === "network" ? "サーバーとのやり取りに失敗"
      : kind === "not_logged_in" ? "サイトにログインしていなかった"
      : kind === "pass_deadline" ? "1回の検索が上限の時間を過ぎた（見張りで次のお客様へ）"
      : "検索中の失敗";
    add(code, "bad", `${kind === "ui" ? "ui_not_found" : "error"}:${siteKey}:${keyPart(kind === "ui" ? a.error : kind)}`, title, String(a.error ?? kind));
  }

  // ── 画面の部品（検索ボタン・モーダルのボタン）──
  for (const cf of arr(f?.click_fails).slice(0, 5)) {
    add("UI_NOT_FOUND", "bad", `ui_not_found:${siteKey}:${keyPart(cf.what)}:${keyPart(cf.text)}`,
      `「${cf.text ?? cf.what}」が押せなかった`, `${cf.what}${cf.sample?.length ? `（見えていた物: ${cf.sample.slice(0, 6).join("・")}）` : ""}`);
  }
  if (f && f.search_clicked === false && !arr(f.click_fails).some((x) => /search|検索/.test(`${x.what}${x.text ?? ""}`))) {
    add("UI_NOT_FOUND", "bad", `ui_not_found:${siteKey}:search:検索`, "検索ボタンが押せなかった", "検索ボタンを押せずに終わった");
  }

  // ── 駅 ──
  const intendedStations = uniq(arr(i?.station_names).map((s) => String(s)).filter(Boolean));
  const missing: MissingItem[] = [];
  for (const m of arr(f?.stations_missing)) if (m && m.name && !missing.some((x) => sameStation(x.name, m.name))) missing.push(m);
  const okNames = arr(f?.stations_ok);
  const formStations = form?.stations;
  const stationMode = !(i?.area_mode === "ward");
  if (stationMode && Array.isArray(formStations) && formStations.length > 0 && intendedStations.length > 0 && intendedStations.length <= 40) {
    for (const s of intendedStations) {
      const inForm = formStations.some((x) => sameStation(x, s)) || okNames.some((x) => sameStation(x, s));
      if (!inForm && !missing.some((x) => sameStation(x.name, s))) missing.push({ name: s, line: null });
    }
  }
  for (const m of missing.slice(0, 8)) {
    add("STATION_MISSING", "bad", `station_missing:${siteKey}:${keyPart(m.line)}:${keyPart(normStation(m.name))}`,
      `${normStation(m.name)}が入っていない`,
      `${m.line ? `路線「${m.line}」で` : ""}駅「${m.name}」のボタンが見つからない${m.label_count != null ? `（ラベル${m.label_count}個` : ""}${m.sample?.length ? `・例: ${m.sample.slice(0, 6).join("・")}` : ""}${m.label_count != null ? "）" : ""}`);
  }

  // ── 路線 ──
  for (const m of arr(f?.lines_missing).slice(0, 5)) {
    add("ROUTE_MISSING", "bad", `route_missing:${siteKey}:${keyPart(m.name)}`, `路線「${m.name}」が選べなかった`,
      `路線のボタンが見つからない${m.label_count != null ? `（ラベル${m.label_count}個` : ""}${m.sample?.length ? `・例: ${m.sample.slice(0, 6).join("・")}` : ""}${m.label_count != null ? "）" : ""}`);
  }

  // ── 場所が作れていない ──
  for (const t of arr(i?.unknown_tokens).slice(0, 5)) {
    add("AREA_UNRESOLVED", "warn", `area_unresolved:${siteKey}:${keyPart(t)}`, `「${t}」を場所に直せなかった`, "地名・駅名の表に無い言葉（検索の条件から落ちた）");
  }
  if (i && c?.desired_area && String(c.desired_area).trim() && !hasAnyArea(i) && kind !== "no_area") {
    add("AREA_UNRESOLVED", "bad", `area_unresolved:${siteKey}:all`, "場所の条件が1つも入っていない", `希望エリア「${String(c.desired_area).slice(0, 60)}」から駅・路線・市区が作れなかった`);
  }

  // ── 通勤の到達時間で選んだ駅（2026-09-29 v2.5.39）──
  //   拡張が「梅田まで30分」等から目的の駅に N 分以内で着く駅を入れた回は info で残す（駅名は載せず数だけ）。
  //   通勤の条件（列に分がある・希望エリアに「◯◯まで◯分」）があるのに intended.commute が無く駅が少ない回は warn（古い拡張・読めなかった）
  const cm = i?.commute ?? null;
  const commuteText = String(c?.desired_area ?? "").normalize("NFKC");
  const hasCommuteWant = (!!c?.commute_station && typeof c?.commute_minutes === "number" && c.commute_minutes > 0)
    || /(?:まで|から|へ|に)\s*(?:は)?\s*(?:電車|地下鉄|JR)?\s*(?:で)?\s*(?:約)?\d{1,3}\s*分/.test(commuteText) || /通勤\s*\d{1,3}\s*分/.test(commuteText);
  if (cm && Array.isArray(cm.targets) && cm.targets.length) {
    const tg = cm.targets.map((t) => `${t.target ?? "?"}まで${t.minutes ?? "?"}分`).join("・");
    const key0 = `${keyPart(cm.targets[0]?.target)}:${cm.targets[0]?.minutes ?? "-"}`;
    if (cm.skipped) {
      add("COMMUTE_REACH", "ok", `commute_reach:${siteKey}:skipped:${keyPart(cm.skipped)}`, `通勤の条件（${tg}）はあるが駅は広げなかった`,
        cm.skipped === "concrete_area" ? "希望エリアが具体的な駅・地名なので、その場所で検索した（通勤の列だけの時の決まり）" : String(cm.skipped));
    } else {
      add("COMMUTE_REACH", "ok", `commute_reach:${siteKey}:${key0}`, `通勤の到達時間で駅を選んだ（${tg}・${cm.stations ?? "?"}駅・${cm.lines ?? "?"}路線）`,
        `乗り換え${cm.transfers ?? 1}回まで${cm.capped ? `・${cm.total ?? "?"}駅を上限で切った（所要の短い順）` : ""}`);
    }
  } else if (hasCommuteWant && stationMode && intendedStations.length > 0 && intendedStations.length < 10 && !i?.select_all_line_stations) {
    add("COMMUTE_REACH", "warn", `commute_reach:${siteKey}:not_expanded`, "通勤の条件があるのに到達時間で駅を選んでいない",
      `駅 ${intendedStations.length} 件だけ（通勤=${c?.commute_station ?? "-"}:${c?.commute_minutes ?? "-"}・希望エリア「${commuteText.slice(0, 40)}」）。拡張が v2.5.39 より前か、目的の駅が路線図に無い`);
  }

  // ── 場所の入れ方（駅か地域か）──
  const want = c?.area_mode === "station" || c?.area_mode === "ward" ? c.area_mode : null;
  const used = i?.area_mode === "station" || i?.area_mode === "ward" ? i.area_mode : null;
  if (want && used && want !== used) {
    add("LOCATION_MODE", "warn", `location_mode:${siteKey}:${want}→${used}`, want === "station" ? "駅で探すお客様を地域で検索した" : "地域で探すお客様を駅で検索した",
      `お客様の設定=${want}・入れた=${used}`);
  }
  if (f?.area_path === "none" && hasAnyArea(i)) {
    add("LOCATION_MODE", "bad", `location_mode:${siteKey}:none`, "場所の条件なしで検索した", "駅・路線・市区のどれも入らないまま検索（全件検索のおそれ）");
  }
  if (f?.fallback) {
    add("LOCATION_MODE", "bad", `location_mode:${siteKey}:fallback`, "条件を外して検索した", String(f.fallback));
  }

  // ── 賃料 ──
  const iRent = parseMan(i?.rent_max);
  if (form && "rent_max" in form && iRent != null) {
    const fRent = parseMan(form.rent_max);
    if (fRent == null) {
      add("RENT_MISMATCH", "bad", `rent_mismatch:${siteKey}:not_filled`, "賃料の上限が入っていない", `入れようとした=${iRent}万・入った=なし`);
    } else if (fRent < iRent - 0.05) {
      add("RENT_MISMATCH", "bad", `rent_mismatch:${siteKey}:lower`, "賃料の上限が狭い", `入れようとした=${iRent}万・入った=${fRent}万`);
    } else if (fRent > iRent + Math.max(1, iRent * 0.15)) {
      add("RENT_MISMATCH", "warn", `rent_mismatch:${siteKey}:higher`, "賃料の上限が広すぎる", `入れようとした=${iRent}万・入った=${fRent}万`);
    }
  }

  // ── 間取り ──
  const iPlans = planTokens(i?.floor_plan);
  const fLayouts = form?.layouts;
  if (iPlans.length && Array.isArray(fLayouts) && site !== "reins") {
    const got = fLayouts.map(normPlanLabel);
    if (!got.length) {
      add("FLOOR_PLAN_DROPPED", "bad", `floor_plan_dropped:${siteKey}:all`, "間取りが1つも入っていない", `入れようとした=${i?.floor_plan}`);
    } else if (got.some((g) => /^\d(SLDK|LDK|SDK|SK|DK|K|R)$|5K_OVER/.test(g))) {
      // 読み戻しが間取りの形（1LDK 等）で読めた時だけ比べる（ラベルの作りが違って読めない時に誤った札を付けない）
      // SLDK は itandi に無く別の間取りに置き換える決まり（page-script）なので比べない
      const miss = iPlans.filter((p) => !/SLDK$/.test(p) && !got.includes(p));
      if (miss.length) add("FLOOR_PLAN_DROPPED", "warn", `floor_plan_dropped:${siteKey}:${keyPart(miss[0])}`, `間取り「${miss.join("・")}」が入っていない`, `入れようとした=${i?.floor_plan}・入った=${got.join("・")}`);
    }
  }

  // ── 更新日（リアプロ: select[name=update_date]／itandi: 「募集条件更新 N日以内」の欄・v2.5.34 から）──
  //   itandi の欄は「0」（当日）と「なし」（空）が別の値 → 0 を残す読み方。リアプロは今までどおり（先頭の選択肢の値を 0 と読まない）
  const udStatus = site === "itandi" ? (f?.update_days?.status ?? null) : null;
  if (site === "itandi" && udStatus === "field_missing") {
    const want = i?.rp_update_days != null ? parseDaysKeepZero(i.rp_update_days) : null;
    add("UI_NOT_FOUND", "warn", `ui_not_found:${siteKey}:update_days:募集条件更新`, "募集条件更新（N日以内）の欄が見つからない",
      `入れようとした=${want ?? "指定なし"}日・更新日で絞らずに検索した${f?.update_days?.name ? `（名前だけで見つけた候補=${f.update_days.name}・打っていない）` : ""}`);
  }
  if ((site === "realpro" || site === "itandi") && form && "update_days" in form) {
    const parseDays = site === "itandi" ? parseDaysKeepZero : parseIntLoose;
    const intendedDays = i?.rp_update_days != null ? parseDays(i.rp_update_days) : null;
    const filledDays = parseDays(form.update_days);
    if (site === "itandi" && udStatus === "out_of_range" && intendedDays != null && filledDays == null) {
      // 一覧（なし/0〜9）に無い日数（14 等）は打たずに「なし」（広い側・漏れない）で検索した＝決まりどおり → ok の札で残すだけ。
      //   9 に丸めると狭くなり物件が漏れるので丸めない（v2.5.34 反証の検証）
      add("UPDATE_DAYS", "ok", `update_days:${siteKey}:out_of_range`, `更新日（${intendedDays}日以内）は ITANDI の選択肢に無いので指定なしで検索した`, `入れようとした=${intendedDays}日・入った=指定なし（広い側）`);
    } else if (site === "itandi" && udStatus === "set_typed" && intendedDays != null && filledDays === intendedDays) {
      // 一覧から選べず、打った文字が欄に見えているだけ（値として確定したかは画面の文字では分からない）→ 作りを確かめるまで warn
      add("UPDATE_DAYS", "warn", `update_days:${siteKey}:typed_unverified`, `更新日（${intendedDays}日以内）は打っただけで、検索に効いたか確かめられていない`, `欄に見えている文字=${filledDays}・一覧の選択肢から選べなかった`);
    } else if (intendedDays != null && filledDays !== intendedDays) {
      if (udStatus === "not_accepted") {
        add("UPDATE_DAYS", "warn", `update_days:${siteKey}:not_accepted`, `更新日（${intendedDays}日以内）を欄が受け付けず、指定なしで検索した`, `入れようとした=${intendedDays}日・入った=${filledDays ?? "指定なし"}（itandi の選択肢は なし/0〜9）`);
      } else {
        add("UPDATE_DAYS", "bad", `update_days:${siteKey}:not_filled`, "更新日が入っていない", `入れようとした=${intendedDays}日・入った=${filledDays ?? "指定なし"}`);
      }
    } else if (intendedDays == null && filledDays != null) {
      add("UPDATE_DAYS", "bad", `update_days:${siteKey}:leftover`, "前の更新日が残っていた", `入れようとした=指定なし・入った=${filledDays}日`);
    }
    // 2026-09-29 v2.5.41: 「決まり」を出どころごとに（9/22〜の warn 90件のうち differs 90件は、決まりの側が誤っていた）:
    //   ①拡張の search-audit.js maskDigits が写しの日時「2026-09-26T02:50…」を電話番号の形として「＊＊＊T02:50…」に伏せていた
    //     → 前回物件を出した日が読めず、決まりは毎回「指定なし」になっていた（写しの日時は v2.5.41 から伏せない・古い行は決まりが分からない＝言わない）
    //   ②午後の便（全員 1）・web_brain（サーバーが積んだ値）・計画（前回の検索から空いた日数で広げた値）を知らなかった
    const expected = expectedUpdateDays(a, nowMs);
    if (expected.known && expected.days !== intendedDays) {
      add("UPDATE_DAYS", "warn", `update_days:${siteKey}:differs`, "更新日が決まりと違う", `決まり=${expected.days ?? "指定なし"}（${expected.from}）・入れた=${intendedDays ?? "指定なし"}（一時調整なら問題なし）`);
    }
    // 前回の検索から空いた時間を、実際に入った日数（読み戻しが無ければ入れようとした日数）で覆えているか
    const usedDays = udStatus === "out_of_range" ? null : (form.update_days != null ? filledDays : intendedDays);
    const startMs = a.created_at ? Date.parse(a.created_at) : nowMs;
    const gapH = hoursSince(a.last_search_at ?? null, Number.isFinite(startMs) ? startMs : nowMs);
    if (gapH != null && !coversGap(usedDays, gapH)) {
      add("UPDATE_DAYS", "warn", `update_days:${siteKey}:gap_uncovered`, `更新日（${usedDays}日以内）では前回の検索から空いた分を覆えていない`,
        `前回の検索=${String(a.last_search_at).slice(0, 16).replace("T", " ")}（${fmtGap(gapH)}前）・要る日数=${neededDays(gapH)}日・入った=${usedDays}日（間に更新された物件が漏れるおそれ）`);
    }
  }
  // ── 更新日の中の物件を最後まで見たか（C3）・一覧の更新日が指定の中か（C2）──
  if (site === "realpro" || site === "itandi") {
    const daysUsed = i?.rp_update_days != null ? parseIntLoose(i.rp_update_days) : null;
    if (r?.page_limit && daysUsed != null) {
      add("UPDATE_DAYS", "warn", `update_days:${siteKey}:cut_by_pages`, `更新日（${daysUsed}日以内）の物件を${r.page_limit}ページで打ち切った`,
        `ページの上限（${r.page_limit}ページ）で次のページを見ていない${r.count_number != null ? `（件数 ${r.count_number}・読んだ ${r.read_rows ?? "?"}行）` : ""}${r.page_limit < SEARCH_MAX_PAGES && !(a.command_payload && (a.command_payload as { max_pages?: unknown }).max_pages) ? `・上限が今の${SEARCH_MAX_PAGES}ページより少ない（v2.5.41 以前の拡張）` : ""}`);
    }
    // 2026-09-30 v2.5.42 ITANDI の1回の物件数の上限（itandi-guard.js MAX_ROWS）で打ち切った（C3・見張りの ⚠ の1行にも）
    if (r?.row_limit) {
      add("UPDATE_DAYS", "warn", `update_days:${siteKey}:cut_by_rows`, `1回の物件数の上限（${r.row_limit}件）で打ち切った`,
        `上限の${r.row_limit}件を選んだ所で次のページを見ていない（読んだ ${r.read_rows ?? "?"}行）`);
    }
    const out = agesOutside(daysUsed, r?.update_ages ?? null);
    if (out?.bad) {
      add("UPDATE_DAYS", "warn", `update_days:${siteKey}:rows_outside`, `一覧に更新日（${daysUsed}日以内）より古い物件が混ざっている`,
        `${out.outside}/${out.total}行が${daysUsed}日より前の更新（最大 ${r?.update_ages?.max_days != null ? Math.floor(r.update_ages.max_days) : "?"}日前）＝更新日の絞りが効いていないおそれ`);
    }
  }

  // ── 登録の条件と入った値の食い違い（2026-09-27 v2.5.31・search-condition-drift.ts）──
  //   点検 22（古い条件で検索した回）は「区の混ざり・間取りの欠け・築年・家賃」がずれていたのに、家賃しか言わなかった。
  //   入った値（読み戻し・無い欄は入れようとした値）を登録の条件と比べる。3項目以上ずれたら「古い条件で検索したおそれ」
  //   同じずれを2回言わない:
  //   ・家賃・間取りで「入れようとした値は登録どおり・画面だけ違う」＝入力の失敗は RENT_MISMATCH／FLOOR_PLAN_DROPPED が言う → ここでは言わない
  //   ・家賃が低いのを入れようとした値でしか比べられない時は、下の CONDITION_MISREAD（rent_lower）が言う
  const driftIn = { site, is_wide: a.is_wide ?? i?.is_wide ?? null, customer: c as Record<string, unknown> | null, intended: i as Record<string, unknown> | null };
  const driftAll = c ? conditionDrift({ ...driftIn, form: form as Record<string, unknown> | null }).items : [];
  const driftIntended = c && form ? conditionDrift({ ...driftIn, form: null }).items : driftAll;
  const driftItems = driftAll.filter((d) => {
    if (d.field === "rent" && d.source === "intended" && d.kind === "lower") return false;
    if ((d.field === "rent" || d.field === "floor_plan") && d.source === "form" && !driftIntended.some((x) => x.field === d.field)) return false;
    return true;
  });
  const driftFields = new Set(driftItems.map((x) => x.field));
  if (driftFields.size >= 3) {
    add("CONDITION_STALE", "bad", `condition_stale:${siteKey}`, `登録の条件と${driftFields.size}項目ちがう（古い条件で検索したおそれ）`,
      driftItems.map((x) => x.title).join("／"));
  }
  // 更新日は drift に入れない（v2.5.34 反証: 自動便の 1日 ↔ 手で決めた 7 で毎回 bad・古い条件の数にも入った・リアプロにも効いた）。
  //   更新日は上の UPDATE_DAYS（入れようとした値↔入った値・決まりとの違い differs）だけが言う
  for (const d of driftItems) {
    add("CONDITION_DRIFT", d.severity, `condition_drift:${siteKey}:${d.field}:${d.kind}`, d.title, `${d.detail}${d.source === "intended" ? "（読み戻しが無いので入れようとした値）" : ""}`);
  }
  const driftRent = driftItems.some((x) => x.field === "rent");

  // ── お客様の条件を読み落としていないか ──
  if (c && i) {
    const cRent = parseMan(c.rent_max ?? c.max_rent);
    if (cRent != null && iRent == null) add("CONDITION_MISREAD", "warn", `condition_misread:${siteKey}:rent_max`, "賃料の条件が検索に入っていない", `お客様=${cRent}万`);
    else if (!driftRent && cRent != null && iRent != null && iRent < cRent * 0.98) add("CONDITION_MISREAD", "warn", `condition_misread:${siteKey}:rent_lower`, "賃料がお客様の上限より低い", `お客様=${cRent}万・検索=${iRent}万`);
    const cPlans = planTokens(c.floor_plan || c.layout);
    if (cPlans.length && !iPlans.length) add("CONDITION_MISREAD", "warn", `condition_misread:${siteKey}:floor_plan`, "間取りの条件が検索に入っていない", `お客様=${c.floor_plan || c.layout}`);
    if (c.walk_minutes && !i.walk_minutes) add("CONDITION_MISREAD", "warn", `condition_misread:${siteKey}:walk`, "徒歩の条件が検索に入っていない", `お客様=${c.walk_minutes}分`);
    if (c.building_age && !i.building_age) add("CONDITION_MISREAD", "warn", `condition_misread:${siteKey}:age`, "築年数の条件が検索に入っていない", `お客様=${c.building_age}年`);
  }

  // ── 前の条件の消し残り ──
  if (f?.reset_fail) add("RESET_FAILED", "warn", `reset_failed:${siteKey}`, "前の条件を消せなかった", String(f.reset_fail));

  // ── 結果 ──
  let zero = false;
  if (r && !r.batch_timed_out && !kind) {
    const readRows = typeof r.read_rows === "number" ? r.read_rows : null;
    zero = readRows === 0 || (readRows == null && r.property_count === 0 && r.sendable_rows == null);
    if (zero) {
      const confirmed = r.count_number === 0 || r.zero_reason === "count_text_zero";
      if (confirmed) add("ZERO_CONFIRMED", "warn", `zero_confirmed:${siteKey}`, "0件（画面の件数も0）", `件数表示=${r.count_text ?? "?"}`);
      else add("ZERO_UNCONFIRMED", "bad", `zero_unconfirmed:${siteKey}:${keyPart(r.zero_reason || "unknown")}`, "0件（検索できていたか確かめられない）",
        `理由=${r.zero_reason ?? "不明"}・件数表示=${r.count_text ?? "読めない"}`);
    }
    if (typeof r.sendable_rows === "number" && r.sendable_rows > 0 && typeof r.sent_count === "number" && r.sent_count < r.sendable_rows) {
      add("SENT_LT_READ", "warn", `sent_lt_read:${siteKey}`, "送れる物件を全部は送れていない", `送れる=${r.sendable_rows}・送った=${r.sent_count}`);
    }
  }
  if (r?.batch_timed_out && !kind) {
    add("ERROR_BATCH_TIMEOUT", "bad", `error:${siteKey}:batch_timeout`, "結果を読み終わる合図が5分届かなかった", "0件とは限らない（読み取り・送信が途中で止まった）");
  }

  // ── 2026-09-30 v2.5.42 送付済みの部屋を選んだ・ダウンロードした（見張り・sent-skip の結果の確かめ）──
  const sel = sentSelectedOf(a);
  if (sel && sel.count > 0) {
    add("SENT_SELECTED", "warn", `sent_selected:${siteKey}`, `送付済みの部屋を${sel.count}件選んだ・ダウンロードした`,
      `${sel.names.slice(0, 4).join("・")}（一覧でチェック ${sel.picked}・資料 ${sel.downloaded}・送付済みの部屋 ${sel.sentRooms}件と照らした）`);
  } else if (sel && typeof r?.sent_skipped === "number" && r.sent_skipped > 0) {
    add("SENT_SELECTED", "ok", `sent_selected:${siteKey}:none`, `送付済みの部屋 ${r.sent_skipped}件は選ばなかった`, `選んだ・ダウンロードした部屋に送付済みは無い（照らした送付済み ${sel.sentRooms}件）`);
  }

  // ── 2026-09-30 v2.5.42 ITANDI の条件が効いていない検索（止めた・1回だけ入れ直した）。原因を 拡張側／ITANDI 側／判断つかず に分ける ──
  const g = r?.guard ?? null;
  if (g && (g.suspect || g.first)) {
    const gc = itandiGuardCause(a);
    const tried = !!g.retry?.tried;
    const fixed = tried && !!g.retry?.fixed;
    const outcome = !tried ? "no_retry" : fixed ? "fixed" : "unfixed";
    const why = (g.first?.reasons ?? g.reasons ?? []).map((x) => GUARD_REASON_JA[x] ?? x).join("・") || "条件の外の物件が多い";
    add("ITANDI_GUARD", fixed ? "warn" : "bad", `itandi_guard:${siteKey}:${gc.cause}:${outcome}`,
      `条件が効いていない検索（${GUARD_CAUSE_JA[gc.cause]}・${fixed ? "入れ直しで直った" : tried ? "入れ直しても直らず見送り" : "入れ直していない"}）`,
      `${why}${g.first?.count != null ? `・件数 ${g.first.count}` : ""}${g.first?.judged != null ? `・行 ${g.first.judged}のうち外 ${g.first?.outside?.any ?? "?"}` : ""}／根拠: ${gc.evidence.join("・")}`);
  }

  checks.sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity] || codeRank(x.code) - codeRank(y.code));
  const severity: AuditSeverity = checks.length ? checks[0].severity : "ok";
  const cause_keys = uniq(checks.map((x) => x.cause_key)).slice(0, 10);
  return { checks, severity, cause_key: checks[0]?.cause_key ?? null, cause_keys, zero };
}

const GUARD_REASON_JA: Record<string, string> = {
  count_over: "件数が 3,000件を超えている", rent_outside: "家賃が上限を超える物件が多い", layout_outside: "希望に無い間取りが多い",
  area_outside: "希望の区の外の物件が多い", rows_outside: "条件の外の物件が多い",
};
export type GuardCause = "ext" | "site" | "unknown";
export const GUARD_CAUSE_JA: Record<GuardCause, string> = { ext: "拡張側（欄に入っていない・押せない）", site: "ITANDI 側（入れた値は合っているのに結果が条件を守っていない）", unknown: "判断つかず（読み戻しが無い）" };

/** 条件の読み戻しの札のうち「拡張が欄に入れられなかった」と読める物（1回目の読み戻しに当てる） */
function extSideEvidence(c: AuditCheck): boolean {
  if (c.severity === "ok") return false;
  // RESET_FAILED は入れない: ITANDI は「条件リセットのボタンが見つからない」が全回（28/28・scripts/audit-itandi-guard.ts 2026-09-30）に付く＝分ける材料にならない
  if (["UI_NOT_FOUND", "STATION_MISSING", "ROUTE_MISSING", "AREA_UNRESOLVED", "LOCATION_MODE", "RENT_MISMATCH", "FLOOR_PLAN_DROPPED", "CONDITION_STALE"].includes(c.code)) return true;
  // 登録の条件とのズレは「欄が入っていない・余分・広い（higher）」だけ（狭い lower は結果が条件の外に出る理由にならない）
  if (c.code === "CONDITION_DRIFT" && c.severity === "bad" && /:(missing|extra|higher|not_filled)$/.test(c.cause_key)) return true;
  if (c.code === "UPDATE_DAYS" && /:(not_filled|leftover)$/.test(c.cause_key)) return true;
  return c.code.startsWith("ERROR_");
}

/**
 * 2026-09-30 v2.5.42 竹内「拡張ツールの部分が問題なのか ITANDI への登録がちゃんと入らなかったのかが原因となるので、その点も併せて確認して」:
 *   ITANDI の条件が効いていない検索の原因を分ける（純関数・学習の材料）。材料は**1回目の**読み戻し（入れ直す前・guard.first_fill）:
 *   ①拡張側（ext）… 読み戻しで欄が入っていない・押せない・前の条件が残った（STATION_MISSING・RENT_MISMATCH・UI_NOT_FOUND 等）
 *   ②ITANDI 側（site）… 読み戻しは入れようとした値どおりなのに、結果が家賃・間取り・区を守っていない（ITANDI の保存条件・サイトの挙動）
 *   ③判断つかず（unknown）… 読み戻しが無い（古い版・直接入力の経路）
 */
export function itandiGuardCause(a: AuditInput): { cause: GuardCause; evidence: string[] } {
  const g = a.result?.guard ?? null;
  const fill = (g?.first_fill ?? null) || a.filled || null;
  if (!fill || (fill.form == null && fill.search_clicked == null && !arr(fill.click_fails).length)) return { cause: "unknown", evidence: ["読み戻しが無い"] };
  const v = runSearchAuditChecks({ ...a, filled: fill, result: { ...(a.result ?? {}), guard: null, guard_stopped: null, picked_rooms: null }, sent_rooms: null, downloaded_rooms: null, error: null, error_kind: null, status: "finished" });
  const ev = v.checks.filter(extSideEvidence);
  if (ev.length) return { cause: "ext", evidence: ev.slice(0, 4).map((c) => c.title) };
  if (fill.search_clicked === false) return { cause: "ext", evidence: ["検索ボタンが押せなかった"] };
  if (fill.form == null) return { cause: "unknown", evidence: ["欄の読み戻しが無い"] };
  return { cause: "site", evidence: ["入れた値は読み戻しで合っている"] };
}

/**
 * 2026-09-30 v2.5.42 送付済みの部屋を選んだ・ダウンロードした数（純関数・sent-room-match の完全一致＝拡張の sent-skip と同じ線）。
 *   送付済みの一覧が無い（読めない）時は null（言わない）
 */
export function sentSelectedOf(a: Pick<AuditInput, "sent_rooms" | "downloaded_rooms" | "result">): { count: number; picked: number; downloaded: number; names: string[]; sentRooms: number } | null {
  if (!a.sent_rooms || !a.sent_rooms.length) return null;
  const idx = buildSentRoomIndex(a.sent_rooms);
  if (!idx.size) return null;
  const keys = new Map<string, string>();
  let picked = 0, downloaded = 0;
  for (const p of arr(a.result?.picked_rooms)) {
    if (p && isSentRoom(idx, p.n ?? null, p.r ?? null)) { picked++; keys.set(`${p.n}|${p.r}`, `${p.n} ${p.r}`); }
  }
  for (const d of arr(a.downloaded_rooms)) {
    if (d && isSentRoom(idx, d.name, d.room)) { downloaded++; keys.set(`${d.name}|${d.room}`, `${d.name} ${d.room}`); }
  }
  return { count: keys.size, picked, downloaded, names: [...keys.values()], sentRooms: idx.size };
}

/**
 * 2026-09-30 v2.5.42 週のまとめ（search-audit-weekly）: ITANDI の条件が効いていない検索を 原因（拡張側／ITANDI 側／判断つかず）×
 *   結果（入れ直しで直った／直らず見送り／入れ直していない）で数える＋送付済みの部屋を選んだ回・物件数の上限で打ち切った回（純関数）。
 *   「どの直し方が効いたか」を学ぶ材料: 直った回の原因の割合・直らなかった回の原因の割合
 */
export function itandiGuardWeekly(rows: ReadonlyArray<{ checks?: AuditCheck[] | null }>): {
  guard: Record<GuardCause, { fixed: number; unfixed: number; no_retry: number }>;
  guardRuns: number; fixRate: number | null; sentSelectedRuns: number; sentSelectedRooms: number; rowCutRuns: number; pageCutRuns: number; lines: string[];
} {
  const guard: Record<GuardCause, { fixed: number; unfixed: number; no_retry: number }> = {
    ext: { fixed: 0, unfixed: 0, no_retry: 0 }, site: { fixed: 0, unfixed: 0, no_retry: 0 }, unknown: { fixed: 0, unfixed: 0, no_retry: 0 },
  };
  let guardRuns = 0, sentSelectedRuns = 0, sentSelectedRooms = 0, rowCutRuns = 0, pageCutRuns = 0;
  for (const r of rows) {
    const cs = arr(r.checks);
    const g = cs.find((c) => c.code === "ITANDI_GUARD");
    if (g) {
      const [, , cause, outcome] = g.cause_key.split(":");
      const k = (cause === "ext" || cause === "site" ? cause : "unknown") as GuardCause;
      const o = outcome === "fixed" || outcome === "unfixed" ? outcome : "no_retry";
      guard[k][o]++;
      guardRuns++;
    }
    const s = cs.find((c) => c.code === "SENT_SELECTED" && c.severity !== "ok");
    if (s) { sentSelectedRuns++; const n = Number((s.title.match(/(\d+)件/) ?? [])[1]); if (Number.isFinite(n)) sentSelectedRooms += n; }
    if (cs.some((c) => /:cut_by_rows$/.test(c.cause_key))) rowCutRuns++;
    if (cs.some((c) => /:cut_by_pages$/.test(c.cause_key))) pageCutRuns++;
  }
  const tried = (["ext", "site", "unknown"] as GuardCause[]).reduce((a, k) => a + guard[k].fixed + guard[k].unfixed, 0);
  const fixedAll = (["ext", "site", "unknown"] as GuardCause[]).reduce((a, k) => a + guard[k].fixed, 0);
  const fixRate = tried ? Math.round((fixedAll / tried) * 100) / 100 : null;
  const lines: string[] = [];
  if (guardRuns) {
    const part = (k: GuardCause, ja: string) => guard[k].fixed + guard[k].unfixed + guard[k].no_retry ? `${ja} ${guard[k].fixed + guard[k].unfixed + guard[k].no_retry}回（直った ${guard[k].fixed}・直らず ${guard[k].unfixed}${guard[k].no_retry ? `・入れ直していない ${guard[k].no_retry}` : ""}）` : "";
    lines.push(`ITANDI の条件が効いていない検索 ${guardRuns}回: ${[part("ext", "拡張側"), part("site", "ITANDI 側"), part("unknown", "判断つかず")].filter(Boolean).join("／")}${fixRate != null ? `・入れ直しで直った率 ${Math.round(fixRate * 100)}%` : ""}`);
  }
  if (sentSelectedRuns) lines.push(`送付済みの部屋を選んだ・ダウンロードした回 ${sentSelectedRuns}回（${sentSelectedRooms}部屋）`);
  if (rowCutRuns) lines.push(`ITANDI の物件数の上限で打ち切った回 ${rowCutRuns}回`);
  return { guard, guardRuns, fixRate, sentSelectedRuns, sentSelectedRooms, rowCutRuns, pageCutRuns, lines };
}

/** DeepSeek に見立てを頼むか（bad か、warn の0件だけ） */
export function needsDiagnosis(v: Pick<AuditVerdict, "severity" | "zero">): boolean {
  return v.severity === "bad" || (v.severity === "warn" && v.zero);
}

/** 原因の鍵 → 画面の見出し（札の title が無い時の代わり） */
export function causeTitle(causeKey: string): string {
  const [kind, site, a, b] = causeKey.split(":");
  const siteJa = site === "realpro" ? "リアプロ" : site === "itandi" ? "itandi" : site === "reins" ? "レインズ" : site;
  switch (kind) {
    case "station_missing": return `${siteJa}: 駅「${b ?? a}」が入らない${a && a !== "-" && b ? `（${a}）` : ""}`;
    case "route_missing": return `${siteJa}: 路線「${a}」が選べない`;
    case "area_unresolved": return a === "all" ? `${siteJa}: 場所の条件が作れない` : `${siteJa}: 「${a}」を場所に直せない`;
    case "location_mode": return `${siteJa}: 場所の入れ方（${a}）`;
    case "rent_mismatch": return `${siteJa}: 賃料の上限（${a}）`;
    case "floor_plan_dropped": return `${siteJa}: 間取りが入らない（${a}）`;
    case "update_days": return `${siteJa}: 更新日（${a}）`;
    case "condition_misread": return `${siteJa}: 条件の読み落とし（${a}）`;
    case "condition_drift": return `${siteJa}: 登録の条件と違う（${a}${b ? `・${b}` : ""}）`;
    case "condition_stale": return `${siteJa}: 古い条件で検索したおそれ`;
    case "reset_failed": return `${siteJa}: 前の条件を消せない`;
    case "ui_not_found": return `${siteJa}: 画面の部品が見つからない（${[a, b].filter(Boolean).join("・")}）`;
    case "zero_unconfirmed": return `${siteJa}: 0件（確かめられない・${a}）`;
    case "zero_confirmed": return `${siteJa}: 0件（件数表示も0）`;
    case "sent_lt_read": return `${siteJa}: 送れる物件を送り切れない`;
    case "sent_selected": return `${siteJa}: 送付済みの部屋を選んだ・ダウンロードした`;
    case "itandi_guard": return `${siteJa}: 条件が効いていない検索（${a === "ext" ? "拡張側" : a === "site" ? "ITANDI 側" : "判断つかず"}・${b === "fixed" ? "入れ直しで直った" : b === "unfixed" ? "直らず見送り" : "入れ直していない"}）`;
    case "stalled": return `${siteJa}: 途中で止まった（${a}）`;
    case "error": return a === "not_logged_in" ? `${siteJa}: ログインしていない` : `${siteJa}: 失敗（${a}）`;
    // 2026-09-29 見張りの週のまとめの提案（screen-watch-server.weeklyScreenWatch）。形は watch_rule:<規則>／decision:commute_missing:<目的の駅>
    case "watch_rule": return `見張りの規則の見直し（誤警報が多い: ${site}）`;
    case "decision": return site === "commute_missing" ? `通勤の到達駅が抜けやすい（${a}）` : `決め方のズレ（${site}${a ? `・${a}` : ""}）`;
    default: return causeKey;
  }
}

/**
 * 回の見出しに付ける1行（例「この回の検索: 駅 3/4・東三国が入っていない」）。点検していない回は null
 */
export function auditHeadline(row: { severity?: string | null; intended?: Intended | null; checks?: AuditCheck[] | null }): string | null {
  if (!row || !row.severity) return null;
  const parts: string[] = [];
  const n = uniq(arr(row.intended?.station_names).map(normStation).filter(Boolean)).length;
  const miss = arr(row.checks).filter((x) => x.code === "STATION_MISSING").length;
  if (n > 0 && n <= 40) parts.push(`駅 ${Math.max(0, n - miss)}/${n}`);
  const top = arr(row.checks).find((x) => x.severity !== "ok");
  if (top) parts.push(top.title);
  if (!parts.length) parts.push("問題なし");
  return `この回の検索: ${parts.join("・")}`;
}

/**
 * AIXツールの「回」（届いた物件のまとまり）に当たる検索の回を選ぶ（純関数）。
 *   同じサイトで、回が届き始める20分前から届き終わりの5分後までに始まった検索。サイトごとに一番近い1つ
 */
export function pickAuditForRound<T extends { site: string | null; created_at: string }>(
  runs: T[], round: { sites: Array<string | null>; from: string; to?: string | null },
): T[] {
  const from = Date.parse(round.from), to = Date.parse(round.to || round.from);
  if (!Number.isFinite(from)) return [];
  const lo = from - 20 * 60_000, hi = (Number.isFinite(to) ? to : from) + 5 * 60_000;
  const out: T[] = [];
  for (const s of uniq(round.sites.map((x) => normalizeSite(x)).filter(Boolean))) {
    const cands = runs.filter((r) => normalizeSite(r.site) === s && Date.parse(r.created_at) >= lo && Date.parse(r.created_at) <= hi);
    cands.sort((a, b) => Math.abs(Date.parse(a.created_at) - from) - Math.abs(Date.parse(b.created_at) - from));
    if (cands[0]) out.push(cands[0]);
  }
  return out;
}

/** 版の比べ（"2.5.25" 形式）。a>=b なら true */
export function versionGte(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const pa = a.split(".").map((x) => Number(x) || 0), pb = b.split(".").map((x) => Number(x) || 0);
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const d = (pa[k] ?? 0) - (pb[k] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

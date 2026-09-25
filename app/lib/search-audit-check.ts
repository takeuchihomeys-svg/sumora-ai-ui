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

export type AuditSeverity = "ok" | "warn" | "bad";
export type AuditSite = "realpro" | "itandi" | "reins";

export type CheckCode =
  | "STATION_MISSING" | "ROUTE_MISSING" | "AREA_UNRESOLVED" | "CONDITION_MISREAD" | "RENT_MISMATCH"
  | "FLOOR_PLAN_DROPPED" | "UPDATE_DAYS" | "LOCATION_MODE" | "RESET_FAILED" | "UI_NOT_FOUND"
  | "ZERO_UNCONFIRMED" | "ZERO_CONFIRMED" | "SENT_LT_READ" | "STALLED" | `ERROR_${string}`;

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
  /** 場所の入れ方（station / route / area / none）。page-script の判定のまま */
  area_path?: string | null;
  /** 条件を外して検索した（例: 駅が選べず駅なしで検索） */
  fallback?: string | null;
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
  "RENT_MISMATCH", "FLOOR_PLAN_DROPPED", "UPDATE_DAYS", "CONDITION_MISREAD", "RESET_FAILED", "ZERO_UNCONFIRMED",
  "SENT_LT_READ", "ZERO_CONFIRMED",
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

  // ── 更新日（リアプロだけ）──
  if (site === "realpro" && form && "update_days" in form) {
    const intendedDays = i?.rp_update_days != null ? parseIntLoose(i.rp_update_days) : null;
    const filledDays = parseIntLoose(form.update_days);
    if (intendedDays != null && filledDays !== intendedDays) {
      add("UPDATE_DAYS", "bad", `update_days:${siteKey}:not_filled`, "更新日が入っていない", `入れようとした=${intendedDays}日・入った=${filledDays ?? "指定なし"}`);
    } else if (intendedDays == null && filledDays != null) {
      add("UPDATE_DAYS", "bad", `update_days:${siteKey}:leftover`, "前の更新日が残っていた", `入れようとした=指定なし・入った=${filledDays}日`);
    }
    if (c) {
      const base = a.created_at ? Date.parse(a.created_at) : nowMs;
      const expected = effectiveRpUpdateDays(c, Number.isFinite(base) ? base : nowMs);
      if (expected !== intendedDays) {
        add("UPDATE_DAYS", "warn", `update_days:${siteKey}:differs`, "更新日が決まりと違う", `決まり=${expected ?? "指定なし"}・入れた=${intendedDays ?? "指定なし"}（一時調整なら問題なし）`);
      }
    }
  }

  // ── お客様の条件を読み落としていないか ──
  if (c && i) {
    const cRent = parseMan(c.rent_max ?? c.max_rent);
    if (cRent != null && iRent == null) add("CONDITION_MISREAD", "warn", `condition_misread:${siteKey}:rent_max`, "賃料の条件が検索に入っていない", `お客様=${cRent}万`);
    else if (cRent != null && iRent != null && iRent < cRent * 0.98) add("CONDITION_MISREAD", "warn", `condition_misread:${siteKey}:rent_lower`, "賃料がお客様の上限より低い", `お客様=${cRent}万・検索=${iRent}万`);
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

  checks.sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity] || codeRank(x.code) - codeRank(y.code));
  const severity: AuditSeverity = checks.length ? checks[0].severity : "ok";
  const cause_keys = uniq(checks.map((x) => x.cause_key)).slice(0, 10);
  return { checks, severity, cause_key: checks[0]?.cause_key ?? null, cause_keys, zero };
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
    case "reset_failed": return `${siteJa}: 前の条件を消せない`;
    case "ui_not_found": return `${siteJa}: 画面の部品が見つからない（${[a, b].filter(Boolean).join("・")}）`;
    case "zero_unconfirmed": return `${siteJa}: 0件（確かめられない・${a}）`;
    case "zero_confirmed": return `${siteJa}: 0件（件数表示も0）`;
    case "sent_lt_read": return `${siteJa}: 送れる物件を送り切れない`;
    case "stalled": return `${siteJa}: 途中で止まった（${a}）`;
    case "error": return a === "not_logged_in" ? `${siteJa}: ログインしていない` : `${siteJa}: 失敗（${a}）`;
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

// app/lib/screen-watch.ts（純関数・DB も fetch も無し）
// 見張り: 拡張が今動かしている1つの画面を「人が見るように」見て、決め方のズレも見つける。
//
// 2026-09-29 竹内「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
//   新しい仕組みは作らず、今ある3つ（v2.5.40 の心拍と写真・検索の点検 search_audits・DeepSeek の見立て runDiagnosis）を1本の見張りにつなぐ。
//
// 見る所（要所）: C1 条件を入れた後（filled）／C2 検索結果（results・C1 の約4秒後）／C3 回の終わり（done・サーバーの recordFinished）／
//   C4 動きが無い時（stall・拡張の止まりの写真）。心拍（1分）は判断に使わない。
// 判断の段: ①決定論（detectScreenState）→ ②Jev（最初は影＝記録だけ）→ ③DeepSeek（異常の疑いの時だけ・文字を先に・写真は文字が無い時だけ）
//   → ④物件検索のブレインの裁定（意図・決定論の表・画面の3つが食い違った時だけ・提案だけ）
// 自動で動くのは3つだけ: 止める（ログイン切れ・サイトのエラー＝①の硬い判定の時だけ）／待つ／知らせる。
//   再読み込み・再試行・クリックは返さない（actionFor・テストで固定）。
// 費用: 1日の上限 SCREEN_WATCH_DAILY_USD（既定 $10）。上限は常に混雑時の2倍で数え、超えたら①だけで続ける（検索は止めない）。
// ⚠ UPDATE_DAYS の warn（更新日の違い）は異常として扱わない（9/28 の点検の札の半分以上がこれ＝数えると誤警報だらけ）。
import { createMasker } from "./pii-pseudonym";
import { agesOutside, fmtGap, type UpdateAges } from "./search-update-days";

// ─── 型 ─────────────────────────────────────────────────────────────────────

export const WATCH_LABELS = ["normal", "stuck", "login_expired", "modal_blocking", "wrong_conditions", "zero_suspicious", "site_error", "decision_drift"] as const;
export type WatchLabel = (typeof WATCH_LABELS)[number];
/** Jev・DeepSeek が選べるラベル（決め方のズレは④が見るので入れない・分からない＝unknown） */
export const MODEL_LABELS = ["normal", "stuck", "login_expired", "modal_blocking", "wrong_conditions", "zero_suspicious", "site_error", "unknown"] as const;
export type ModelLabel = (typeof MODEL_LABELS)[number];
export const CHECKPOINTS = ["filled", "results", "done", "stall"] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

/** ページの文字（拡張 snapshot-core.readDom の形の一部） */
export type WatchDom = {
  url?: string | null;
  title?: string | null;
  count_text?: string | null;
  count_number?: number | null;
  page_text?: string | null;
  alert_text?: string | null;
  modal_text?: string | null;
  text_head?: string | null;
  band_text?: string | null;
  visibility?: string | null;
  /** 2026-09-29 v2.5.41 リアプロの一覧の行の更新日の経過（snapshot-core readDom・「309 4日前」の形） */
  update_ages?: UpdateAges | null;
};

/** 点検の札（search-audit-check の AuditCheck の必要な所だけ） */
export type WatchCheck = { code: string; severity: string; cause_key?: string | null; title?: string | null };

export type CountRange = { low: number; high: number | null; median: number; n: number; screenMedian: number | null; screenN: number };

export type DecisionLite = { severity: "ok" | "warn" | "bad"; items: Array<{ kind: string; severity: "warn" | "bad"; title: string }> };

export type WatchMaterial = {
  checkpoint: Checkpoint;
  site?: string | null;
  dom?: WatchDom | null;
  dom_error?: string | null;
  checks?: WatchCheck[] | null;
  error?: string | null;
  error_kind?: string | null;
  /** C4 のきっかけ（stall／pass_deadline／fill_timeout／waiter_timeout） */
  stall_kind?: string | null;
  idle_min?: number | null;
  waiting_for?: string | null;
  range?: CountRange | null;
  /** C3: 読んだ行数（件数の文が無い時の代わり） */
  read_rows?: number | null;
  /** C3: 2026-09-30 v2.5.43 更新日順で前回の検索より古い行で止めた回（読んだ行が少ない・0 でも検索できていないのではない） */
  update_stopped?: boolean | null;
  decision?: DecisionLite | null;
  is_wide?: boolean | null;
  /** 入れようとした場所の数（駅＋区・市）。広い検索（AREA_WIDE 以上）は件数が多くても「条件が効いていない」と言わない */
  area_size?: number | null;
  /**
   * 2026-09-29 v2.5.41 更新日（竹内「更新日を生かすことによって最新の物件の検索や新規物件のもれがないように」）:
   *   days＝その回の更新日（入れようとした値）・gap_hours＝前回の検索（最後に終わった回）から空いた時間・need_days＝覆うのに要る日数
   */
  update?: { days: number | null; gap_hours: number | null; need_days: number | null; last_search_at: string | null } | null;
};
/** これ以上の駅・区で検索した回は、件数の絶対の上限（3,000）で疑わない（大阪市内全部・通勤の到達駅 240 など） */
export const AREA_WIDE = 15;

export type Detection = {
  label: WatchLabel;
  /** 当たった規則（全部） */
  rules: string[];
  /** 硬い＝これだけで動いてよい（止めるのは硬い時だけ） */
  hard: boolean;
  reason: string;
  /** ★物件出し★に足す1行（条件が入り切っていない等）。無ければ null */
  notice: string | null;
  /**
   * 2026-09-29 v2.5.41 更新日の見張り（C1 入ったか・前回から空いた分を覆えたか／C2 一覧の更新日が中か／C3 ページで打ち切ったか）。
   *   ラベル（止める・広げてを止める）は変えない＝更新日は検索を止める理由にしない。★物件出し★の知らせに1行足すだけ
   */
  update_items: UpdateFinding[];
  update_notice: string | null;
  /**
   * 2026-09-30 v2.5.42 竹内「画面見るところで、前に共有した物件はダウンロードされないようになっているのか読み取って」:
   *   送付済みの部屋を選んだ・ダウンロードした（点検の SENT_SELECTED・C3）→ ★物件出し★のまとめに1行。ラベルは変えない（検索は止めない）
   */
  sent_notice: string | null;
};

/** 送付済みの部屋の見張り（純関数）: 点検の SENT_SELECTED の札 → 1行（例「⚠ 送付済みの部屋を2件ダウンロードしていた」） */
export function sentSelectedNotice(checks: ReadonlyArray<{ code?: string | null; severity?: string | null; title?: string | null; detail?: string | null }> | null | undefined): string | null {
  const c = (checks ?? []).find((x) => x && x.code === "SENT_SELECTED" && x.severity !== "ok");
  if (!c) return null;
  const n = Number((String(c.title ?? "").match(/(\d+)件/) ?? [])[1]);
  return `⚠ 送付済みの部屋を${Number.isFinite(n) && n > 0 ? `${n}件` : ""}ダウンロードしていた（${clip(String(c.detail ?? "").split("（")[0], 40)}）`;
}

export type UpdateFinding = { code: string; severity: "warn" | "bad"; title: string };

/** 点検の札の鍵（update_days:<site>:<種類>）→ 見張りに出す種類。differs（決まりとの違い）は材料の違いなので出さない */
const UPDATE_KINDS: Record<string, "warn" | "bad"> = {
  not_filled: "bad", leftover: "bad", not_accepted: "warn", typed_unverified: "warn", gap_uncovered: "warn", cut_by_pages: "warn", rows_outside: "warn",
  // 2026-09-30 v2.5.42 ITANDI の1回の物件数の上限で打ち切った（C3）
  cut_by_rows: "warn",
};

/** 更新日の見張り（純関数）。点検の札（C1・C3）と一覧の更新日（C2 の画面の文字）から */
export function updateDaysFindings(m: WatchMaterial): { items: UpdateFinding[]; notice: string | null } {
  const items: UpdateFinding[] = [];
  const seen = new Set<string>();
  for (const c of m.checks ?? []) {
    if (!c || c.code !== "UPDATE_DAYS" || c.severity === "ok") continue;
    const kind = String(c.cause_key ?? "").split(":")[2] ?? "";
    const sev = UPDATE_KINDS[kind];
    if (!sev || seen.has(kind)) continue;
    seen.add(kind);
    items.push({ code: kind, severity: sev, title: String(c.title ?? kind) });
  }
  const days = m.update?.days ?? null;
  const out = m.checkpoint === "results" ? agesOutside(days, m.dom?.update_ages ?? null) : null;
  if (out?.bad && !seen.has("rows_outside")) {
    items.push({ code: "rows_outside", severity: "warn", title: `一覧に更新日（${days}日以内）より古い物件が混ざっている（${out.outside}/${out.total}行）` });
  }
  const pick = (k: string) => items.find((x) => x.code === k);
  const gap = pick("gap_uncovered"), rows = pick("rows_outside"), cut = pick("cut_by_pages") ?? pick("cut_by_rows"), nf = pick("not_filled") ?? pick("leftover");
  const notice = nf ? `⚠ 更新日が意図どおりに入っていない（${clip(nf.title, 40)}）`
    : gap ? `⚠ 更新日（${days ?? "?"}日以内）では前回の検索から空いた${fmtGap(m.update?.gap_hours ?? null)}を覆えていない（間の新着が漏れるおそれ）`
    : rows ? "⚠ 更新日の絞りが効いていないおそれ（古い更新の物件が一覧に混ざっている）"
    : cut ? `⚠ ${clip(cut.title, 50)}（残りのページの新着を見ていない）`
    : null;
  return { items, notice };
}

// ─── 設定（環境変数） ────────────────────────────────────────────────────────

export type WatchConfig = {
  enabled: boolean;
  dailyUsd: number;
  jev: "shadow" | "gate" | "off";
  image: boolean;
  autoTune: boolean;
  notifyGroup: boolean;
};
const offish = (v: string | undefined) => /^(off|0|false|no)$/i.test(String(v ?? "").trim());
export function readWatchConfig(env: Record<string, string | undefined> = process.env): WatchConfig {
  const usd = Number(env.SCREEN_WATCH_DAILY_USD);
  const jev = String(env.SCREEN_WATCH_JEV ?? "").trim().toLowerCase();
  return {
    enabled: !offish(env.SCREEN_WATCH),
    dailyUsd: Number.isFinite(usd) && usd >= 0 ? usd : 10,
    jev: jev === "gate" ? "gate" : jev === "off" ? "off" : "shadow",
    image: !offish(env.SCREEN_WATCH_IMAGE),
    autoTune: !offish(env.SCREEN_WATCH_AUTO_TUNE),
    // 止めた時の1通を★物件出し★に出すか（未決: AIXツールだけにもできる → SCREEN_WATCH_NOTIFY_GROUP=off）
    notifyGroup: !offish(env.SCREEN_WATCH_NOTIFY_GROUP),
  };
}

/** 自動で調整する線（件数の幅の倍率・Jev から DeepSeek に回す線）。screen_watch_settings の active が上書き */
export type WatchThresholds = { countLo: number; countHi: number; countAbsMax: number; countJumpX: number; jevGateProb: number | null };
export const DEFAULT_THRESHOLDS: WatchThresholds = { countLo: 0.3, countHi: 3, countAbsMax: 3000, countJumpX: 5, jevGateProb: null };

export function sanitizeThresholds(raw: unknown): WatchThresholds {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
  return {
    countLo: n(o.countLo, 0.05, 0.9, DEFAULT_THRESHOLDS.countLo),
    countHi: n(o.countHi, 1.5, 20, DEFAULT_THRESHOLDS.countHi),
    countAbsMax: n(o.countAbsMax, 500, 100000, DEFAULT_THRESHOLDS.countAbsMax),
    countJumpX: n(o.countJumpX, 2, 50, DEFAULT_THRESHOLDS.countJumpX),
    jevGateProb: typeof o.jevGateProb === "number" && o.jevGateProb > 0 && o.jevGateProb < 1 ? o.jevGateProb : null,
  };
}

// ─── 過去の値（件数の幅） ────────────────────────────────────────────────────

export type CountSample = { count: number; kind: "screen" | "rows" };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 同じお客様×サイト×ピンポイント／広げての直近の ok の回（新しい順に渡す）の件数から幅を出す。直近5回・中央値 m。
 *   下限 0.3m（m が 0 なら 0・それ以外は最低 1）・上限 3m（最低 30）。過去が無ければ null（0件の疑いは言わない）。
 *   screen＝画面の件数（見張りの C2）・rows＝読んだ行数（ページの上限で頭打ち）。上限の飛び（5倍）は画面の件数どうしだけで比べる
 */
export function expectedCountRange(samples: ReadonlyArray<CountSample>, t: Pick<WatchThresholds, "countLo" | "countHi"> = DEFAULT_THRESHOLDS): CountRange | null {
  const ok = samples.filter((s) => typeof s.count === "number" && Number.isFinite(s.count) && s.count >= 0).slice(0, 5);
  if (!ok.length) return null;
  const m = median(ok.map((s) => s.count));
  const scr = samples.filter((s) => s.kind === "screen" && Number.isFinite(s.count) && s.count >= 0).slice(0, 5).map((s) => s.count);
  return {
    low: m > 0 ? Math.max(1, Math.floor(m * t.countLo)) : 0,
    high: Math.max(30, Math.ceil(m * t.countHi)),
    median: m,
    n: ok.length,
    screenMedian: scr.length ? median(scr) : null,
    screenN: scr.length,
  };
}

// ─── ① 決定論 ─────────────────────────────────────────────────────────────

const LOGIN_TEXT_RE = /ログインしてください|ログインが必要|再度ログイン|ログインし直|セッション(?:が切れ|の有効期限|がタイムアウト)|未ログイン/;
const LOGIN_URL_RE = /\/(?:login|signin|sign_in|auth)(?:[/?.#]|$)|[?&](?:method|page)=login/i;
// 2026-09-30 v2.5.48 ログインの画面をサイトの形で見分ける（本番の写真 extension_snapshots #23・#27: リアプロのログイン切れは
//   url=https://www.realnetpro.com/index.php・題「リアプロBB+仲介ログイン画面」。LOGIN_URL_RE（/login 等）にも LOGIN_TEXT_RE（ログインしてください 等）にも当たらず、
//   results・done とも normal と読んでいた＝#216・#217・#230・#231）。検索の画面は main.php なので、リアプロの index.php・ルートはログインの画面
const LOGIN_URL_SITE_RE = /^https?:\/\/(?:www\.)?realnetpro\.com\/(?:index\.php)?(?:[?#]|$)/i;
/** タブの題（「…ログイン画面」「ログイン | …」）。本文のお知らせの「ログイン」は見ない（題だけ） */
const LOGIN_TITLE_RE = /ログイン(?:画面|ページ)|^\s*(?:ログイン|Login|Sign in)\s*(?:[|｜\-–:：]|$)/i;
/** 拡張の失敗の文: 検索の画面にならない（開き直しても）＝ログインの画面に移った形がほとんど（background _ensureRealproTab / _ensureItandiTab） */
const TAB_NOT_SEARCH_RE = /AXLX_TAB_DEAD[^\n]*(?:main\.php|検索の画面)/;
const SITE_ERROR_RE = /メンテナンス中|ただいまメンテナンス|アクセスが集中|エラーが発生しました|Service Unavailable|Internal Server Error|503|502 Bad Gateway/;
/** 予告・お知らせの形（日付・時刻・予定）。今起きているエラーの強い文（SITE_ERROR_NOW_RE）が無い時だけ「お知らせ」とみなす */
const SITE_NOTICE_RE = /お知らせ|予定|予告|実施|\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}:\d{2}\s*[〜～~-]/;
const SITE_ERROR_NOW_RE = /ただいまメンテナンス|只今メンテナンス|アクセスが集中|エラーが発生しました|Service Unavailable|Internal Server Error|502 Bad Gateway/;
/** 条件が入り切っていない（入れようとした値↔入った値・登録の条件↔入った値）の札。UPDATE_DAYS・warn の札は入れない */
const WRONG_CODES = new Set(["STATION_MISSING", "ROUTE_MISSING", "CONDITION_STALE", "CONDITION_DRIFT", "LOCATION_MODE", "AREA_UNRESOLVED", "RENT_MISMATCH", "FLOOR_PLAN_DROPPED"]);
const STUCK_KINDS = new Set(["stall", "pass_deadline", "fill_timeout", "waiter_timeout", "watchdog", "batch_timeout", "stalled"]);

function errKindOf(error: string | null | undefined, kind: string | null | undefined): string | null {
  if (kind) return kind;
  const e = String(error ?? "");
  if (!e.trim()) return null;
  if (/__BATCH_STOPPED__|ストップ/.test(e)) return "stopped";
  if (/見張りの時間切れ/.test(e)) return "pass_deadline";
  if (/watchdog/i.test(e)) return "watchdog";
  if (/fill-done|検索完了シグナル|AXLX_NO_FILL_START/.test(e)) return "fill_timeout";
  if (/全ページ送信完了|5分/.test(e)) return "batch_timeout";
  if (/未ログイン|ログインしてください|ログインしてから|セッションが見つかりません/.test(e)) return "not_logged_in";
  if (TAB_NOT_SEARCH_RE.test(e)) return "tab_not_search";
  if (/メンテナンス|アクセスが集中/.test(e)) return "site_error";
  return "exception";
}

/**
 * 1つの画面（要所の材料）を見て、ラベル・当たった規則・硬さを返す。
 *   硬い（hard）のは: ログイン画面／ログインの文・サイトのエラーの文（どちらも件数が読めない時だけ＝件数が出ていれば動いている）・
 *   拡張の失敗の文が「未ログイン」・止まりとモーダルが重なった時
 */
export function detectScreenState(m: WatchMaterial, t: WatchThresholds = DEFAULT_THRESHOLDS): Detection {
  const d = m.dom ?? {};
  const rules: string[] = [];
  const countKnown = typeof d.count_number === "number" && Number.isFinite(d.count_number);
  const texts = [d.alert_text, d.modal_text, d.title].map((x) => String(x ?? "")).join(" ");
  const kind = errKindOf(m.error, m.error_kind);
  const checks = (m.checks ?? []).filter((c) => c && c.code);

  // ログイン切れ
  const loginUrl = LOGIN_URL_RE.test(String(d.url ?? "")) || LOGIN_URL_SITE_RE.test(String(d.url ?? ""));
  const loginTitle = LOGIN_TITLE_RE.test(String(d.title ?? ""));
  const loginText = LOGIN_TEXT_RE.test(texts) || loginTitle;
  const loginErr = kind === "not_logged_in";
  // 検索の画面にならないタブ（画面の材料が無くても拡張の失敗の文で分かる）。ログイン切れの疑い＝硬くはしない（止めない・ラベルだけ正しく）
  const loginTab = kind === "tab_not_search";
  if (loginUrl) rules.push("login:url");
  if (loginTitle) rules.push("login:title");
  else if (loginText) rules.push("login:text");
  if (loginErr) rules.push("login:error");
  if (loginTab) rules.push("login:tab_not_search");
  const loginHard = (loginUrl || loginText) && !countKnown || loginErr;
  // サイトのエラー
  const siteText = SITE_ERROR_RE.test(texts);
  if (siteText) rules.push("site_error:text");
  const siteErr = kind === "site_error";
  if (siteErr) rules.push("site_error:error");
  const uiErr = kind === "ui" || checks.some((c) => c.code === "UI_NOT_FOUND" && c.severity === "bad");
  if (uiErr) rules.push("site_error:ui_not_found");
  // 止まり・モーダル
  const stuck = m.checkpoint === "stall" || STUCK_KINDS.has(String(m.stall_kind ?? "")) || STUCK_KINDS.has(String(kind ?? "")) || checks.some((c) => c.code === "STALLED");
  if (stuck) rules.push(`stuck:${m.stall_kind ?? kind ?? "stall"}`);
  const modal = !!String(d.modal_text ?? "").trim();
  if (modal) rules.push("modal");
  // 条件が入り切っていない（札 bad・UPDATE_DAYS は見ない）
  const wrongChecks = checks.filter((c) => c.severity === "bad" && WRONG_CODES.has(c.code));
  for (const c of wrongChecks.slice(0, 5)) rules.push(`wrong:${c.code}`);
  const cnt = countKnown ? (d.count_number as number) : null;
  const tooMany = cnt != null && cnt > t.countAbsMax && !(typeof m.area_size === "number" && m.area_size >= AREA_WIDE);
  if (tooMany) rules.push(`wrong:count_over_${t.countAbsMax}`);
  const jump = cnt != null && m.range?.screenMedian != null && m.range.screenMedian > 0 && (m.range.screenN ?? 0) >= 2 && cnt > m.range.screenMedian * t.countJumpX;
  if (jump) rules.push(`wrong:count_jump_x${t.countJumpX}`);
  // 0件の疑い
  const zeroScreen = cnt === 0 && !!m.range && m.range.low >= 3;
  const zeroRows = m.checkpoint === "done" && m.read_rows === 0 && !!m.range && m.range.low >= 3 && !m.update_stopped;
  const zeroCheck = checks.some((c) => c.code === "ZERO_UNCONFIRMED" && c.severity === "bad");
  if (zeroScreen) rules.push("zero:screen_below_history");
  if (zeroRows) rules.push("zero:rows_below_history");
  if (zeroCheck) rules.push("zero:unconfirmed");
  // 決め方のズレ
  const drift = m.decision && m.decision.severity !== "ok" ? m.decision : null;
  if (drift) rules.push(`decision:${drift.items[0]?.kind ?? "drift"}`);

  // 更新日（ラベルは変えない・規則と1行だけ）
  const upd = updateDaysFindings(m);
  for (const u of upd.items.slice(0, 4)) rules.push(`update:${u.code}`);
  const sentNotice = sentSelectedNotice(checks);
  if (sentNotice) rules.push("sent:selected");
  // 2026-09-30 v2.5.48 同じ自動入力が2本走った回（点検の札 DOUBLE_FILL・bad）。ラベルは変えない（止まり・時間切れはそのラベルのまま）・規則に残す
  if (checks.some((c) => c.code === "DOUBLE_FILL" && c.severity === "bad")) rules.push("double_fill");
  const out = (label: WatchLabel, hard: boolean, reason: string, notice: string | null = null): Detection => ({ label, rules, hard, reason, notice, update_items: upd.items, update_notice: upd.notice, sent_notice: sentNotice });
  if (loginHard || loginUrl || loginText) {
    return out("login_expired", loginHard, loginErr ? "拡張の失敗の文が未ログイン" : loginUrl ? "タブの URL がログインの画面" : `ログインの文: ${clip(d.alert_text || d.modal_text || d.title, 60)}`);
  }
  if (loginTab) return out("login_expired", false, `検索の画面にならない（ログイン切れの疑い）: ${clip(m.error, 80)}`, "⚠ 検索の画面が開けませんでした（ログイン切れの疑い・ログインし直してください）");
  // 2026-09-29 検証: ITANDI は件数の文が読めない（search_audits の count_text は全部 null）ので「件数が出ていれば止めない」が効かない。
  //   予告のお知らせ（「メンテナンス中のお知らせ（10/1 2:00〜）」）は今のエラーではない → 強い文（ただいま・アクセス集中・5xx）が無ければ硬くしない
  const siteNoticeOnly = siteText && SITE_NOTICE_RE.test(texts) && !SITE_ERROR_NOW_RE.test(texts);
  if (siteNoticeOnly) rules.push("site_error:notice_only");
  if (siteText || siteErr) return out("site_error", (siteText && !countKnown && !siteNoticeOnly) || siteErr,`サイトのエラーの文: ${clip(d.alert_text || d.modal_text || d.title || m.error, 60)}`);
  if (stuck && modal) return out("modal_blocking", true, `止まっている画面にモーダル: ${clip(d.modal_text, 60)}`);
  if (wrongChecks.length || tooMany || jump) {
    const what = wrongChecks[0]?.title ?? (tooMany ? `件数 ${cnt!.toLocaleString("en-US")} は条件が効いていない量` : `件数 ${cnt} は過去の中央値 ${m.range?.screenMedian} の${t.countJumpX}倍超`);
    return out("wrong_conditions", false, what, `⚠ 条件が入り切っていない検索（${clip(what, 40)}）`);
  }
  if (zeroScreen || zeroRows || zeroCheck) {
    const what = zeroCheck ? (checks.find((c) => c.code === "ZERO_UNCONFIRMED")?.title ?? "0件（確かめられない）") : `0件（過去は ${m.range?.low}件以上）`;
    return out("zero_suspicious", false, what, `⚠ 0件の疑い（${clip(what, 40)}）`);
  }
  if (uiErr) return out("site_error", false, "画面の部品が見つからない（サイトの作りが変わった可能性）");
  if (stuck) return out("stuck", false, `動きが無い（${m.stall_kind ?? kind ?? "stall"}${m.idle_min != null ? `・${m.idle_min}分` : ""}${m.waiting_for ? `・待っていた物=${clip(m.waiting_for, 40)}` : ""}）`);
  if (modal) return out("modal_blocking", false, `モーダルが開いている: ${clip(d.modal_text, 60)}`);
  if (drift) return out("decision_drift", false, drift.items.map((x) => x.title).join("／").slice(0, 200));
  return out("normal", false, "問題なし");
}

function clip(s: unknown, n: number): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

// ─── 動き（自動で動くのは 止める・待つ・知らせる だけ） ─────────────────────

export const WATCH_ACTIONS = ["none", "wait", "stop_site", "flag", "suggest"] as const;
export type WatchActionKind = (typeof WATCH_ACTIONS)[number];
export type WatchAction = {
  kind: WatchActionKind;
  /** そのサイトの残りの回を止めるか（拡張が次のお客様の境目で見送る） */
  stopSite: boolean;
  /** その回の自動の広げてを止めるか（decideWiden の watchBlocked） */
  blockWiden: boolean;
  /** ★物件出し★に知らせるか（止めた時の1通・⚠ の1行） */
  notify: boolean;
  reason: string;
};

/** ラベル → 動き。再読み込み・再試行・クリックは返さない（WATCH_ACTIONS の外は作らない） */
export function actionFor(label: WatchLabel, ctx: { hard: boolean }): WatchAction {
  const a = (kind: WatchActionKind, reason: string, o: Partial<WatchAction> = {}): WatchAction => ({ kind, stopSite: false, blockWiden: false, notify: false, reason, ...o });
  switch (label) {
    case "normal": return a("none", "問題なし");
    case "stuck": return a("wait", "待つ（1回の検索の上限の見張りが次のお客様へ進める）");
    case "modal_blocking": return a("wait", "待つ（モーダル・1回の検索の上限の見張りに任せる）");
    case "login_expired":
    case "site_error":
      return ctx.hard
        ? a("stop_site", label === "login_expired" ? "そのサイトの残りを見送る（ログインのし直しが要る）" : "そのサイトの残りを見送る（サイトのエラー）", { stopSite: true, notify: true })
        : a("flag", "疑い（決定論の硬い判定ではないので止めない）");
    case "wrong_conditions":
    case "zero_suspicious":
      return a("flag", "この回の自動の広げてを止め、★物件出し★に⚠の1行", { blockWiden: true, notify: true });
    case "decision_drift":
      return a("suggest", "決め方のズレ（段1は提案だけ）");
    default:
      return a("none", "知らないラベル");
  }
}

/** 止めた時の1通（サイト×2時間に1通） */
export const STOP_NOTICE_GAP_MS = 2 * 3600_000;
export function shouldSendStopNotice(lastSentAtMs: number | null, nowMs: number): boolean {
  return lastSentAtMs == null || !Number.isFinite(lastSentAtMs) || nowMs - lastSentAtMs >= STOP_NOTICE_GAP_MS;
}
const SITE_JA: Record<string, string> = { realpro: "リアプロ", realnetpro: "リアプロ", itandi: "ITANDI", reins: "レインズ" };
export function siteJa(site: string | null | undefined): string { return SITE_JA[String(site ?? "")] ?? String(site ?? "?"); }
export function stopNoticeText(label: WatchLabel, site: string | null | undefined, remaining: number | null): string {
  const s = siteJa(site);
  const rest = remaining != null && remaining > 0 ? `（残り ${remaining}人は見送り）` : "（この後の回は見送り）";
  return label === "login_expired"
    ? `⚠【見張り】${s}のログインが切れています。ログインし直してください${rest}`
    : `⚠【見張り】${s}がエラーの画面を出しています（メンテナンス・アクセス集中など）。落ち着いたら検索し直してください${rest}`;
}

// ─── 費用の関所（$10・回数） ─────────────────────────────────────────────────

export type WatchStage = "jev" | "text" | "image" | "arbiter";
/** 1回あたりの見積もり（混雑時の2倍を含む）。呼んでいる最中の分を足す時に使う */
export const EST_USD: Record<WatchStage, number> = { jev: 0.00006, text: 0.00055, image: 0.001, arbiter: 0.001 };
export const DAILY_COUNT_CAP: Record<WatchStage, number> = { jev: 600, text: 150, image: 20, arbiter: 60 };
/** 1回の検索（run）あたり。裁定はお客様×サイト×日に1（arbiterDoneToday） */
export const PER_RUN_CAP: Record<Exclude<WatchStage, "arbiter">, number> = { jev: 4, text: 2, image: 1 };
/** llm_usage_logs の名札（当日の額はこの行を合計する） */
export const WATCH_USAGE_ACTIONS = { jev: "jev:screen_watch", text: "screen_watch_text", image: "screen_watch_image", arbiter: "screen_watch_arbiter" } as const;

export type BudgetState = "ok" | "capped" | "no_key";
export type BudgetGate = { state: BudgetState; allow: Record<WatchStage, boolean>; reason: string };

export function watchBudgetGate(i: {
  spentUsd: number;
  capUsd: number;
  counts: Partial<Record<WatchStage, number>>;
  perRun: Partial<Record<Exclude<WatchStage, "arbiter">, number>>;
  arbiterDoneToday: boolean;
  keys: { jev: boolean; deepseek: boolean };
}): BudgetGate {
  const none: Record<WatchStage, boolean> = { jev: false, text: false, image: false, arbiter: false };
  if (!i.keys.jev && !i.keys.deepseek) return { state: "no_key", allow: none, reason: "鍵が無い（決定論だけ）" };
  if (!Number.isFinite(i.spentUsd) || i.spentUsd >= i.capUsd) return { state: "capped", allow: none, reason: `今日の費用 $${(i.spentUsd || 0).toFixed(4)} が上限 $${i.capUsd} に達した（決定論だけ）` };
  const c = (s: WatchStage) => i.counts[s] ?? 0;
  const r = (s: Exclude<WatchStage, "arbiter">) => i.perRun[s] ?? 0;
  const room = (s: WatchStage) => i.spentUsd + EST_USD[s] <= i.capUsd;
  const allow: Record<WatchStage, boolean> = {
    jev: i.keys.jev && c("jev") < DAILY_COUNT_CAP.jev && r("jev") < PER_RUN_CAP.jev && room("jev"),
    text: i.keys.deepseek && c("text") < DAILY_COUNT_CAP.text && r("text") < PER_RUN_CAP.text && room("text"),
    image: i.keys.deepseek && c("image") < DAILY_COUNT_CAP.image && r("image") < PER_RUN_CAP.image && room("image"),
    arbiter: i.keys.deepseek && c("arbiter") < DAILY_COUNT_CAP.arbiter && !i.arbiterDoneToday && room("arbiter"),
  };
  return { state: "ok", allow, reason: "ok" };
}

/** JST の日付（YYYY-MM-DD） */
export function jstDate(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}
/** JST の今日の始まり（UTC の ISO） */
export function jstDayStartIso(ms: number): string {
  return new Date(Date.parse(`${jstDate(ms)}T00:00:00+09:00`)).toISOString();
}

// ─── 文字の仮名化（帯を抜く＋お客様の名前を伏せる） ─────────────────────────

/** 帯（score-overlay）の文の頭の名前「隼斗: 家賃〜10.5万 / 2K …」（名前だけ伏せる。条件の文字は名前ではないので残す・text_head は改行が詰められていて行では切れない） */
const BAND_NAME_RE = /[^\s:：|｜/／]{1,16}(?=\s*[:：]\s*家賃)/g;

/**
 * DeepSeek・Jev に渡す前の文字。帯の文（band_text・帯の形の行）を抜き、お客様の名前の揺れを仮名に、長い数字（電話）を伏せる。
 *   帯の文そのものはスタッフの診断用に band_text（文字）で残るので、ここで抜いても困らない
 */
export function maskWatchText(text: string | null | undefined, o: { bandText?: string | null; names?: ReadonlyArray<string | null | undefined>; seed?: string }): string {
  let s = String(text ?? "");
  if (!s) return "";
  const band = String(o.bandText ?? "").trim();
  if (band) s = s.split(band).join(" ");
  s = s.replace(BAND_NAME_RE, "〇〇");
  const names = (o.names ?? []).map((x) => String(x ?? "").trim()).filter((x) => x.length >= 1);
  if (names.length) {
    try {
      const mk = createMasker({ conversationId: o.seed || "screen-watch", customerName: names[0], knownNames: names.slice(1) });
      s = mk.mask(s);
    } catch { /* 伏せられない時は名前ごと落とす */ for (const n of names) s = s.split(n).join("〇〇"); }
    for (const n of names) if (n.length >= 2) s = s.split(n).join("〇〇"); // 念のため（揺れの無い形）
  }
  return s.replace(/\d[\d\-‐－ー ]{8,}\d/g, "＊＊＊").replace(/\s+/g, " ").trim();
}

// ─── ② Jev（最初は影） ─────────────────────────────────────────────────────

export const JEV_ACTION = "screen_watch";
export const JEV_QUESTIONS = {
  label: {
    type: "choice" as const,
    instructions: "物件検索サイト（リアプロ・ITANDI・レインズ）を拡張が自動で操作している。渡した画面の状態から、今の画面の様子を1つ選ぶ。",
    criteria: {
      normal: "検索結果が普通に出ている・検索が進んでいる",
      stuck: "画面が進まず止まっている（待ちの時間切れ・動きが無い）",
      login_expired: "ログインの画面・ログインが切れた表示",
      modal_blocking: "モーダル（小窓）が開いたまま操作を止めている",
      wrong_conditions: "検索の条件が入り切っていない・件数が条件の効いていない量",
      zero_suspicious: "0件だが過去は物件があった（検索できていない疑い）",
      site_error: "サイトのエラー・メンテナンス・アクセス集中",
      unknown: "材料が足りず分からない",
    } as Record<ModelLabel, string>,
  },
};

/**
 * 2026-09-29 v2.5.41 Jev に渡すブレインの材料（見張りは意図を渡してよい・memory feedback_jev_brain_materials）:
 *   登録の条件・要望の項目・通勤の到達時間・今回だけか切り替えか・検索の意図・前回の検索からの時間。
 *   お客様の名前は入れない（竹内「顧客名はアカウント名やから…質が落ちないなら防ぐ」＝画面の様子の判断に名前は要らない＝伏せても質は落ちない）
 */
export type JevBrainMaterial = {
  conditions?: Record<string, unknown> | null;
  wants?: string[] | null;
  commute?: string | null;
  scope?: "temporary" | "permanent" | null;
  intent?: string | null;
  update_days?: { days: number | null; gap_hours: number | null; need_days: number | null } | null;
};

/** Jev に渡す state（仮名化済みの文字だけ・各120字） */
export function jevStateFor(m: WatchMaterial, masked: { count?: string; alert?: string; modal?: string }, det: Detection, brain: JevBrainMaterial | null = null): Record<string, unknown> {
  return {
    ...(brain ? { brain: {
      conditions: brain.conditions ?? null,
      wants: (brain.wants ?? []).slice(0, 12).map((w) => clip(w, 30)),
      commute: brain.commute ? clip(brain.commute, 60) : null,
      scope: brain.scope ?? null,
      intent: brain.intent ? clip(brain.intent, 200) : null,
      update_days: brain.update_days ?? null,
    } } : {}),
    update_findings: det.update_items.slice(0, 4).map((u) => clip(u.title, 60)),
    checkpoint: m.checkpoint,
    site: m.site ?? null,
    count_text: clip(masked.count, 120) || null,
    alert_text: clip(masked.alert, 120) || null,
    modal_text: clip(masked.modal, 120) || null,
    idle_minutes: m.idle_min ?? null,
    waiting_for: clip(m.waiting_for, 120) || null,
    drift: (m.checks ?? []).filter((c) => c.severity === "bad" && c.code !== "UPDATE_DAYS").slice(0, 5).map((c) => clip(c.title ?? c.code, 60)),
    past_count: m.range ? { low: m.range.low, high: m.range.high, median: m.range.median } : null,
    rule_hint: det.rules.slice(0, 6),
  };
}

/** Jev の答え → ラベル（知らないラベルは null） */
export function parseJevLabel(answers: Record<string, unknown> | null | undefined): { label: ModelLabel; prob: number | null } | null {
  const a = (answers ?? {})["label"] as { choice?: unknown; probabilities?: Record<string, unknown>; confidence?: unknown } | undefined;
  const c = typeof a?.choice === "string" ? a.choice : null;
  if (!c || !(MODEL_LABELS as readonly string[]).includes(c)) return null;
  const p = a?.probabilities && typeof a.probabilities[c] === "number" ? (a.probabilities[c] as number) : typeof a?.confidence === "number" ? (a.confidence as number) : null;
  return { label: c as ModelLabel, prob: p };
}

// ─── ③ DeepSeek（文字を先に・写真は文字が無い時だけ） ──────────────────────

export const SCREEN_WATCH_TEXT_VERSION = "screen-watch-text-v1";
export const SCREEN_WATCH_TEXT_PROMPT = `【見張り・画面の文字】${SCREEN_WATCH_TEXT_VERSION}
あなたは不動産の物件検索サイト（リアプロ＝realnetpro・ITANDI BB・レインズ）を Chrome 拡張が自動で操作している画面を見張る係です。
渡すのは、拡張が読んだその画面の文字（件数・ページ・注意の文・モーダル・表題・ページの頭）と、拡張の状態（段・待っている物・動きの無い分・入らなかった条件・過去の件数）です。
お客様の名前は伏せてあります。推測で画面の部品の名前を作らない。材料に無いことは書かない。
次のどれか1つを選んでください:
normal（検索が普通に進んでいる）／stuck（止まっている）／login_expired（ログインが切れた）／modal_blocking（モーダルが操作を止めている）／
wrong_conditions（条件が入り切っていない・件数が条件の効いていない量）／zero_suspicious（0件だが検索できていない疑い）／site_error（サイトのエラー・メンテナンス）／unknown（分からない）
JSON だけを返す: {"label":"…","reason_ja":"スタッフが読む理由を1文","confidence":0.0〜1.0}`;

export const SCREEN_WATCH_IMAGE_PROMPT = `【見張り・画面の写真】${SCREEN_WATCH_TEXT_VERSION}
あなたは不動産の物件検索サイトを Chrome 拡張が自動で操作している画面の写真を見る係です。拡張の帯（お客様の名前が出る所）は黒く塗ってあります。
写真に見えている物だけで、次のどれか1つを選んでください:
normal／stuck／login_expired／modal_blocking／wrong_conditions／zero_suspicious／site_error／unknown
JSON だけを返す: {"label":"…","reason_ja":"写真に見えている物を1文","confidence":0.0〜1.0}`;

export function buildTextUser(m: WatchMaterial, masked: { count?: string; page?: string; alert?: string; modal?: string; title?: string; head?: string }, det: Detection): string {
  const lines = [
    `段: ${m.checkpoint}`,
    `サイト: ${siteJa(m.site)}`,
    `件数の文: ${clip(masked.count, 120) || "（読めない）"}`,
    `ページ: ${clip(masked.page, 40) || "-"}`,
    `注意の文: ${clip(masked.alert, 120) || "-"}`,
    `モーダル: ${clip(masked.modal, 120) || "-"}`,
    `表題: ${clip(masked.title, 80) || "-"}`,
    `ページの頭: ${clip(masked.head, 200) || "-"}`,
    `動きの無い分: ${m.idle_min ?? "-"}・待っていた物: ${clip(m.waiting_for, 80) || "-"}`,
    `拡張の失敗: ${clip(m.error, 120) || "-"}`,
    `入らなかった条件: ${(m.checks ?? []).filter((c) => c.severity === "bad" && c.code !== "UPDATE_DAYS").slice(0, 5).map((c) => clip(c.title ?? c.code, 50)).join("／") || "-"}`,
    `過去の件数: ${m.range ? `中央値 ${m.range.median}（${m.range.low}〜${m.range.high ?? "-"}）` : "無し"}`,
    `決定論の見立て: ${det.label}（${det.rules.slice(0, 5).join(", ") || "-"}）`,
  ];
  return lines.join("\n");
}

function jsonObj(text: string): Record<string, unknown> | null {
  const s = String(text ?? "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(s.slice(a, b + 1)); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

export type ModelRead = { label: ModelLabel; reason_ja: string; confidence: number | null };
export function parseWatchText(text: string): ModelRead | null {
  const j = jsonObj(text);
  if (!j || typeof j.label !== "string" || !(MODEL_LABELS as readonly string[]).includes(j.label)) return null;
  const c = typeof j.confidence === "number" && j.confidence >= 0 && j.confidence <= 1 ? j.confidence : null;
  return { label: j.label as ModelLabel, reason_ja: clip(j.reason_ja, 200), confidence: c };
}

// ─── ④ 物件検索のブレインの裁定（提案だけ） ────────────────────────────────

export const SCREEN_WATCH_ARBITER_VERSION = "screen-watch-arbiter-v1";
export const SCREEN_WATCH_ARBITER_PROMPT = `【見張り・検索の決め方の裁定】${SCREEN_WATCH_ARBITER_VERSION}
あなたは不動産の物件検索のブレインです。1回の検索について「どの駅・区で検索するか」を決めた3つが食い違った時に、どれが正しいかを裁きます。
3つ: brain＝ブレインの意図（拡張が実際に入れようとした条件）／table＝決定論の表（お客様の登録の条件から別の道で出した期待）／screen＝画面に実際に入った値。
決まり:
・サイトごとの表記は別（リアプロ＝駅名・沿線は内部名／ITANDI＝路線ごとに駅／レインズ＝沿線と「◯駅〜◯駅」の範囲）。表記の違いだけならズレではない。
・通勤「梅田まで30分」は目的の駅に30分以内で着く駅（乗り換え1回まで・各停の目安・上限240駅＝所要の短い順に切る）。通勤の列だけで希望エリアが具体的な駅・地名なら広げない。
・広げて検索（is_wide）は周りの駅・区が増えてよい（余計ではない）。ピンポイントは名指しの駅・区だけ。
・お客様の言い直しは「ずっと」（登録の条件を直す）か「今回だけ」（一時調整）かを分ける。スタッフのメモの一時調整がある回はそれが正。
・再検索は1人1日1回まで・自動の再検索は今は行わない（提案だけ）。
お客様の名前は伏せてあります。材料に無いことは書かない。
JSON だけを返す: {"right":"brain|table|screen|unclear","missing":["抜けた駅・区"],"extra":["余計な駅・区"],"next":"none|re_search_temp|fix_registered|fix_rule|ask_staff","reason_ja":"理由を1〜2文","confidence":0.0〜1.0}`;

export type ArbiterRead = {
  right: "brain" | "table" | "screen" | "unclear";
  missing: string[];
  extra: string[];
  next: "none" | "re_search_temp" | "fix_registered" | "fix_rule" | "ask_staff";
  reason_ja: string;
  confidence: number | null;
};
export function parseArbiter(text: string): ArbiterRead | null {
  const j = jsonObj(text);
  if (!j) return null;
  const right = ["brain", "table", "screen", "unclear"].includes(String(j.right)) ? j.right as ArbiterRead["right"] : null;
  const next = ["none", "re_search_temp", "fix_registered", "fix_rule", "ask_staff"].includes(String(j.next)) ? j.next as ArbiterRead["next"] : null;
  if (!right || !next) return null;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => clip(x, 30)).filter(Boolean).slice(0, 20) : []);
  const c = typeof j.confidence === "number" && j.confidence >= 0 && j.confidence <= 1 ? j.confidence : null;
  return { right, missing: arr(j.missing), extra: arr(j.extra), next, reason_ja: clip(j.reason_ja, 300), confidence: c };
}

// ─── 結果の結び付け（その後の実際） ─────────────────────────────────────────

export type OutcomeFacts = {
  /** その回の点検の最後の札（重さ・原因の鍵・失敗の種類） */
  severity?: string | null;
  cause_key?: string | null;
  error_kind?: string | null;
  /** 24時間以内にスタッフが同じお客様×サイトで個別の検索をし、駅・区が違った */
  staffFixed?: boolean;
  /** 24時間以内に登録の条件が変わった */
  conditionChanged?: boolean;
  /** 見張りの後の経過（ms） */
  ageMs: number;
};
export type Outcome = "hit" | "false_alarm" | "miss" | "ok";
/** 本当の異常か（UPDATE_DAYS だけの warn は異常ではない） */
export function trulyAbnormal(f: OutcomeFacts): boolean {
  if (f.error_kind === "pass_deadline" || f.error_kind === "not_logged_in") return true;
  if (f.staffFixed || f.conditionChanged) return true;
  if (f.severity === "bad") return !String(f.cause_key ?? "").startsWith("update_days");
  return false;
}
/** 24時間たった時の当たり・外れ（まだなら null） */
export function outcomeOf(finalLabel: string, f: OutcomeFacts): { outcome: Outcome; detail: Record<string, unknown> } | null {
  if (f.ageMs < 24 * 3600_000) return null;
  const flagged = finalLabel !== "normal";
  const truth = trulyAbnormal(f);
  const outcome: Outcome = flagged ? (truth ? "hit" : "false_alarm") : (truth ? "miss" : "ok");
  return { outcome, detail: { severity: f.severity ?? null, cause_key: f.cause_key ?? null, error_kind: f.error_kind ?? null, staff_fixed: !!f.staffFixed, condition_changed: !!f.conditionChanged } };
}

/** 2つの駅・区の並びが違うか（スタッフが手で足した・外した） */
export function placesDiffer(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  const x = new Set(a.map((s) => String(s).normalize("NFKC").replace(/駅$/, "")));
  const y = new Set(b.map((s) => String(s).normalize("NFKC").replace(/駅$/, "")));
  if (x.size !== y.size) return true;
  for (const v of x) if (!y.has(v)) return true;
  return false;
}

// ─── 週のまとめ・線の自動調整 ───────────────────────────────────────────────

export type EventLite = {
  final_label: string; det_label?: string | null; jev_label?: string | null; jev_prob?: number | null; ds_label?: string | null;
  checkpoint?: string | null; outcome?: string | null; cost_usd?: number | null; arbiter?: Record<string, unknown> | null;
  material?: Record<string, unknown> | null; site?: string | null;
};

export function weeklyWatchStats(events: ReadonlyArray<EventLite>): {
  total: number; byLabel: Record<string, number>; byOutcome: Record<string, number>; costUsd: number;
  stage: Record<string, { hit: number; false_alarm: number; miss: number; ok: number }>;
  jevAgree: { n: number; agree: number }; missingPlaces: Array<{ name: string; n: number }>; arbiterRight: Record<string, number>;
} {
  const byLabel: Record<string, number> = {}, byOutcome: Record<string, number> = {}, arbiterRight: Record<string, number> = {};
  const stage: Record<string, { hit: number; false_alarm: number; miss: number; ok: number }> = {};
  const miss = new Map<string, number>();
  let cost = 0, jn = 0, ja = 0;
  for (const e of events) {
    byLabel[e.final_label] = (byLabel[e.final_label] ?? 0) + 1;
    if (e.outcome) byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    cost += Number(e.cost_usd ?? 0) || 0;
    const cp = e.checkpoint ?? "?";
    stage[cp] ??= { hit: 0, false_alarm: 0, miss: 0, ok: 0 };
    if (e.outcome && e.outcome in stage[cp]) stage[cp][e.outcome as Outcome]++;
    if (e.jev_label && e.det_label) { jn++; if ((e.jev_label === "normal") === (e.det_label === "normal")) ja++; }
    const r = e.arbiter as { right?: string; missing?: string[] } | null;
    if (r?.right) arbiterRight[r.right] = (arbiterRight[r.right] ?? 0) + 1;
    for (const m of r?.missing ?? []) miss.set(m, (miss.get(m) ?? 0) + 1);
    const dm = (e.material?.decision_missing ?? []) as string[];
    if (Array.isArray(dm)) for (const m of dm) miss.set(String(m), (miss.get(String(m)) ?? 0) + 1);
  }
  return {
    total: events.length, byLabel, byOutcome, costUsd: +cost.toFixed(6), stage, jevAgree: { n: jn, agree: ja },
    missingPlaces: [...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, n })), arbiterRight,
  };
}

/**
 * 件数の幅の倍率を当て直す（結果の分かった行だけ）。今の線と比べて「見逃し（miss）が増えず・誤警報が減る」候補だけを返す。
 *   行の material に count（画面の件数）と range_median（その時の過去の中央値）がある物だけ使う。当て直せない時は null
 */
export function tuneCountThresholds(events: ReadonlyArray<EventLite>, current: WatchThresholds): { thresholds: WatchThresholds; backtest: Record<string, unknown>; reason: string } | null {
  const rows = events.filter((e) => e.outcome && e.material && typeof e.material.count === "number" && typeof e.material.range_median === "number") as Array<EventLite & { material: { count: number; range_median: number } }>;
  if (rows.length < 30) return null;
  const truthOf = (e: EventLite) => e.outcome === "hit" || e.outcome === "miss";
  const score = (lo: number) => {
    let missN = 0, fa = 0;
    for (const e of rows) {
      const m = e.material.range_median;
      const low = m > 0 ? Math.max(1, Math.floor(m * lo)) : 0;
      const flagged = e.material.count === 0 && low >= 3;
      const truth = truthOf(e);
      if (truth && !flagged && e.material.count === 0) missN++;
      if (flagged && !truth) fa++;
    }
    return { miss: missN, false_alarm: fa };
  };
  const base = score(current.countLo);
  let best: { lo: number; s: { miss: number; false_alarm: number } } | null = null;
  for (const lo of [0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
    const s = score(lo);
    if (s.miss > base.miss) continue;
    if (s.false_alarm < (best?.s.false_alarm ?? base.false_alarm)) best = { lo, s };
  }
  if (!best || best.lo === current.countLo) return null;
  return {
    thresholds: { ...current, countLo: best.lo },
    backtest: { rows: rows.length, before: { countLo: current.countLo, ...base }, after: { countLo: best.lo, ...best.s } },
    reason: `件数の下限の倍率 ${current.countLo}→${best.lo}（見逃し ${base.miss}→${best.s.miss}・誤警報 ${base.false_alarm}→${best.s.false_alarm}）`,
  };
}

/**
 * Jev から DeepSeek に回す線（段2・gate の時だけ使う）。Jev の「normal でない」確率が線以上の時だけ DeepSeek に回すとして、
 *   本当の異常（hit／miss）を見逃す率が5%以下の一番高い線。結果の分かった行が100未満なら null
 */
export function tuneJevGate(events: ReadonlyArray<EventLite>): { prob: number; missRate: number; n: number } | null {
  const rows = events.filter((e) => e.outcome && e.jev_label && typeof e.jev_prob === "number");
  if (rows.length < 100) return null;
  const truth = rows.filter((e) => e.outcome === "hit" || e.outcome === "miss");
  if (!truth.length) return null;
  const abn = (e: EventLite) => (e.jev_label === "normal" ? 1 - (e.jev_prob as number) : (e.jev_prob as number));
  for (const p of [0.5, 0.4, 0.3, 0.2, 0.1, 0.05]) {
    const missed = truth.filter((e) => abn(e) < p).length;
    if (missed / truth.length <= 0.05) return { prob: p, missRate: +(missed / truth.length).toFixed(4), n: rows.length };
  }
  return null;
}

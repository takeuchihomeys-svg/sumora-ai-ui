// app/lib/search-widen-chain.ts（純関数・DB 依存なし・画面からも使える）
// ブレインモードの検索を「まずピンポイント → 足りなければ広げて（1回だけ）」にする決まり。
//
// 竹内さん（2026-09-27）:
//   「新着物件はピンポイントで検索して、物件がなかったら広げて検索する。新規の場合は10件、ピンポイント検索で出なかったら広げて検索をする。
//    そして上位10件が物件ピックアップに選ばれる形。ピンポイント検索で検索した物件はピンポイントなので加点する」
//   「まずピンポイント検索して、なければ広げて検索する形（おススメの物件や新着物件がなければ）。
//    また検索結果はピンポイント検索で行ったか広げて検索を行ったかもちゃんと分かるようにする（ブレインモードの場合）」
//
// 流れ（既存の作りに合わせた・拡張は変えずにサーバーがコマンドを積む）:
//   ① 拡張（ブレイン）がピンポイントで検索 → 検索の点検（search_audits・is_wide=false）と売上サポ（property_pickups・search_mode=pinpoint）に残る
//   ② サーバーが「足りるか」を決める（decideWiden）。呼ぶ所は3つ（どれも同じ関数・同じお客様×サイトで冪等）:
//        まとめ（finishCompleteGroup・判定と画像の読み取りが済んだ後）／検索の点検の finished（送れる物件が0件＝物件が届かない回）／
//        Cron（2分おき・物件が届かなかった回の拾い漏れ）
//   ③ 足りなければ AIXツールの一括検索と同じ web_brain のコマンド（is_wide:true・同じサイト・同じ更新日の決まり・payload.chain）を1つ積む
//        → ブレインの PC が拾って広げて検索（拡張の変更なし・拾い手の決まりも今まで通り）
//   ④ 広げての回が届いたら、同じまとめ（30分以内の joinableGroupId）に足されて順位と 👑 が付け直る。広げても足りなければ止める（もう積まない）
//
// 「足りない」の数え方: そのピンポイントの回（同じお客様×サイト・続けて検索した回＝area_mode both の2パスも1つ）で届いた行のうち、
//   ブレインの判定が「通す」（verdict=pass）の数。外す候補（送付済み・家賃3割超）・保留は数えない。
//   ※ 一度グループに送った建物は merge-pdfs が除く・送付済みは判定が外す候補にするので「送った物件を除いた通す」になる
//   新規（この検索の前に物件を出したことが無い＝更新日で絞らない回）: 10件未満なら広げる（PICKUP_AIX_MAX＝ピックアップに選ぶ上位10件をそろえる）
//   新着・追加（前に出したことがある＝更新日で絞った回）: 0件なら広げる
//
// 広げない（止める）時: 広げての回（is_wide）／ブレイン×スタッフ（人が選んで送る）／メモの上書きの回（「大正駅で検索」など人が範囲を決めた）／
//   レインズ（条件を入れるだけで物件が届かない）／比較の検索（scrape_compare）／同じお客様×サイトで広げてがもう積まれている・走っている／
//   この回の後に自動の広げてを積んだ（1回だけ）。分からない時は広げない（勝手に検索しない側に倒す）
import { PICKUP_AIX_MAX } from "./pickup-aix-handoff";
import { effectiveRpUpdateDays } from "./rp-update-days";

export type SearchMode = "pinpoint" | "widen";
export function normalizeSearchMode(v: unknown): SearchMode | null {
  return v === "pinpoint" || v === "widen" ? v : null;
}

/** 新規は上位10件（ピックアップに選ぶ数）がそろうまで・新着／追加は1件でも */
export const NEW_CUSTOMER_MIN_PASS = PICKUP_AIX_MAX;
export const ADDITIONAL_MIN_PASS = 1;
/** 同じピンポイントの回とみなす検索の間隔（area_mode both の地域→駅の2パス・itandi とリアプロは別サイトなので別に数える） */
export const SESSION_GAP_MS = 30 * 60_000;
/** 見る検索の古さの上限（これより前の検索では広げない） */
export const LOOKBACK_MS = 3 * 3600_000;
/** 検索の点検が started のまま（検索中）とみなす長さ（これを過ぎた started は止まった回として扱う） */
export const IN_PROGRESS_MS = 15 * 60_000;
/** 送れる物件があったのに行が1つも届いていない時に待つ長さ（merge-pdfs の記録は最長 約5分） */
export const ROWS_WAIT_MS = 8 * 60_000;
/** 地域→駅の2パスのお客様の1つ目（ward）が終わってから、2つ目が始まるのを待つ長さ */
export const BOTH_PASS_WAIT_MS = 5 * 60_000;

export type WidenKind = "new" | "additional";
export function passThreshold(kind: WidenKind): number {
  return kind === "new" ? NEW_CUSTOMER_MIN_PASS : ADDITIONAL_MIN_PASS;
}

/** 物件の届くサイト（売上サポ・検索の点検の呼び名）→ コマンドのサイト（web_brain）。レインズ・知らないサイトは null（広げない） */
export function commandSiteOf(site: string | null | undefined): "realnetpro" | "itandi" | null {
  const s = String(site ?? "").toLowerCase();
  if (s === "realpro" || s === "realnetpro" || s === "リアプロ") return "realnetpro";
  if (s === "itandi") return "itandi";
  return null;
}
/** 売上サポ・検索の点検の呼び名にそろえる（realpro / itandi / reins） */
export function pickupSiteOf(site: string | null | undefined): "realpro" | "itandi" | "reins" | null {
  const s = String(site ?? "").toLowerCase();
  if (s === "realpro" || s === "realnetpro" || s === "リアプロ") return "realpro";
  if (s === "itandi") return "itandi";
  if (s === "reins" || s === "レインズ") return "reins";
  return null;
}

export type AuditLite = {
  run_id: string;
  created_at: string;
  finished_at?: string | null;
  status: string | null;
  site: string | null;
  mode: string | null;
  trigger: string | null;
  is_wide: boolean | null;
  pass?: string | null;
  command_id?: string | null;
  result?: { sent_count?: number | null; read_rows?: number | null; property_count?: number | null } | null;
  customer_snapshot?: Record<string, unknown> | null;
  /** 入れようとした条件（rp_update_days＝その回の更新日） */
  intended?: Record<string, unknown> | null;
  ext_version?: string | null;
  /** 検索中の失敗（拡張の _auditFinish の error＝fill-done の時間切れ・例外・見張り 85秒・タブが応答しない）。無い回は null */
  error?: string | null;
  error_kind?: string | null;
};

/**
 * 2026-09-27 竹内「重い順から治す」（YUMA の点検 24 → Cron が自動の広げて 3e82fb32 を積んだ）: 「検索していない（失敗）」と「検索して0件」を分ける。
 *   検索できていない回 = error が付き、読んだ・送ったの数が無い（fill-done の時間切れ・例外・見張り・タブが応答しない）。
 *   もう1つ: started のまま IN_PROGRESS_MS を過ぎて結果も無い（拡張が止まって閉じられなかった）。
 *   ⚠ 5分の待ち切れ（検索は押せたが送信の完了が来ない）は result に batch_timed_out が付く＝検索はした回なのでここに入れない
 */
export function runDidNotSearch(a: AuditLite, nowMs: number): boolean {
  const r = a.result;
  const noCounts = r == null || (r.sent_count == null && r.read_rows == null && r.property_count == null);
  if (!noCounts) return false;
  if (a.error || a.error_kind) return true;
  const at = Date.parse(String(a.created_at ?? ""));
  return a.status === "started" && Number.isFinite(at) && nowMs - at >= IN_PROGRESS_MS;
}

/**
 * 個別の検索（trigger=single）の is_wide が正しく残る拡張の版。2.5.27 までは finished が is_wide=false で上書きし、
 *   広げての個別の検索が「ピンポイント」と記録されていた → それより前の版の個別の検索では広げない（広げての後にもう一度広げない）
 */
export const SINGLE_IS_WIDE_FIXED_VERSION = "2.5.28";
function versionAtLeast(v: string | null | undefined, min: string): boolean {
  if (!v) return false;
  const a = v.split(".").map((x) => Number(x) || 0), b = min.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d !== 0) return d > 0; }
  return true;
}
export type PickupLite = {
  id: number;
  created_at: string;
  site: string | null;
  verdict: string | null;
  search_mode?: string | null;
  complete_group_id?: string | null;
};
export type ChainCommandLite = {
  id: string;
  created_at: string;
  status: string;
  sites?: string[] | null;
  customer_ids?: string[] | null;
  payload?: { source?: unknown; is_wide?: unknown; chain?: WidenChainInfo | null } | null;
};
/** 積んだコマンドの payload.chain（画面と拡張のログが読む） */
export type WidenChainInfo = {
  from: "pinpoint";
  kind: WidenKind;
  pass_count: number;
  threshold: number;
  /** 元のピンポイントの回（検索の点検の run_id） */
  pinpoint_run_ids: string[];
  pinpoint_started_at: string;
  site: "realpro" | "itandi";
  /** 広げての回の更新日（ピンポイントの回と同じ値＝同じ新着の幅で広げる。null＝絞らない） */
  rp_update_days: number | null;
  /**
   * 2026-09-30 v2.5.44 広げての回のリアプロの並び（新規＝ad・送った後＝updated）とページの上限。
   *   広げる中身は拡張の今の「広げて検索」のまま（段は作らない）
   */
  sort?: "ad" | "updated";
  max_pages?: number;
  /** 送った後の累計の線で広げた時の材料（直近のピンポイントの回の数・送れる物件0件の時間） */
  cumulative?: { runs: number; zero_hours: number } | null;
};

export type WidenDecision =
  | { action: "widen"; reason: string; chain: WidenChainInfo }
  | { action: "enough"; reason: string; kind: WidenKind; passCount: number; threshold: number }
  | { action: "wait"; reason: string }
  | { action: "skip"; reason: string };

const ms = (s: string | null | undefined) => { const v = Date.parse(String(s ?? "")); return Number.isFinite(v) ? v : NaN; };

/**
 * 新規か（この検索の前に物件を出したことが無い）。検索の点検の customer_snapshot（検索を始めた時のお客様の写し）の
 *   last_property_sent_at・property_viewed_at が両方空なら新規（＝拡張が更新日で絞らない回・rp-update-days と同じ線）。
 *   merge-pdfs は送るたびに last_property_sent_at を今に書き直すので、判定の時のお客様の行ではなく検索を始めた時の写しを見る。
 *   写しが無い時は予備: その回より前の送付の記録の件数（0なら新規）
 */
export function classifyKind(
  snapshot: Record<string, unknown> | null | undefined, sentBeforeSession: number | null,
  actual: { firstProposalAt?: string | null; sessionStartMs?: number; originState?: string | null } = {},
): WidenKind {
  // 2026-09-30 v2.5.44 竹内さんの決定「状態の判定は実際にお客様へ届けた送付で」:
  //   ① 自動便の計画（plan_by_customer の state）があればそれ（新規・条件の言い直し＝new／それ以外＝additional）
  //   ② 実際にお客様へ届けた最初の送付（isProposalSend）がこの回より後／無い＝new・前＝additional
  //   ③ 読めない時だけ今までの写し（last_property_sent_at は merge-pdfs が自動検索の回でも書くので汚れている）
  const os = actual.originState ?? null;
  if (os === "new" || os === "cond_changed") return "new";
  if (os === "active" || os === "dormant" || os === "dormant_hot") return "additional";
  if (actual.firstProposalAt !== undefined) {
    if (actual.firstProposalAt === null) return "new";
    const f = Date.parse(actual.firstProposalAt);
    if (Number.isFinite(f) && actual.sessionStartMs != null && Number.isFinite(actual.sessionStartMs)) return f >= actual.sessionStartMs ? "new" : "additional";
    if (Number.isFinite(f)) return "additional";
  }
  if (snapshot && typeof snapshot === "object") {
    const has = (k: string) => typeof snapshot[k] === "string" && Number.isFinite(Date.parse(snapshot[k] as string));
    return has("last_property_sent_at") || has("property_viewed_at") ? "additional" : "new";
  }
  return (sentBeforeSession ?? 1) > 0 ? "additional" : "new";
}

function hasOverride(a: AuditLite): boolean {
  const s = a.customer_snapshot;
  return !!(s && typeof s === "object" && (s as Record<string, unknown>)._search_override);
}

/**
 * そのお客様×サイトの一番新しいピンポイントの回（続けて検索した回をまとめる）。無ければ null。
 * audits はそのお客様の検索の点検（順不同・他のサイトも混ざってよい）
 */
export function pinpointSession(audits: ReadonlyArray<AuditLite>, site: string, nowMs: number): { latest: AuditLite; runs: AuditLite[]; startMs: number } | null {
  const sk = pickupSiteOf(site);
  const mine = audits
    .filter((a) => pickupSiteOf(a.site) === sk && Number.isFinite(ms(a.created_at)) && nowMs - ms(a.created_at) <= LOOKBACK_MS)
    .sort((a, z) => ms(z.created_at) - ms(a.created_at));
  const latest = mine[0];
  if (!latest) return null;
  const runs: AuditLite[] = [latest];
  for (let i = 1; i < mine.length; i++) {
    const a = mine[i];
    if (a.is_wide === true) break;
    if (ms(runs[runs.length - 1].created_at) - ms(a.created_at) > SESSION_GAP_MS) break;
    runs.push(a);
  }
  return { latest, runs, startMs: Math.min(...runs.map((r) => ms(r.created_at))) };
}

export type DecideInput = {
  site: string;
  audits: ReadonlyArray<AuditLite>;
  rows: ReadonlyArray<PickupLite>;
  commands: ReadonlyArray<ChainCommandLite>;
  nowMs: number;
  /** 写しが無い時の予備（その回より前の送付の記録の件数） */
  sentBeforeSession?: number | null;
  /** 検索の点検の finished から呼んだ（物件が届かない回だけ決める。送れる物件があった回はまとめの時に決める） */
  fromAuditFinish?: boolean;
  /** 2026-09-29 見張り（screen-watch）: 「条件が入り切っていない・0件の疑い」の印（search_audits.watch.block_widen）が付いた回の run_id。
   *  このピンポイントの回（続けて検索した回）に1つでも入っていれば自動の広げてを止める */
  watchBlocked?: ReadonlyArray<string>;
  /** 2026-09-30 v2.5.44 実際にお客様へ届けた最初の送付（null＝まだ・undefined＝読めない） */
  firstProposalAt?: string | null;
  /** 2026-09-30 v2.5.44 そのピンポイントの回を積んだ命令の計画（payload.plan_by_customer[id].state） */
  originState?: string | null;
  /**
   * 2026-09-30 竹内「午後の便は…もっと限定的に」: そのピンポイントの回を積んだ命令の計画が自動の広げてを許すか
   *   （payload.plan_by_customer[id].widen_chain・午後の便は false）。false の時は広げない（新規の広げては午前だけ）。無い命令は今まで通り
   */
  originWidenChain?: boolean | null;
  /**
   * 2026-09-30 v2.5.44 送った後（additional）は「毎回0件なら」でなく累計の線（cumulativeWiden）で広げる。
   *   audits・rows・commands は CUMULATIVE_LOOKBACK_DAYS 日分を渡す。SEARCH_WIDEN_CUMULATIVE=off で今までの1回ごと
   */
  cumulative?: boolean;
};

// ── 送った後の累計の線（2026-09-30 v2.5.44 竹内さんの決定） ────────────────────────────
// 送った後の回は「前回の検索以降だけ」なので新着が0件なのは正常。1回ごとの「0件なら広げる」をやめ、
//   直近のピンポイントの回が3回以上・48時間以上送れる物件（通す）が0件・広げては7日に1回まで、の時だけ広げる。
//   実データ: 広げての回から送った物件は 728行中1件（0.1%）・自動で広げた29回からの送付は0件（設計 wf_7b9c28ba）
export const CUMULATIVE_MIN_RUNS = 3;
export const CUMULATIVE_ZERO_HOURS = 48;
export const CUMULATIVE_EVERY_DAYS = 7;
export const CUMULATIVE_LOOKBACK_DAYS = 7;
/** 累計の線で広げる時の更新日（前回以降の窓では狭すぎる・広げての回は止める線なし） */
export const CUMULATIVE_WIDEN_DAYS = 7;

export function cumulativeWiden(i: { site: string; audits: ReadonlyArray<AuditLite>; rows: ReadonlyArray<PickupLite>; commands: ReadonlyArray<ChainCommandLite>; nowMs: number }):
  { ok: boolean; reason: string; runs: number; zeroHours: number | null } {
  const sk = pickupSiteOf(i.site);
  const cmdSite = commandSiteOf(sk);
  const since = i.nowMs - CUMULATIVE_LOOKBACK_DAYS * 86400_000;
  const lastChain = i.commands.filter((c) => c.payload?.chain && (c.sites ?? []).some((s) => commandSiteOf(s) === cmdSite) && ms(c.created_at) >= i.nowMs - CUMULATIVE_EVERY_DAYS * 86400_000);
  if (lastChain.length) return { ok: false, reason: "widened_within_7d", runs: 0, zeroHours: null };
  const runs = i.audits
    .filter((a) => pickupSiteOf(a.site) === sk && a.is_wide === false && a.status === "finished" && a.mode !== "brain_staff" && ms(a.created_at) >= since && !runDidNotSearch(a, i.nowMs))
    .sort((a, z) => ms(a.created_at) - ms(z.created_at));
  // 続けて検索した回（地域→駅の2パス）は1回に数える
  const sessions: number[] = [];
  for (const r of runs) { const t = ms(r.created_at); if (!sessions.length || t - sessions[sessions.length - 1] > SESSION_GAP_MS) sessions.push(t); }
  const passTimes = i.rows.filter((r) => pickupSiteOf(r.site) === sk && r.verdict === "pass" && normalizeSearchMode(r.search_mode) !== "widen" && ms(r.created_at) >= since).map((r) => ms(r.created_at));
  const lastPass = passTimes.length ? Math.max(...passTimes) : null;
  const after = sessions.filter((t) => lastPass == null || t > lastPass);
  const zeroFrom = lastPass ?? (sessions.length ? sessions[0] : null);
  const zeroHours = zeroFrom == null ? null : Math.round(((i.nowMs - zeroFrom) / 3600_000) * 10) / 10;
  if (after.length < CUMULATIVE_MIN_RUNS) return { ok: false, reason: `runs_${after.length}_of_${CUMULATIVE_MIN_RUNS}`, runs: after.length, zeroHours };
  if (zeroHours == null || zeroHours < CUMULATIVE_ZERO_HOURS) return { ok: false, reason: `zero_${zeroHours ?? 0}h_of_${CUMULATIVE_ZERO_HOURS}h`, runs: after.length, zeroHours };
  return { ok: true, reason: "cumulative", runs: after.length, zeroHours };
}

/** 足りるか・広げるか（純関数）。広げる時は積むコマンドの payload.chain を返す */
export function decideWiden(input: DecideInput): WidenDecision {
  const { nowMs } = input;
  const site = pickupSiteOf(input.site);
  if (!commandSiteOf(site)) return { action: "skip", reason: "site" };
  const sess = pinpointSession(input.audits, site as string, nowMs);
  if (!sess) return { action: "skip", reason: "no_audit" };
  const { latest, runs } = sess;
  if (latest.is_wide !== false) return { action: "skip", reason: latest.is_wide ? "latest_is_widen" : "unknown_mode" };
  if (latest.mode === "brain_staff") return { action: "skip", reason: "staff" };
  if (!latest.trigger || latest.trigger === "scrape_compare") return { action: "skip", reason: "trigger" };
  if (runs.some((r) => r.trigger === "single" && !versionAtLeast(r.ext_version, SINGLE_IS_WIDE_FIXED_VERSION))) return { action: "skip", reason: "old_ext_single" };
  if (runs.some(hasOverride)) return { action: "skip", reason: "override" };
  // 午後の便（計画の widen_chain=false）から続く広げては積まない
  if (input.originWidenChain === false) return { action: "skip", reason: "plan_no_chain" };
  // 見張りが「条件が入り切っていない検索」と見た回は、足りない理由が検索の失敗かもしれない＝広げて上塗りしない（人が見る）
  if (input.watchBlocked?.length && runs.some((r) => input.watchBlocked!.includes(r.run_id))) return { action: "skip", reason: "watch_blocked" };
  const startMs = sess.startMs;
  // 1回だけ: この回の後に自動の広げてを積んだ・同じお客様×サイトの広げてが積まれている／走っている
  const cmdSite = commandSiteOf(site);
  const sameSite = (c: ChainCommandLite) => (c.sites ?? []).some((s) => commandSiteOf(s) === cmdSite);
  if (input.commands.some((c) => sameSite(c) && c.payload?.chain && ms(c.created_at) >= startMs - 60_000)) return { action: "skip", reason: "already_chained" };
  if (input.commands.some((c) => sameSite(c) && (c.status === "pending" || c.status === "running"))) return { action: "skip", reason: "queued" };
  // まだ検索中の回がある
  if (runs.some((r) => r.status === "started" && nowMs - ms(r.created_at) < IN_PROGRESS_MS)) return { action: "wait", reason: "in_progress" };
  // 検索できなかった回（失敗）は0件と数えない＝広げない。地域→駅の2パスの片方だけの失敗も、足りるかが分からないので広げない（分からない時は検索しない側）
  if (runs.some((r) => runDidNotSearch(r, nowMs))) return { action: "skip", reason: "pinpoint_failed" };
  // 地域→駅の2パスの1つ目が終わったところ（2つ目がこれから始まる）
  const latestFin = ms(latest.finished_at) || ms(latest.created_at);
  if (latest.pass === "ward" && nowMs - latestFin < BOTH_PASS_WAIT_MS) return { action: "wait", reason: "both_pass" };
  const rows = input.rows.filter((r) => pickupSiteOf(r.site) === site && ms(r.created_at) >= startMs - 60_000 && normalizeSearchMode(r.search_mode) !== "widen");
  const sentAny = runs.some((r) => (r.result?.sent_count ?? 0) > 0);
  const sentUnknown = runs.some((r) => r.result?.sent_count == null);
  if (input.fromAuditFinish && (sentAny || sentUnknown)) return { action: "wait", reason: "rows_coming" };
  // 送れる物件があった（または分からない）のに行がまだ無い: merge-pdfs の記録を待つ（全部送付済みで行が作られない時は待った後に0件で決める）
  if (!rows.length && (sentAny || sentUnknown) && nowMs - latestFin < ROWS_WAIT_MS) return { action: "wait", reason: "rows_coming" };
  // 届いた行がまだまとめられていない（判定・画像の読み取りの途中）→ まとめの時に決める
  if (rows.some((r) => !r.complete_group_id)) return { action: "wait", reason: "not_complete" };
  const kind = classifyKind(runs[runs.length - 1].customer_snapshot ?? latest.customer_snapshot ?? null, input.sentBeforeSession ?? null,
    { firstProposalAt: input.firstProposalAt, sessionStartMs: startMs, originState: input.originState ?? null });
  const threshold = passThreshold(kind);
  const passCount = rows.filter((r) => r.verdict === "pass").length;
  if (passCount >= threshold) return { action: "enough", reason: "enough", kind, passCount, threshold };
  // 送った後は累計の線（1回の0件では広げない）
  let cumulative: { runs: number; zero_hours: number } | null = null;
  if (kind === "additional" && input.cumulative) {
    const c = cumulativeWiden({ site: site as string, audits: input.audits, rows: input.rows, commands: input.commands, nowMs });
    if (!c.ok) return { action: "skip", reason: `cumulative_not_yet:${c.reason}` };
    cumulative = { runs: c.runs, zero_hours: c.zeroHours ?? 0 };
  }
  return {
    action: "widen",
    reason: kind === "new" ? "new_under_threshold" : cumulative ? "additional_cumulative" : "additional_none",
    chain: {
      from: "pinpoint", kind, pass_count: passCount, threshold,
      pinpoint_run_ids: runs.map((r) => r.run_id).slice(0, 5),
      pinpoint_started_at: new Date(startMs).toISOString(),
      site: site as "realpro" | "itandi",
      rp_update_days: cumulative ? CUMULATIVE_WIDEN_DAYS : sessionRpUpdateDays(runs, startMs),
      // 2026-09-30 v2.5.44 新規＝AD 順・送った後＝更新順（竹内さんの決定）・ページの上限5
      sort: kind === "new" ? "ad" : "updated",
      max_pages: CHAIN_MAX_PAGES,
      cumulative,
    },
  };
}

/** 広げての回のページの上限（auto-search-schedule.SEARCH_MAX_PAGES・拡張 DEFAULT_MAX_PAGES と同じ 5） */
export const CHAIN_MAX_PAGES = 5;

/**
 * 広げての回の更新日: ピンポイントの回に実際に入れようとした値（intended.rp_update_days）。無ければ検索を始めた時の写しから同じ決まりで。
 *   ⚠ お客様の今の行から計算しない（merge-pdfs が送った時に last_property_sent_at を今にするので「1日以内」になってしまう）
 */
export function sessionRpUpdateDays(runs: ReadonlyArray<AuditLite>, startMs: number): number | null {
  for (const r of runs) {
    const v = r.intended?.rp_update_days;
    if (typeof v === "number" && v > 0) return v;
    if (r.intended && "rp_update_days" in r.intended && r.intended.rp_update_days == null) return null;
  }
  const snap = runs[runs.length - 1]?.customer_snapshot;
  if (!snap) return null;
  return effectiveRpUpdateDays({
    rp_update_days: typeof snap.rp_update_days === "number" ? snap.rp_update_days : null,
    last_property_sent_at: typeof snap.last_property_sent_at === "string" ? snap.last_property_sent_at : null,
    property_viewed_at: typeof snap.property_viewed_at === "string" ? snap.property_viewed_at : null,
  }, startMs);
}

// ── 画面の1行（売上サポの回の見出し） ────────────────────────────────────────

export type ChainNote = { site: "realpro" | "itandi"; line: string; tone: "info" | "warn" | "stop" };

const SITE_JA: Record<string, string> = { realpro: "リアプロ", itandi: "itandi" };

/**
 * 自動で広げた回の説明（画面の回の見出しの下）。commands はそのお客様の web_brain のコマンド（chain の付いた物だけ使う）・
 *   rows はそのお客様の売上サポの行。広げても足りなければ「ここで止めます」
 */
export function widenChainNotes(commands: ReadonlyArray<ChainCommandLite>, rows: ReadonlyArray<PickupLite>, nowMs: number = Date.now()): ChainNote[] {
  const out: ChainNote[] = [];
  const chains = commands.filter((c) => c.payload?.chain && nowMs - ms(c.created_at) <= 24 * 3600_000)
    .sort((a, z) => ms(z.created_at) - ms(a.created_at));
  const seen = new Set<string>();
  for (const c of chains) {
    const ch = c.payload!.chain as WidenChainInfo;
    const site = pickupSiteOf(ch.site) as "realpro" | "itandi" | null;
    if (!site || seen.has(site)) continue;
    seen.add(site);
    const head = `🎯 ピンポイントで通す物件が ${ch.pass_count}件（${ch.kind === "new" ? `新規は${ch.threshold}件そろうまで` : ch.cumulative ? `送った後: 直近${ch.cumulative.runs}回・${Math.round(ch.cumulative.zero_hours)}時間 送れる物件なし` : "新着・追加は1件も無い時"}）→ 🔎 自動で広げて検索`;
    const widened = rows.filter((r) => pickupSiteOf(r.site) === site && normalizeSearchMode(r.search_mode) === "widen" && ms(r.created_at) >= ms(c.created_at));
    const widePass = widened.filter((r) => r.verdict === "pass").length;
    const siteJa = SITE_JA[site] ?? site;
    if (c.status === "pending") out.push({ site, tone: "info", line: `${siteJa}: ${head}を積みました（ブレインの PC が拾うのを待っています）` });
    else if (c.status === "running") out.push({ site, tone: "info", line: `${siteJa}: ${head}中です` });
    else if (c.status === "error" || c.status === "cancelled") out.push({ site, tone: "warn", line: `${siteJa}: ${head}は動きませんでした（${c.status === "cancelled" ? "止めた" : "失敗・ブレインの PC が無い"}）` });
    else {
      const total = ch.pass_count + widePass;
      const enough = total >= ch.threshold;
      out.push({
        site, tone: enough ? "info" : "stop",
        line: `${siteJa}: ${head}しました（広げて通す物件 ${widePass}件・合わせて ${total}件）${enough ? "" : "。広げても足りないので、ここで止めます（もう広げません）"}`,
      });
    }
  }
  return out;
}

/** 回（まとめ）の検索の種類の1行: 「🎯 ピンポイント 5件・🔎 広げて 3件」。どちらも分からない回は null */
export function roundSearchModeLine(items: ReadonlyArray<{ search_mode?: string | null }>): { line: string; mixed: boolean; pinpoint: number; widen: number } | null {
  const p = items.filter((x) => normalizeSearchMode(x.search_mode) === "pinpoint").length;
  const w = items.filter((x) => normalizeSearchMode(x.search_mode) === "widen").length;
  if (!p && !w) return null;
  const parts: string[] = [];
  if (p) parts.push(`🎯 ピンポイント ${p}件`);
  if (w) parts.push(`🔎 広げて ${w}件`);
  const unknown = items.length - p - w;
  if (unknown > 0) parts.push(`検索の種類が分からない ${unknown}件`);
  return { line: parts.join("・"), mixed: p > 0 && w > 0, pinpoint: p, widen: w };
}

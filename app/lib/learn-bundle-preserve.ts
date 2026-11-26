/**
 * 束の学習成果を消さない（2026-11-17）
 *
 *   実測: 本番 fresh / 約31分ごとの再生成（source_rows=6000）が
 *   shots.learned の solid 96→0 を繰り返す。直前1件だけ見ると連鎖消失。
 *
 *   → 直近履歴から learned / foundation_audit / 駅遷移 を継ぐ。
 *   → 継いでも solid=0 のままなら「消す書き込み」として拒否できる判定を返す。
 *
 * ★ 2026-11-18:
 *   lookback=20 だと solid=0 の連打で 96 行が窓外 → historyHadSolid=false で 0 insert が合法になる穴。
 *   → 既定 lookback=80／履歴に solid≥min があれば別クエリで必ず拾う／site は all もフォールバック。
 *   → 履歴 SELECT 失敗時は solid 不足なら safe_to_write=false（読めない＝消す書き込みを許さない）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyBundleAliasExpansion } from "./field-name-aliases";
import { isPlaybookNewerThanCode, pickNewestPlaybook } from "./playbook-freshness";
import { PLAYBOOK_BUILD_V } from "./action-playbook";
import { AUTO_RULES_REVIEWED_UP_TO } from "./auto-procedure-rules";
import { SCENE_JA, describeSceneFlow, type SceneFlow } from "./learn-flow-steps";

export type BundlePreserveResult = {
  solid: number;
  preserved: boolean;
  preserved_solid: number;
  has_fa: boolean;
  has_transit: boolean;
  /** true ならこの束を最新として書いてよい（消す書き込みではない） */
  safe_to_write: boolean;
  why: string;
  /** 履歴読み取り失敗（RLS・鍵・一時障害） */
  read_error?: string | null;
};

export const INHERIT_LOOKBACK_DEFAULT = 80;
export const INHERIT_LOOKBACK_MAX = 200;

export function countLearnedSolid(bundle: unknown): { solid: number; learned: unknown } {
  const learned = (bundle as { shots?: { learned?: unknown } } | null)?.shots?.learned;
  let solid = 0;
  if (learned && typeof learned === "object") {
    for (const list of Object.values(learned as Record<string, unknown>)) {
      for (const f of Array.isArray(list) ? list : []) {
        const rec = f as { x?: unknown; y?: unknown; n?: unknown };
        if (typeof rec?.x !== "number" || typeof rec?.y !== "number") continue;
        if ((Number(rec.n) || 0) >= 3) solid++;
      }
    }
  }
  return { solid, learned: learned ?? null };
}

export function hasStationTransitSteps(bundle: unknown): boolean {
  const sf = (bundle as { scene_flows?: Array<{ scene?: string; steps?: string[] }> } | null)?.scene_flows;
  const st = Array.isArray(sf) ? sf.find((x) => x.scene === "station") : null;
  return !!(st?.steps || []).some((s) => /駅の設定へ進む|沿線の設定へ戻る|one_station/.test(String(s)));
}

/**
 * ★ 2026-11-19 竹内さん「1は危ない可能性がある」:
 *   旧は site 別（realpro/itandi）の束が足りない時に **all の束から位置を継いでいた**。
 *   実測: itandi の束（自前 206 欄）が all（realpro 878 欄）の位置で上書きされた（2409 を取り消し）。
 *   → 位置は**その site の履歴だけ**から継ぐ。all へは落とさない（サイトを混ぜない）。
 */
function scopesToSearch(scope: string): string[] {
  const s = String(scope || "all");
  return [s];
}

type HistRow = { bundle: unknown; created_at?: string };

/**
 * 2026-11-21 作業員G（台帳 #588・②）: 引き継ぎで前の束を丸ごと（bundle 列）読んでいた（束の作り直し1回で 31MB）。
 *   引き継ぎが使うのは shots・foundation_audit・scene_flows の3つだけなので、その3つだけを読む（中身の決め方は変えない）。
 *   既定 on（11/22・止める LEARN_HISTORY_SLIM=off）
 */
export function learnHistorySlimOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  // 2026-11-22 土台の点検の on/off で全 F の差 0 を確かめて既定 on（止める: LEARN_HISTORY_SLIM=off）
  return (env.LEARN_HISTORY_SLIM ?? "").trim().toLowerCase() !== "off";
}
/**
 * ★ 2.8.297（追補）細く読む時も、手順書の「作った版」の印だけは読む（pb_up_to・pb_build＝数文字）。
 *   実測（2026-11-25 点検）: 標準が on なので、手順書本体（数十万字）を読まない細い読みでは、履歴の新しい手順書を
 *   prepareBundleForWrite に渡せず、古いコードで潰さない歯止めが本番の標準の経路で働いていなかった。
 *   → 印だけ読み、コードより新しい物が履歴にある時だけ、その1行の手順書を1回だけ読む（inheritLinkFoundations）。
 */
export const HISTORY_SLIM_SELECT = "created_at,shots:bundle->shots,foundation_audit:bundle->foundation_audit,scene_flows:bundle->scene_flows,pb_up_to:bundle->playbook->>rules_up_to,pb_build:bundle->playbook->>build_v";
function historySelect(): string { return learnHistorySlimOn() ? HISTORY_SLIM_SELECT : "bundle,created_at"; }
/** 細く読んだ行を、引き継ぎが読む形（bundle の中の3つ）に戻す（純関数） */
export function toHistRow(r: unknown): HistRow {
  const o = (r ?? {}) as Record<string, unknown>;
  if ("bundle" in o) return o as HistRow;
  const bundle: Record<string, unknown> = {};
  for (const k of ["shots", "foundation_audit", "scene_flows"]) if (o[k] != null) bundle[k] = o[k];
  const created_at = typeof o.created_at === "string" ? o.created_at : undefined;
  // ★ 2.8.297（追補）手順書の印だけ（本体は読んでいない＝__stamp_only）。いつの行かも持つ（必要な時に1行だけ読み直すため）
  if (o.pb_up_to != null && String(o.pb_up_to).trim() !== "") {
    bundle.playbook = { rules_up_to: String(o.pb_up_to), build_v: Number(o.pb_build) || 0, __stamp_only: true, __at: created_at };
  }
  return { bundle, created_at };
}

async function loadHistoryRows(
  sb: SupabaseClient,
  scope: string,
  lookback: number,
): Promise<{ rows: HistRow[]; error: string | null }> {
  const { data, error } = await sb
    .from("human_learn_profile")
    .select(historySelect())
    .eq("scope", scope)
    .order("created_at", { ascending: false })
    .limit(lookback);
  if (error) return { rows: [], error: String(error.message || "history_read").slice(0, 120) };
  return { rows: ((data || []) as unknown[]).map(toHistRow), error: null };
}

/** 窓内に無くても solid≥min の最新1件を拾う（lookback 溢れ対策） */
async function loadBestSolidRow(
  sb: SupabaseClient,
  scope: string,
  minSolid: number,
  scan: number,
): Promise<{ row: HistRow | null; error: string | null }> {
  const { data, error } = await sb
    .from("human_learn_profile")
    .select(historySelect())
    .eq("scope", scope)
    .order("created_at", { ascending: false })
    .limit(scan);
  if (error) return { row: null, error: String(error.message || "best_solid_read").slice(0, 120) };
  let best: HistRow | null = null;
  let bestSolid = 0;
  for (const row of ((data || []) as unknown[]).map(toHistRow)) {
    const s = countLearnedSolid(row.bundle).solid;
    if (s >= minSolid && s > bestSolid) {
      bestSolid = s;
      best = row as HistRow;
    }
  }
  return { row: best, error: null };
}

type LearnedRec = { name?: unknown; kind?: unknown; x?: unknown; y?: unknown; n?: unknown };

function isSolidRec(r: LearnedRec | undefined): boolean {
  return !!r && typeof r.x === "number" && typeof r.y === "number" && (Number(r.n) || 0) >= 3;
}

/**
 * 古い learned と今作った learned を**欄ごとに**合わせる（純関数）。
 *   ・同じ欄（画面・名前・種類・同じ名前の何個目か）が両方にある → 今の方。ただし古い方が確か（n≥3）で今の方が確かでない時だけ古い方
 *   ・古い方にしか無い欄 → 残す／今の方にしか無い欄 → 足す
 *   ⚠ 旧は古い learned で**丸ごと置き換え**ていた。今作った束は直近 10000 行しか読まないので
 *     確かな欄が古い束より少なく、毎回置き換わる → 2026-11-19 00:54 から 38 束 learned が1字も変わらず、
 *     その後に読んだ写真（11-20 の 147枚・欄 4327個）が束に届いていなかった。
 *   確かな欄の数は古い束より減らない（消さない守りはそのまま）。
 */
export function mergeLearnedKeepSolid(
  cur: unknown,
  old: unknown,
): { learned: Record<string, unknown[]>; from_new: number; kept_old: number } {
  const asMap = (v: unknown): Record<string, unknown[]> => {
    const out: Record<string, unknown[]> = {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, list] of Object.entries(v as Record<string, unknown>)) if (Array.isArray(list)) out[k] = list;
    return out;
  };
  const curM = asMap(cur);
  const oldM = asMap(old);
  const keyed = (list: unknown[]) => {
    const seen = new Map<string, number>();
    return list.map((r) => {
      const rec = (r && typeof r === "object" ? r : {}) as LearnedRec;
      const base = `${String(rec.name ?? "")}\u0000${String(rec.kind ?? "")}`;
      const i = seen.get(base) ?? 0;
      seen.set(base, i + 1);
      return { key: `${base}\u0000${i}`, rec: r };
    });
  };
  const learned: Record<string, unknown[]> = {};
  let from_new = 0, kept_old = 0;
  for (const screen of new Set([...Object.keys(curM), ...Object.keys(oldM)])) {
    const oldByKey = new Map(keyed(oldM[screen] ?? []).map((e) => [e.key, e.rec]));
    const out: unknown[] = [];
    const used = new Set<string>();
    for (const e of keyed(curM[screen] ?? [])) {
      const o = oldByKey.get(e.key) as LearnedRec | undefined;
      if (o && isSolidRec(o) && !isSolidRec(e.rec as LearnedRec)) { out.push(o); kept_old++; }
      else { out.push(e.rec); from_new++; }
      used.add(e.key);
    }
    for (const [k, r] of oldByKey) if (!used.has(k)) { out.push(r); kept_old++; }
    if (out.length) learned[screen] = out;
  }
  return { learned, from_new, kept_old };
}

function applyLearnedFromOld(
  bundle: Record<string, unknown>,
  oldB: unknown,
  oldSolid: number,
): void {
  const old = countLearnedSolid(oldB);
  if (!old.learned || typeof old.learned !== "object") return;
  const curSh = ((bundle.shots as Record<string, unknown>) || {});
  const oldSh = ((oldB as { shots?: Record<string, unknown> })?.shots || {});
  const merged = mergeLearnedKeepSolid(curSh.learned, old.learned);
  bundle.shots = {
    ...oldSh,
    ...curSh,
    learned: merged.learned,
    learned_from_new: merged.from_new,
    preserved_learned: true,
    preserved_solid: oldSolid,
    in_storage: Math.max(Number(curSh.in_storage) || 0, Number(oldSh.in_storage) || 0),
    kinds: (curSh.kinds && typeof curSh.kinds === "object" && Object.keys(curSh.kinds as object).length)
      ? curSh.kinds
      : (oldSh.kinds ?? curSh.kinds ?? {}),
  };
}

/**
 * 履歴から学習土台を継ぎ足す（破壊的に bundle を更新）。
 * lookback 既定 80（最大 200）。
 */
/**
 * inheritLinkFoundations 等で bundle.scene_flows の station 手順が後から差し替わった時、
 * bundle.supervisor / supervisor_by_site.realpro 内の「場面: ...」行を最新 scene_flows と同期する。
 *   ※ 統括の判断文・矛盾自体は一切書き換えず、機械的に生成された scene_flows の転記行だけを一致させる。
 */
export function syncSupervisorSceneFlows(bundle: Record<string, unknown>, site?: string | null): number {
  const flows = Array.isArray(bundle.scene_flows) ? (bundle.scene_flows as SceneFlow[]) : [];
  if (!flows.length) return 0;
  const targets: Array<Record<string, unknown>> = [];
  const sup = bundle.supervisor as Record<string, unknown> | null | undefined;
  if (sup && typeof sup === "object") targets.push(sup);
  const bySite = bundle.supervisor_by_site as Record<string, unknown> | null | undefined;
  if (bySite && typeof bySite === "object") {
    const sKey = site === "itandi" ? "itandi" : "realpro";
    const sSup = bySite[sKey] as Record<string, unknown> | null | undefined;
    if (sSup && typeof sSup === "object") targets.push(sSup);
  }
  let synced = 0;
  for (const t of targets) {
    const meeting = t.meeting as { evidence?: Array<{ label?: string; value?: string; guessed?: boolean }> } | null | undefined;
    const ev = Array.isArray(meeting?.evidence) ? meeting.evidence : null;
    if (!ev) continue;
    for (const f of flows) {
      if (!f || !f.scene) continue;
      const ja = SCENE_JA[f.scene];
      if (!ja) continue;
      const label = `場面: ${ja}`;
      const expected = describeSceneFlow(f).replace(`${ja}: `, "");
      for (const row of ev) {
        if (row && row.label === label && row.value !== expected) {
          row.value = expected;
          synced++;
        }
      }
    }
  }
  return synced;
}

export async function inheritLinkFoundations(
  sb: SupabaseClient,
  bundle: Record<string, unknown>,
  scope: string,
  opt: { lookback?: number; minSolid?: number } = {},
): Promise<BundlePreserveResult> {
  const lookback = Math.max(5, Math.min(INHERIT_LOOKBACK_MAX, opt.lookback ?? INHERIT_LOOKBACK_DEFAULT));
  const minSolid = opt.minSolid ?? 30;
  const needFa = !bundle.foundation_audit;
  // ★ 2026-11-27: ITANDI / REINS にリアプロ固有の駅手順（駅の設定へ進む 等）を継承しない（#2520→#2821 の無限連鎖汚染を止める）
  const isRealproFamily = scope !== "itandi" && scope !== "reins";
  const needTransit = isRealproFamily && !hasStationTransitSteps(bundle);
  if (!isRealproFamily && Array.isArray(bundle.scene_flows)) {
    const cleanFlows: Array<{ scene?: string; steps?: string[] }> = [];
    for (const f of bundle.scene_flows as Array<{ scene?: string; steps?: string[] }>) {
      if (f && f.scene === "station" && Array.isArray(f.steps)) {
        const keptSteps = f.steps.filter((s) => !/駅の設定へ進む|沿線の設定へ戻る|one_station|沿線・駅絞り込み/.test(String(s)));
        if (keptSteps.length) cleanFlows.push({ ...f, steps: keptSteps });
      } else {
        cleanFlows.push(f);
      }
    }
    bundle.scene_flows = cleanFlows;
  }

  let preserved = false;
  let preserved_solid = 0;
  let read_error: string | null = null;
  let historyHadSolid = false;

  const scopes = scopesToSearch(scope);
  const historyPlaybooks: Array<Record<string, unknown>> = [];

  for (const sc of scopes) {
    const { rows, error } = await loadHistoryRows(sb, sc, lookback);
    if (error) {
      read_error = read_error || `${sc}:${error}`;
      continue;
    }
    for (const row of rows) {
      // ★ 2.8.297: 履歴の一番新しい手順書を覚える（prepareBundleForWrite が「古いコードで新しい手順書を潰さない」ために使う）
      const hp = (row.bundle as { playbook?: Record<string, unknown> | null } | null)?.playbook;
      if (hp && typeof hp === "object") {
        if (hp.__stamp_only) hp.__scope = sc;
        historyPlaybooks.push(hp);
      }
      const old = countLearnedSolid(row.bundle);
      if (old.solid >= minSolid) historyHadSolid = true;
      const curSolid = countLearnedSolid(bundle).solid;
      if (
        old.solid >= minSolid
        && old.learned
        && typeof old.learned === "object"
        && old.solid > curSolid
      ) {
        applyLearnedFromOld(bundle, row.bundle, old.solid);
        preserved = true;
        preserved_solid = Math.max(preserved_solid, old.solid);
      }
      if (needFa && !bundle.foundation_audit) {
        const fa = (row.bundle as { foundation_audit?: unknown } | null)?.foundation_audit;
        if (fa && typeof fa === "object") bundle.foundation_audit = fa;
      }
      if (needTransit && !hasStationTransitSteps(bundle)) {
        const sf = (row.bundle as { scene_flows?: Array<{ scene?: string; steps?: string[]; runs?: number; ops?: number }> } | null)?.scene_flows;
        const st = Array.isArray(sf)
          ? sf.find((x) => x.scene === "station" && (x.steps || []).some((s) => /駅の設定へ進む|沿線の設定へ戻る/.test(String(s))))
          : null;
        if (st?.steps?.length) {
          const flows = Array.isArray(bundle.scene_flows)
            ? [...(bundle.scene_flows as Array<{ scene?: string; steps?: string[] }>)]
            : [];
          const ix = flows.findIndex((x) => x.scene === "station");
          if (ix >= 0) flows[ix] = { ...flows[ix], steps: st.steps };
          else flows.push({ scene: "station", steps: st.steps, runs: st.runs || 1, ops: st.ops || st.steps.length } as never);
          bundle.scene_flows = flows;
        }
      }
      const now = countLearnedSolid(bundle);
      if (now.solid >= minSolid && now.solid >= preserved_solid && bundle.foundation_audit && (!needTransit || hasStationTransitSteps(bundle))) {
        break;
      }
    }
  }

  // lookback 窓外の solid≥min も必ず拾う（0 連打で窓外に押し出された 96 を救出）
  if (countLearnedSolid(bundle).solid < minSolid || !historyHadSolid) {
    for (const sc of scopes) {
      const { row, error } = await loadBestSolidRow(sb, sc, minSolid, INHERIT_LOOKBACK_MAX);
      if (error) {
        read_error = read_error || `${sc}:best:${error}`;
        continue;
      }
      if (!row) continue;
      const old = countLearnedSolid(row.bundle);
      if (old.solid >= minSolid) historyHadSolid = true;
      if (old.solid > countLearnedSolid(bundle).solid) {
        applyLearnedFromOld(bundle, row.bundle, old.solid);
        preserved = true;
        preserved_solid = Math.max(preserved_solid, old.solid);
      }
    }
  }

  /** inherit 後も拡張の完全一致引き用に別名を載せる */
  applyBundleAliasExpansion(bundle);
  /** 駅遷移などを後から継いだとき、統括 evidence の「場面: ...」行を最新 scene_flows と同期させる */
  try { syncSupervisorSceneFlows(bundle, scope); } catch { /* */ }

  // ★ 2.8.297: 履歴の一番新しい手順書を「列挙されない印」で束に載せる（JSON にも DB にも出ない・prepareBundleForWrite が読んで消す）
  try {
    let newest = pickNewestPlaybook<Record<string, unknown>>(historyPlaybooks);
    // コードより新しい物だけ残す価値がある（そうでなければ作り直してよい＝本体は要らない）
    if (newest && !isPlaybookNewerThanCode(newest, { upTo: AUTO_RULES_REVIEWED_UP_TO, build: PLAYBOOK_BUILD_V })) newest = null;
    // 細い読みで印だけの時は、その1行の手順書本体を1回だけ読む（読めなければ印を付けない＝今までの動き）
    if (newest && newest.__stamp_only) {
      const at = String(newest.__at ?? ""), sc = String(newest.__scope ?? "");
      let full: Record<string, unknown> | null = null;
      if (at && sc) {
        const { data, error } = await sb
          .from("human_learn_profile")
          .select("playbook:bundle->playbook")
          .eq("scope", sc)
          .eq("created_at", at)
          .limit(1);
        const p = !error && Array.isArray(data) ? (data[0] as { playbook?: unknown } | undefined)?.playbook : null;
        if (p && typeof p === "object" && !Array.isArray(p) && (p as { rules_up_to?: unknown }).rules_up_to != null) full = p as Record<string, unknown>;
      }
      newest = full;
    }
    if (newest) {
      Object.defineProperty(bundle, "__prev_playbook", { value: newest, enumerable: false, configurable: true, writable: true });
    }
  } catch { /* 印が付かなくても書く（今までの動き） */ }

  const solid = countLearnedSolid(bundle).solid;
  const has_fa = !!bundle.foundation_audit;
  const has_transit = hasStationTransitSteps(bundle);

  /**
   * 読めないのに solid 不足 → 消す書き込みを許さない（空履歴と RLS 失敗を混ぜない）
   * 履歴に solid≥min がある／自前で足りる、以外は拒否。
   */
  if (read_error && solid < minSolid) {
    return {
      solid,
      preserved,
      preserved_solid,
      has_fa,
      has_transit,
      safe_to_write: false,
      why: `履歴読めず消す書き込み拒否（新solid=${solid}・${read_error}）`,
      read_error,
    };
  }

  const safe_to_write = solid >= minSolid || !historyHadSolid;
  const why = safe_to_write
    ? (preserved ? `引き継ぎsolid=${preserved_solid}` : solid >= minSolid ? `自前solid=${solid}` : "履歴にsolid無し・初回可")
    : `消す書き込み拒否（新solid=${solid}・履歴に≥${minSolid}あり）`;

  return { solid, preserved, preserved_solid, has_fa, has_transit, safe_to_write, why, read_error };
}

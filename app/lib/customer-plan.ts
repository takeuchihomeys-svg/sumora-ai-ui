// app/lib/customer-plan.ts — お客様ごとの全体の統括の計画（conversations.customer_plan）を、ブレインの番の後に1回だけ組む（純関数・DB/LLM なし）
//
// 竹内さん 11/15「お客様ごとの全体の統括（それ作る・全体的に強化）」（台帳 #101・統括役の OK 11/21・作業員M）。
//   今ある部品は番ごとの last_brain_meta にあって次の番で上書きされる＝お客様ごとに続いて残る置き場が無かった。
//   ここで番の部品から計画を組み、前の計画と比べて「変わった欄」を残す。文と道は変えない（記録だけ・読む側は後で既定 off）。
// 欄の名前は作業員L の連携の地図（DECIDED_ITEMS: focus・push_strength・next_send）と situation_now（promise_id・ask_id・sent_id）にそろえる。
//   station        … 地図の駅（conversations.status・meta.checkpoint_stage）
//   focus          … 統括の重点（meta.conductor_focus.focus）
//   aims           … この番の狙い・中期の狙い・仕込み（meta.turn_aims）。since＝中期の狙いが同じまま続いている始まりの時刻
//   next_send      … 次に送る物（統括の指示書 conductor_brief.next の行き先・強さ＝push_strength・時機）と前の通とのつながり（meta.next_send_link）
//   promises_open  … 開いている約束（situation_now.promises_open の promise_id・kind・経った時間）
//   asks           … まだ答えていない要件・約束して結果がまだの要件（要件の帳面の ask_id）
//   sent_recent    … 最近送った物（situation_now.sent の sent_id・kind・物件）
//   feeling        … 今の気持ちの状態（customer_mindset.state）と前の計画からの動き（同じ・変わった）
//   property_policy… 探す条件の要約（property_search_params の鍵だけ・値は短く）
//   changed        … 前の計画から変わった欄の名前
// スイッチ CUSTOMER_PLAN（既定 shadow＝ブレインの後に conversations.customer_plan に書くだけ／off＝何もしない）。
// テスト: app/lib/__tests__/customer-plan.test.ts

type Env = Record<string, string | undefined>;
export type CustomerPlanMode = "off" | "shadow";
export function customerPlanMode(env: Env = typeof process !== "undefined" ? process.env : {}): CustomerPlanMode {
  return (env.CUSTOMER_PLAN ?? "").trim().toLowerCase() === "off" ? "off" : "shadow";
}

export type CustomerPlan = {
  v: 1;
  updated_at: string;
  seen_customer_at: string | null;
  station: { status: string | null; checkpoint_stage: string | null };
  focus: string | null;
  aims: { state: string | null; turn_aim: string | null; mid_aim: string | null; plant: string | null; since: string | null };
  next_send: { dest: string | null; push_strength: string | null; timing: string | null; link_kind: string | null; link_refs: Array<Record<string, string>> };
  promises_open: Array<{ promise_id: string; kind: string; due_h: number | null }>;
  asks: { open: string[]; promised: string[] };
  sent_recent: Array<{ sent_id: string; kind: string; props: string[] }>;
  feeling: { state: string | null; prev_state: string | null; moved: boolean };
  property_policy: Record<string, string>;
  changed: string[];
};

const s = (v: unknown, n = 60): string | null => (typeof v === "string" && v.trim() && v !== "null" ? v.trim().slice(0, n) : null);
const o = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 探す条件の要約（鍵と短い値だけ・名前や本文は入れない） */
function policyOf(p: unknown): Record<string, string> {
  const r = o(p);
  if (!r) return {};
  const keep = ["area", "areas", "stations", "rent_max", "rent_min", "layout", "layouts", "move_in", "walk_minutes", "built_year", "pet", "must", "ng_properties"];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = r[k];
    if (v == null || v === "") continue;
    out[k] = (Array.isArray(v) ? `${v.length}件` : typeof v === "object" ? "あり" : String(v)).slice(0, 40);
  }
  return out;
}

/** 番の meta（ブレインの後）と前の計画から、今の計画を組む（純関数） */
export function buildCustomerPlan(i: { meta: Record<string, unknown> | null | undefined; status?: string | null; prev?: unknown; nowIso: string }): CustomerPlan | null {
  const m = i.meta;
  if (!m) return null;
  const prev = o(i.prev) as Partial<CustomerPlan> | null;
  const ta = o(m.turn_aims);
  const brief = o(m.conductor_brief);
  const bn = o(brief?.next);
  const link = o(m.next_send_link);
  const sn = o(m.situation_now);
  const led = o(m.ask_ledger);
  const carry = o(m.ask_carry);
  const ms = o(m.customer_mindset);
  const midAim = s(ta?.mid_aim, 40);
  const prevAims = o(prev?.aims);
  const since = midAim && prevAims && prevAims.mid_aim === midAim && typeof prevAims.since === "string" ? prevAims.since : midAim ? i.nowIso : null;
  // 前の番から持ち越した物（ask_carry）が無ければ、この番の要件のうち行き先がある物（ブレインの直後＝まだ送っていない）
  const ledOpen = arr(led?.items).filter((e) => o(e)?.route !== "none").map((e) => String(o(e)?.id ?? "")).filter(Boolean);
  const state = s(ms?.state, 20);
  const prevFeeling = o(prev?.feeling);
  const plan: CustomerPlan = {
    v: 1,
    updated_at: i.nowIso,
    seen_customer_at: s(m.analyzed_msg_ts, 40),
    station: { status: s(i.status, 30), checkpoint_stage: s(m.checkpoint_stage, 30) },
    focus: s(o(m.conductor_focus)?.focus, 30),
    aims: { state: s(ta?.state, 30), turn_aim: s(ta?.turn_aim, 40), mid_aim: midAim, plant: s(ta?.plant, 40), since },
    next_send: {
      dest: s(bn?.dest, 30), push_strength: s(bn?.strength, 20), timing: s(bn?.timing, 30),
      link_kind: s(link?.kind, 30), link_refs: arr(link?.refs).slice(0, 4).map((r) => Object.fromEntries(Object.entries(o(r) ?? {}).map(([k, v]) => [k, String(v).slice(0, 80)]))),
    },
    promises_open: arr(sn?.promises_open).slice(0, 6).map((p) => ({ promise_id: String(o(p)?.promise_id ?? ""), kind: String(o(p)?.kind ?? ""), due_h: typeof o(p)?.due_h === "number" ? (o(p)!.due_h as number) : null })).filter((p) => p.promise_id),
    asks: {
      open: (arr(carry?.open).length ? arr(carry?.open) : ledOpen).map(String).slice(0, 8),
      promised: arr(carry?.promised).map(String).slice(0, 8),
    },
    sent_recent: arr(sn?.sent).slice(-3).map((x) => ({ sent_id: String(o(x)?.sent_id ?? ""), kind: String(o(x)?.kind ?? ""), props: arr(o(x)?.props).map((p) => String(p).slice(0, 30)).slice(0, 4) })).filter((x) => x.sent_id),
    feeling: { state, prev_state: s(prevFeeling?.state, 20), moved: !!state && !!prevFeeling?.state && prevFeeling.state !== state },
    property_policy: policyOf(m.property_search_params),
    changed: [],
  };
  plan.changed = prev ? planChangedFields(prev, plan) : ["新しい計画"];
  return plan;
}

const KEYS: Array<keyof CustomerPlan> = ["station", "focus", "aims", "next_send", "promises_open", "asks", "sent_recent", "feeling", "property_policy"];
/** 前の計画から変わった欄（時刻・since・changed は比べない） */
export function planChangedFields(prev: Partial<CustomerPlan>, cur: CustomerPlan): string[] {
  const norm = (k: keyof CustomerPlan, v: unknown) => {
    if (k === "aims" && v && typeof v === "object") { const { since: _s, ...rest } = v as Record<string, unknown>; void _s; return JSON.stringify(rest); }
    if (k === "feeling" && v && typeof v === "object") return String((v as Record<string, unknown>).state ?? "");
    return JSON.stringify(v ?? null);
  };
  return KEYS.filter((k) => norm(k, prev[k]) !== norm(k, cur[k]));
}

// ── 読む側（2026-11-21 作業員M・台帳 #101 の (2)・統括役の OK）: 統括の指示書が前の番の計画を読む（既定 off）──────────
/** CONDUCTOR_BRIEF_PLAN=on の時だけ、統括の指示書に前の計画の欄（plan）を足す（記録だけ・書き手の役目の対応表には入れない＝文は変えない） */
export function conductorBriefPlanOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CONDUCTOR_BRIEF_PLAN ?? "").trim().toLowerCase() === "on";
}
export type PlanBriefSection = {
  mid_aim: string | null;
  /** 中期の狙いが続いている時間（時間） */
  aim_hours: number | null;
  /** 前の計画の次に送る物と、この番の統括の次の一手が同じ行き先か（same／changed／unknown） */
  next_vs_plan: "same" | "changed" | "unknown";
  prev_next: { dest: string | null; push_strength: string | null };
  /** 24時間以上開いている約束（promise_id） */
  overdue_promises: string[];
  /** 前の番から持ち越した、まだ答えていない要件の数 */
  carried_open: number;
  /** 気持ちが前の計画から動いたか（前の状態 → 今） */
  feeling_moved: string | null;
};
/** 前の計画と今の番の meta から、指示書に足す欄を作る（純関数）。前の計画が無ければ null */
export function planBriefSection(prev: unknown, meta: Record<string, unknown> | null | undefined, nowMs: number): PlanBriefSection | null {
  const p = o(prev) as Partial<CustomerPlan> | null;
  if (!p || p.v !== 1) return null;
  const pa = o(p.aims), pn = o(p.next_send);
  const nowNext = o(o(o(meta)?.conductor_brief)?.next);
  const nowDest = s(nowNext?.dest, 30);
  const prevDest = s(pn?.dest, 30);
  const since = typeof pa?.since === "string" ? Date.parse(pa.since) : NaN;
  const ms = o(o(meta)?.customer_mindset);
  const nowState = s(ms?.state, 20);
  const prevState = s(o(p.feeling)?.state, 20);
  return {
    mid_aim: s(pa?.mid_aim, 40),
    aim_hours: Number.isFinite(since) ? Math.round((nowMs - since) / 36e5) : null,
    next_vs_plan: !prevDest || !nowDest ? "unknown" : prevDest === nowDest ? "same" : "changed",
    prev_next: { dest: prevDest, push_strength: s(pn?.push_strength, 20) },
    overdue_promises: arr(p.promises_open).filter((x) => typeof o(x)?.due_h === "number" && (o(x)!.due_h as number) >= 24).map((x) => String(o(x)?.promise_id ?? "")).filter(Boolean).slice(0, 4),
    carried_open: arr(o(p.asks)?.open).length,
    feeling_moved: prevState && nowState && prevState !== nowState ? `${prevState}→${nowState}` : null,
  };
}

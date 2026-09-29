// app/lib/aix-jev-materials.ts
// LINE 返信の AIX 用の Jev（aix-jev.ts）に渡す「ブレインの材料」を組む純関数。
//
// 2026-09-29 竹内「Jev の判断の部分にブレインや物件検索の部分の大切な部分は与えられる形になっているのか？」→
//   調べると AIX の Jev は会話の文（8通）と段階・送った数・見積書・直前の AIX しか持っていなかった。
//   決定（memory feedback_jev_brain_materials）: **材料は渡す・ブレインの答えは渡さない**。AIX 用と物件検索用は別々（名札・記録・費用も別）。
//
// ── 渡す（ブレインが同じ場面で見ている材料・どれも「事実」か「お客様の要約」）──
//   ・customer_summary   … property_customers.ai_summary_json の 状況（situation）・希望（requirements）・こだわり（opinions）・温度感・時期感
//   ・registered_conditions … 登録の条件（エリア・駅・通勤の到達時間・家賃・広さ・設備・NG・その他の要望）＝「家賃を上げて」の元の上限が分かる
//   ・stage               … customer-state の今の段階（初回／提案中／見積送付済み／内覧予定…・決定論）と主のお部屋の状態・内覧の予定
//   ・records             … 行動台帳（action-ledger）の確定事実: 送った物件の数と最後の時刻・見積書・約束したが未実行の物・確認の報告・内覧の案内
//   ・recent_aix          … スタッフが実際に送った直近の AIX（種類・ピッカー・どれだけ前か）
//   ・condition_scope_cue … 今回のお客様の文にある「今回だけ」「切り替え」の語（condition-change-scope の決定論の語だけ）
//
// ── 渡さない（影の比べで「別々に考えて一致するか」を測るため・Jev が写すだけにならないように）──
//   ・ブレインの結論: 次の AIX（suggested_aix_button・action）・check_pattern・send_mode・condition_change_scope・reply_mode
//   ・ai_summary_json の next_action（次の一手）・winning_pattern（勝ち筋）・purchase_signal_level（ブレインの買う気の読み）
//   ・conversation_direction.current_phase（ブレインの段階）・customer-state の conflicts（PHASE_MISMATCH はブレインの段階を含む）
//
// ── 個人情報 ──
//   竹内さん 2026-09-29「顧客名はアカウント名なので、質が落ちる可能性あるなら防がなくて大丈夫だが、質が落ちないなら防ぐ」
//   → AIX の種類・ピッカーの判断にお客様の名前は要らない（名前で答えが変わる場面が無い）ので、**文は全部 mask（pii-pseudonym／maskPII）を通す**。
//     物件名（建物名＋部屋）はお客様の個人情報ではなく、会話の文でも同じ名前が出る（どの物件の話かの照合に要る）ので残す（mask は通す）。
//   ・申込以降の会話は呼び出し側で渡さない（isPostApplyStatus）。
import type { LedgerFacts } from "./action-ledger";
import type { CustomerState } from "./customer-state";
import { temporaryScopeCue, permanentScopeCue } from "./condition-change-scope";
import { jstAgo } from "./jst-date";

/** property_customers の読む列（brain-core の pc と同じ名前） */
export type JevCustomerRow = {
  desired_area?: string | null; area_mode?: string | null; floor_plan?: string | null;
  rent_min?: number | null; rent_max?: number | null; floor_area_min?: number | null; floor_area_max?: number | null;
  walk_minutes?: number | null; commute_station?: string | null; commute_minutes?: number | null;
  move_in_time?: string | null; pet?: boolean | null; initial_cost_limit?: number | null; building_age?: number | null;
  preferences?: string | null; ng_points?: string | null; other_requests?: string | null;
  ai_summary_json?: Record<string, unknown> | null;
};

export type JevRecentAixRow = { aix_type: string | null; check_pattern?: string | null; send_mode?: string | null; app_sub_mode?: string | null; created_at: string; sent_at?: string | null };

export type AixJevMaterialsInput = {
  /** 今（「どれだけ前か」の基準・過去の場面の評価ではその場面の時刻） */
  now?: number;
  customer?: JevCustomerRow | null;
  state?: Pick<CustomerState, "stage" | "stageLabel" | "stageDetail" | "upcomingViewing" | "viewings" | "focusKey" | "properties" | "searching"> | null;
  ledger?: LedgerFacts | null;
  /** 新しい順・送った（sent_at あり）物だけ使う */
  recentAix?: ReadonlyArray<JevRecentAixRow> | null;
  /** 今回のお客様の文（未返信の連投。仮名化の前でよい＝ここで mask する） */
  latestCustomerText?: string | null;
  /** 仮名化（pii-pseudonym の maskBlock か pii-mask の maskPII）。必ず渡す */
  mask: (s: string) => string;
};

export type AixJevMaterials = {
  customer_summary?: Record<string, unknown>;
  registered_conditions?: Record<string, unknown>;
  stage?: Record<string, unknown>;
  records?: Record<string, unknown>;
  recent_aix?: Array<Record<string, unknown>>;
  condition_scope_cue?: { temporary: string | null; permanent: string | null };
};

/** ai_summary_json から渡す欄（結論の欄 next_action・winning_pattern・purchase_signal_level は入れない） */
export const SUMMARY_FIELDS_FOR_JEV = ["situation", "requirements", "opinions", "emotion", "urgency"] as const;
/** 渡さない欄（テストで固定する） */
export const SUMMARY_FIELDS_WITHHELD = ["next_action", "winning_pattern", "purchase_signal_level", "personality_profile"] as const;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const man = (yen: number | null | undefined) => (typeof yen === "number" && yen > 0 ? `${Math.round(yen / 1000) / 10}万` : null);

function summaryOf(json: Record<string, unknown> | null | undefined, mask: (s: string) => string): Record<string, unknown> | undefined {
  if (!json || typeof json !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const k of SUMMARY_FIELDS_FOR_JEV) {
    const v = (json as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) out[k] = mask(clip(v.trim(), 200));
    else if (Array.isArray(v)) {
      const arr = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 5).map((x) => mask(clip(x.trim(), 120)));
      if (arr.length) out[k] = arr;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function conditionsOf(c: JevCustomerRow | null | undefined, mask: (s: string) => string): Record<string, unknown> | undefined {
  if (!c) return undefined;
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== "") out[k] = v; };
  const txt = (s: string | null | undefined, n = 200) => (s && s.trim() ? mask(clip(s.trim().replace(/\s+/g, " "), n)) : null);
  put("area", txt(c.desired_area));
  if (c.area_mode && c.area_mode !== "auto") put("area_mode", c.area_mode);
  put("floor_plan", txt(c.floor_plan, 60));
  put("rent_min", man(c.rent_min));
  put("rent_max", man(c.rent_max));
  if (c.floor_area_min || c.floor_area_max) put("floor_area", `${c.floor_area_min ? `${c.floor_area_min}㎡以上` : ""}${c.floor_area_max ? `${c.floor_area_max}㎡以下` : ""}`);
  if (c.walk_minutes) put("walk_minutes_max", c.walk_minutes);
  if (c.commute_station) put("commute", `${txt(c.commute_station, 40)}${c.commute_minutes ? `まで${c.commute_minutes}分以内` : ""}`);
  put("move_in", txt(c.move_in_time, 60));
  if (c.pet != null) put("pet", c.pet ? "可が必要" : "不要");
  put("initial_cost_max", man(c.initial_cost_limit));
  if (c.building_age) put("building_age_max", `${c.building_age}年以内`);
  put("preferences", txt(c.preferences));
  put("ng", txt(c.ng_points));
  put("other_requests", txt(c.other_requests));
  return Object.keys(out).length ? out : undefined;
}

function stageOf(s: AixJevMaterialsInput["state"], now: number, mask: (s: string) => string): Record<string, unknown> | undefined {
  if (!s) return undefined;
  const focus = s.focusKey ? s.properties.find((p) => p.key === s.focusKey) ?? null : null;
  const byStatus: Record<string, number> = {};
  for (const p of s.properties) byStatus[p.statusLabel] = (byStatus[p.statusLabel] ?? 0) + 1;
  const out: Record<string, unknown> = { stage: s.stageLabel };
  if (s.stageDetail) out.stage_detail = mask(clip(s.stageDetail, 80));
  if (focus) {
    out.focus_room = {
      name: mask(clip(focus.name, 40)), status: focus.statusLabel, sent_by_us: focus.sentByUs,
      customer_interest: focus.customerInterest, estimate_sent: focus.estimateSent, vacating: focus.vacating,
      last_event: jstAgo(focus.lastAt, now),
    };
  }
  if (s.properties.length) out.rooms_by_status = byStatus;
  if (s.upcomingViewing) out.upcoming_viewing = s.upcomingViewing.label;
  const done = s.viewings.filter((v) => v.status === "done").length;
  if (done) out.viewings_done = done;
  if (s.searching?.active) out.searching = s.searching.reason;
  return out;
}

function recordsOf(f: LedgerFacts | null | undefined, now: number): Record<string, unknown> | undefined {
  if (!f) return undefined;
  const out: Record<string, unknown> = {
    properties_sent: f.propertiesSentCount,
    estimate_sent: f.estimateSent,
  };
  if (f.lastPropertiesSentAt) out.last_properties_sent = jstAgo(f.lastPropertiesSentAt, now);
  if (f.propertiesSentSinceCustomerLatest) out.properties_sent_after_customer_latest = true;
  if (f.estimateSentFor.length) out.estimate_sent_count = f.estimateSentFor.length;
  const promised: string[] = [];
  if (f.pickupPromisedUnfulfilled) promised.push(`物件のピックアップ${f.pickupPromisedAt ? `（${jstAgo(f.pickupPromisedAt, now)}）` : ""}`);
  if (f.estimatePromisedUnfulfilled) promised.push("見積書");
  if (f.confirmationPromisedUnfulfilled) promised.push(`確認${f.confirmationPromisedObject ? `（${f.confirmationPromisedObject}）` : ""}`);
  if (promised.length) out.promised_not_done = promised;
  if (f.confirmationReported) out.confirmation_reported = f.confirmationReportDetail ?? f.confirmationReportPattern ?? true;
  if (f.viewingInvited) out.viewing_invited = true;
  if (f.meetingPlaceSent) out.meeting_place_sent = true;
  if (f.viewingAppointment) out.viewing_appointment = f.viewingAppointment.day;
  if (f.viewingDone) out.viewing_done = true;
  if (f.applicationGuided) out.application_guided = true;
  if (f.conditionAsked) out.condition_asked = true;
  if (f.lastDoneKind) out.last_done = `${f.lastDoneKind}${f.lastDoneAt ? `（${jstAgo(f.lastDoneAt, now)}）` : ""}`;
  return out;
}

function recentAixOf(rows: AixJevMaterialsInput["recentAix"], now: number): Array<Record<string, unknown>> | undefined {
  const sent = (rows ?? []).filter((r) => r.aix_type && (r.sent_at ?? null) !== null).slice(0, 3);
  if (!sent.length) return undefined;
  return sent.map((r) => {
    const o: Record<string, unknown> = { aix: r.aix_type, when: jstAgo(r.sent_at ?? r.created_at, now) };
    if (r.check_pattern) o.check_pattern = r.check_pattern;
    if (r.send_mode) o.send_mode = r.send_mode;
    if (r.app_sub_mode) o.app_sub_mode = r.app_sub_mode;
    return o;
  });
}

/**
 * AIX 用の Jev の材料（JSON）。何も材料が無ければ null（state に入れない＝今までと同じ）。
 * ⚠ ブレインの結論は入れない（上の「渡さない」）。文は必ず input.mask を通す。
 */
export function buildAixJevMaterials(input: AixJevMaterialsInput): AixJevMaterials | null {
  const now = input.now ?? Date.now();
  const out: AixJevMaterials = {};
  const summary = summaryOf(input.customer?.ai_summary_json ?? null, input.mask);
  if (summary) out.customer_summary = summary;
  const cond = conditionsOf(input.customer, input.mask);
  if (cond) out.registered_conditions = cond;
  const stage = stageOf(input.state, now, input.mask);
  if (stage) out.stage = stage;
  const records = recordsOf(input.ledger, now);
  if (records) out.records = records;
  const aix = recentAixOf(input.recentAix, now);
  if (aix) out.recent_aix = aix;
  const text = input.latestCustomerText ?? "";
  if (text.trim()) {
    const temporary = temporaryScopeCue(text);
    const permanent = permanentScopeCue(text);
    if (temporary || permanent) out.condition_scope_cue = { temporary, permanent };
  }
  return Object.keys(out).length ? out : null;
}

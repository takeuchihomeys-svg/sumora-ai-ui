// app/lib/conductor-priority.ts — 統括④⑥と「計画をほかの仕組みに渡す」の純関数（DB/LLM なし・どれも既定 off・記録だけから）
//
// 2026-11-03 竹内さん（KB P1「統括に6つ足す」④⑥・統括役「統括の計画を、ほかの仕組みにも渡す」）:
//   ④ 振り分けの外れから学ぶ … 毎週、統括の振り分けの外れ（呼ぶべき役を呼ばなかった・受け渡しで落ちた）を場面ごとに集め、教訓の1行にする（設計知見 P2・札「振り分けの教訓」）
//   ⑥ お客様をまたいだ優先 … 段階（申込・内覧の直前）× 計画の期限 × 待たせている時間 × 開いている約束 で点を付け、brain-sweep の順・深い読み・staff-todo の並びに使う
//   計画を渡す … plan_ahead から、物件検索（内覧できる空室を先に）・見積書・内覧のカレンダー（期限の前の候補）・やることリストへのヒント
// 切替: CROSS_CUSTOMER_PRIORITY・PLAN_AHEAD_CONSUMERS（記録だけ・既定 on・=off で止める）。テスト: app/lib/__tests__/conductor-priority.test.ts
type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
// 2026-11-03 竹内さん（記録だけのスイッチは悪化0の後に全部へ）: どちらも並び・中身を変えない記録だけ＝既定 on（止める時は =off）
export const crossCustomerPriorityOn = (env: Env = envOf()) => (env.CROSS_CUSTOMER_PRIORITY ?? "").trim().toLowerCase() !== "off";
export const planAheadConsumersOn = (env: Env = envOf()) => (env.PLAN_AHEAD_CONSUMERS ?? "").trim().toLowerCase() !== "off";

const H = 3_600_000;
/** customer-state の段階ごとの重み（申込・内覧の直前ほど高い） */
const STAGE_WEIGHT: Record<string, number> = {
  apply_prep: 5, viewed: 4, viewing_scheduled: 4, viewing_arranging: 3.5, estimate_sent: 3, interested: 3, proposing: 2, searching: 1.5, first: 2, applying: 0.5, won: 0, dropped: 0,
};
/** 計画の goal から期限（ミリ秒・無ければ null）。「今日」「明日」「今週」「今月」だけを読む（創作しない） */
export function planDeadlineMs(goal: string | null | undefined, nowMs: number): number | null {
  const g = goal ?? "";
  if (/今日|本日/.test(g)) return nowMs + 12 * H;
  if (/明日/.test(g)) return nowMs + 36 * H;
  if (/今週/.test(g)) return nowMs + 4 * 24 * H;
  if (/来週/.test(g)) return nowMs + 10 * 24 * H;
  if (/今月/.test(g)) return nowMs + 20 * 24 * H;
  return null;
}

export type PriorityInput = { stage: string | null; planGoal?: string | null; lastCustomerAt?: string | null; lastStaffAt?: string | null; openPromises?: number; nowMs: number };
export type PriorityResult = { score: number; deep: boolean; why: string[] };
export function customerPriority(i: PriorityInput): PriorityResult {
  const why: string[] = [];
  let s = STAGE_WEIGHT[i.stage ?? ""] ?? 1;
  why.push(`段階 ${i.stage ?? "-"}=${s}`);
  const dl = planDeadlineMs(i.planGoal, i.nowMs);
  if (dl != null) { const days = Math.max(0, (dl - i.nowMs) / (24 * H)); const add = days <= 1 ? 2 : days <= 4 ? 1.2 : 0.5; s += add; why.push(`計画の期限 ${days.toFixed(1)}日=+${add}`); }
  const lc = i.lastCustomerAt ? Date.parse(i.lastCustomerAt) : NaN, ls = i.lastStaffAt ? Date.parse(i.lastStaffAt) : NaN;
  if (Number.isFinite(lc) && (!Number.isFinite(ls) || lc > ls)) { const h = (i.nowMs - lc) / H; const add = h >= 3 ? 1.5 : h >= 1 ? 1 : 0.5; s += add; why.push(`待たせている ${h.toFixed(1)}時間=+${add}`); }
  if ((i.openPromises ?? 0) > 0) { const add = Math.min(1.5, 0.5 * (i.openPromises ?? 0)); s += add; why.push(`開いている約束 ${i.openPromises}=+${add}`); }
  return { score: Math.round(s * 10) / 10, deep: s >= 6, why };
}
/** 並べ直し（点の高い順・同点は元の順＝今の brain-sweep・staff-todo の順を崩さない） */
export function rankCustomers<T>(items: ReadonlyArray<T>, scoreOf: (x: T) => number): T[] {
  return items.map((x, idx) => ({ x, idx, s: scoreOf(x) })).sort((a, b) => b.s - a.s || a.idx - b.idx).map((v) => v.x);
}

// ── 計画をほかの仕組みに渡す（ヒントだけ・決めるのは各仕組み）─────────────────────
export type PlanConsumerHints = {
  property: { preferViewable: boolean; recommendOne: boolean } | null;
  estimate: { nextIsEstimate: boolean } | null;
  calendar: { beforeMs: number | null } | null;
  todo: { label: string } | null;
};
export function planConsumerHints(plan: { goal?: string; steps?: string[] } | null | undefined, nowMs: number): PlanConsumerHints {
  if (!plan || (!plan.goal && !plan.steps?.length)) return { property: null, estimate: null, calendar: null, todo: null };
  const steps = plan.steps ?? [], first = steps[0] ?? "", all = `${plan.goal ?? ""} ${steps.join(" ")}`;
  const viewing = /内覧/.test(all);
  return {
    property: /物件|ピックアップ|オススメ|内覧/.test(all) ? { preferViewable: viewing, recommendOne: /オススメ|1件/.test(first) } : null,
    estimate: /見積/.test(all) ? { nextIsEstimate: /見積/.test(first) } : null,
    calendar: viewing ? { beforeMs: planDeadlineMs(plan.goal, nowMs) } : null,
    todo: first ? { label: `次の手: ${first.slice(0, 15)}` } : null,
  };
}

// ── ④ 振り分けの外れから学ぶ（毎週・場面ごとの教訓の1行）────────────────────────
export type RoutingMiss = { scene: string; kind: "missed_role" | "handoff_drop" | "wrong_order"; detail: string };
/** 同じ場面×同じ外れが2回以上の物だけを教訓にする（1回きりは事例として残すだけ） */
export function routingLessons(misses: ReadonlyArray<RoutingMiss>, minCount = 2): Array<{ scene: string; lesson: string; count: number }> {
  const by = new Map<string, { scene: string; kind: RoutingMiss["kind"]; detail: string; n: number }>();
  for (const m of misses) { const k = `${m.scene}|${m.kind}|${m.detail}`; const v = by.get(k) ?? { scene: m.scene, kind: m.kind, detail: m.detail, n: 0 }; v.n++; by.set(k, v); }
  const say: Record<RoutingMiss["kind"], (d: string) => string> = {
    missed_role: (d) => `この場面では ${d} を呼ぶ（呼ばずに外れた）`,
    handoff_drop: (d) => `この場面では「${d}」の受け渡しで落ちやすい（渡す形を確かめる）`,
    wrong_order: (d) => `この場面では ${d} の順で解く`,
  };
  return [...by.values()].filter((v) => v.n >= minCount).sort((a, b) => b.n - a.n).map((v) => ({ scene: v.scene, lesson: say[v.kind](v.detail), count: v.n }));
}

/** conversations.status（日本語の段階名）→ customer-state の段階の粗い対応（DB の追加の読みなしで点を付ける時だけ使う） */
export function statusToStage(status: string | null | undefined): string | null {
  const s = status ?? "";
  if (!s) return null;
  if (/申込|審査/.test(s)) return "apply_prep";
  if (/内覧/.test(s)) return "viewing_arranging";
  if (/見積/.test(s)) return "estimate_sent";
  if (/提案|物件/.test(s)) return "proposing";
  if (/成約|契約/.test(s)) return "won";
  return "searching";
}

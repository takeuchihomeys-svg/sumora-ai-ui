// app/lib/conductor-roles.ts — 統括の「役の名簿」と「番ごとのやる事の一覧」と「考える力の配分」（純関数・データだけ・DB/LLM なし）
//
// 2026-11-03 竹内さん（KB P1「統括そのものを大きく強化する — Claude Code の統括のように」）:
//   1 役の名簿 … Claude Code の道具の一覧に当たる物。各ブレイン・道具ごとに「何をする役か・渡す物・返る物・費用・いつ呼ぶか」を1か所に持つ。
//     統括（LINE のブレイン）はこれを見て呼ぶ役を選ぶ（conductor-handoff.candidateRoles は網＝候補だけ）。
//   2 番ごとのやる事の一覧 … 統括は最初にこの番でやる事を短い一覧にし（答える・約束・AIX・取りに行く・確かめ）、役を呼ぶたびに済み／まだを付ける。
//     全部済むまで終えない。digest.td に一覧と結果。
//   3 統括の考える力 … 難しい番は統括に強い AI と考える時間を使い、下の役は安くする（need の難しさで決める）。
// 切替: CONDUCTOR_ROSTER（既定 off・記録だけ）。テスト: app/lib/__tests__/conductor-roles.test.ts
import type { NeedTool } from "./brain-need";
type Env = Record<string, string | undefined>;
export const conductorRosterOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_ROSTER ?? "").trim().toLowerCase() === "on";

export type RosterKind = "brain" | "check" | "tool" | "system";
export type RosterEntry = {
  id: string;
  kind: RosterKind;
  /** 何をする役か */
  does: string;
  /** 渡す物 */
  gives: string;
  /** 返る物 */
  returns: string;
  /** 1回の費用の目安（USD）と AI。0＝決まった計算・DB だけ */
  cost: { usd: number; model: "none" | "deepseek" | "haiku" | "sonnet" | "sonnet_thinking" };
  /** いつ呼ぶか */
  when: string;
  /** 実装の置き場・切替 */
  where: string;
};

const TOOL_DOES: Record<NeedTool, string> = {
  sheet_detail: "物件の資料の中身（設備・契約条件）", sent_ledger: "こちらが送った事の全部", estimate: "送った見積の金額と中身",
  company_fact: "会社の事実（竹内さんの決定）", examples: "竹内さんの近い実例", past_lines: "お客様の古い発言の該当行",
  property_record: "物件ごとの記録（オススメ・持ち込み）", now_fulfillable: "確認済み・見積を作れる・送れる候補",
  aix_cards: "AIX の担当の札", customer_memo: "お客様のメモ",
};

export const ROSTER: readonly RosterEntry[] = [
  { id: "aix_desk", kind: "brain", does: "AIX の番で担当の札を比べて1つ選ぶ・差し戻し・逆向きの相談", gives: "Handoff（決まった事・あなたが決める事・守る線）＋候補の札", returns: "AixVerdict → aix_recheck（BrainRecheck）", cost: { usd: 0.004, model: "deepseek" }, when: "統括が AIX の番と決めた時／返信の番で自信が低い・スタッフしか知らない気配の時（相談）", where: "aix-commander.ts・AIX_DESK_COMMAND／AIX_DESK_CONSULT" },
  { id: "compose", kind: "brain", does: "趣旨・主語・メインの1文・添え・締め（文の設計図）", gives: "Handoff＋状況のまとめ＋場面の技能（writer の束）", returns: "ComposeIntent・ComposeBlueprint", cost: { usd: 0.003, model: "deepseek" }, when: "返信の番で、お礼・スタンプだけの軽い番でない時", where: "compose-blueprint.ts・BRAIN_COMPOSE_BLUEPRINT" },
  { id: "writer", kind: "brain", does: "設計図の部品を竹内さんの言い回しで文にする", gives: "設計図＋場面の技能の rules・examples", returns: "下書き", cost: { usd: 0.03, model: "sonnet" }, when: "返信の番は毎回", where: "generate-reply" },
  { id: "check_coverage", kind: "check", does: "答え漏れ（聞かれた事・約束に全部答えたか）", gives: "下書き＋asks", returns: "漏れの一覧", cost: { usd: 0.002, model: "deepseek" }, when: "質問・依頼が2つ以上の番", where: "compose-checks.ts・COMPOSE_CHECK_COVERAGE" },
  { id: "check_ground", kind: "check", does: "根拠なし（材料に無い事実を書いていないか）", gives: "下書き＋材料", returns: "根拠の無い文", cost: { usd: 0.002, model: "deepseek" }, when: "物件・費用・会社の事実を書いた番", where: "compose-checks.ts・COMPOSE_CHECK_GROUND" },
  { id: "check_reader", kind: "check", does: "読み手の目（お客様が読んで分かるか・押し付けでないか）", gives: "下書き", returns: "直す所", cost: { usd: 0.002, model: "deepseek" }, when: "長い番・お断り・不満の番", where: "compose-checks.ts・COMPOSE_CHECK_READER" },
  { id: "check_worry", kind: "check", does: "奥の心配に応えたか（3段の relief）", gives: "下書き＋three_layer", returns: "応えていない心配", cost: { usd: 0.002, model: "deepseek" }, when: "3段の worry がある番", where: "compose-checks.ts・COMPOSE_CHECK_WORRY" },
  ...(Object.keys(TOOL_DOES) as NeedTool[]).map((t): RosterEntry => ({
    id: `fetch_${t}`, kind: "tool", does: `取りに行く: ${TOOL_DOES[t]}`, gives: "道具の名前＋何が知りたいか（need.why）", returns: "時刻と出所つきの材料の行", cost: { usd: 0, model: "none" },
    when: `need.missing に ${t} がある時（1番につき1回・読み直しは opts.recheck の fetch）`, where: "brain-need.ts NEED_TOOLS",
  })),
  { id: "fetch_viewing_slots", kind: "tool", does: "取りに行く: 内覧の空いている枠", gives: "物件・期限", returns: "候補の日時", cost: { usd: 0, model: "none" }, when: "内覧調整の番", where: "viewing-flow・カレンダー" },
  { id: "deep", kind: "brain", does: "深く読む（全履歴＋考える時間で決め直しの案）", gives: "全履歴＋事実の帳面＋最初の判断", returns: "決め直しの案（opts.recheck の deep）", cost: { usd: 0.12, model: "sonnet_thinking" }, when: "need が 難しさ high かつ 自信 low の番だけ", where: "brain-recheck.ts（次の段）" },
  { id: "property_search", kind: "system", does: "物件検索のブレイン（ピックアップ・🌟の選び方）", gives: "条件＋plan_ahead＋状況のまとめ", returns: "候補の物件", cost: { usd: 0.01, model: "deepseek" }, when: "計画の手に物件ピックアップ・オススメがある時", where: "property-brain.ts（PLAN_AHEAD_CONSUMERS 案）" },
  { id: "estimate", kind: "system", does: "見積書", gives: "物件＋割引の決まり", returns: "見積の下書き", cost: { usd: 0, model: "none" }, when: "計画の手に見積書がある・お客様の依頼", where: "fill-estimate" },
  { id: "viewing_calendar", kind: "system", does: "内覧の予定", gives: "物件・期限（plan_ahead.goal）", returns: "空いている枠", cost: { usd: 0, model: "none" }, when: "内覧の段階", where: "viewing calendar" },
  { id: "staff_todo", kind: "system", does: "スタッフのやることリスト", gives: "優先の点（段階×計画の期限×経過）", returns: "並び", cost: { usd: 0, model: "none" }, when: "毎番の後（並べ直しだけ）", where: "staff-todo-list.ts" },
];
export const rosterById = (id: string) => ROSTER.find((r) => r.id === id) ?? null;
/** 統括のプロンプトに入れる名簿の短い表（キャッシュに乗る固定の文） */
export const ROSTER_PROMPT = `【役の名簿（呼ぶ役はこの中から選ぶ・呼ばない役は理由が要らない）】\n${ROSTER.filter((r) => r.kind !== "system").map((r) => `- ${r.id}: ${r.does}／いつ: ${r.when}`).join("\n")}`;

// ── 2 番ごとのやる事の一覧（digest.td）────────────────────────────────
export type TodoKind = "answer" | "promise" | "aix" | "fetch" | "check";
export type TurnTodo = { kind: TodoKind; what: string; role: string | null; status: "pending" | "done" | "skipped" };
const TODO_SHORT: Record<TodoKind, string> = { answer: "答", promise: "約", aix: "A", fetch: "取", check: "確" };
export function initTurnTodos(o: {
  asks?: ReadonlyArray<{ what: string; route: "reply" | "promise" | "aix" | "none" }>; finalAction?: string | null; missing?: ReadonlyArray<string>; checks?: ReadonlyArray<string>;
}): TurnTodo[] {
  const out: TurnTodo[] = [];
  for (const a of o.asks ?? []) {
    if (a.route === "none") continue;
    out.push({ kind: a.route === "reply" ? "answer" : a.route, what: a.what.slice(0, 20), role: a.route === "aix" ? "aix_desk" : "writer", status: "pending" });
  }
  if (o.finalAction && o.finalAction !== "reply" && !out.some((t) => t.kind === "aix")) out.push({ kind: "aix", what: o.finalAction, role: "aix_desk", status: "pending" });
  for (const m of o.missing ?? []) out.push({ kind: "fetch", what: m, role: `fetch_${m}`, status: "pending" });
  for (const c of o.checks ?? []) out.push({ kind: "check", what: c, role: c, status: "pending" });
  return out;
}
export function markTodo(todos: TurnTodo[], role: string, status: "done" | "skipped"): TurnTodo[] {
  return todos.map((t) => (t.role === role && t.status === "pending" ? { ...t, status } : t));
}
export const todosOpen = (todos: ReadonlyArray<TurnTodo>) => todos.filter((t) => t.status === "pending");
/** "答2/2,A1/1,取0/1"（済み/全部） */
export function todoDigest(todos: ReadonlyArray<TurnTodo>): string | null {
  if (!todos.length) return null;
  const by = new Map<TodoKind, { d: number; n: number }>();
  for (const t of todos) { const v = by.get(t.kind) ?? { d: 0, n: 0 }; v.n++; if (t.status === "done") v.d++; by.set(t.kind, v); }
  return [...by.entries()].map(([k, v]) => `${TODO_SHORT[k]}${v.d}/${v.n}`).join(",");
}

// ── 3 統括の考える力の配分（need の難しさで決める）──────────────────────
export type ThinkBudget = { conductor: "sonnet" | "sonnet_thinking"; thinkingTokens: number; sub: "deepseek" | "haiku"; why: string };
export function thinkBudget(need: { difficulty?: string | null; confidence?: string | null } | null | undefined): ThinkBudget {
  const d = need?.difficulty ?? "mid", c = need?.confidence ?? "mid";
  if (d === "high" && c !== "high") return { conductor: "sonnet_thinking", thinkingTokens: 4000, sub: "deepseek", why: "難しい番・自信が高くない" };
  if (d === "high" || c === "low") return { conductor: "sonnet_thinking", thinkingTokens: 2000, sub: "deepseek", why: d === "high" ? "難しい番" : "自信が低い" };
  return { conductor: "sonnet", thinkingTokens: 0, sub: "deepseek", why: "普通の番" };
}

// scripts/lib/conductor-duty.ts — 統括の受け持ち表（土台ごとに 統括が ①持つ ②使う ③反映する のどこまで行っているか・純関数・LLM/DB なし）
//
// 2026-11-23 作業員A（竹内さん 11/23・P0・台帳 #662「ちゃんと統括は全部管理して細かく細分化して反映できるように」）。
//   設計知見: 575a7cd5（統括の芯＝重点を先に決めて必要なブレインだけ動かす）・7d6fe3eb（確認の順番となぜ）・3041baaa（作った部品が本番に届いているか・足すより先につなぐ）・
//   0f38f47f（土台→細分化→物差し→弱い所を自動で→統括につなぐ）。
// 段: 持つ＝その土台の材料が統括・ブレインの入力に入っている（連携の地図の read.* の行）／使う＝統括がその材料を見て決めた印がある（conductor.* の行）／
//     反映＝決めた事が指示書の役目・書き手・AIX に渡った（conductor.compose_*・writer.*・conductor.delivery の行）
//   段の状態は連携の地図の見張り（cron_run_logs の linkage-watch・作業員L）の最新: 全部つながっている＝済・切れ／親が off＝欠け・測れない行がある・行が無い＝未確認
//   ⚠ 土台 → 連携の地図の行の対応は 11/23 の作業員A の案（行の名前と作り手から当てた）。持ち主が確かめて直す
export type DutyStage = "have" | "use" | "reflect";
export const DUTY_JA: Record<DutyStage, string> = { have: "持つ", use: "使う", reflect: "反映" };
export type DutyRow = { id: string; name: string; owner: string; have: string[]; use: string[]; reflect: string[]; parts?: string[] };
export const CONDUCTOR_DUTY: readonly DutyRow[] = [
  { id: "n.promise", name: "約束", owner: "作業員L", have: ["read.overdue_promises"], use: ["conductor.our_side"], reflect: ["conductor.compose_roles"], parts: ["BRIEF_CARRY_TO_WRITER"] },
  { id: "n.chrono", name: "時系列", owner: "作業員L", have: ["read.timeline"], use: ["conductor.brief"], reflect: ["writer.situation"] },
  { id: "route.path", name: "道筋（申込までの地図）", owner: "作業員A", have: ["read.route_map", "read.route_substate"], use: ["conductor.aims"], reflect: ["conductor.compose_roles"], parts: ["ROUTE_TO_BRIEF", "ROUTE_PATH_TO_BRIEF", "BRAIN_TURN_AIMS"] },
  { id: "route.now", name: "今どこ", owner: "作業員A", have: ["read.situation_now", "read.route_map"], use: ["next.situation_grasp"], reflect: ["conductor.brief"] },
  { id: "n.closing", name: "決めに行く", owner: "作業員M", have: ["read.mindset"], use: ["conductor.focus"], reflect: ["writer.reply"] },
  { id: "n.flex", name: "臨機応変", owner: "作業員N", have: ["read.turn_read"], use: ["conductor.check_order"], reflect: ["conductor.compose_plan"] },
  { id: "n.trust", name: "信頼", owner: "作業員N・作業員L", have: ["read.exchange"], use: ["conductor.our_side"], reflect: ["writer.reply"] },
  { id: "n.feeling", name: "気持ち", owner: "作業員K2・作業員L", have: ["read.mindset", "read.latent_five"], use: ["conductor.focus"], reflect: ["conductor.compose_roles"] },
  { id: "n.appeal", name: "訴求", owner: "作業員K2", have: ["read.uptake"], use: ["conductor.aix_desk"], reflect: ["writer.aix_second"] },
  { id: "n.asks", name: "要件", owner: "作業員M", have: ["read.turn_read"], use: ["conductor.brief"], reflect: ["conductor.delivery"] },
  { id: "n.link", name: "つなぎ", owner: "作業員H・作業員L", have: ["read.uptake"], use: ["conductor.combo"], reflect: ["writer.reply"] },
  { id: "n.lessons", name: "統括の学び", owner: "作業員L", have: ["rag.near_focus"], use: ["conductor.near"], reflect: ["conductor.brief"], parts: ["CONDUCTOR_LESSONS"] },
];

export type LinkStatus = { cut: ReadonlySet<string>; off: ReadonlySet<string>; unmeasured?: ReadonlySet<string> };
export type StageState = "済" | "欠け" | "未確認";
export type DutyResult = { id: string; name: string; owner: string; stages: Record<DutyStage, { state: StageState; rows: string[]; bad: string[] }>; reach: DutyStage | null; parts: string[] };

function stageOf(rows: readonly string[], known: ReadonlySet<string>, st: LinkStatus | null): { state: StageState; rows: string[]; bad: string[] } {
  if (!rows.length || !st) return { state: "未確認", rows: [...rows], bad: [] };
  const missing = rows.filter((r) => !known.has(r));
  const bad = rows.filter((r) => st.cut.has(r) || st.off.has(r));
  if (bad.length) return { state: "欠け", rows: [...rows], bad };
  if (missing.length || rows.some((r) => st.unmeasured?.has(r))) return { state: "未確認", rows: [...rows], bad: [] };
  return { state: "済", rows: [...rows], bad: [] };
}

/** 土台ごとの3段（known＝連携の地図にある行の id・st＝見張りの最新） */
export function conductorDutyOf(table: readonly DutyRow[], known: ReadonlySet<string>, st: LinkStatus | null): DutyResult[] {
  return table.map((r) => {
    const stages = { have: stageOf(r.have, known, st), use: stageOf(r.use, known, st), reflect: stageOf(r.reflect, known, st) };
    // どこまで行っているか＝前の段から続けて済の一番先（持つが済でなければ null）
    const reach: DutyStage | null = stages.have.state !== "済" ? null : stages.use.state !== "済" ? "have" : stages.reflect.state !== "済" ? "use" : "reflect";
    return { id: r.id, name: r.name, owner: r.owner, stages, reach, parts: r.parts ?? [] };
  });
}

/** 毎朝の1枚の1行と数 */
export function conductorDutySummary(res: readonly DutyResult[]): { line: string; have: number; use: number; reflect: number; n: number; notReflected: DutyResult[] } {
  const n = res.length;
  // 段は前から続けて済の数（持つが済でない土台は、使う・反映が済でも数えない）
  const order: Array<DutyStage | null> = [null, "have", "use", "reflect"];
  const c = (s: DutyStage) => res.filter((r) => order.indexOf(r.reach) >= order.indexOf(s)).length;
  const notReflected = res.filter((r) => r.reach !== "reflect").sort((a, b) => ["reflect", "use", "have", null].indexOf(b.reach) - ["reflect", "use", "have", null].indexOf(a.reach));
  const top = notReflected.slice(0, 5).map((r) => `${r.name}（${r.reach ? `${DUTY_JA[r.reach]}まで` : "持つが未"}${(["have", "use", "reflect"] as DutyStage[]).filter((s) => r.stages[s].state === "欠け").map((s) => `・${DUTY_JA[s]}が欠け ${r.stages[s].bad.join(",")}`).join("")}）`);
  return { line: `統括の受け持ち: 持つ ${c("have")}/${n}・使う ${c("use")}/${n}・反映 ${c("reflect")}/${n}｜反映まで行っていない ${top.join("・") || "なし"}`, have: c("have"), use: c("use"), reflect: c("reflect"), n, notReflected };
}

/** 台帳に足す行（欠けの段がある土台だけ・同じ土台の行が開いていれば足さない） */
export const dutyGapPrefix = (name: string) => `統括の受け持ち ${name}:`;
export function conductorDutyGapsToAdd(res: readonly DutyResult[], openTitles: readonly string[]): Array<{ title: string; owner: string; next: string }> {
  return res.filter((r) => (["have", "use", "reflect"] as DutyStage[]).some((s) => r.stages[s].state === "欠け") && !openTitles.some((t) => t.startsWith(dutyGapPrefix(r.name))))
    .map((r) => {
      const bad = (["have", "use", "reflect"] as DutyStage[]).filter((s) => r.stages[s].state === "欠け");
      return { title: `${dutyGapPrefix(r.name)} ${bad.map((s) => `${DUTY_JA[s]}が欠け（${r.stages[s].bad.join("・")}）`).join("・")}`, owner: r.owner,
        next: `今ある既定 off の部品を先につなぐ（${r.parts.join("・") || "連携の地図の切れている行の持ち主に確かめる"}）・新しく作るのは最後（P0 3041baaa）` };
    });
}

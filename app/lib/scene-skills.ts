// app/lib/scene-skills.ts — 場面の技能と決まりの本（純関数・DB/LLM なし）
//
// 2026-11-03 作業員6（竹内さん KB P1「100% に向けて土台の7つを入れる」①決まりの本 ②場面の技能・作業員2と型を合わせた）。
//   決まりの本: 設計知見（system_design_thinking）の木（parent）を場面で切って組む。P0 が先頭・親の決まりが子より必ず先・段の順（P0→P1→P2）・文字の上限で止める。
//     木の親がまだ書かれていない行（parent=null）は段と新しさの順で並ぶ（後から親が付けば自動で親の後ろに入る）。
//   場面の技能: 決まり・手本（竹内さんの文の解剖・compose RAG）・使う道具（brain-need.ts の NEED_TOOLS と同じ名前）・確かめ方・文字の上限を1つに。
//     束は2つ（brain: ブレインへ／writer: 書き手へ）。retires は移した古い決まり・網・注記の名前（退役の一覧）。優先の順は conductor-handoff.ts の CONDUCTOR_PRIORITY_ORDER を見る。
//   スイッチ SCENE_SKILLS=on（既定 off・ブレイン側も同じ物を見る）。今は誰も呼んでいない。
// テスト: app/lib/__tests__/scene-skills.test.ts
import { KB_SCENES, rowInScene, type KbScene } from "./design-knowledge-rag";
import type { NeedTool } from "./brain-need";

export function sceneSkillsOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SCENE_SKILLS ?? "").trim().toLowerCase() === "on";
}
export type RuleRow = { id: string; title: string; insight: string; priority: number | null; tags: string[] | null; parent: string | null; created_at: string; for?: "brain" | "writer" | "both" };
export type BookRule = { id: string; text: string; source: "kb" | "code"; priority: 0 | 1 | 2; parent: string | null };
export type SkillCheck = "coverage" | "ground" | "reader" | "worry" | "deviation";
export type SceneSkill = {
  scene: KbScene;
  brain: { rules: BookRule[]; tools: NeedTool[]; budgetChars: number };
  writer: { rules: BookRule[]; examples: { kind: "anatomy" | "compose_rag"; ids: string[] }; budgetChars: number };
  checks: SkillCheck[];
  retires: string[];
  version: string;
};

/** 決まりの1行（題＋中身の頭・上限 maxLen） */
export function ruleText(r: Pick<RuleRow, "title" | "insight">, maxLen = 220): string {
  const head = r.title.replace(/\s+/g, " ").trim();
  const body = r.insight.replace(/\s+/g, " ").trim();
  const t = body && !body.startsWith(head.slice(0, 20)) ? `${head} — ${body}` : body || head;
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

/** 木を場面で切って決まりの本を組む: その場面の行（＋その祖先は場面外でも入れる）・P0 先頭・親は子より先・段→新しさ・文字の上限 */
export function buildRuleBook(rows: ReadonlyArray<RuleRow>, scene: KbScene, o: { budgetChars?: number; maxPriority?: 0 | 1 | 2; target?: "brain" | "writer" } = {}): BookRule[] {
  const maxP = o.maxPriority ?? 1;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fits = (r: RuleRow) => (r.priority ?? 2) <= maxP && (!o.target || !r.for || r.for === "both" || r.for === o.target);
  const inScene = rows.filter((r) => fits(r) && ((r.priority ?? 2) === 0 || rowInScene({ title: r.title, tags: r.tags ?? [] } as Parameters<typeof rowInScene>[0], scene)));
  const want = new Map<string, RuleRow>();
  for (const r of inScene) {
    want.set(r.id, r);
    let p = r.parent, n = 0;
    while (p && n++ < 10) { const pr = byId.get(p); if (!pr) break; if (fits(pr)) want.set(pr.id, pr); p = pr.parent; }
  }
  const depth = (r: RuleRow) => { let d = 0, p = r.parent; while (p && d < 10 && want.has(p)) { d++; p = want.get(p)!.parent; } return d; };
  const rootOf = (r: RuleRow): RuleRow => { let cur = r, n = 0; while (cur.parent && want.has(cur.parent) && n++ < 10) cur = want.get(cur.parent)!; return cur; };
  const list = [...want.values()].sort((a, b) => {
    const ra = rootOf(a), rb = rootOf(b);
    const pa = ra.priority ?? 2, pb = rb.priority ?? 2;
    if (ra.id !== rb.id) return pa - pb || rb.created_at.localeCompare(ra.created_at);
    return depth(a) - depth(b) || (a.priority ?? 2) - (b.priority ?? 2) || b.created_at.localeCompare(a.created_at);
  });
  const out: BookRule[] = [];
  let used = 0;
  const budget = o.budgetChars ?? 4000;
  for (const r of list) {
    const text = ruleText(r);
    if (used + text.length > budget && (r.priority ?? 2) !== 0) continue; // P0 は上限でも落とさない
    used += text.length;
    out.push({ id: r.id, text, source: "kb", priority: ((r.priority ?? 2) as 0 | 1 | 2), parent: r.parent && want.has(r.parent) ? r.parent : null });
  }
  return out;
}

/** 決まりの本を書き手・ブレインに渡す1ブロック（親の決まりの下に子を字下げ） */
export function ruleBookNote(rules: ReadonlyArray<BookRule>, scene: KbScene): string {
  if (!rules.length) return "";
  const depth = new Map<string, number>();
  for (const r of rules) depth.set(r.id, r.parent ? (depth.get(r.parent) ?? 0) + 1 : 0);
  const mark = (p: number) => (p === 0 ? "★" : p === 1 ? "・" : "　-");
  return [`【決まりの本（${KB_SCENES[scene].terms || scene}・上の決まりほど先に守る・ぶつかったら上の決まりと新しい決定が先）】`,
    ...rules.map((r) => `${"　".repeat(depth.get(r.id) ?? 0)}${mark(r.priority)} ${r.text}`)].join("\n");
}

/** 場面の技能の既定（道具・確かめ・文字の上限）。決まりは buildRuleBook で埋める */
export const SCENE_SKILL_DEFAULTS: Record<KbScene, { tools: NeedTool[]; checks: SkillCheck[]; brainBudget: number; writerBudget: number }> = {
  ack: { tools: ["sent_ledger"], checks: ["deviation"], brainBudget: 1500, writerBudget: 800 },
  considering: { tools: ["sent_ledger", "customer_memo"], checks: ["deviation", "worry"], brainBudget: 2500, writerBudget: 1500 },
  question: { tools: ["sheet_detail", "company_fact", "sent_ledger"], checks: ["coverage", "ground", "deviation"], brainBudget: 3500, writerBudget: 2500 },
  conditions: { tools: ["customer_memo", "now_fulfillable", "sent_ledger"], checks: ["coverage", "deviation"], brainBudget: 3000, writerBudget: 2000 },
  property_share: { tools: ["property_record", "sheet_detail", "sent_ledger"], checks: ["coverage", "ground", "deviation"], brainBudget: 3000, writerBudget: 2000 },
  property_send: { tools: ["property_record", "sent_ledger", "customer_memo"], checks: ["coverage", "ground", "deviation"], brainBudget: 3000, writerBudget: 2000 },
  cost: { tools: ["estimate", "company_fact", "sent_ledger"], checks: ["coverage", "ground", "deviation"], brainBudget: 3500, writerBudget: 2500 },
  viewing: { tools: ["sent_ledger", "now_fulfillable"], checks: ["coverage", "ground", "deviation"], brainBudget: 3000, writerBudget: 2000 },
  apply: { tools: ["company_fact", "sent_ledger"], checks: ["coverage", "ground", "deviation"], brainBudget: 3000, writerBudget: 2000 },
  other: { tools: ["sent_ledger", "past_lines"], checks: ["coverage", "deviation", "reader"], brainBudget: 3500, writerBudget: 2500 },
};
export function buildSceneSkill(rows: ReadonlyArray<RuleRow>, scene: KbScene, o: { examples?: SceneSkill["writer"]["examples"]; retires?: string[]; version?: string } = {}): SceneSkill {
  const d = SCENE_SKILL_DEFAULTS[scene];
  return {
    scene,
    brain: { rules: buildRuleBook(rows, scene, { budgetChars: d.brainBudget, target: "brain" }), tools: d.tools, budgetChars: d.brainBudget },
    writer: { rules: buildRuleBook(rows, scene, { budgetChars: d.writerBudget, target: "writer" }), examples: o.examples ?? { kind: "anatomy", ids: [] }, budgetChars: d.writerBudget },
    checks: d.checks, retires: o.retires ?? [], version: o.version ?? new Date().toISOString().slice(0, 10),
  };
}

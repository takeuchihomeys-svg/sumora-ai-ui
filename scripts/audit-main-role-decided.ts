// scripts/audit-main-role-decided.ts — 主の役目の当たりが、統括の決めた事（作業員22 conductor-decided の compose の必ず届ける欄＝重点・継続の約束・依頼ごとの道と答え・潜在・こちら側）
//   が文の統括に届いた時にどれだけ上がるかを見積もる（AI を呼ばない・DB を読まない・費用0）。2026-11-12 作業員10
//   材料: 正解 53番（gold-1113）× 試験の答案の brain（conductor_focus は答案に残っている欄）
//   比べる: 今の設計図の主の役目 ／ 決めた事から引いた主の役目（重点 → compose-vocab の COMPOSE_AIM_TABLE で役目・誘導先で行を選ぶ・継続の約束は keep）／
//          2つを合わせる（設計図が空か、決めた事の重点がある時は重点を先）／どちらかが当たる上限
// 実行: npx tsx scripts/audit-main-role-decided.ts [--show]
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, readComposeContext, planFieldsOf, type TakeuchiGold } from "../app/lib/compose-sentence-plan";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { aimOf } from "../app/lib/compose-vocab";
import { toNextDest } from "../app/lib/next-move-types";
import { focusOfReplyText, relationKeep, type Focus } from "../app/lib/conductor-focus";
import type { SentenceRole } from "../app/lib/takeuchi-anatomy-roles";

const ROOT = resolve(__dirname, "..");
const show = process.argv.includes("--show");
type Prob = { id: string; customer?: string; staffText?: string };
const gold = (JSON.parse(readFileSync(join(ROOT, "scripts/compose-understanding/gold-1113.json"), "utf8")) as { turns: TakeuchiGold[] }).turns;
const ids = new Set(gold.map((g) => g.id));
const probs = new Map((JSON.parse(readFileSync(join(ROOT, "scripts/brain-exam/problems.json"), "utf8")) as Prob[]).map((p) => [p.id, p]));
const brainOf = new Map<string, { at: string; brain: Record<string, unknown> }>();
const wt = resolve(ROOT, "..");
for (const d of [join(ROOT, "scripts/brain-exam/results"), ...readdirSync(wt).map((x) => join(wt, x, "scripts/brain-exam/results"))]) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!/^main-.*\.jsonl$/.test(f)) continue;
    const p = join(d, f); if (statSync(p).mtimeMs < Date.now() - 14 * 86_400_000) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\{"id":"(q\d+)"/); if (!m || !ids.has(m[1]) || !line.includes('"brain"')) continue;
      try { const r = JSON.parse(line) as { id: string; at?: string; brain?: Record<string, unknown> }; if (!r.brain?.turn_contract) continue; const prev = brainOf.get(r.id); if (!prev || (r.at ?? "") > prev.at) brainOf.set(r.id, { at: r.at ?? "", brain: r.brain }); } catch { /* */ }
    }
  }
}
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
let n = 0, now = 0, dec = 0, merged = 0, upper = 0, hasFocus = 0, oracle = 0, oracleMerged = 0, keepOn = 0, keepMerged = 0;
for (const g of gold) {
  const b = brainOf.get(g.id)?.brain; if (!b) continue;
  n++;
  const scene = resolveReplyScene({ customerText: String(probs.get(g.id)?.customer ?? "") }).scene;
  const u = readTurnUnderstanding(b), s7 = readSevenFields(b);
  const f = planFieldsOf(u, s7, buildSentencePlan(u, s7, { scene, ctx: readComposeContext(b) }));
  const cf = obj(b.conductor_focus);
  const focus = typeof cf?.focus === "string" ? (cf.focus as Focus) : null;
  if (focus) hasFocus++;
  const dest = toNextDest(s7.leadTo ?? null, "lead_to");
  const fromDecided: SentenceRole | null = focus ? aimOf({ focus }, dest)?.roles[0] ?? null : cf?.keepPromise === true ? "keep" : null;
  const mergedRole = focus ? fromDecided : f.mainRole ?? fromDecided;
  if (f.mainRole === g.mainRole) now++;
  if (fromDecided === g.mainRole) dec++;
  if (mergedRole === g.mainRole) merged++;
  if (f.mainRole === g.mainRole || fromDecided === g.mainRole) upper++;
  // 上限の見積もり: 重点が竹内さんの文どおりに届いたら（focusOfReplyText で竹内さんの文から重点を作る＝答えを見た上限）
  const of = focusOfReplyText(String(probs.get(g.id)?.staffText ?? ""));
  const orole = aimOf({ focus: of }, dest)?.roles[0] ?? null;
  if (orole === g.mainRole) oracle++;
  if ((f.mainRole ?? orole) === g.mainRole) oracleMerged++;
  // 決まった計算で今でも作れる「継続の約束」（relationKeep・条件の番は true）が届いたら: 主が空・答えの番で keep にする
  const kp = relationKeep({ scene });
  if (kp) keepOn++;
  const km = kp && (!f.mainRole || f.mainRole === "answer") ? "keep" : f.mainRole;
  if (km === g.mainRole) keepMerged++;
  if (show) console.log(`- ${g.id} 竹内=${g.mainRole} 今=${f.mainRole ?? "空"} 決めた事=${fromDecided ?? "空"}（重点 ${focus ?? "-"}）`);
}
const pc = (a: number) => `${a}/${n}（${n ? Math.round((a / n) * 100) : 0}%）`;
console.log(`番 ${n}（重点のある答案 ${hasFocus}）`);
console.log(`重点が竹内さんの文どおり届いた時（答えを見た上限）: 重点だけ ${pc(oracle)}・設計図が空の時だけ重点 ${pc(oracleMerged)}`);
console.log(`継続の約束（relationKeep・${keepOn}番で true）を主が空・答えの番に使う: ${pc(keepMerged)}`);
console.log(`主の役目: 今の設計図 ${pc(now)}・決めた事だけ ${pc(dec)}・合わせる（重点を先） ${pc(merged)}・どちらかが当たる上限 ${pc(upper)}`);

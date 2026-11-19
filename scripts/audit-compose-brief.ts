// scripts/audit-compose-brief.ts — 文の統括の指示書（COMPOSE_BRIEF）を竹内さんの正解の番で記録だけで測る（AI を呼ばない・DB を読まない・費用0）
//   材料: 正解 scripts/compose-understanding/gold-*.json の番・その番の試験の答案の brain（--brains か results の main-*.jsonl）・problems.json の竹内さんの文（staffText）
//   測る物:
//     締め: 指示書の締め（COMPOSE_CLOSING の名前）× 竹内さんの文の締め
//     疑いの印の空振り: 竹内さんの文そのものに確かめ（draftDoubts）を当てて、印が出た数（＝正解の文に出る印は誤報の目安）
//     期日の言葉: 竹内さんの文の期日の言葉のうち、指示書の材料にあった割合
//     自信の印の分かれ方（high/mid/low）と、欄が埋まった数
// 実行: npx tsx scripts/audit-compose-brief.ts [--gold=scripts/compose-understanding/gold-1113.json] [--brains=<json>] [--show]
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, readComposeContext } from "../app/lib/compose-sentence-plan";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { orderTypeOf } from "../app/lib/compose-order-table";
import { buildComposeBrief, draftDoubts, composeSure, closingOfText, dateWordsOf, BRIEF_NONE, DRAFT_DOUBT_KINDS } from "../app/lib/compose-brief";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const show = process.argv.includes("--show");
type Prob = { id: string; customer?: string; staffText?: string; context?: Array<{ s: string; t: string; aix?: boolean }> };
const gold = (JSON.parse(readFileSync(resolve(ROOT, arg("gold", "scripts/compose-understanding/gold-1113.json")), "utf8")) as { turns: Array<{ id: string }> }).turns;
const ids = new Set(gold.map((g) => g.id));
const probs = new Map((JSON.parse(readFileSync(join(ROOT, "scripts/brain-exam/problems.json"), "utf8")) as Prob[]).map((p) => [p.id, p]));
const brainOf = new Map<string, { at: string; brain: Record<string, unknown> }>();
if (arg("brains")) for (const r of JSON.parse(readFileSync(resolve(ROOT, arg("brains")), "utf8")) as Array<{ id: string; at?: string; brain: Record<string, unknown> }>) brainOf.set(r.id, { at: r.at ?? "", brain: r.brain });
else {
  const wt = resolve(ROOT, "..");
  const dirs = [join(ROOT, "scripts/brain-exam/results"), ...(() => { try { return readdirSync(wt).map((d) => join(wt, d, "scripts/brain-exam/results")); } catch { return []; } })()];
  const since = Date.now() - 14 * 86_400_000;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!/^main-.*\.jsonl$/.test(f)) continue;
      const p = join(d, f); if (statSync(p).mtimeMs < since) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.includes('"brain"')) continue;
        const m = line.match(/^\{"id":"(q\d+)"/); if (!m || !ids.has(m[1])) continue;
        try { const r = JSON.parse(line) as { id: string; at?: string; brain?: Record<string, unknown> }; if (!r.brain?.turn_contract) continue; const prev = brainOf.get(r.id); if (!prev || (r.at ?? "") > prev.at) brainOf.set(r.id, { at: r.at ?? "", brain: r.brain }); } catch { /* 壊れた行 */ }
      }
    }
  }
}
let n = 0, closeHit = 0, dateAll = 0, dateIn = 0;
const doubtFP: Record<string, number> = Object.fromEntries(DRAFT_DOUBT_KINDS.map((k) => [k, 0]));
const sure: Record<string, number> = { high: 0, mid: 0, low: 0 };
const filled: Record<string, number> = { aim: 0, values: 0, keyPoint: 0, facts: 0, dates: 0, skeleton: 0, propertyName: 0 };
for (const g of gold) {
  const b = brainOf.get(g.id); const p = probs.get(g.id);
  if (!b || !p?.staffText) continue;
  n++;
  const customerText = String(p.customer ?? "");
  const scene = resolveReplyScene({ customerText }).scene;
  const u = readTurnUnderstanding(b.brain), s7 = readSevenFields(b.brain);
  const plan = buildSentencePlan(u, s7, { scene, ctx: readComposeContext(b.brain) });
  const staff = (p.context ?? []).filter((m) => m.s === "staff").map((m) => m.t);
  // 材料: 申込の門で外した番は gold に入っていない。資料の文字は答案に無いので、こちらの直近の送信（物件の記録）を材料の代わりにする
  const materialText = staff.slice(-3).join("\n");
  const brief = buildComposeBrief({ plan, s7, meta: b.brain, scene, customerText, materialText, recentStaffTexts: staff, firstContact: staff.length === 0 });
  const takeuchi = p.staffText;
  if (closingOfText(takeuchi) === brief.closing.name) closeHit++;
  const doubts = draftDoubts(brief, takeuchi);
  for (const d of doubts) doubtFP[d.kind]++;
  const dw = dateWordsOf(takeuchi); dateAll += dw.length; dateIn += dw.filter((x) => brief.dates.includes(x)).length;
  const sr = composeSure(brief, { orderType: orderTypeOf(scene, plan.rows.find((r) => r.rank === "main")?.role ?? null), appealAsked: !!s7.appeal, doubts: [] });
  sure[sr.level]++;
  if (brief.aim !== BRIEF_NONE) filled.aim++; if (brief.values !== BRIEF_NONE) filled.values++; if (brief.keyPoint !== BRIEF_NONE) filled.keyPoint++;
  if (brief.facts.length) filled.facts++; if (brief.dates.length) filled.dates++; if (brief.skeleton.elements.length || brief.skeleton.answerSource) filled.skeleton++; if (brief.propertyName !== BRIEF_NONE) filled.propertyName++;
  if (show) console.log(`- ${g.id} 締め 指示書=${brief.closing.name} 竹内=${closingOfText(takeuchi)}｜疑い=${doubts.map((d) => d.kind).join(",") || "-"}｜自信=${sr.level}`);
}
const pc = (a: number, b: number) => `${a}/${b}（${b ? Math.round((a / b) * 100) : 0}%）`;
console.log(`番 ${n}（答案の brain と竹内さんの文がある番）`);
console.log(`締め（誘い＋結びを1つの名前で）: ${pc(closeHit, n)}`);
console.log(`期日の言葉: 竹内さんの文の期日 ${dateAll} のうち材料にあった ${pc(dateIn, dateAll)}`);
console.log(`疑いの印の空振り（竹内さんの文に出た印）: ${Object.entries(doubtFP).map(([k, v]) => `${k} ${v}`).join("・")}`);
console.log(`自信の印: high ${sure.high}・mid ${sure.mid}・low ${sure.low}`);
console.log(`欄が埋まった番: ${Object.entries(filled).map(([k, v]) => `${k} ${v}`).join("・")}`);

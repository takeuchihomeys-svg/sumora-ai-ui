// 試験の物差し（LLM なし）: 試験の答案（brain.turn_contract）から two-message-plan で組み立てを作り、2つに分けて採点する
//   ① 竹内さんとの一致（基準）: 組み合わせの型（R・A・AT・RAT・AR・ATR・RAR）が scripts/brain-exam/two-msg-shapes.json の型に入るか
//   ② 原則の揃い方: 答える・信頼・訴求（できる場面）の抜けが0か（checkPlan）
//   ＋ 1通の番の余計な2通目（必ず0を見る）・2通3通の番で依頼に返信と AIX の両方が入ったか
//   ＋ 超えた候補: 竹内さんと型は違うが原則の抜けが0で、竹内さんの番に抜けの印（gap）がある問題（竹内さんに推奨つきで確かめる）
// 2026-11-05 竹内さん（KB P1 3701b532 組み合わせの型・「竹内の送り方は基準・絶対の正解ではない」）・作業員7
// 使い方: npx tsx scripts/two-msg-shape-eval.ts <results.jsonl> [<results.jsonl> ...]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planMessages, checkPlan, type PlanAsk } from "../app/lib/two-message-plan";

type Expect = { shapes: string[]; mixed?: boolean; single?: boolean; first?: boolean; canAppeal?: boolean; gap?: string };
const EXPECT = JSON.parse(readFileSync(join(__dirname, "brain-exam", "two-msg-shapes.json"), "utf8")) as Record<string, Expect>;
const TWO_STAGE_AIX: Record<string, string> = { estimate: "estimate_sheet", check: "property_check_result", pickup: "property_send", photo: "property_check_result" };

type Row = { id: string; rep: number; brain?: { reply_mode?: string; action?: string; aix?: string; two_stage?: string | null; turn_contract?: { asks?: Array<Record<string, unknown>> } }; path?: { ok?: boolean; code?: string } };

export function planOfRow(r: Row, tk: Expect) {
  const asks = ((r.brain?.turn_contract?.asks ?? []) as Array<Record<string, unknown>>).map((a) => ({ quote: String(a.quote ?? ""), route: String(a.route ?? "reply"), kind: (a.kind as string | null) ?? null, answer: (a.answer as string | null) ?? null, aix: (a.aix as string | null) ?? null, about: (a.about as string | null) ?? null })) as PlanAsk[];
  const finalAix = r.brain?.reply_mode === "aix" ? String(r.brain?.action ?? r.brain?.aix ?? "") || null : r.brain?.two_stage ? TWO_STAGE_AIX[String(r.brain.two_stage)] ?? null : null;
  // 2段の番で約束の依頼が無い時は、約束の返信が先（2段＝約束の返信）
  const asks2 = r.brain?.two_stage && !asks.some((a) => a.route === "promise") ? [...asks, { quote: "(2段の約束)", route: "promise" } as PlanAsk] : asks;
  const plan = planMessages({ asks: asks2, finalAix, firstContact: tk.first, canAppeal: tk.canAppeal });
  return { asks, plan, check: checkPlan(plan, { asks: asks2, canAppeal: tk.canAppeal }) };
}

function main() {
  for (const f of process.argv.slice(2)) {
    const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } }).filter((r): r is Row => !!r && !!EXPECT[r.id]);
    const byShape: Record<string, { n: number; hit: number }> = {};
    let match = 0, principle = 0, mixedN = 0, mixedBoth = 0, singleN = 0, extra = 0, pathOk = 0;
    const lines: string[] = [], beyond: string[] = [];
    for (const r of rows) {
      const tk = EXPECT[r.id];
      const { asks, plan, check } = planOfRow(r, tk);
      const hit = tk.shapes.includes(plan.shape);
      const key = tk.shapes[0];
      (byShape[key] ??= { n: 0, hit: 0 }).n++; if (hit) { byShape[key].hit++; match++; }
      if (check.gaps.length === 0) principle++;
      if (tk.mixed) { mixedN++; if (asks.some((a) => a.route === "reply") && (asks.some((a) => a.route === "aix" || a.route === "promise") || !!plan.messages.find((m) => m.slot === "aix"))) mixedBoth++; }
      if (tk.single) { singleN++; if (plan.count > 1 && !(plan.shape === "AT" && tk.shapes.includes("A"))) extra++; }
      if (r.path?.ok) pathOk++;
      if (!hit && check.gaps.length === 0 && tk.gap) beyond.push(`${r.id}#${r.rep} 竹内 ${tk.shapes.join("|")}（抜け: ${tk.gap}）→ ブレイン ${plan.shape}・原則の抜け0`);
      lines.push(`  ${r.id}#${r.rep} 竹内 ${tk.shapes.join("|")} / 組み ${plan.shape} ${hit ? "○" : "✕"} 道 ${r.path?.code ?? "-"} ${r.path?.ok ? "○" : "✕"}  依頼 ${asks.map((a) => a.route[0]).join("") || "-"}${check.gaps.length ? `  抜け: ${check.gaps.join(" / ")}` : ""}`);
    }
    console.log(`\n== ${f}（${rows.length}行）`);
    console.log(lines.join("\n"));
    console.log(`① 竹内さんとの一致（基準）: ${match}/${rows.length}（${Object.entries(byShape).map(([k, v]) => `${k} ${v.hit}/${v.n}`).join("・")}）`);
    console.log(`② 原則の揃い方（答える・信頼・訴求の抜け0）: ${principle}/${rows.length}`);
    console.log(`1通の番の余計な2通目（0を見る）: ${extra}/${singleN}`);
    console.log(`2通・3通の番で依頼に返信と AIX の両方: ${mixedBoth}/${mixedN}`);
    console.log(`道の合格: ${pathOk}/${rows.length}`);
    console.log(`超えた候補（竹内さんに確かめる）: ${beyond.length ? `\n  ${beyond.join("\n  ")}` : "0"}`);
  }
}
if (process.argv[1] && /two-msg-shape-eval/.test(process.argv[1])) main();

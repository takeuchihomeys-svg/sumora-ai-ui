// scripts/audit-asks-facts.ts — COMPOSE_ASKS_FACTS で設計図の「事実」の欄が埋まる数を正解53で測る（AI を呼ばない・DB を読まない・費用0）
//   比べる: 今の設計図の「どの部分」（planFieldsOf.part）／ブレインの依頼ごとの答え（asksFactsOf）を足した事実の欄
//   当たり: 竹内さんの「どの部分」の語の半分以上が事実の欄の文字に入っている（audit-compose-understanding の textHit と同じ形）
//   ⚠ 記録の値（見積の金額・内覧の日時）は答案に無いので、ここでは数えない（本番の配線だけ）
// 実行: npx tsx scripts/audit-asks-facts.ts [--show]
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, readComposeContext, planFieldsOf, type TakeuchiGold } from "../app/lib/compose-sentence-plan";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { asksFactsOf } from "../app/lib/compose-asks-facts";

const ROOT = resolve(__dirname, "..");
const show = process.argv.includes("--show");
const gold = (JSON.parse(readFileSync(join(ROOT, "scripts/compose-understanding/gold-1113.json"), "utf8")) as { turns: TakeuchiGold[] }).turns;
const ids = new Set(gold.map((g) => g.id));
const probs = new Map((JSON.parse(readFileSync(join(ROOT, "scripts/brain-exam/problems.json"), "utf8")) as Array<{ id: string; customer?: string }>).map((p) => [p.id, p]));
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
const words = (t: string | null | undefined) => [...new Set(String(t ?? "").normalize("NFKC").match(/[一-龯ァ-ヶーA-Za-z0-9]{2,}/gu) ?? [])];
const hit = (gold: string, plan: string) => { const a = words(gold); return a.length > 0 && a.filter((w) => plan.normalize("NFKC").includes(w)).length * 2 >= a.length; };
let n = 0, goldHas = 0, nowFilled = 0, newFilled = 0, nowHit = 0, newHit = 0;
for (const g of gold) {
  const b = brainOf.get(g.id)?.brain; if (!b) continue;
  n++;
  const scene = resolveReplyScene({ customerText: String(probs.get(g.id)?.customer ?? "") }).scene;
  const u = readTurnUnderstanding(b), s7 = readSevenFields(b);
  const f = planFieldsOf(u, s7, buildSentencePlan(u, s7, { scene, ctx: readComposeContext(b) }));
  const facts = asksFactsOf(b);
  const nowText = f.part ?? "", newText = [f.part ?? "", ...facts.map((x) => x.text)].join("／");
  if (nowText) nowFilled++; if (newText.replace(/／/g, "")) newFilled++;
  if (!g.part) continue;
  goldHas++;
  const h0 = !!nowText && hit(g.part, nowText), h1 = !!newText && hit(g.part, newText);
  if (h0) nowHit++; if (h1) newHit++;
  if (show && h0 !== h1) console.log(`- ${g.id} 竹内=${g.part}｜今=${nowText || "空"}｜足した=${facts.map((x) => `${x.text}（${x.from}）`).join("・")}`);
}
console.log(`番 ${n}: 事実の欄が埋まった番 今 ${nowFilled} → 足した後 ${newFilled}`);
console.log(`竹内さんの「どの部分」がある ${goldHas} 番の当たり: 今 ${nowHit} → 足した後 ${newHit}`);

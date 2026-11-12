// scripts/audit-compose-roots.ts — 文の外れを2つの根（KB d16cfe1b・P0）＋材料・道で分ける（AI を呼ばない・DB を読まない・費用0）
//   2026-11-12 作業員10（統括役・竹内さん「文の中身弱い部分も土台や細分化たりていないのではないか」）
//   A 考え方の土台が無い（その場面で竹内さんが何をなぜ書くかの決まり・型が無い）
//   B 細分化されていない（型はあるが粗い＝値は出たが竹内さんと違う）
//   C 材料が文の役に届いていない（ブレインは欄を持っているのに設計図に来ない）
//   D 道・読みの誤りが文に流れた（文の側の問題ではない）
// 材料: ① 竹内さんの正解 53番（gold-1113）× 試験の答案の brain ② 本番の直し（exam-cache/edited-turns/2026-10-16/weak-spots.json の文の直し・返信 151＋AIX の文 148）
// 分け方は決まった線（下の rootOfGold・rootOfEdit）。分からない物は「?」で残す。
// 実行: npx tsx scripts/audit-compose-roots.ts [--gold=scripts/compose-understanding/gold-1113.json]
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, readComposeContext, planFieldsOf, type TakeuchiGold, type PlanFields } from "../app/lib/compose-sentence-plan";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { buildComposeBrief, closingOfText } from "../app/lib/compose-brief";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
type Prob = { id: string; customer?: string; staffText?: string; context?: Array<{ s: string; t: string }> };
const gold = (JSON.parse(readFileSync(resolve(ROOT, arg("gold", "scripts/compose-understanding/gold-1113.json")), "utf8")) as { turns: TakeuchiGold[] }).turns;
const ids = new Set(gold.map((g) => g.id));
const probs = new Map((JSON.parse(readFileSync(join(ROOT, "scripts/brain-exam/problems.json"), "utf8")) as Prob[]).map((p) => [p.id, p]));
const brainOf = new Map<string, { at: string; brain: Record<string, unknown> }>();
{
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
type Root = "A" | "B" | "C" | "D";
const ELEMENTS = ["主の役目", "頭", "つなぎ", "押さえ", "信頼", "潜在", "締め", "事実"] as const;
type El = typeof ELEMENTS[number];
const tally = new Map<string, { n: number; ex: string }>();
const all: Array<{ el: El; root: Root; src: string; ex: string; detail?: Record<string, string> }> = [];
const add = (el: El, root: Root, src: string, ex: string, detail?: Record<string, string>) => { all.push({ el, root, src, ex, detail }); const k = `${el}|${root}|${src}`; const v = tally.get(k); if (v) v.n++; else tally.set(k, { n: 1, ex }); };
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const has = (v: unknown) => v != null && v !== "" && !(Array.isArray(v) && !v.length);

// ── ① 正解 53番 ──
/** 道の誤り: ブレインの主の依頼が AIX・出し方が AIX なのに竹内さんは返信だけ */
function pathWrong(b: Record<string, unknown>): boolean {
  const tc = obj(b.turn_contract); const asks = Array.isArray(tc?.asks) ? (tc!.asks as unknown[]).map(obj) : [];
  const lead = asks[typeof tc?.lead_with === "number" ? (tc.lead_with as number) : 0];
  return lead?.route === "aix" || b.reply_mode === "aix";
}
/** その要素の材料をブレインが持っているか（BRAIN_FIELD_ROUTE の「plan」に行く欄） */
const SOURCE: Record<string, (b: Record<string, unknown>) => boolean> = {
  主の役目: (b) => has(obj(b.turn_contract)?.asks) || has(b.turn_read),
  つなぎ: (b) => has(obj(b.seven_read)?.lead) || has(obj(b.appeal_timing)?.kind) || has(b.reply_direction),
  押さえ: (b) => has(obj(b.seven_read)?.point_how) || has(obj(b.judge_basis)?.key_point) || has(b.main_point),
  信頼: (b) => has(obj(b.seven_read)?.trust_how),
  潜在: (b) => has(b.latent_read) || has(b.three_layer) || has(b.customer_concern) || has(obj(b.customer_mindset)?.anxiety) || has(obj(b.seven_read)?.latent),
  事実: (b) => (Array.isArray(obj(b.turn_contract)?.asks) ? (obj(b.turn_contract)!.asks as unknown[]).some((a) => has(obj(a)?.part) || has(obj(a)?.answer)) : false) || has(obj(obj(b.turn_read)?.target)?.detail),
};
function rootOfGold(el: El, goldHas: boolean, hit: boolean, planHas: boolean, b: Record<string, unknown>, fromTable = false): Root | null {
  if (!goldHas || hit) return null;
  if (pathWrong(b)) return "D";
  if (planHas || fromTable) return "B";
  return SOURCE[el]?.(b) ? "C" : "A";
}
let gN = 0;
for (const g of gold) {
  const bb = brainOf.get(g.id); const p = probs.get(g.id);
  if (!bb || !p?.staffText) continue;
  gN++;
  const b = bb.brain; const customerText = String(p.customer ?? ""); const scene = resolveReplyScene({ customerText }).scene;
  const u = readTurnUnderstanding(b), s7 = readSevenFields(b);
  const plan = buildSentencePlan(u, s7, { scene, ctx: readComposeContext(b) });
  const f: PlanFields = planFieldsOf(u, s7, plan);
  const ex = (what: string) => `${g.id}「${customerText.replace(/\s+/g, " ").slice(0, 24)}」${what}`;
  const r1 = rootOfGold("主の役目", true, f.mainRole === g.mainRole, !!f.mainRole, b); if (r1) add("主の役目", r1, "正解53", ex(`竹内=${g.mainRole} 設計図=${f.mainRole ?? "空"}`));
  const leadHit = f.leadTo === g.leadTo && (g.bridgeRole == null || f.bridgeRole === g.bridgeRole);
  const r2 = rootOfGold("つなぎ", g.leadTo !== "none" || g.bridgeRole != null, leadHit, !!f.leadTo || !!f.bridgeRole, b); if (r2) add("つなぎ", r2, "正解53", ex(`竹内=${g.leadTo}/${g.bridgeRole ?? "-"} 設計図=${f.leadTo ?? "空"}/${f.bridgeRole ?? "-"}`));
  const gk = (g as unknown as { keyHow?: string[] }).keyHow ?? [], gt = (g as unknown as { trustHow?: string[] }).trustHow ?? [];
  const fromTable = plan.how?.src === "table";
  const r3 = rootOfGold("押さえ", gk.length > 0, gk.some((x) => (f.keyHow as string[]).includes(x)), f.keyHow.length > 0, b, fromTable); if (r3) add("押さえ", r3, "正解53", ex(`竹内=${gk.join("+")} 設計図=${f.keyHow.join("+") || "空"}${fromTable ? "（表）" : ""}`));
  const r4 = rootOfGold("信頼", gt.length > 0, gt.some((x) => (f.trustHow as string[]).includes(x)), f.trustHow.length > 0, b, fromTable); if (r4) add("信頼", r4, "正解53", ex(`竹内=${gt.join("+")} 設計図=${f.trustHow.join("+") || "空"}${fromTable ? "（表）" : ""}`));
  const r5 = rootOfGold("潜在", g.latent != null, f.latent === g.latent, f.latent != null, b); if (r5) add("潜在", r5, "正解53", ex(`竹内=${g.latent} 設計図=${f.latent ?? "空"}`));
  const r6 = rootOfGold("事実", !!g.part, !!f.part && !!g.part && f.part.includes(g.part.slice(0, 4)), !!f.part, b); if (r6) add("事実", r6, "正解53", ex(`竹内=${g.part} 設計図=${f.part ?? "空"}`), { id: g.id, customer: customerText.slice(0, 160), takeuchiPart: g.part ?? "", takeuchi: String(p.staffText).slice(0, 240), asks: JSON.stringify(obj(b.turn_contract)?.asks ?? []).slice(0, 500) });
  // 締め: 指示書の締め（決め表）× 竹内さんの文。誘導先が外れていれば C（誘導先が届いていない）、誘いは合って結びだけ違えば A（結びの土台が弱い）、誘いが違えば B
  const staff = (p.context ?? []).filter((m) => m.s === "staff").map((m) => m.t);
  const brief = buildComposeBrief({ plan, s7, meta: b, scene, customerText, materialText: staff.slice(-3).join("\n"), recentStaffTexts: staff, firstContact: staff.length === 0 });
  const tk = closingOfText(p.staffText), bc = brief.closing.name;
  if (tk !== bc) {
    const inviteT = /_cta$/.test(tk), inviteB = /_cta$/.test(bc);
    const root: Root = pathWrong(b) ? "D" : inviteT !== inviteB || (inviteT && tk !== bc) ? (leadHit ? "B" : "C") : "A";
    add("締め", root, "正解53", ex(`竹内=${tk} 決め表=${bc}`));
  }
}

// ── ② 本番の直し（weak-spots 2026-10-16・文の直しだけ・aix_turn は道なので D に数える） ──
type Spot = { bucket: string; type: string; scene: string; n: number; examples: Array<{ customer: string; draft: string; sent: string }> };
const ws = JSON.parse(readFileSync(resolve(ROOT, "../../exam-cache/edited-turns/2026-10-16/weak-spots.json"), "utf8")) as { spots: Spot[] };
const STAFF_ONLY_RE = /見積|御見積|割引|円|内覧[^。]{0,10}(?:\d{1,2}[:：時]|日)|\d{1,2}[:：]\d{2}|\d{1,2}時/;
function rootOfEdit(s: Spot, e: { customer: string; draft: string; sent: string }): Array<[El, Root]> {
  const aix = s.bucket === "aix_text_edit";
  switch (s.type) {
    case "greeting_added": case "greeting_cut": case "name_line_added": return [["頭", "B"]]; // 決まり（挨拶は基本・了承だけは省く 10/08）はあるが番の分け方が粗い
    case "close_added": case "close_cut": return [["締め", "A"]]; // 締めの決め表が無かった（11/12 に COMPOSE_CLOSING_TABLE を作った）
    case "appeal_added": case "appeal_cut": return [["つなぎ", "B"]]; // 押す強さの上限・刺さり3分岐はあるが粗い
    case "fact_fix": return [["事実", STAFF_ONLY_RE.test(e.sent) && !STAFF_ONLY_RE.test(e.customer) ? "D" : "C"]]; // 人しか知らない値＝AIX の番 / それ以外は材料が届いていない
    case "promise_escape": return [["主の役目", "C"]]; // 答えの材料があるのに確認の約束（材料が答えの役に届いていない）
    case "promise_added": return [["主の役目", "D"]]; // 人が確認の約束にした＝スタッフだけが知る事を返信で言い切った（AIX と返信の分け方）
    case "vague_promise_cut": return [["主の役目", "B"]]; // 約束の型が粗い（対象の無い約束）
    case "extra_cut": return [["信頼", "B"]]; // 信頼の一言（伴走・安心）の出し時が粗い
    case "longer": return [["押さえ", aix ? "B" : "C"]]; // 人が中身を足した＝返信は材料が届いていない・AIX の文は型が粗い
    case "shorter": return [["押さえ", "B"]]; // 長さの型が粗い
    case "rewrite": return [["主の役目", "D"]]; // 近さ0.3未満＝場面・中身が違う（読み違い・AIX の種類違い）
    default: return [["事実", "D"]]; // other: 人しか知らない事・型の網に当たらない
  }
}
let eN = 0;
for (const s of ws.spots) {
  if (s.bucket === "aix_turn") { add("主の役目", "D", "直し", `AIX の番を人が押した ${s.scene}（${s.n}番）`); continue; }
  for (const e of s.examples) { eN++; for (const [el, r] of rootOfEdit(s, e)) add(el, r, s.bucket === "reply_edit" ? "直し・返信" : "直し・AIX の文", `${s.type}「${e.customer.replace(/\s+/g, " ").slice(0, 18)}」→ 人「${e.sent.replace(/\s+/g, " ").slice(0, 40)}」`, { scene: s.scene, type: s.type, customer: e.customer, draft: e.draft, sent: e.sent }); }
}

console.log(`正解 ${gN}番・本番の直しの例 ${eN}通（weak-spots の文の直しの例・aix_turn は種類ごとに1と数える）`);
console.log("要素｜A 土台が無い｜B 細分化が粗い｜C 材料が届いていない｜D 道・読みの誤り");
for (const el of ELEMENTS) {
  const cell = (r: Root) => { const xs = [...tally.entries()].filter(([k]) => k.startsWith(`${el}|${r}|`)); const n = xs.reduce((a, [, v]) => a + v.n, 0); return n ? `${n}（${xs.map(([k, v]) => `${k.split("|")[2]} ${v.n}`).join("・")}）` : "0"; };
  console.log(`${el}｜${cell("A")}｜${cell("B")}｜${cell("C")}｜${cell("D")}`);
}
console.log("\n代表の実物（要素×根の最初の1通）");
for (const el of ELEMENTS) for (const r of ["A", "B", "C", "D"] as Root[]) { const x = [...tally.entries()].find(([k]) => k.startsWith(`${el}|${r}|`)); if (x) console.log(`- ${el}×${r}: ${x[1].ex}`); }
// --dump=<json> [--dump-el=事実|C]: 行ごとに書き出す（他の作業員に渡す時）
if (arg("dump")) { writeFileSync(arg("dump"), JSON.stringify(all.filter((x) => !arg("dump-el") || `${x.el}|${x.root}` === arg("dump-el")), null, 1)); console.log(`書いた: ${arg("dump")}`); }

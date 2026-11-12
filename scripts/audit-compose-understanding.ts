// scripts/audit-compose-understanding.ts — 『文の統括が理解できているか』の物差し（AI を呼ばない・DB を読まない）
//
// 2026-11-11 作業員10（KB P1 c3673fba ④「設計図の各欄が竹内さんの同じ番の文の欄と合うか（欄ごとの当たり）。書き上がった文だけで採点しない」）。
//   正解: scripts/compose-understanding/gold-*.json（竹内さんの番の文の欄を人が付けた物・申込の門で外した番は入れない）
//   設計図の材料: 試験の答案（scripts/brain-exam/results/*.jsonl の brain＝その番のブレインの判断・読み）。--results で場所を変える
//   比べる2つ:
//     今＝今の文の統括（reply-compose-conductor の「この通の重点」＝役目1つ＋継続の約束）が持つ欄
//     新＝compose-sentence-plan（COMPOSE_SENTENCE_PLAN）の1文ずつの設計図が持つ欄
//   欄: 主の役目・役目の組み合わせ・主→従の順・何の物件・何の事・どの部分・誘導先・次へのつなぎ・訴求・潜在意識のカバー・要点の押さえ方・信頼の作り方
//   数え方: 竹内さんに値がある番のうち当たった数（hit/goldHas）。竹内さんに値が無いのに埋めた数＝extra（作り話・余分の目安）
// 実行: npx tsx scripts/audit-compose-understanding.ts [--gold=scripts/compose-understanding/gold-1111.json] [--results=<jsonl かフォルダ,…>] [--out=<json>] [--show]
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readTurnUnderstanding, readSevenFields, buildSentencePlan, readComposeContext, planFieldsOf, scoreFields, tallyFields, understandingCoverage, sentencePlanNote,
  SCORE_FIELDS, UNDERSTANDING_FIELDS, type TakeuchiGold, type PlanFields, type ScoreField, type FieldHit,
} from "../app/lib/compose-sentence-plan";
import { decideMessageFocus, readComposeInputs, prevStaffKindOf, customerAskedNewOf, type MessageFocusKey } from "../app/lib/reply-compose-conductor";
import { resolveReplyScene } from "../app/lib/reply-scene";
import type { SentenceRole } from "../app/lib/takeuchi-anatomy-roles";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);
const ROOT = resolve(__dirname, "..");

type Prob = { id: string; customer?: string; context?: Array<{ s: string; t: string }> };
type Row = { id: string; at?: string; brain?: Record<string, unknown> };

// --ids=q022,q063: この番だけ測る（前後で同じ番を比べる）。--only-brain: 答案の brain がある番だけ数える（案A の試験の答案は一部の番だけ）
const goldAll = (JSON.parse(readFileSync(resolve(ROOT, arg("gold", "scripts/compose-understanding/gold-1111.json")), "utf8")) as { turns: TakeuchiGold[] }).turns;
const idsArg = new Set(arg("ids").split(",").map((x) => x.trim()).filter(Boolean));
let gold = idsArg.size ? goldAll.filter((g) => idsArg.has(g.id)) : goldAll;
const ids = new Set(gold.map((g) => g.id));
const probs = new Map((JSON.parse(readFileSync(join(ROOT, "scripts/brain-exam/problems.json"), "utf8")) as Prob[]).map((p) => [p.id, p]));

/** 答案のファイル（既定: この作業ツリーと横の作業ツリーの results の main-*.jsonl・14日以内）。同じ問題は新しい答案の brain を使う */
function resultFiles(): string[] {
  const given = arg("results");
  const dirs = given ? given.split(",") : [join(ROOT, "scripts/brain-exam/results"), ...(() => { const wt = resolve(ROOT, ".."); try { return readdirSync(wt).map((d) => join(wt, d, "scripts/brain-exam/results")); } catch { return []; } })()];
  const out: string[] = [];
  const since = Date.now() - 14 * 86_400_000;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    if (d.endsWith(".jsonl")) { out.push(d); continue; }
    for (const f of readdirSync(d)) if (/^main-.*\.jsonl$/.test(f) || given) { const p = join(d, f); if (f.endsWith(".jsonl") && statSync(p).mtimeMs >= since) out.push(p); }
  }
  return out;
}
const brainOf = new Map<string, { at: string; brain: Record<string, unknown>; file: string }>();
// --brains=<json>: 固定した答案の brain（scripts/compose-understanding/brains-1112.json の形 [{id, at, brain}]）だけで測る（答案が新しくなっても前後で同じ材料）
if (arg("brains")) for (const r of JSON.parse(readFileSync(resolve(ROOT, arg("brains")), "utf8")) as Array<{ id: string; at?: string; brain: Record<string, unknown> }>) brainOf.set(r.id, { at: r.at ?? "", brain: r.brain, file: arg("brains") });
for (const f of arg("brains") ? [] : resultFiles()) {
  let txt = ""; try { txt = readFileSync(f, "utf8"); } catch { continue; }
  for (const line of txt.split("\n")) {
    if (!line.includes('"brain"')) continue;
    const m = line.match(/^\{"id":"(q\d+)"/); if (!m || !ids.has(m[1])) continue;
    let r: Row; try { r = JSON.parse(line) as Row; } catch { continue; }
    if (!r.brain || !r.brain.turn_contract) continue;
    const prev = brainOf.get(r.id);
    if (!prev || (r.at ?? "") > prev.at) brainOf.set(r.id, { at: r.at ?? "", brain: r.brain, file: f });
  }
}

if (flag("only-brain")) gold = gold.filter((g) => brainOf.has(g.id));
/** 今の文の統括（この通の重点）→ 比べる欄。重点の役目1つ＋継続の約束だけ（他の欄は持っていない） */
const FOCUS_ROLE: Record<MessageFocusKey, SentenceRole | null> = { answer: "answer", promise: "promise", ease: "worry", close: "viewing", propose: "keep", relation_ack: "uke", relation_keep: "uke" };
function currentFields(brain: Record<string, unknown>, p: Prob | undefined): PlanFields {
  const customerText = String(p?.customer ?? "");
  const lastStaff = [...(p?.context ?? [])].reverse().find((m) => m.s === "staff")?.t ?? null;
  const mf = decideMessageFocus({ inputs: readComposeInputs(brain), scene: resolveReplyScene({ customerText }).scene, ackOnly: false, prevStaff: prevStaffKindOf(lastStaff), customerAskedNew: customerAskedNewOf(customerText), keepSaidToday: false, nearKeepShare: null });
  const r = FOCUS_ROLE[mf.key];
  const roles = [r, mf.keep ? "keep" : null].filter((x): x is SentenceRole => !!x);
  return { roles, mainRole: r, property: null, about: null, part: null, leadTo: mf.keep ? "keep" : null, bridgeRole: null, appeal: [], latent: null, keyHow: [], trustHow: [] };
}

const nowRows: Array<Record<ScoreField, FieldHit>> = [];
const newRows: Array<Record<ScoreField, FieldHit>> = [];
const cov = new Map<string, { got: number; inPlan: number }>();
const per: Array<Record<string, unknown>> = [];
let noBrain = 0;
for (const g of gold) {
  const b = brainOf.get(g.id);
  const brain = b?.brain ?? {};
  if (!b) noBrain++;
  const u = readTurnUnderstanding(brain), s = readSevenFields(brain), plan = buildSentencePlan(u, s, { scene: resolveReplyScene({ customerText: String(probs.get(g.id)?.customer ?? "") }).scene, ctx: readComposeContext(brain) });
  const nf = planFieldsOf(u, s, plan), cf = currentFields(brain, probs.get(g.id));
  const sNew = scoreFields(g, nf), sNow = scoreFields(g, cf);
  newRows.push(sNew); nowRows.push(sNow);
  for (const [k, v] of Object.entries(understandingCoverage(u, s, plan))) { const c = cov.get(k) ?? { got: 0, inPlan: 0 }; c.got += v.got ? 1 : 0; c.inPlan += v.inPlan ? 1 : 0; cov.set(k, c); }
  const sev = (brain as { seven_read?: unknown; latent_read?: unknown });
  per.push({ seven: !!sev.seven_read, latent4: !!sev.latent_read, id: g.id, brainFrom: b ? b.file.replace(/^.*worktrees[\\/]/, "") : null, gold: { main: g.mainRole, roles: g.roles, lead: g.leadTo, latent: g.latent }, now: { main: cf.mainRole, roles: cf.roles }, new: { main: nf.mainRole, roles: nf.roles, lead: nf.leadTo, property: nf.property, about: nf.about, latent: nf.latent }, hitNew: sNew, hitNow: sNow, note: flag("show") ? sentencePlanNote(plan) : undefined });
}
const tNow = tallyFields(nowRows), tNew = tallyFields(newRows);
const pct = (h: number, n: number) => (n ? `${h}/${n}（${Math.round((h / n) * 100)}%）` : "-");
console.log(`竹内さんの番 ${gold.length}（答案の brain あり ${gold.length - noBrain}・無し ${noBrain}・7つの欄あり ${per.filter((p) => p.seven).length}・潜在の4欄あり ${per.filter((p) => p.latent4).length}）`);
console.log("\n欄ごとの当たり（竹内さんに値がある番のうち）｜今の文の統括｜新（1文ずつの設計図）｜新が値の無い番を埋めた数");
for (const f of SCORE_FIELDS) console.log(`- ${f}｜${pct(tNow[f].hit, tNow[f].goldHas)}｜${pct(tNew[f].hit, tNew[f].goldHas)}｜${tNew[f].extra}`);
console.log("\n欄の受け取り（新・番の数）: 材料にある｜設計図に出た");
for (const f of UNDERSTANDING_FIELDS) { const c = cov.get(f) ?? { got: 0, inPlan: 0 }; console.log(`- ${f}｜${c.got}｜${c.inPlan}`); }
if (flag("show")) for (const p of per) console.log(`\n== ${p.id}\n${JSON.stringify({ gold: p.gold, now: p.now, new: p.new })}\n${(p.note as string) || "（注記なし）"}`);
const out = arg("out");
if (out) { writeFileSync(resolve(ROOT, out), JSON.stringify({ at: new Date().toISOString(), n: gold.length, noBrain, now: tNow, new: tNew, coverage: Object.fromEntries(cov), per }, null, 1)); console.log(`\n書いた: ${out}`); }

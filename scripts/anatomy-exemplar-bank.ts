// scripts/anatomy-exemplar-bank.ts — 竹内さんの手本の束を作り（exam-cache・倉庫の外）、gold の番で「引いた手本の役目の並び」が竹内さんの実際とどれだけ同じかを測る
//   2026-11-12 作業員5。LLM を呼ばない・DB を読まない（手元の roles-r1・seven-all198・seven-latent4*・seven-claude-43.tsv と、作業員10 の gold・試験の答案だけ）。
//   純関数は app/lib/takeuchi-exemplar.ts。束は申込の手前の番だけ（roles-r1 は turn-application-gate を通した 198通）・名前は YUMA に伏せ済み。
// 実行: npx tsx scripts/anatomy-exemplar-bank.ts [--gold=../compose-1105/scripts/compose-understanding/gold-1111.json] [--result=../compose-1105/scripts/compose-understanding/result-1111.json]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { latentKeyOf, leadKeyOf, pickExemplar, roleSeqSimilarity, brainFieldOf, BRAIN_FIELD_LABEL, type Exemplar } from "../app/lib/takeuchi-exemplar";
import { LEAD_TO, type LeadTo, type SentenceRole } from "../app/lib/takeuchi-anatomy-roles";
import { maskSelfNamesPair } from "../app/lib/self-name-mask";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(process.cwd(), "..", "..", "exam-cache");
const WT = resolve(process.cwd(), "..");
type R1 = { id: string; scene: string; sentences: string[]; roles: Array<{ i: number; role: SentenceRole | null; why: string | null }>; customer: string };
type Seven = { id: string; reads: Array<{ lead: LeadTo | null; latent?: { fact?: string } | null } | null> };
type L4 = { id: string; reads: Array<{ trigger?: { text: string }; part?: { property: string | null; point: string }; feeling?: { what: string; strength: string }; want?: string; fact?: string | null } | null> };

const r1 = JSON.parse(readFileSync(join(CACHE, "anatomy-roles", "roles-r1.json"), "utf8")) as R1[];
const seven = new Map((JSON.parse(readFileSync(join(CACHE, "anatomy-seven", "seven-all198.json"), "utf8")) as Seven[]).map((o) => [o.id, o.reads[0]]));
const l4 = new Map([...["seven-latent4.json", "seven-latent4b.json"]].flatMap((f) => (existsSync(join(CACHE, "anatomy-seven", f)) ? (JSON.parse(readFileSync(join(CACHE, "anatomy-seven", f), "utf8")) as L4[]) : [])).map((o) => [o.id, o.reads[0]]));
// Claude Code が手で読んだ 43通（誘導先は手の読みを正にする）
const hand = new Map<string, LeadTo>();
const tsv = join(CACHE, "anatomy-seven", "seven-claude-43.tsv");
if (existsSync(tsv)) { const L = readFileSync(tsv, "utf8").trim().split("\n").map((l) => l.split("\t")); const li = L[0].indexOf("誘導先"); for (const r of L.slice(1)) if ((LEAD_TO as readonly string[]).includes(r[li])) hand.set(r[0], r[li] as LeadTo); }

// 割れた文（3回読みで多数が無い 41文）は Claude Code の読み（split-r1-claude.json）で埋める
const splitFix = new Map<string, SentenceRole>();
const sp = join(CACHE, "anatomy-roles", "split-r1-claude.json");
if (existsSync(sp)) for (const x of JSON.parse(readFileSync(sp, "utf8")) as Array<{ id: string; i: number; role: SentenceRole }>) splitFix.set(`${x.id}#${x.i}`, x.role);
// gold の番そのもの（試験の問題と同じ送信）は束に入れない＝答えを見て当てない
const goldIds = new Set((existsSync(resolve(arg("gold", "../compose-1105/scripts/compose-understanding/gold-1111.json"))) ? (JSON.parse(readFileSync(resolve(arg("gold", "../compose-1105/scripts/compose-understanding/gold-1111.json")), "utf8")) as { turns: Array<{ id: string }> }).turns : []).map((t) => t.id));
const goldStaff = (JSON.parse(readFileSync(join(process.cwd(), "scripts/brain-exam/problems.json"), "utf8")) as Array<{ id: string; staffText?: string }>).filter((p) => goldIds.has(p.id)).map((p) => String(p.staffText ?? "").replace(/s+/g, ""));
const isGoldTurn = (sents: string[]) => { const k = sents.map((x) => x.replace(/s+/g, "")).filter((x) => x.length >= 12).slice(0, 2); return k.length > 0 && goldStaff.some((g) => k.every((x) => g.includes(x))); };
let skippedGold = 0;
const bank: Array<Exemplar & { hand: boolean }> = [];
for (const o of r1) {
  const s7 = seven.get(o.id); const f4 = l4.get(o.id);
  const lead = hand.get(o.id.slice(0, 8)) ?? s7?.lead ?? null;
  if (!lead) continue;
  if (isGoldTurn(o.sentences)) { skippedGold++; continue; }
  const sm = maskSelfNamesPair(o.customer, o.sentences.join("\u0000"));
  const sents = sm.staff.split("\u0000");
  bank.push({
    id: o.id, scene: o.scene, latent: latentKeyOf(o.customer), lead, hand: hand.has(o.id.slice(0, 8)),
    customer: (sm.customer ?? "").slice(0, 200),
    sentences: sents.map((text, k) => { const role = o.roles[k]?.role ?? splitFix.get(`${o.id}#${k + 1}`) ?? null; return { text, role, why: (o.roles[k]?.why ?? "").slice(0, 40), brainField: brainFieldOf(role) }; }),
    latentFour: f4?.feeling && f4.want ? { trigger: f4.trigger?.text ?? "", part: `${f4.part?.property ?? ""}${f4.part?.point ?? ""}`, feeling: `${f4.feeling.what}（${f4.feeling.strength}）`, want: f4.want } : null,
    fact: f4?.fact ?? s7?.latent?.fact ?? null,
  });
}
writeFileSync(join(CACHE, "anatomy-seven", "exemplar-bank.json"), JSON.stringify(bank, null, 1));
// ① 手本の表（型＝場面×潜在×誘導先 ごとに1〜3通・手で読んだ物を先に）
const byKey = new Map<string, typeof bank>();
for (const e of bank) { const k = `${e.scene}|${e.latent}|${e.lead}`; (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(e); }
const md: string[] = ["# 竹内さんの手本の表（場面×潜在の型×誘導先・1文ずつ 役目／なぜ／ブレインの欄）", "", `束 ${bank.length}通・型 ${byKey.size}（2通以上の型だけ載せる）・名前は YUMA に伏せ済み・申込の手前の番だけ`, ""];
for (const [k, list] of [...byKey.entries()].filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length)) {
  md.push(`## ${k}（${list.length}通）`);
  for (const e of list.sort((a, b) => Number(b.hand) - Number(a.hand)).slice(0, 2)) {
    md.push(`- ${e.id.slice(0, 8)}${e.hand ? "（手で読んだ）" : ""} 客: ${e.customer.replace(/\n/g, " / ").slice(0, 90)}`);
    if (e.latentFour) md.push(`  - 潜在: きっかけ「${e.latentFour.trigger}」・部分 ${e.latentFour.part}・気持ち ${e.latentFour.feeling}・したい事 ${e.latentFour.want}${e.fact ? `・事実 ${e.fact}` : ""}`);
    e.sentences.forEach((s, i) => md.push(`  ${i + 1}. [${s.role ?? "?"}｜${BRAIN_FIELD_LABEL[s.brainField]}] ${s.text.slice(0, 80)} ← ${s.why}`));
  }
  md.push("");
}
writeFileSync(join(CACHE, "anatomy-seven", "exemplar-table.md"), md.join("\n"));
console.log(`束 ${bank.length}通（gold と同じ送信 ${skippedGold}通は入れない）・型 ${byKey.size}・2通以上の型 ${[...byKey.values()].filter((l) => l.length >= 2).length}`);

// ③ gold の番で測る: ブレインの判断から鍵を作って引いた手本の並び vs 竹内さんの並び（比べに: 誘導先を正解で与えた時・今の設計図）
const goldPath = resolve(arg("gold", "../compose-1105/scripts/compose-understanding/gold-1111.json"));
const resPath = resolve(arg("result", "../compose-1105/scripts/compose-understanding/result-1111.json"));
if (!existsSync(goldPath)) { console.log("gold が無いので測らない"); process.exit(0); }
type Gold = { id: string; roles: SentenceRole[]; leadTo: LeadTo | null };
const gold = (JSON.parse(readFileSync(goldPath, "utf8")) as { turns: Gold[] }).turns;
const per = new Map((JSON.parse(readFileSync(resPath, "utf8")) as { per: Array<{ id: string; brainFrom: string; new?: { roles?: string[] } }> }).per.map((p) => [p.id, p]));
const probs = new Map((JSON.parse(readFileSync(join(process.cwd(), "scripts/brain-exam/problems.json"), "utf8")) as Array<{ id: string; sub?: string; customer?: string }>).map((p) => [p.id, p]));
const brainOf = (file: string, id: string): Record<string, unknown> | null => {
  const f = isAbsolute(file) ? file : join(WT, file);
  if (!existsSync(f)) return null;
  for (const l of readFileSync(f, "utf8").split("\n")) { if (!l.trim()) continue; try { const j = JSON.parse(l) as { id: string; brain?: Record<string, unknown> }; if (j.id === id) return j.brain ?? null; } catch { /* 壊れた行は飛ばす */ } }
  return null;
};
let sB = 0, sO = 0, sP = 0, leadHit = 0, sameB = 0;
const rows: string[] = [];
for (const g of gold) {
  const p = probs.get(g.id); const pr = per.get(g.id); const b = pr ? brainOf(pr.brainFrom, g.id) : null;
  const scene = String(p?.sub ?? "").split(":")[0];
  const concern = b?.customer_concern as { topic?: string; object?: string } | undefined;
  const latent = latentKeyOf(p?.customer ?? "", concern ? `${concern.topic ?? ""} ${concern.object ?? ""}` : null);
  const lead = leadKeyOf({ dir: b?.reply_direction as string, action: (b?.action ?? b?.aix) as string, mode: b?.reply_mode as string });
  const hb = pickExemplar(bank, { scene, latent, lead });
  const ho = pickExemplar(bank, { scene, latent, lead: g.leadTo ?? "none" });
  const simB = hb ? roleSeqSimilarity(hb.ex.sentences.map((s) => s.role), g.roles) : 0;
  const simO = ho ? roleSeqSimilarity(ho.ex.sentences.map((s) => s.role), g.roles) : 0;
  const simP = roleSeqSimilarity(pr?.new?.roles ?? [], g.roles);
  sB += simB; sO += simO; sP += simP; if (lead === g.leadTo) leadHit++; if (simB === 1) sameB++;
  rows.push(`${g.id}\t${scene}\t${latent}\t${lead}${lead === g.leadTo ? "" : `(正解 ${g.leadTo})`}\tL${hb?.level ?? "-"}\t${(hb?.ex.sentences.map((s) => s.role).join(">")) ?? "-"}\t${g.roles.join(">")}\t${simB.toFixed(2)}\t${simO.toFixed(2)}\t${simP.toFixed(2)}`);
}
const n = gold.length;
const out = [`id\t場面\t潜在の型\t誘導先(ブレインから)\t段\t引いた手本の並び\t竹内さんの並び\t近さ(ブレイン鍵)\t近さ(誘導先を正解で)\t近さ(今の設計図)`, ...rows,
  `# ${n}番: 近さの平均 ブレインの鍵 ${(sB / n).toFixed(2)}・誘導先を正解で与えた時 ${(sO / n).toFixed(2)}・今の設計図 ${(sP / n).toFixed(2)}／誘導先の当たり ${leadHit}/${n}／並びが同じ ${sameB}/${n}`];
writeFileSync(join(CACHE, "anatomy-seven", "exemplar-gold-1111.tsv"), out.join("\n"));
console.log(out[out.length - 1]);

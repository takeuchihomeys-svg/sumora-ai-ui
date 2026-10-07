// scripts/audit-r3-replay-score.ts — 3巡目: yuma-r3-replay.ts の出力をスタッフの実際と比べる（読むだけ・LLM なし）
//   ①道（ブレインの版ごと）: 返信⇔スタッフの手打ち／AIX⇔スタッフが押した AIX（物件の AIX は送付・オススメ・ピックアップを同じに）
//   ②文（下書きの版ごと・スタッフが手打ちした番だけ）: 見張りと同じ判定（judgeTurn の same/same_meaning）・似ている度・確認に逃げる・訴求の足しすぎ・行為の不足/余り・扉の1文
// 実行: npx tsx scripts/audit-r3-replay-score.ts <jsonl> [<jsonl> ...] [--show=<scene|all>] [--brain=new]
import { readFileSync } from "node:fs";
import { bigramSim, editCore, classifyEdit } from "../app/lib/edit-diff";
import { judgeTurn, isAgree } from "../app/lib/line-watch-judge";
import { staffActsOf } from "../app/lib/customer-sim-shadow";
import { detectAppeal } from "../app/lib/appeal-timing";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const show = process.argv.find((a) => a.startsWith("--show="))?.slice(7);
type B = { action?: string | null; reply_mode?: string | null; src?: string | null };
type R = { id: string; scene: string; staffPath: string[]; customer?: string[]; staff?: string; error?: string; skip?: string; no_draft?: string } & Record<string, unknown>;
const rows: R[] = files.flatMap((f) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as R));
const usable = rows.filter((r) => !r.error && !r.skip);
const PROP = /^property_(send|recommendation|pickup)$/;
const sameAix = (a: string, b: string) => a === b || (PROP.test(a) && PROP.test(b));
const N = (s: string) => s.normalize("NFKC");
const CHECK = /確認(?:させて|致し|いたし|して|し(?:ご連絡|次第|て)|出来次第)|お調べ|問い合わせ|問合せ/;
const EXTRA = /見つかるまで|全力で|サポートさせて|尽力|最善の|ご安心|安心です|楽しみ|嬉しく思/;
const pct = (a: number, n: number) => `${Math.round((a / Math.max(1, n)) * 100)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ① 道（ブレインの版ごと・回数（brain_on_1 …）は同じ版にまとめ、番ごとの一致率の平均と 95% の幅＝番を単位にした標準誤差×1.96）
//   ピッカー: スタッフがピッカー付きで押した番で、ブレインが同じ AIX を選んだ時の check_pattern の一致
const bBase = (k: string) => k.slice(6).replace(/_\d+$/, "");
const brainKeys = [...new Set(usable.flatMap((r) => Object.keys(r).filter((k) => k.startsWith("brain_") && k !== "brain_errors").map(bBase)))];
console.log(`番 ${usable.length}（エラー ${rows.filter((r) => r.error).length}・飛ばし ${rows.filter((r) => r.skip).length}）`);
const scenes = [...new Set(usable.map((r) => r.scene))];
const pathOk = (r: R, x: B) => { const brain = x.reply_mode === "aix" && x.action ? x.action : "reply"; return brain === "reply" ? r.staffPath[0] === "reply" : r.staffPath.some((s) => sameAix(s, brain)); };
// 竹内さん「１それで大丈夫」（10/07）: AI の2段の約束の返信＋スタッフがその約束の AIX を直接押した＝決まりどおり（見張り v5 と同じ）
const pathOk2 = (r: R, x: B) => {
  if (pathOk(r, x)) return true;
  const m = /two_stage_promise\((pickup|check|check_question|estimate)\)/.exec(x.src ?? "");
  if (!m || x.reply_mode === "aix") return false;
  const k = m[1];
  return r.staffPath.some((a) => (k === "pickup" && /^property_(send|recommendation|search)$/.test(a)) || (k.startsWith("check") && (a === "property_check_result" || a === "acknowledge_check")) || (k === "estimate" && a === "estimate_sheet"));
};
const turnRate = (r: R, b: string, f: (r: R, x: B) => boolean | null) => {
  const xs = Object.keys(r).filter((k) => k.startsWith("brain_") && k !== "brain_errors" && bBase(k) === b).map((k) => r[k] as B);
  const v = xs.map((x) => f(r, x)).filter((y): y is boolean => y !== null);
  return v.length ? v.filter(Boolean).length / v.length : null;
};
const meanCi = (xs: number[]) => { const n = xs.length; if (!n) return { m: NaN, ci: NaN, n }; const m = xs.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1)); return { m, ci: (1.96 * sd) / Math.sqrt(n), n }; };
const fmtCi = (o: { m: number; ci: number; n: number }) => (o.n ? `${Math.round(o.m * 100)}%±${Math.round(o.ci * 100)}（n=${o.n}）` : "-");
const cpOk = (r: R, x: B) => {
  const cps = ((r as { staffCp?: string[] }).staffCp ?? []);
  if (!cps.length) return null;
  const a = x.reply_mode === "aix" ? x.action : null;
  const hit = cps.find((c) => a && sameAix(c.split(":")[0], a));
  if (!hit) return null;
  return (x as B & { cp?: string | null }).cp === hit.split(":")[1];
};
const kinds = (r: R, x: B) => { const brain = x.reply_mode === "aix" && x.action ? x.action : "reply"; const sr = r.staffPath[0] === "reply"; return pathOk(r, x) ? "agree" : brain === "reply" ? "r2a" : sr ? "a2r" : "other"; };
for (const b of brainKeys) {
  const line = (rs: R[]) => {
    const rates = rs.map((r) => turnRate(r, b, pathOk)).filter((x): x is number => x !== null);
    const rates2 = rs.map((r) => turnRate(r, b, pathOk2)).filter((x): x is number => x !== null);
    const cps = rs.map((r) => turnRate(r, b, cpOk)).filter((x): x is number => x !== null);
    const k = { a2r: 0, r2a: 0, other: 0, all: 0 };
    for (const r of rs) for (const key of Object.keys(r).filter((q) => q.startsWith("brain_") && q !== "brain_errors" && bBase(q) === b)) { const kk = kinds(r, r[key] as B); k.all++; if (kk !== "agree") k[kk as "a2r" | "r2a" | "other"]++; }
    return `道の一致 ${fmtCi(meanCi(rates))}（2段の決まりどおりを一致に ${fmtCi(meanCi(rates2))}）｜外れの内訳（全回）AI=AIX→人=返信 ${k.a2r}・AI=返信→人=AIX ${k.r2a}・別の AIX ${k.other}／${k.all}回｜ピッカー一致 ${fmtCi(meanCi(cps))}`;
  };
  console.log(`\n■ ブレイン ${b}: 全体 ${line(usable)}`);
  for (const s of scenes) console.log(`   ${s.padEnd(15)} ${line(usable.filter((r) => r.scene === s))}`);
}
// 版の差（番ごとに対にして・on − off）
if (brainKeys.includes("on") && brainKeys.includes("off")) {
  console.log("\n■ 場面で絞る（on − off・番ごとの差の平均と 95% の幅）");
  for (const s of ["全体", ...scenes]) {
    const rs = usable.filter((r) => s === "全体" || r.scene === s);
    const d = rs.map((r) => { const a = turnRate(r, "on", pathOk), c = turnRate(r, "off", pathOk); return a !== null && c !== null ? a - c : null; }).filter((x): x is number => x !== null);
    const o = meanCi(d);
    console.log(`   ${s.padEnd(15)} 道の一致の差 ${o.n ? `${o.m >= 0 ? "+" : ""}${Math.round(o.m * 100)}pt ±${Math.round(o.ci * 100)}（n=${o.n}）${Math.abs(o.m) > o.ci ? " ← 揺れより大きい" : ""}` : "-"}`);
  }
}

// ② 文
function score(draft: string, staff: string) {
  const now = new Date().toISOString();
  const j = judgeTurn({ draft, brainAction: null, brainReplyMode: "reply", hasBrain: true, window: { closed: true, texts: [{ at: now, text: staff, burst: true }], presses: [], aixMessages: 0, aixMessagesBurst: 0 } });
  const e = classifyEdit(draft, staff);
  const A = staffActsOf(draft), Bs = staffActsOf(staff);
  const ad = detectAppeal(draft), as = detectAppeal(staff);
  return {
    agree: isAgree(j.verdict), sim: bigramSim(editCore(draft), editCore(staff)), close: e.amount === "none" || e.amount === "tiny" || e.amount === "small",
    checkEscape: CHECK.test(N(draft)) && !CHECK.test(N(staff)), extra: EXTRA.test(draft) && !EXTRA.test(staff),
    appealExtra: (ad.apply || ad.viewing) && !(as.apply || as.viewing), appealMiss: !(ad.apply || ad.viewing) && (as.apply || as.viewing),
    actMiss: [...Bs].filter((x) => !A.has(x)).length, actExtra: [...A].filter((x) => !Bs.has(x)).length,
  };
}
type S = ReturnType<typeof score>;
const baseOf = (k: string) => k.slice(6).replace(/_\d+$/, "");
const variants = [...new Set(usable.flatMap((r) => Object.keys(r).filter((k) => k.startsWith("draft_")).map(baseOf)))];
const textRows = usable.filter((r) => r.staffPath[0] === "reply" && r.staff);
const agg = new Map<string, Map<string, S[]>>();
for (const r of textRows) for (const v of variants) for (const k of Object.keys(r).filter((x) => x.startsWith("draft_") && baseOf(x) === v)) {
  const d = r[k] as string | null; if (!d) continue;
  const s = score(d, r.staff!);
  for (const sc of [r.scene, "全体"]) { if (!agg.has(sc)) agg.set(sc, new Map()); const m = agg.get(sc)!; m.set(v, [...(m.get(v) ?? []), s]); }
}
if (variants.length) {
  console.log(`\n■ 下書きの文（スタッフが手打ちした番 ${textRows.length}・ブレインが AIX で下書きなし ${textRows.filter((r) => r.no_draft).length}）列: ${variants.join(" / ")}`);
  console.log("場面 | n | 一致 | 近い | 似ている度 | 確認に逃げる | 余計な一文 | 訴求を足す | 訴求が抜ける | 行為の不足 | 行為の余り");
  for (const [k, m] of [...agg].sort((a, b) => (a[0] === "全体" ? -1 : b[0] === "全体" ? 1 : 0))) {
    const cell = (f: (xs: S[]) => string) => variants.map((v) => f(m.get(v) ?? [])).join(" / ");
    const p = (sel: (s: S) => boolean) => (xs: S[]) => pct(xs.filter(sel).length, xs.length);
    console.log(`${k} | ${cell((x) => String(x.length))} | ${cell(p((s) => s.agree))} | ${cell(p((s) => s.close))} | ${cell((x) => avg(x.map((s) => s.sim)).toFixed(2))} | ${cell(p((s) => s.checkEscape))} | ${cell(p((s) => s.extra))} | ${cell(p((s) => s.appealExtra))} | ${cell(p((s) => s.appealMiss))} | ${cell((x) => avg(x.map((s) => s.actMiss)).toFixed(2))} | ${cell((x) => avg(x.map((s) => s.actExtra)).toFixed(2))}`);
  }
}
// ③ ブレインの判断（必須の話題 key_topics）と下書き・スタッフの文のずれ: 話題ごとに「下書きにある／スタッフの文にある」を語の重なりで読む
//   ブレインの話題がスタッフにある＋下書きに無い＝生成がブレインに従っていない／スタッフに無い＋下書きにある＝ブレインの指示が余計
const grams2 = (x: string) => { const n = editCore(x).replace(/[をにがはのでとへもやかな]/g, ""); const g = new Set<string>(); for (let i = 0; i + 2 <= n.length; i++) g.add(n.slice(i, i + 2)); return g; };
const covers = (topic: string, text: string) => { const g = grams2(topic); if (!g.size) return false; const tg = grams2(text); let k = 0; for (const x of g) if (tg.has(x)) k++; return k / g.size >= 0.4; };
{
  const bk = brainKeys.includes("on") ? "on" : brainKeys.includes("new") ? "new" : brainKeys[0];
  const cnt = new Map<string, number[]>(); // scene → [両方, 人だけ(従っていない), 下書きだけ(余計), どちらも無い]
  for (const r of textRows) {
    const x = r[`brain_${bk}`] as (B & { key_topics?: string[] | null }) | undefined;
    const topics = (x?.key_topics ?? []).filter(Boolean);
    const dk = Object.keys(r).find((k) => k.startsWith("draft_") && r[k]);
    if (!topics.length || !dk) continue;
    const d = r[dk] as string;
    for (const tp of topics) {
      const inD = covers(tp, d), inS = covers(tp, r.staff!);
      for (const sc of [r.scene, "全体"]) { const a = cnt.get(sc) ?? [0, 0, 0, 0]; a[inD && inS ? 0 : inS ? 1 : inD ? 2 : 3]++; cnt.set(sc, a); }
    }
  }
  if (cnt.size) {
    console.log(`
■ ブレインの必須の話題（${bk}）× 下書き（${variants[0] ?? "-"}）× スタッフの文: 両方にある／人だけ（下書きが従っていない）／下書きだけ（ブレインの指示が余計）／どちらも無い`);
    for (const [k, a] of [...cnt].sort((x, y) => (x[0] === "全体" ? -1 : y[0] === "全体" ? 1 : 0))) console.log(`  ${k.padEnd(15)} ${a.join(" / ")}`);
  }
}
if (show) for (const r of usable.filter((x) => show === "all" || x.scene === show)) {
  console.log(`\n==== ${r.id} [${r.scene}] 人=${r.staffPath.join(",")} ${brainKeys.map((b) => { const x = r[`brain_${b}`] as B | undefined; return `${b}=${x?.reply_mode === "aix" ? x.action : "返信"}(${x?.src ?? "-"})`; }).join(" ")}`);
  console.log(`客: ${(r.customer ?? []).join(" ⏎ ").replace(/\n/g, " ").slice(0, 160)}`);
  console.log(`人: ${(r.staff ?? "").replace(/\n/g, " / ").slice(0, 220)}`);
  for (const k of Object.keys(r).filter((x) => x.startsWith("draft_"))) console.log(`${k.slice(6).padEnd(6)}: ${String(r[k] ?? r[`skip_${k.slice(6)}`] ?? "").replace(/\n/g, " / ").slice(0, 220)}`);
}

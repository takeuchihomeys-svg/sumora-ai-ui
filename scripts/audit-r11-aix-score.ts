// scripts/audit-r11-aix-score.ts — 11巡目の前後（AIX の文・竹内さんの送信が正解）を採点する（読むだけ・LLM なし）
//   入力: 番（scripts/.replay-out/r11-aix-cases.json・r11-aix-second-cases.json）と r11-aix-<label>.jsonl（yuma-r11-aix-text.ts の生成）
//   物差し: ①竹内さんの送った通との近さ（芯が同じ・似ている度 dice）②冒頭の型・締めの型・挨拶の有無が竹内さんと同じか
//           ③決まった言い回しの有無が竹内さんと同じか（新着の一文・如何でしょうか・中でも・内覧誘導・ご査収・申込誘導・引き続きピックアップ）
//           ④作り事（入力＝会話・本文・1通目に無い日付・時刻・金額・号室・階・徒歩分）
// 実行: npx tsx scripts/audit-r11-aix-score.ts --labels=ds1[,ds2] [--samples=2] [--action=rec-second]
import { readFileSync, existsSync } from "node:fs";
import { dice, coreOf, diffTexts } from "../app/lib/text-diff-types";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const LABELS = arg("labels", "ds1").split(",");
const SAMPLES = Number(arg("samples", "0"));
const ONLY = arg("action", "");
const CASES = arg("cases", "scripts/.replay-out/r11-aix-cases.json,scripts/.replay-out/r11-aix-second-cases.json").split(",");
type Case = { id: string; action: string; body: Record<string, unknown>; sent: string; inputText: string };
type Out = { id: string; action: string; v: string; rep: number; text: string; err: string | null };
const cases = new Map<string, Case>(CASES.filter(existsSync).flatMap((f) => (JSON.parse(readFileSync(f, "utf8")).cases as Case[])).map((c) => [c.id, c]));
const outs: Out[] = [];
for (const l of LABELS) { const f = `scripts/.replay-out/r11-aix-${l}.jsonl`; if (!existsSync(f)) continue; for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const o = JSON.parse(line) as Out; if (cases.has(o.id)) outs.push({ ...o, rep: o.rep + LABELS.indexOf(l) * 10 }); } }

const N = (s: string) => s.normalize("NFKC").replace(/,/g, "").replace(/(\d)\s*月\s*(\d)/g, "$1/$2").replace(/(\d)\s*日/g, "$1").replace(/：/g, ":");
function tokens(t: string): string[] {
  const s = N(t); const out: string[] = [];
  for (const m of s.matchAll(/(\d{1,2})\/(\d{1,2})/g)) out.push(`${Number(m[1])}/${Number(m[2])}`);
  for (const m of s.matchAll(/(\d{1,2}):(\d{2})/g)) out.push(`${Number(m[1])}:${m[2]}`);
  for (const m of s.matchAll(/(\d{3,})円/g)) out.push(`${m[1]}円`);
  for (const m of s.matchAll(/(\d{2,4})号室/g)) out.push(`${Number(m[1])}号室`);
  for (const m of s.matchAll(/(\d{1,2})階/g)) out.push(`${m[1]}階`);
  for (const m of s.matchAll(/徒歩(\d{1,2})分/g)) out.push(`徒歩${m[1]}分`);
  for (const m of s.matchAll(/(\d+)件/g)) out.push(`${m[1]}件`);
  return out;
}
function novel(text: string, input: string): string[] {
  const ni = N(input);
  const has = (tok: string) => {
    if (/^\d+\/\d+$/.test(tok)) { const [m, d] = tok.split("/"); return new RegExp(`(^|\\D)0?${m}/0?${d}(\\D|$)`).test(ni); }
    if (/^\d+:\d+$/.test(tok)) { const [hh, mm] = tok.split(":"); return new RegExp(`(^|\\D)0?${hh}:${mm}`).test(ni) || (mm === "00" && new RegExp(`(^|\\D)${hh}時`).test(ni)); }
    if (/号室$/.test(tok)) return new RegExp(`0*${tok.replace("号室", "")}(\\D|$)`).test(ni);
    if (/件$/.test(tok)) return ni.includes(tok) || tok === "1件";
    if (/円$/.test(tok)) { const v = Number(tok.replace("円", "")); return ni.includes(String(v)) || (v % 10000 === 0 && ni.includes(`${v / 10000}万`)); }
    return ni.includes(tok);
  };
  return [...new Set(tokens(text))].filter((t) => !has(t));
}
const first = (t: string) => (t.trim().split("\n").map((x) => x.trim()).filter(Boolean)[0] ?? "").normalize("NFKC");
function openerOf(t: string): string {
  const f = first(t);
  if (/^🌟/.test(f)) return "🌟"; if (/^【|^[①-⑳]/.test(f)) return "【";
  if (/^[^\s、。！!]{1,14}さん(?:お世話になっております|お待たせ|夜分)/.test(f) || /^(?:お世話になっております|お待たせ|夜分)/.test(f)) return "挨拶";
  if (/^[^\s、。！!]{1,14}さん[！!]*$/.test(f)) return "名前だけの行";
  if (/^はい/.test(f)) return "はい"; if (/^かしこまりました/.test(f)) return "かしこまりました";
  if (/^(?:1件)?新着|^新着で/.test(f)) return "新着で"; if (/如何でしょうか/.test(f)) return "如何でしょうか"; if (/^お送りさせて/.test(f)) return "お送りさせて…中でも";
  return "その他";
}
const GREET = /(?:^|\n)[^\n]{0,16}(?:お世話になっております|お待たせ致しました|夜分遅くに)/;
const lastLine = (t: string) => (t.trim().split("\n").map((x) => x.trim()).filter(Boolean).pop() ?? "").normalize("NFKC");
function closerOf(t: string): string {
  const l = lastLine(t);
  if (/お手隙の際にご査収/.test(l)) return "ご査収"; if (/お手隙の際にご確認/.test(l)) return "ご確認";
  if (/ご都合よろしい|ご案内させて/.test(l)) return "内覧誘導"; if (/お申込み?し?で?お部屋(?:抑|押)/.test(l)) return "申込誘導";
  if (/お気軽に/.test(l)) return "お気軽に"; if (/何卒/.test(l)) return "何卒"; if (/^※/.test(l)) return "※";
  return "その他";
}
const FEATS: Record<string, RegExp> = {
  挨拶: GREET, 新着の一文: /新着で|募集に(?:出|で)ました/, 如何でしょうか: /如何でしょうか/, 中でも: /お部屋の中でも|物件の中でも/,
  内覧誘導: /ご都合よろしいお日にち|お部屋ご案内させて/, ご査収: /お手隙の際にご査収/, 申込誘導: /お申込み?し?で?お部屋(?:抑|押)/,
  引き続きピックアップ: /引き続き[^\n]{0,30}(?:ピックアップ|お探し)/, お待たせ: /お待たせ/, 名前だけの行: /^[^\s、。！!\n]{1,14}さん[！!]*\n/,
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f2 = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(2));
const grp = (a: string) => a.replace(/:[^:]+$/, (m) => (a.startsWith("rec-second") ? m : ""));

const by = new Map<string, Out[]>(); for (const o of outs) { const g = grp(o.action); if (ONLY && !g.startsWith(ONLY)) continue; if (!by.has(g)) by.set(g, []); by.get(g)!.push(o); }
console.log(`# 11巡目の前後（竹内さんの送信が正解）labels=${LABELS.join(",")}・生成 ${outs.length}（失敗 ${outs.filter((o) => !o.text).length}）`);
console.log("種類｜版｜番｜生成｜そのまま｜似ている度｜冒頭の型が同じ｜締めの型が同じ｜言い回しの有無が同じ（全項目の平均）｜作り事 通/延べ");
const detail: string[] = [];
for (const [g, os] of [...by].sort()) {
  const ids = [...new Set(os.map((o) => o.id))];
  for (const v of ["before", "after"]) {
    const ok = os.filter((o) => o.v === v && o.text);
    if (!ok.length) continue;
    const sent = (o: Out) => cases.get(o.id)!.sent;
    const sims = ok.map((o) => dice(coreOf(o.text), coreOf(sent(o))));
    const same = ok.filter((o) => { const d = diffTexts(o.text, sent(o)); return d.same || d.sameCore; }).length;
    const op = ok.filter((o) => openerOf(o.text) === openerOf(sent(o))).length;
    const cl = ok.filter((o) => closerOf(o.text) === closerOf(sent(o))).length;
    const featAgree = new Map<string, [number, number, number]>(); // 同じ・生成だけ・竹内だけ
    for (const o of ok) for (const [k, re] of Object.entries(FEATS)) { const a = re.test(o.text), b = re.test(sent(o)); const x = featAgree.get(k) ?? [0, 0, 0]; if (a === b) x[0]++; else if (a) x[1]++; else x[2]++; featAgree.set(k, x); }
    const agreeAvg = avg([...featAgree.values()].map(([s]) => s / ok.length));
    const nov = ok.map((o) => novel(o.text, `${cases.get(o.id)!.inputText}\n${JSON.stringify(cases.get(o.id)!.body).slice(0, 4000)}`));
    console.log(`${g.padEnd(30)}｜${v.padEnd(6)}｜${ids.length}｜${ok.length}｜${same}｜${f2(avg(sims))}｜${op}/${ok.length}｜${cl}/${ok.length}｜${f2(agreeAvg)}｜${nov.filter((x) => x.length).length}/${nov.flat().length}`);
    detail.push(`  ${g} ${v}: 言い回しの食い違い（生成だけ/竹内だけ） ${[...featAgree].filter(([, [, a, b]]) => a + b > 0).map(([k, [, a, b]]) => `${k} ${a}/${b}`).join("・") || "なし"}｜作り事 ${[...new Set(nov.flat())].slice(0, 8).join(" ") || "なし"}｜冒頭 生成:${[...countBy(ok.map((o) => openerOf(o.text)))].map(([k, c]) => `${k}${c}`).join(" ")} 竹内:${[...countBy(ok.map((o) => openerOf(sent(o))))].map(([k, c]) => `${k}${c}`).join(" ")}`);
  }
  if (SAMPLES) for (const id of ids.slice(0, SAMPLES)) {
    detail.push(`    例 ${id}\n      竹内 「${cases.get(id)!.sent.replace(/\n/g, "⏎").slice(0, 200)}」`);
    for (const v of ["before", "after"]) for (const o of os.filter((x) => x.id === id && x.v === v).slice(0, 1)) detail.push(`      ${v.padEnd(6)} 「${o.text.replace(/\n/g, "⏎").slice(0, 200)}」`);
  }
}
function countBy(xs: string[]) { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m; }
console.log("\n" + detail.join("\n"));

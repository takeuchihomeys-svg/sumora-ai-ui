// scripts/audit-r9s2-aix-score.ts — 9巡目 段2 の前後（AIX の文）を採点する（読むだけ・LLM なし）
//   入力: scripts/.replay-out/r9s2-aix-cases.json（番・竹内さんが送った通）と r9s2-aix-<label>.jsonl（yuma-r9s2-aix-text.ts の生成）
//   物差し: ①竹内さんの送った通との近さ（芯が同じ＝そのまま・似ている度 dice・直しの型 diffTexts）
//           ②作り事（入力＝会話・本文に無い日付・時刻・金額・号室・階・徒歩分を数える＝P0 の点検）
//           ③型（コードの雛形・決まり: 禁止の絵文字・置き換え忘れ・お待たせ・社名・締めの行・action ごとの必須の形）
//           ④揺れ（同じ版の2回の近さ）と版の間の近さ
// 実行: npx tsx scripts/audit-r9s2-aix-score.ts --labels=ds1[,ds2] [--samples=2]
import { readFileSync, existsSync } from "node:fs";
import { diffTexts, dice, coreOf, DIFF_TYPE_JA, type DiffType } from "../app/lib/text-diff-types";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const LABELS = arg("labels", "ds1").split(",");
const SAMPLES = Number(arg("samples", "0"));
type Case = { id: string; action: string; route: string; body: Record<string, unknown>; sent: string; genThen: string | null; inputText: string };
type Out = { id: string; action: string; v: string; rep: number; text: string; err: string | null };
const cases = new Map<string, Case>((JSON.parse(readFileSync("scripts/.replay-out/r9s2-aix-cases.json", "utf8")).cases as Case[]).map((c) => [c.id, c]));
const outs: Out[] = [];
for (const l of LABELS) { const f = `scripts/.replay-out/r9s2-aix-${l}.jsonl`; if (!existsSync(f)) continue; for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const o = JSON.parse(line) as Out; outs.push({ ...o, rep: o.rep + (LABELS.indexOf(l) * 10) }); } }

const N = (s: string) => s.normalize("NFKC").replace(/,/g, "").replace(/(\d)\s*月\s*(\d)/g, "$1/$2").replace(/(\d)\s*日/g, "$1").replace(/：/g, ":");
function tokens(t: string): string[] {
  const s = N(t); const out: string[] = [];
  for (const m of s.matchAll(/(\d{1,2})\/(\d{1,2})/g)) out.push(`${Number(m[1])}/${Number(m[2])}`);
  for (const m of s.matchAll(/(\d{1,2}):(\d{2})/g)) out.push(`${Number(m[1])}:${m[2]}`);
  for (const m of s.matchAll(/(\d{3,})円/g)) out.push(`${m[1]}円`);
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)万/g)) out.push(`${m[1]}万`);
  for (const m of s.matchAll(/(\d{2,4})号室/g)) out.push(`${Number(m[1])}号室`);
  for (const m of s.matchAll(/(\d{1,2})階/g)) out.push(`${m[1]}階`);
  for (const m of s.matchAll(/徒歩(\d{1,2})分/g)) out.push(`徒歩${m[1]}分`);
  return out;
}
function novel(text: string, input: string): string[] {
  const ni = N(input);
  const has = (tok: string) => {
    if (/^\d+\/\d+$/.test(tok)) { const [m, d] = tok.split("/"); return new RegExp(`(^|\\D)0?${m}/0?${d}(\\D|$)`).test(ni); }
    if (/^\d+:\d+$/.test(tok)) { const [hh, mm] = tok.split(":"); return new RegExp(`(^|\\D)0?${hh}:${mm}`).test(ni) || (mm === "00" && new RegExp(`(^|\\D)${hh}時`).test(ni)); }
    if (/号室$/.test(tok)) return new RegExp(`0*${tok.replace("号室", "")}(\\D|$)`).test(ni);
    if (/円$/.test(tok)) { const v = Number(tok.replace("円", "")); return ni.includes(String(v)) || (v % 10000 === 0 && ni.includes(`${v / 10000}万`)) || (v % 1000 === 0 && ni.includes(`${(v / 10000).toFixed(1)}万`)); }
    if (/万$/.test(tok)) { const v = Number(tok.replace("万", "")); return ni.includes(tok) || ni.includes(String(Math.round(v * 10000))); }
    return ni.includes(tok);
  };
  return [...new Set(tokens(text))].filter((t) => !has(t));
}
const OK_EMOJI = new Set(["😊", "😌", "🌟", "✨", "✅"]);
function formIssues(o: Out, c: Case): string[] {
  const t = o.text; const is: string[] = [];
  const bad = (t.match(/\p{Extended_Pictographic}/gu) ?? []).filter((e) => !OK_EMOJI.has(e)); if (bad.length) is.push(`絵文字${[...new Set(bad)].join("")}`);
  if (/\[[^\]\n]{1,14}\]|〇〇|○○|\{\{/.test(t)) is.push("置き換え忘れ");
  if (/お待たせ/.test(t)) is.push("お待たせ");
  if (/スモラ|イエヤス|ギガ賃貸/.test(t)) is.push("社名");
  if (/お客様/.test(t)) is.push("お客様");
  const a = o.action;
  if (a === "meeting_place") { if (!/現地エントランスお待ち合わせ/.test(t)) is.push("型:待ち合わせの一文なし"); const addr = String(c.body.meeting_property_address ?? ""); if (addr && !N(t).includes(N(addr))) is.push("型:住所が入力のままでない"); }
  if (a === "estimate_sheet") { const pe = c.body.parsed_estimate as { property_name?: string } | undefined; if (pe?.property_name && !N(t).replace(/\s/g, "").includes(N(pe.property_name).replace(/\s/g, ""))) is.push("型:物件名なし"); if (/初期費用[:：]|節約/.test(t)) is.push("型:金額の重複"); if (t.length > 160) is.push("型:長い"); }
  if (a === "viewing_invite") { const cal = String(c.body.calendar_info ?? ""); const ds = [...N(cal).matchAll(/(\d{1,2})\/(\d{1,2})/g)].map((m) => `${Number(m[1])}/${Number(m[2])}`); if (ds.length && !ds.some((d) => N(t).includes(d))) is.push("型:候補日が入っていない"); }
  if (a === "property_check_result") { const cp = String(c.body.check_pattern ?? ""); if (cp === "unavailable" && !/募集(終了|に出て(い|お)らず|に出ていない|が終了|しておらず|しておりません|していない)|埋まって|決まって|申込(が)?入って|募集停止|ございません/.test(t)) is.push("型:募集終了の結果なし"); if (cp === "available" && !/募集中|空いて|ご案内可能|募集に出て|募集して/.test(t)) is.push("型:募集中の結果なし"); }
  if ((a === "property_send" || a === "rec-template") && t.length > 400) is.push("型:長い");
  return is;
}
const firstLine = (s: string) => coreOf(s.split("\n").map((x) => x.trim()).filter((x) => x && !/^YUMAさん[！!]*$/.test(x))[0] ?? "");
const PROMISE_RE = /ピックアップ(させて|して|致し)|お探し(させて|して|致し)|随時お送り/;
const lastLine = (s: string) => coreOf(s.split("\n").map((x) => x.trim()).filter(Boolean).pop() ?? "");
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f2 = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(2));

const byAction = new Map<string, Out[]>(); for (const o of outs) { if (!byAction.has(o.action)) byAction.set(o.action, []); byAction.get(o.action)!.push(o); }
console.log(`# 段2の前後（AIX の文）labels=${LABELS.join(",")}・生成 ${outs.length}（失敗 ${outs.filter((o) => !o.text).length}）`);
console.log(`action｜番｜版｜生成(失敗)｜そのまま｜似ている度｜冒頭の行が同じ｜締めの行が同じ｜頼まれていない探す約束の足し｜作り事（入力に無い値）通/延べ｜型の外れ 通｜その時の本番の生成との似ている度`);
const detail: string[] = [];
for (const [a, os] of [...byAction].sort()) {
  const ids = [...new Set(os.map((o) => o.id))];
  for (const v of ["on", "stage2"]) {
    const vs = os.filter((o) => o.v === v); const okv = vs.filter((o) => o.text);
    const sims = okv.map((o) => dice(coreOf(o.text), coreOf(cases.get(o.id)!.sent)));
    const same = okv.filter((o) => { const d = diffTexts(o.text, cases.get(o.id)!.sent); return d.same || d.sameCore; }).length;
    const close = okv.filter((o) => dice(lastLine(o.text), lastLine(cases.get(o.id)!.sent)) >= 0.6).length;
    const nov = okv.map((o) => novel(o.text, cases.get(o.id)!.inputText));
    const form = okv.map((o) => formIssues(o, cases.get(o.id)!));
    const genSims = okv.filter((o) => cases.get(o.id)!.genThen).map((o) => dice(coreOf(o.text), coreOf(cases.get(o.id)!.genThen!)));
    const open = okv.filter((o) => dice(firstLine(o.text), firstLine(cases.get(o.id)!.sent)) >= 0.6).length;
    const prom = okv.filter((o) => PROMISE_RE.test(o.text) && !PROMISE_RE.test(cases.get(o.id)!.sent)).length;
    console.log(`${a.padEnd(22)}｜${ids.length}｜${v.padEnd(6)}｜${okv.length}(${vs.length - okv.length})｜${same}｜${f2(avg(sims))}｜${open}｜${close}｜${prom}｜${nov.filter((x) => x.length).length}/${nov.flat().length}｜${form.filter((x) => x.length).length}｜${f2(avg(genSims))}`);
    const ft = new Map<string, number>(); for (const x of form.flat()) ft.set(x, (ft.get(x) ?? 0) + 1);
    const nt = new Map<string, number>(); for (const x of nov.flat()) nt.set(x, (nt.get(x) ?? 0) + 1);
    const dt = new Map<string, number>(); for (const o of okv) for (const t of diffTexts(o.text, cases.get(o.id)!.sent).types) dt.set(t, (dt.get(t) ?? 0) + 1);
    detail.push(`  ${a} ${v}: 型の外れ ${[...ft].map(([k, n]) => `${k} ${n}`).join("・") || "なし"}｜作り事 ${[...nt].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => `${k}×${n}`).join(" ") || "なし"}｜直しの型 ${[...dt].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, n]) => `${DIFF_TYPE_JA[k as DiffType]} ${n}`).join("・")}`);
  }
  // 揺れと版の間
  const pair = (v1: string, v2: string, sameRep: boolean) => {
    const xs: number[] = [];
    for (const id of ids) {
      const A = os.filter((o) => o.id === id && o.v === v1 && o.text), B = os.filter((o) => o.id === id && o.v === v2 && o.text);
      for (const x of A) for (const y of B) { if (x === y) continue; if (v1 === v2 && x.rep >= y.rep) continue; if (!sameRep && v1 !== v2 && x.rep !== y.rep) { /* 版の間は全組 */ } xs.push(dice(coreOf(x.text), coreOf(y.text))); }
    }
    return avg(xs);
  };
  detail.push(`  ${a} 揺れ（同じ版の2回の近さ）: on ${f2(pair("on", "on", true))}・stage2 ${f2(pair("stage2", "stage2", true))}｜版の間 on×stage2 ${f2(pair("on", "stage2", false))}`);
  // 番ごとの差（stage2 − on の似ている度）
  const deltas = ids.map((id) => {
    const s = (v: string) => avg(os.filter((o) => o.id === id && o.v === v && o.text).map((o) => dice(coreOf(o.text), coreOf(cases.get(id)!.sent))));
    return { id, d: s("stage2") - s("on") };
  }).filter((x) => !Number.isNaN(x.d));
  detail.push(`  ${a} 番ごと stage2−on: 良くなった ${deltas.filter((x) => x.d > 0.05).length}・同じ ${deltas.filter((x) => Math.abs(x.d) <= 0.05).length}・悪くなった ${deltas.filter((x) => x.d < -0.05).length}（悪い順 ${deltas.sort((x, y) => x.d - y.d).slice(0, 3).map((x) => `${x.id.split(":")[1]} ${x.d.toFixed(2)}`).join("・")}）`);
  if (SAMPLES) for (const id of ids.slice(0, SAMPLES)) {
    const c = cases.get(id)!;
    detail.push(`    例 ${id}\n      送信 「${c.sent.replace(/\n/g, "⏎").slice(0, 160)}」`);
    for (const v of ["on", "stage2"]) for (const o of os.filter((x) => x.id === id && x.v === v).slice(0, 1)) detail.push(`      ${v.padEnd(6)} 「${o.text.replace(/\n/g, "⏎").slice(0, 160)}」`);
  }
}
console.log("\n" + detail.join("\n"));

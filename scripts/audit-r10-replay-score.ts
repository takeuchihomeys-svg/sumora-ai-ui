// scripts/audit-r10-replay-score.ts — 10巡目の再生（yuma-r10-brain-replay.ts の jsonl）を採点する（読むだけ・LLM なし）
//   二択（AIX の番か返信の番か）・AIX の番を返信にした率（危ない側）・返信の番を AIX にした率・ボタンまで の一致を版ごと・場面ごとに並べ、9割以上の場面を出す。
// 実行: npx tsx scripts/audit-r10-replay-score.ts scripts/.replay-out/r10-r10a.jsonl [--versions=before,after] [--writer=takeuchi]
import { readFileSync } from "node:fs";

const file = process.argv[2];
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const VERSIONS = arg("versions", "before,after").split(",");
const WRITER = arg("writer", "");
type B = { action: string | null; reply_mode: string | null; src: string | null; cp: string | null; dir: string };
type R = { id: string; sub: string; writer: string; truth: string; truthKey: string; truthBtn: string | null; promise: string | null; laterAix: string[]; skip?: string; error?: string } & Record<string, unknown>;
const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as R).filter((r) => !r.skip && !r.error && (!WRITER || r.writer === WRITER));
const PROP = /^property_(send|recommendation|pickup|search)$/;
const fam = (a: string | null) => (!a ? "" : PROP.test(a) ? "物件" : a === "acknowledge_check" ? "acknowledge_check" : a);
const tAix = (r: R) => r.truth === "AIX" || r.truth === "2段→AIX";
const kindOfSrc = (src: string | null) => (src ?? "").match(/two_stage_promise\((\w+)\)/)?.[1] ?? null;
const KIND_FAM: Record<string, RegExp> = { check: /^(?:property_check_result|estimate_sheet|viewing_invite)$/, brought_both: /^(?:property_check_result|estimate_sheet)$/, estimate: /^(?:estimate_sheet|property_check_result)$/, pickup: /^物件$/, pickup_unless_ack: /^物件$/, room_photo_shoot: /^property_check_result$/, viewing_check: /^viewing_invite$/ };
function judge(r: R, b: B | undefined) {
  if (!b) return null;
  const stop = b.reply_mode === "aix" || /^お客様の連絡待ち/.test(b.dir);
  const k = kindOfSrc(b.src);
  const policy = !stop && tAix(r) && !!k && !!KIND_FAM[k]?.test(String(r.truthBtn ?? ""));
  const bin = tAix(r) === stop;
  const btn = stop ? (tAix(r) ? fam(b.action) === r.truthBtn : r.truth === "なし") : !tAix(r) && (r.truth === "2段" ? !!k : true);
  return { stop, bin, binP: bin || policy, aixMissed: tAix(r) && !stop, aixMissedP: tAix(r) && !stop && !policy, overStop: !tAix(r) && stop, btn };
}
const pct = (a: number, b: number) => `${a}/${b}（${b ? Math.round((a / b) * 100) : 0}%）`;
function line(xs: R[], v: string) {
  const js = xs.map((r) => ({ r, j: judge(r, r[`brain_${v}`] as B | undefined) })).filter((x) => x.j);
  const ta = js.filter((x) => tAix(x.r)), tr = js.filter((x) => !tAix(x.r));
  return `二択 ${pct(js.filter((x) => x.j!.bin).length, js.length)}（決まりどおり込み ${pct(js.filter((x) => x.j!.binP).length, js.length)}）｜AIX の番を返信に ${pct(ta.filter((x) => x.j!.aixMissed).length, ta.length)}（決まりどおり除く ${pct(ta.filter((x) => x.j!.aixMissedP).length, ta.length)}）｜返信の番を AIX に ${pct(tr.filter((x) => x.j!.overStop).length, tr.length)}｜ボタンまで ${pct(js.filter((x) => x.j!.btn).length, js.length)}`;
}
console.log(`# ${file}（番 ${rows.length}${WRITER ? `・書き手 ${WRITER}` : ""}）`);
for (const v of VERSIONS) console.log(`  ${v.padEnd(7)} ${line(rows, v)}`);
console.log(`  本番の判断（その時のブレイン・同じ番）: ${(() => { const xs = rows.filter((r) => r.prodBrain); const ok = xs.filter((r) => tAix(r) === (r.prodBrain === "AIX" || r.prodBrain === "なし")).length; return `二択 ${pct(ok, xs.length)}`; })()}`);
console.log(`\n## 場面ごと（after の二択／before の二択）`);
const subs = [...new Set(rows.map((r) => r.sub.split(":")[0]))];
for (const s of subs) {
  const xs = rows.filter((r) => r.sub.split(":")[0] === s);
  console.log(`  ${s.padEnd(15)} n=${String(xs.length).padStart(3)} after ${line(xs, VERSIONS[VERSIONS.length - 1])}\n  ${"".padEnd(21)}before ${line(xs, VERSIONS[0])}`);
}
console.log(`\n## 小場面ごと（after・二択 9割以上 ★）`);
for (const s of [...new Set(rows.map((r) => r.sub))].sort()) {
  const xs = rows.filter((r) => r.sub === s);
  const js = xs.map((r) => judge(r, r[`brain_${VERSIONS[VERSIONS.length - 1]}`] as B | undefined)).filter(Boolean);
  if (!js.length) continue;
  const ok = js.filter((j) => j!.binP).length;
  console.log(`  ${ok / js.length >= 0.9 && js.length >= 2 ? "★" : " "} ${s.padEnd(34)} ${pct(ok, js.length)}`);
}
console.log(`\n## 外れ（after）`);
for (const r of rows) {
  const v = VERSIONS[VERSIONS.length - 1];
  const b = r[`brain_${v}`] as B | undefined; const j = judge(r, b);
  if (!j || j.binP) continue;
  const b0 = r[`brain_${VERSIONS[0]}`] as B | undefined;
  console.log(`  ${r.id} ${r.sub} 書き手=${r.writer} 正解=${r.truthKey}｜after=${b?.reply_mode === "aix" ? `AIX:${b.action}` : `返信(${b?.src ?? ""})`}｜before=${b0?.reply_mode === "aix" ? `AIX:${b0.action}` : `返信(${b0?.src ?? ""})`}\n     客「${String(r.customer ?? "").slice(0, 90)}」 dir=${b?.dir.slice(0, 60)}`);
}

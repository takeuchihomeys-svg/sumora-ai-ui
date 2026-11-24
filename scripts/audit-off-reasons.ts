// scripts/audit-off-reasons.ts — 台帳の built_off の行を「なぜ off のままか」(a)〜(e) と、(a)(b) は連携の鎖の継ぎ目①〜⑧で分ける（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-off-reasons.ts [--json=<file>] [--write]
//   DB は work_items（stage=built_off）だけ読む。コードは app/ の .ts/.tsx を静的に読む（env の読みと既定）。
//   --write: conductor_reach を (a)＝届いていない・(b)(c)＝届いている・(d)(e)＝未確認 で埋める（空の行だけ・件数を先に出す）
// 2026-11-24 作業員A（竹内さん 11/24・統括役の頼み）。分け方は scripts/lib/off-reason.ts
import { createClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LINKAGE_MAP } from "../app/lib/linkage-map";
import { CONDUCTOR_DUTY } from "./lib/conductor-duty";
import { classifyOff, groupByPart, composePlanRows, jointOf, blockRanking, defaultsFromCode, switchNamesOf, chainPlaceOf, offpartRowOf, switchForUnnamed, NO_SWITCH_MARK, OFF_REASON_JA, JOINT_JA, JOINT_DUTY, type OffItem, type Joint } from "./lib/off-reason";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const WRITE = process.argv.includes("--write");

const FILES: Array<{ path: string; text: string }> = [];
function codeText(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      if (f === "node_modules" || f === "__tests__" || f.startsWith(".")) continue;
      const p = join(d, f);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) { const t = readFileSync(p, "utf8"); parts.push(t); FILES.push({ path: p.replace(/\\/g, "/"), text: t }); }
    }
  };
  walk(dir);
  return parts.join("\n");
}

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const { data, error } = await sb.from("work_items").select("id, title, owner, switch_name, next_step, blocker, exam_result, exam_labels, owner_question_id, owner_question_uuid, conductor_reach").eq("stage", "built_off").order("id");
  if (error) throw error;
  const items = (data ?? []) as Array<OffItem & { conductor_reach: string | null }>;
  const code = codeText("app") + "\n" + codeText("scripts/lib");
  const names = [...new Set(items.flatMap((it) => switchNamesOf(it)).concat(LINKAGE_MAP.flatMap((r) => [...r.switches, ...r.readerSwitches])))];
  const readInCode = new Set(names.filter((n) => new RegExp(`\\.${n}\\b|["'\`]${n}["'\`]`).test(code)));
  const defaults = defaultsFromCode(code, names);
  const mapSrc = readFileSync("app/lib/linkage-map.ts", "utf8").split(/\r?\n/);
  const mapLine = new Map(LINKAGE_MAP.map((r) => [r.id, mapSrc.findIndex((l) => l.includes(`id: "${r.id}"`)) + 1]));
  const ctx0 = { map: LINKAGE_MAP, readInCode, defaults, mapLine, composePlanMade: { made: 9, n: 128 } };

  // ── #675（2026-11-24 作業員A）: スイッチ名の無い行に名前を探し、地図の外の行を読む所から地図に載せる（--offparts で使う・動きは変えない）──
  const filled = new Map<number, string>();
  for (const it of items) { const s = switchForUnnamed(it, readInCode); if (s) filled.set(it.id, s); }
  const eff = items.map((it) => (filled.has(it.id) ? { ...it, switch_name: filled.get(it.id)! } : it));
  const mapSw = new Set(LINKAGE_MAP.flatMap((r) => [...r.switches, ...r.readerSwitches]));
  const readSite = (sw: string): { file: string; line: number } | null => {
    const re = new RegExp(`env\\.${sw}\\b|\\b${sw}\\b[^\\n]{0,40}\\?\\?`);
    for (const fl of FILES) { const ls = fl.text.split(/\r?\n/); const k = ls.findIndex((l) => re.test(l)); if (k >= 0) return { file: fl.path, line: k + 1 }; }
    return null;
  };
  const offparts = [...new Set(eff.map((it) => it.switch_name).filter((s): s is string => !!s && !mapSw.has(s)))]
    .map((sw) => { const at = readSite(sw); return at ? offpartRowOf(sw, at.file, at.line, chainPlaceOf(at.file)) : null; })
    .filter((r): r is NonNullable<typeof r> => !!r);
  const OFFPARTS = process.argv.includes("--offparts");
  const ctx = OFFPARTS ? { ...ctx0, map: [...LINKAGE_MAP, ...offparts] } : ctx0;
  if (OFFPARTS) {
    const before = items.map((it) => classifyOff(it, ctx0));
    const unnamed = items.filter((it) => !it.switch_name);
    console.log(`■ #675 地図の外の行を載せる: スイッチ名の無い ${unnamed.length}行のうち名前が見つかった ${filled.size}行（${[...filled.entries()].map(([id, s]) => `#${id}=${s}`).join("・")}）・見つからない ${unnamed.length - filled.size}行（「${NO_SWITCH_MARK}」の印）`);
    console.log(`  地図に足した行（読む所から・id は auto.）: ${offparts.length}`);
    console.log(`  分け直す前: 未確認 ${before.filter((v) => v.reach === "未確認").length}・(a) ${before.filter((v) => v.reason === "a").length}・(b) ${before.filter((v) => v.reason === "b").length}`);
    if (arg("gen")) { writeFileSync(arg("gen"), JSON.stringify(offparts, null, 1)); console.log(`  地図の外の行の写し: ${arg("gen")}`); }
    if (process.argv.includes("--write-switch")) {
      const dupOf: string[] = [];
      for (const [id, s] of filled) { const { error: e } = await sb.from("work_items").update({ switch_name: s }).eq("id", id).is("switch_name", null); if (e?.code === "23505") { dupOf.push(`#${id}=${s}`); continue; } if (e) throw e; }
      if (dupOf.length) console.log(`  同じスイッチの行が台帳に別にある（名前は入れない・同じ部品の重なり）: ${dupOf.join("・")}`);
      const mark = unnamed.filter((it) => !filled.has(it.id));
      for (const it of mark) { if (String(it.blocker ?? "").includes(NO_SWITCH_MARK)) continue; const { error: e } = await sb.from("work_items").update({ blocker: it.blocker ? `${NO_SWITCH_MARK}／${it.blocker}` : NO_SWITCH_MARK }).eq("id", it.id); if (e) throw e; }
      console.log(`  書いた: switch_name ${filled.size}行・印 ${mark.length}行`);
    }
  }

  const vs = eff.map((it) => classifyOff(it, ctx));
  const js = vs.map((v) => jointOf(v, ctx));
  const n = (r: string) => vs.filter((v) => v.reason === r).length;
  console.log(`■ 台帳の built_off ${items.length}行（なぜ off のままか）`);
  for (const r of ["a", "b", "c", "d", "e"] as const) console.log(`  (${r}) ${OFF_REASON_JA[r]}: ${n(r)}`);
  const byOwner = new Map<string, Record<string, number>>();
  for (const [i, v] of vs.entries()) { const o = items[i].owner ?? "?"; const m = byOwner.get(o) ?? {}; m[v.reason] = (m[v.reason] ?? 0) + 1; byOwner.set(o, m); }
  console.log(`  持ち主ごと: ${[...byOwner.entries()].map(([o, m]) => `${o} ${["a", "b", "c", "d", "e"].map((r) => m[r] ?? 0).join("/")}`).join("・")}（a/b/c/d/e）`);

  console.log(`\n■ (a)(b) ${n("a") + n("b")}行の継ぎ目（最初に切れている所・言葉は統括の受け持ちの表の 持つ/使う/反映）`);
  const ab = js.filter((j) => j.block !== "-");
  for (const k of [1, 2, 3, 4, 5, 6, 7, 8] as Joint[]) { const c = ab.filter((j) => j.joint === k).length; if (c) console.log(`  ${JOINT_JA[k]}（${JOINT_DUTY[k]}）: ${c}`); }
  console.log(`  未確認（証拠が取れない）: ${ab.filter((j) => j.joint == null).length}`);
  console.log(`\n■ 1つの継ぎ目の直しで on の候補（試験に進める行）が何行増えるか`);
  for (const g of blockRanking(ab).slice(0, 12)) console.log(`  ${g.rows.length}行  ${g.joint ? JOINT_JA[g.joint] : "未確認"} × ${g.block}  #${g.rows.join(",#")}`);
  const groups = groupByPart(vs, ctx.map, CONDUCTOR_DUTY);
  console.log(`\n■ 統括の欠けた部品（連携の地図の行）ごと（上位）`);
  for (const g of groups.slice(0, 10)) console.log(`  ${g.rows.length}行（a ${g.reasons.a}・b ${g.reasons.b}）${g.part}${g.duty.length ? `［土台: ${g.duty.join("・")}］` : ""}${g.composePlan ? "［設計図を読む］" : ""}`);
  console.log(`  設計図（compose_plan を読む部品）でまとめて止まっている行: ${composePlanRows(groups).length}`);

  // 地図に行が無いスイッチも、読む所（ファイル:行）から鎖の場所を出す（証拠つき・決められない物は未確認）
  const placeOf = (sw: string | null): { place: Joint | null; at: string } => {
    if (!sw) return { place: null, at: "スイッチの名前が無い" };
    const re = new RegExp(`env\\.${sw}\\b`);
    for (const fl of FILES) { const ls = fl.text.split(/\r?\n/); const k = ls.findIndex((l) => re.test(l)); if (k >= 0) return { place: chainPlaceOf(fl.path), at: `${fl.path}:${k + 1}` }; }
    return { place: null, at: "env の読みが無い" };
  };
  const places = eff.map((it) => placeOf(it.switch_name));
  console.log(`\n■ 全 ${items.length}行の鎖の場所（スイッチを最初に読む所のファイルで決めた・地図の外の行も）`);
  for (const r of ["a", "b", "c", "d", "e"] as const) {
    const ix = vs.map((v, i) => (v.reason === r ? i : -1)).filter((i) => i >= 0);
    if (!ix.length) continue;
    const c = new Map<string, number>(); for (const i of ix) { const k = places[i].place ? JOINT_JA[places[i].place!] : "未確認"; c.set(k, (c.get(k) ?? 0) + 1); }
    console.log(`  (${r}) ${[...c.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  const rows = items.map((it, i) => ({ place: places[i].place, placeAt: places[i].at, id: it.id, owner: it.owner, switch: it.switch_name, title: it.title.slice(0, 80), reason: vs[i].reason, why: vs[i].why, parts: vs[i].parts, reach: vs[i].reach, joint: js[i].joint, block: js[i].block, evidence: js[i].evidence }));
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify(rows, null, 1));
  const todo = items.map((it, i) => ({ id: it.id, cur: it.conductor_reach, next: vs[i].reach })).filter((x) => !x.cur || (OFFPARTS && x.cur === "未確認" && x.next !== "未確認")); // #675: 分け直しで決まった未確認の行も書き直す
  const cnt = (r: string) => todo.filter((x) => x.next === r).length;
  console.log(`\n■ conductor_reach を埋める（空の行だけ）: ${todo.length}行（届いていない ${cnt("届いていない")}・届いている ${cnt("届いている")}・未確認 ${cnt("未確認")}）${WRITE ? "" : " ← --write で書く"}`);
  if (WRITE) {
    for (const r of ["届いていない", "届いている", "未確認"]) {
      const ids = todo.filter((x) => x.next === r).map((x) => x.id);
      if (!ids.length) continue;
      const { error: e } = await sb.from("work_items").update({ conductor_reach: r }).in("id", ids);
      if (e) throw e;
      console.log(`  書いた: ${r} ${ids.length}行`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });

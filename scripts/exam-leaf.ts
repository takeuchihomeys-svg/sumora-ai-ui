// scripts/exam-leaf.ts — 試験の問題と地図の葉をつなぐ（読む・書く・LLM なし・費用0・作業員P・2026-11-23・台帳 #610）
//
// 統括役 11/23（竹内さん「テストの部分のブレインも理解した方が良いのではないか」）: 試験の側も同じ地図を読み書きする。
//   --tag [--write]                    brain-exam の問題（scripts/brain-exam/spec.json）を AIX の番の木の葉（AIX の種類×場面）に当てる（exam_leaf_links）。
//                                      当たらない問題・問題が0の葉（試験で確かめられない葉＝穴）を一覧に出す。場面は問題の番の見張り（line_watch_turns.scene_key）から。
//   --result --after=<label> [--before=<label>] [--dir=<results の置き場>] [--write] [--apply-lower]
//                                      試験の結果（<dir>/<label>.jsonl の score.pass・問題ごとに過半で○）を葉ごとの 前→後 の○にして exam_leaf_results へ。
//                                      悪くなった葉に見込みの付いた作業があれば、work_items.forecast_exam に印と「見込みを下げる案」を書いて要確認に出す（--apply-lower で幅を下げる）。
//   --order --ids=q1,q2,...            伸びしろの大きい葉の問題を先にする順番の案（EXAM_ORDER_BY_MAP・既定 off＝案を出すだけ。exam-conductor 本体の動きは変えない・$10/夜・夜だけの決まりはそのまま）
//   --lessons [--write]                試験の学び（conductor_lessons）に葉の印（leaf_keys）を付ける（形だけ・expected_act の AIX の種類×scene）
// 点は保存の点（rescore しない）。お客様の文は出さない（問題の id・種類・場面だけ）。
// 実行: npx tsx --env-file=.env.local scripts/exam-leaf.ts --tag
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { examLeafOf, examResultsByLeaf, examOrderByMap, examOrderByMapOn, examAixKindOf, sceneOfWatchKey, rankLeaves, covers, fixShareOf, type ExamProblemLite } from "../app/lib/metric-map";
import { readLatestTree, nodesFromRows, loadForecastItems, isNightJst } from "./lib/metric-map-server";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => argv.includes(`--${k}`);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
const ROOT = arg("root", "core:conductor_aix_60d");
const SET = "brain-exam";

/** 問題の番の見張りの scene_key（会話 × 時刻 ±30分の一番近い番） */
async function sceneKeysOf(probs: ExamProblemLite[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const convs = [...new Set(probs.map((p) => p.conv).filter(Boolean))] as string[];
  const rows: Array<{ conversation_id: string; customer_turn_at: string; scene_key: string | null }> = [];
  for (let i = 0; i < convs.length; i += 40) {
    const { data, error } = await sb.from("line_watch_turns").select("conversation_id,customer_turn_at,scene_key").in("conversation_id", convs.slice(i, i + 40)).limit(5000);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
  }
  for (const p of probs) {
    if (!p.conv || !p.at) { out.set(p.id, null); continue; }
    const t = Date.parse(p.at);
    const near = rows.filter((r) => r.conversation_id === p.conv).map((r) => ({ r, d: Math.abs(Date.parse(r.customer_turn_at) - t) })).filter((x) => x.d <= 30 * 60_000).sort((a, b) => a.d - b.d)[0];
    out.set(p.id, near?.r.scene_key ?? null);
  }
  return out;
}

async function cmdTag() {
  const probs = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as ExamProblemLite[];
  const aixProbs = probs.filter((p) => examAixKindOf(p));
  const scenes = await sceneKeysOf(aixProbs);
  const links: Array<{ problem_id: string; exam_set: string; root_metric: string; leaf_key: string; how: string }> = [];
  const unmatched: Array<{ id: string; why: string }> = [];
  for (const p of probs) {
    const r = examLeafOf(p, ROOT, scenes.get(p.id) ?? null);
    if (r.leaf) links.push({ problem_id: p.id, exam_set: SET, root_metric: ROOT, leaf_key: r.leaf, how: r.how }); else unmatched.push({ id: p.id, why: r.how });
  }
  // 木の葉（種類×場面の段）と問題の数
  const tree = await readLatestTree(sb, ROOT, "style");
  const nodes = nodesFromRows(tree.rows);
  const scenesLevel = nodes.filter((x) => x.depth === 2);
  const kindLevel = nodes.filter((x) => x.depth === 1);
  // 問題はその葉と下に当てた物だけ数える（種類までの問題は場面の葉に数えない＝場面が分からない）
  const cnt = (key: string) => links.filter((l) => covers(key, l.leaf_key)).length;
  console.log(`問題 ${probs.length}: 葉に当てた ${links.length}（種類×場面 ${links.filter((l) => l.leaf_key.includes("/scene=")).length}・種類まで ${links.filter((l) => !l.leaf_key.includes("/scene=")).length}）・当たらない ${unmatched.length}`);
  const why = unmatched.reduce<Record<string, number>>((a, u) => ({ ...a, [u.why]: (a[u.why] ?? 0) + 1 }), {});
  console.log(`  当たらない理由: ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join("・")}`);
  if (nodes.length) {
    console.log(`\n木（${tree.day}）の AIX の種類ごと: 本番の外れ と 試験の問題`);
    for (const k of kindLevel) console.log(`  ${k.label}: n ${k.n}・外れ ${k.misses}・問題 ${cnt(k.key)}`);
    const withP = scenesLevel.filter((s) => cnt(s.key) > 0), noP = scenesLevel.filter((s) => cnt(s.key) === 0);
    console.log(`\n種類×場面の葉 ${scenesLevel.length}: 問題のある葉 ${withP.length}・問題が0の葉 ${noP.length}（外れのある葉のうち問題0 ${noP.filter((s) => s.misses > 0).length}）`);
    for (const s of noP.filter((x) => x.misses > 0).sort((a, b) => b.misses - a.misses).slice(0, 12)) console.log(`  穴（試験で確かめられない）: ${s.key.split("/").slice(1).join(" › ")}・外れ ${s.misses}/${s.n}`);
    const offTree = [...new Set(links.map((l) => l.leaf_key))].filter((k) => !nodes.some((x) => x.key === k));
    if (offTree.length) console.log(`  問題はあるが本番の木（60日）に無い葉 ${offTree.length}: ${offTree.slice(0, 8).map((k) => k.split("/").slice(1).join(" › ")).join("・")}`);
  } else console.log("木がまだ無い（夜に self-improve --write か work-items.ts --map --live）＝問題の数だけ出した");
  if (flag("write")) {
    for (let i = 0; i < links.length; i += 200) {
      const { error } = await sb.from("exam_leaf_links").upsert(links.slice(i, i + 200).map((l) => ({ ...l, tagged_at: new Date().toISOString() })), { onConflict: "problem_id,exam_set,root_metric" });
      if (error) throw new Error(`exam_leaf_links: ${error.message}`);
    }
    console.log(`書いた: exam_leaf_links ${links.length}行`);
  }
}

/** <dir>/<label>.jsonl の問題ごとの○（過半で○・誤りの行は除く） */
function passOf(dir: string, label: string): Map<string, boolean> {
  const f = join(dir, `${label}.jsonl`);
  if (!existsSync(f)) throw new Error(`結果が無い: ${f}`);
  const by = new Map<string, { ok: number; n: number }>();
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { id: string; error?: unknown; score?: { pass?: boolean } };
    if (r.error || !r.score) continue;
    const o = by.get(r.id) ?? { ok: 0, n: 0 }; o.n++; if (r.score.pass) o.ok++; by.set(r.id, o);
  }
  return new Map([...by].map(([id, o]) => [id, o.ok * 2 > o.n]));
}

async function cmdResult() {
  const dir = arg("dir", "scripts/brain-exam/results");
  const after = arg("after"), before = arg("before");
  if (!after) throw new Error("--after=<label> が要る");
  const a = passOf(dir, after), b = before ? passOf(dir, before) : new Map<string, boolean>();
  const { data } = await sb.from("exam_leaf_links").select("problem_id,leaf_key").eq("root_metric", ROOT).eq("exam_set", SET).limit(3000);
  const links = (data ?? []) as Array<{ problem_id: string; leaf_key: string }>;
  const by = examResultsByLeaf(links, b, a);
  console.log(`試験 ${after}${before ? `（前 ${before}）` : ""}: 葉 ${by.size}`);
  const items = await loadForecastItems(sb);
  const worseLeaves: string[] = [];
  for (const [k, o] of [...by].sort((x, y) => y[1].worse.length - x[1].worse.length)) {
    console.log(`  ${k.split("/").slice(1).join(" › ")}: 問題 ${o.n}・○ ${before ? `${o.before_ok} → ` : ""}${o.after_ok}${o.worse.length ? `・悪くなった ${o.worse.join(",")}` : ""}${o.better.length ? `・良くなった ${o.better.join(",")}` : ""}`);
    if (o.worse.length) worseLeaves.push(k);
  }
  for (const it of items) {
    // 試験前の見込みの積み上げ（forecast_exam.parts: 葉ごとの直る番の数）は、部品の葉で当てる＝端末の数の見込みでも、文の癖の木の葉で試験の問題に当たる（11/23 統括役）
    const fe = (it.forecast_exam ?? null) as { phase?: string; parts?: Array<{ leaf: string; fixes: number; exam?: unknown }> } | null;
    if (fe?.parts?.length) {
      const parts = fe.parts.map((p) => {
        const h = [...by].filter(([k]) => covers(p.leaf, k) || covers(k, p.leaf));
        if (!h.length) return p;
        const e = { label: after, before: before || null, n: h.reduce((s, [, o]) => s + o.n, 0), before_ok: h.reduce((s, [, o]) => s + o.before_ok, 0), after_ok: h.reduce((s, [, o]) => s + o.after_ok, 0), worse: h.reduce((s, [, o]) => s + o.worse.length, 0) };
        console.log(`  作業 #${it.id} の部品 ${p.leaf.split("/").slice(1).join(" › ")}（直る見込み ${p.fixes}番）: 試験で ${e.before_ok}→${e.after_ok}/${e.n}${e.worse ? `・悪くなった ${e.worse} → 要確認（見込みを下げる）` : ""}`);
        return { ...p, exam: e };
      });
      if (flag("write")) await sb.from("work_items").update({ forecast_exam: { ...fe, phase: "試験後", parts, at: new Date().toISOString() }, updated_at: new Date().toISOString() }).eq("id", it.id);
      continue;
    }
    const at = it.forecast_leaf ?? it.forecast_metric;
    if (!at) continue;
    const hit = [...by].filter(([k]) => covers(at, k) || covers(k, at));
    if (!hit.length) continue;
    const worse = hit.reduce((s, [, o]) => s + o.worse.length, 0), n = hit.reduce((s, [, o]) => s + o.n, 0);
    const exam = { label: after, before: before || null, n, before_ok: hit.reduce((s, [, o]) => s + o.before_ok, 0), after_ok: hit.reduce((s, [, o]) => s + o.after_ok, 0), worse, at: new Date().toISOString() };
    let lower: { high: number } | null = null;
    if (worse && it.forecast_high != null && it.forecast_low != null) lower = { high: Math.max(it.forecast_low, Math.round((it.forecast_high - (it.forecast_high - it.forecast_low) * (worse / Math.max(1, n))) * 10) / 10) };
    console.log(`  作業 #${it.id}: 試験で ${exam.before_ok}→${exam.after_ok}/${n}${worse ? `・悪くなった ${worse} → 要確認（見込みの上を ${it.forecast_high} → ${lower?.high} に下げる案・直る見込み ${Math.round((fixShareOf(it) ?? 0) * 100)}%）` : ""}`);
    if (flag("write")) {
      const patch: Record<string, unknown> = { forecast_exam: { ...exam, lower_high: lower?.high ?? null }, updated_at: new Date().toISOString() };
      if (lower && flag("apply-lower")) patch.forecast_high = lower.high;
      await sb.from("work_items").update(patch).eq("id", it.id);
    }
  }
  if (flag("write")) {
    const rows = [...by].map(([k, o]) => ({ run_label: after, before_label: before || null, root_metric: ROOT, leaf_key: k, n_problems: o.n, before_ok: before ? o.before_ok : null, after_ok: o.after_ok, worse: o.worse, better: o.better, at: new Date().toISOString() }));
    if (rows.length) { const { error } = await sb.from("exam_leaf_results").upsert(rows, { onConflict: "run_label,root_metric,leaf_key" }); if (error) throw new Error(error.message); }
    console.log(`書いた: exam_leaf_results ${rows.length}行`);
  }
}

async function cmdOrder() {
  const ids = arg("ids").split(",").map((s) => s.trim()).filter(Boolean);
  const { data } = await sb.from("exam_leaf_links").select("problem_id,leaf_key").eq("root_metric", ROOT).limit(3000);
  const linkOf = new Map(((data ?? []) as Array<{ problem_id: string; leaf_key: string }>).map((r) => [r.problem_id, r.leaf_key]));
  const tree = await readLatestTree(sb, ROOT, "style");
  const ranked = rankLeaves(nodesFromRows(tree.rows), await loadForecastItems(sb), { writerSelect: "style" });
  const order = examOrderByMap(ids.length ? ids : [...linkOf.keys()], linkOf, ranked);
  console.log(`順番の案（EXAM_ORDER_BY_MAP=${examOrderByMapOn() ? "on" : "off（案だけ・exam-conductor は今までどおり）"}）: ${order.slice(0, 30).join(",")}`);
}

async function cmdLessons() {
  const { data } = await sb.from("conductor_lessons").select("id,expected_act,scene,leaf_keys").eq("is_current", true).limit(500);
  const rows = (data ?? []) as Array<{ id: string; expected_act: string; scene: string | null; leaf_keys: string[] | null }>;
  let n = 0;
  for (const r of rows) {
    const kind = examAixKindOf({ id: r.id, accept: [r.expected_act] });
    if (!kind) continue;
    const key = `${ROOT}/kind=${kind}${r.scene ? `/scene=${sceneOfWatchKey(r.scene, kind)}` : ""}`;
    n++;
    if (flag("write")) await sb.from("conductor_lessons").update({ leaf_keys: [...new Set([...(r.leaf_keys ?? []), key])] }).eq("id", r.id);
  }
  console.log(`学び ${rows.length}行のうち葉の印を付けられる ${n}${flag("write") ? "（書いた）" : "（見るだけ・--write で書く）"}`);
}

(async () => {
  const h = (new Date().getUTCHours() + 9) % 24;
  if (!isNightJst() && flag("tag") && !flag("force")) console.log(`営業時間（${h}時）: 見張りの読みは問題の会話だけに絞って読む`);
  if (flag("tag")) return cmdTag();
  if (flag("result")) return cmdResult();
  if (flag("order")) return cmdOrder();
  if (flag("lessons")) return cmdLessons();
  console.log("使い方: --tag [--write] ／ --result --after=<label> [--before=<label>] [--dir=] [--write] [--apply-lower] ／ --order [--ids=] ／ --lessons [--write]");
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

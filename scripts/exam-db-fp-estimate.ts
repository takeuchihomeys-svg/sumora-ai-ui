// scripts/exam-db-fp-estimate.ts — 試験の使い回しの鍵の DB の指紋: 旧（件数・最後の時刻）と中身（exam-db-fp.ts）で、過去7日の試験の記録に
//   どれだけ使い回しが当たったかの見積もり（LLM なし・本番 DB は読むだけ）。
// 実行: npx tsx --env-file=.env.local scripts/exam-db-fp-estimate.ts [--days=7] [--breakdown（どこが鍵を変えたか・遅い）]
// 試験の記録＝全部の作業ツリーの scripts/brain-exam/results/*.meta.json の startedAt。ある回が使い回せる＝7日以内のもっと前の回と鍵が同じ
//   （鍵が変わる時点が2回の間に1つも無い）。DB の歴史は無い＝作った時刻（created_at・first_seen_at）で「その時の行」を作り直し、
//   書き換え（updated_at）は今の値しか残らない → 中身の指紋は「書き換えは効かなかった（下限）／書き換えは全部効いた（上限）」の幅で出す。
import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { examCacheRoot } from "./lib/llm-cassette";
import { dbContentReads, runFpQueryInMemory, contentSigOf, problemReadsRent, type DbContentRead, type Row } from "./lib/exam-db-fp";
import { loadExamProblems } from "./lib/exam-brain-io";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "7")) || 7;
const NOW = Date.now();
const FROM = NOW - DAYS * 86400e3;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function all(table: string, cols: string, order = "id"): Promise<Row[]> {
  const out: Row[] = [];
  for (let a = 0; ; a += 1000) { const r = await sb.from(table).select(cols).order(order).range(a, a + 999); if (r.error) throw new Error(`${table}: ${r.error.message}`); out.push(...(r.data as unknown as Row[])); if (r.data.length < 1000) break; }
  return out;
}
const ms = (v: unknown) => (v ? Date.parse(String(v)) : NaN);
const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 10);

/** 試験の回の時刻（全部の作業ツリーの meta.json） */
function runTimes(): number[] {
  const root = join(examCacheRoot(), "..", "..");
  const dirs = [join(root, "scripts", "brain-exam", "results")];
  const wt = join(root, ".claude", "worktrees");
  if (existsSync(wt)) for (const d of readdirSync(wt)) dirs.push(join(wt, d, "scripts", "brain-exam", "results"));
  const ts: number[] = [];
  for (const d of dirs) { if (!existsSync(d)) continue; for (const f of readdirSync(d)) if (f.endsWith(".meta.json")) { try { const t = ms(JSON.parse(readFileSync(join(d, f), "utf8")).startedAt); if (t >= FROM && t <= NOW) ts.push(t); } catch { /* */ } } }
  return [...new Set(ts)].sort((a, b) => a - b);
}
/** 鍵が変わる時点の列（epoch＝その時刻までの変化の数）から、各回が使い回せたか（7日以内のもっと前の回と同じ） */
function hitRate(runs: number[], keyAt: (t: number) => string, minGapMs = 0): { hits: number; n: number; changes: number } {
  const keys = runs.map(keyAt);
  let hits = 0, n = 0;
  // minGapMs: 前の回から minGapMs 以上あとの回だけ数える（同じ作業者の続けての回＝数分おきの回を除いた「作業者の間」の使い回し）
  for (let j = 1; j < runs.length; j++) {
    if (runs[j] - runs[j - 1] < minGapMs) continue;
    n++;
    for (let i = j - 1; i >= 0 && runs[j] - runs[i] <= 7 * 86400e3; i--) if (keys[i] === keys[j]) { hits++; break; }
  }
  let changes = 0; for (let j = 1; j < keys.length; j++) if (keys[j] !== keys[j - 1]) changes++;
  return { hits, n, changes };
}
const epochOf = (events: number[]) => { const ev = [...events].filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return (t: number) => { let lo = 0, hi = ev.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m] <= t) lo = m + 1; else hi = m; } return lo; }; };
const dailyAt = (t: number) => { const out: number[] = []; for (let d = t; d >= FROM - 86400e3; d -= 86400e3) out.push(d); return out; };

(async () => {
  const runs = runTimes();
  console.log(`試験の回（${DAYS}日・meta.json の startedAt）: ${runs.length}回`);
  try { const { full } = loadExamProblems("."); const ps = [...full.values()]; console.log(`相場を聞く番の問題（相場の材料を鍵に入れる）: ${ps.filter((p) => problemReadsRent(p as never)).length}/${ps.length}問`); } catch (e) { console.log(`（問題が読めない: ${String(e).slice(0, 80)}）`); }
  const reads = dbContentReads(NOW);
  // 作った時刻で作り直せる表（その時の行）
  const K = await all("ai_reply_knowledge", "id, category, importance, hypothesis_status, title, content, created_at, conversation_state");
  const E = await all("ai_reply_examples", "id, entry_source, is_starred, conversation_state, customer_message, sent_reply, reply_angle, created_at, conversation_id");
  const CV = await all("conversations", "id, status");
  const parent = new Map(CV.map((c) => [c.id, c]));
  const PR = await all("ai_prompt_rules", "id, rule_key, action_type, rule_text, condition_key, condition_value, priority, is_permanent, is_active, created_at, updated_at");
  const TR = await all("trigger_action_rules", "id, category, action_type, keyword, confidence, occurrence_count, total_occurrence, conversation_status, updated_at");
  const FB = await all("brain_aix_feedback", "key, updated_at", "key");
  const AP = await all("ai_prompts", "key, updated_at", "key");
  const PSK = await all("property_search_knowledge", "id, is_current, created_at, updated_at");
  const RENT = await all("rent_observations", "id, first_seen_at, attrs_at");
  const PH = await all("phrase_dictionary", "id, priority, created_at");
  const TSL = await all("template_selection_logs", "id, created_at, final_sent_text");
  const MI = await all("brain_meta_insights", "id, title, principle, pattern, impact, category, created_at, updated_at");
  const WPL = await all("winning_pattern_logs", "id, created_at, was_correct");
  const RS = await all("brain_action_reach_stats", "scene_key, computed_at", "scene_key");
  const asOf = (rows: Row[], t: number, col = "created_at") => rows.filter((r) => !(ms(r[col]) > t));
  const sigAt = (r: DbContentRead, rows: Row[], t: number) => { const base = asOf(rows, t); const out: Record<string, Row[]> = {}; for (const [k, q] of Object.entries(r.queries)) out[k] = runFpQueryInMemory(base, q, q.join ? parent : undefined); try { return contentSigOf(r, out); } catch { return "x"; } };

  // ── 旧（件数・最後の時刻）: 変わる時点 ──
  const oldBrainEv: number[] = [], oldDraftEv: number[] = [];
  const addOld = (stage: "brain" | "draft", ev: number[]) => { (stage === "brain" ? oldBrainEv : oldDraftEv).push(...ev); };
  addOld("brain", K.map((r) => ms(r.created_at)));
  addOld("brain", E.map((r) => ms(r.created_at)));
  addOld("brain", PR.flatMap((r) => [ms(r.created_at), ms(r.updated_at)]));
  addOld("brain", TR.map((r) => ms(r.updated_at)));
  const fbLast = Math.max(...FB.map((r) => ms(r.updated_at)));
  addOld("brain", dailyAt(fbLast)); // 毎日の cron が updated_at=now で書き直す
  addOld("brain", MI.map((r) => ms(r.updated_at)));
  addOld("brain", PSK.map((r) => ms(r.updated_at)));
  addOld("brain", RENT.map((r) => ms(r.first_seen_at))); // 件数だけ（新しい部屋）
  addOld("draft", AP.flatMap((r) => (NOW - ms(r.updated_at) < 36 * 3600e3 ? dailyAt(ms(r.updated_at)) : [ms(r.updated_at)])));
  addOld("draft", PH.map((r) => ms(r.created_at)));
  addOld("draft", TSL.map((r) => ms(r.created_at)));
  const oldB = epochOf(oldBrainEv), oldD = epochOf([...oldBrainEv, ...oldDraftEv]);

  // ── 中身: 作り直せる物は「その時の材料」の hash、書き換えしか残らない物は時点（下限＝0・上限＝全部） ──
  const createdReads = reads.filter((r) => ["ai_reply_knowledge", "ai_reply_examples", "brain_meta_insights"].includes(r.table));
  const srcOf = (t: string) => (t === "ai_reply_knowledge" ? K : t === "ai_reply_examples" ? E : MI);
  const prB = reads.find((r) => r.table === "ai_prompt_rules" && r.stage === "brain") as DbContentRead, prD = reads.find((r) => r.table === "ai_prompt_rules" && r.stage === "draft") as DbContentRead;
  const prActive = PR.filter((r) => r.is_active === true).sort((a, b) => (Number(b.priority) - Number(a.priority)) || (ms(b.updated_at) - ms(a.updated_at)) || String(a.rule_key).localeCompare(String(b.rule_key)));
  const prSigAt = (t: number, stage: "brain" | "draft") => { const q = asOf(prActive, t); return stage === "brain" ? contentSigOf(prB, { q }) : h([contentSigOf(prB, { q }), contentSigOf(prD, { q })]); };
  const prUpd = prActive.filter((r) => ms(r.updated_at) - ms(r.created_at) > 60e3).map((r) => ms(r.updated_at));
  const trMat = TR.filter((r) => r.action_type === "template_hint" || (r.category === "keyword_rule" && Number(r.confidence) >= 0.65 && Number(r.occurrence_count) >= 1)).map((r) => ms(r.updated_at));
  const apUsed = AP.filter((r) => ["generation_system", "smora_quick_patterns", "real_estate_rules", "smora_rules", "reply_content_rules", "aix_property_recommendation_rules", "aix_property_send_rules", "template_adapt_rules"].includes(String(r.key))).map((r) => ms(r.updated_at));
  const rentNew = RENT.map((r) => ms(r.first_seen_at)), rentAttr = RENT.map((r) => ms(r.attrs_at));
  const phNew = PH.filter((r) => Number(r.priority) >= 10).map((r) => ms(r.created_at));
  const wplNew = WPL.filter((r) => r.was_correct === true).map((r) => ms(r.created_at));
  const reachDaily = dailyAt(Math.max(...RS.map((r) => ms(r.computed_at))));
  const tslEv = TSL.filter((r) => r.final_sent_text).flatMap((r) => [ms(r.created_at), ms(r.created_at) + 60 * 86400e3]);
  // 相場（rent_observations）は相場を聞く番の問題だけ（problemReadsRent）。psk・地図・meta_insights は答えの後だけ＝入れない
  const bLoE = [...wplNew], bHiE = [...wplNew, ...reachDaily, ...prUpd, ...trMat, ...dailyAt(fbLast)];
  const dLoE = [...bLoE, ...apUsed, ...phNew, ...tslEv], dHiE = [...bHiE, ...apUsed, ...phNew, ...tslEv];
  const rentLo = rentNew, rentHi = [...rentNew, ...rentAttr];
  const bLo = epochOf(bLoE), bHi = epochOf(bHiE), dLo = epochOf(dLoE), dHi = epochOf(dHiE);
  const bLoR = epochOf([...bLoE, ...rentLo]), bHiR = epochOf([...bHiE, ...rentHi]), dLoR = epochOf([...dLoE, ...rentLo]), dHiR = epochOf([...dHiE, ...rentHi]);
  // 材料が変わり得るのは、どれかの読みの条件（上限なし）に入る行が作られた時だけ → その時点ごとに1回だけ計算する
  const cand = new Set<number>();
  for (const r of createdReads) for (const q of Object.values(r.queries)) for (const x of runFpQueryInMemory(srcOf(r.table), { ...q, cols: ["created_at"], limit: undefined }, q.join ? parent : undefined)) { const t = ms(x.created_at); if (t > FROM) cand.add(t); }
  for (const r of prActive) { const t = ms(r.created_at); if (t > FROM) cand.add(t); }
  const cands = [...cand].sort((a, b) => a - b);
  const idxOf = epochOf(cands);
  console.log(`  材料が変わり得る時点: ${cands.length}`);
  const cache = new Map<string, string>();
  const matAt = (t: number, stage: "brain" | "draft") => {
    const i = idxOf(t); const k = `${i}|${stage}`; const c = cache.get(k); if (c) return c;
    const at = i === 0 ? FROM : cands[i - 1];
    const v = h([...createdReads.filter((r) => r.stage === "brain" || stage === "draft").map((r) => sigAt(r, srcOf(r.table), at)), prSigAt(at, stage)]);
    cache.set(k, v); return v;
  };
  const pct = (a: number, b: number) => `${a}/${b}（${b ? Math.round((a / b) * 100) : 0}%）`;
  const show = (name: string, f: (t: number) => string) => {
    const r = hitRate(runs, f), g = hitRate(runs, f, 30 * 60e3), g2 = hitRate(runs, f, 2 * 3600e3);
    console.log(`  ${name}: 使い回せた回 ${pct(r.hits, r.n)}・前の回から30分以上空いた回 ${pct(g.hits, g.n)}・2時間以上 ${pct(g2.hits, g2.n)}・回と回の間で鍵が変わった ${r.changes}回`);
  };
  console.log("ブレインの段（stage=brain）");
  show("旧（件数・最後の時刻）", (t) => `o${oldB(t)}`);
  show("中身（書き換えは効かなかった＝下限の変化）", (t) => `${matAt(t, "brain")}|${bLo(t)}`);
  show("中身（書き換えは全部効いた＝上限の変化）", (t) => `${matAt(t, "brain")}|${bHi(t)}`);
  show("中身・相場を聞く番の問題（下限）", (t) => `${matAt(t, "brain")}|${bLoR(t)}`);
  show("中身・相場を聞く番の問題（上限）", (t) => `${matAt(t, "brain")}|${bHiR(t)}`);
  console.log("下書きの段（stage=draft）");
  show("旧（件数・最後の時刻）", (t) => `o${oldD(t)}`);
  show("中身（下限の変化）", (t) => `${matAt(t, "draft")}|${dLo(t)}`);
  show("中身（上限の変化）", (t) => `${matAt(t, "draft")}|${dHi(t)}`);
  show("中身・相場を聞く番の問題（下限）", (t) => `${matAt(t, "draft")}|${dLoR(t)}`);
  show("中身・相場を聞く番の問題（上限）", (t) => `${matAt(t, "draft")}|${dHiR(t)}`);
  if (process.argv.includes("--breakdown")) {
  // どこが鍵を変えたか（7日の中の変化の数・遅い＝--breakdown の時だけ）
  const inWin = (ev: number[]) => new Set(ev.filter((x) => x > FROM && x <= NOW)).size;
  const parts: Array<[string, number]> = [];
  for (const r of createdReads) { let prev = "", n = 0; for (let i = 0; i <= cands.length; i++) { const s = sigAt(r, srcOf(r.table), i === 0 ? FROM : cands[i - 1]); if (i > 0 && s !== prev) n++; prev = s; } parts.push([`中身 ${r.table}.${r.name}（${r.stage}）`, n]); }
  { let prev = "", n = 0; for (let i = 0; i <= cands.length; i++) { const s = prSigAt(i === 0 ? FROM : cands[i - 1], "brain"); if (i > 0 && s !== prev) n++; prev = s; } parts.push(["中身 ai_prompt_rules 新しい行（ブレイン）", n]); }
  { let prev = "", n = 0; for (let i = 0; i <= cands.length; i++) { const s = prSigAt(i === 0 ? FROM : cands[i - 1], "draft"); if (i > 0 && s !== prev) n++; prev = s; } parts.push(["中身 ai_prompt_rules 新しい行（下書き）", n]); }
  parts.push(["中身 rent_observations 新しい部屋（相場を聞く番の問題だけ）", inWin(rentNew)], ["（上限）rent_observations 属性の更新", inWin(rentAttr)], ["（上限）ai_prompt_rules 書き換え", inWin(prUpd)], ["（上限）trigger_action_rules 書き換え", inWin(trMat)], ["（上限）brain_aix_feedback 毎日", inWin(dailyAt(fbLast))], ["中身 ai_prompts 使う鍵", inWin(apUsed)], ["中身 phrase_dictionary p>=10", inWin(phNew)], ["中身 template_selection_logs 窓", inWin(tslEv)], ["中身 winning_pattern_logs 当たった予測", inWin(wplNew)], ["（上限）brain_action_reach_stats 毎日", inWin(reachDaily)]);
  parts.push(["旧 ブレインの表の時刻", inWin(oldBrainEv)], ["旧 下書きの表の時刻", inWin(oldDraftEv)]);
  for (const [n, c] of parts) console.log(`  変化 ${String(c).padStart(5)}  ${n}`);
  }
  // 鍵の持ち（7日の中で鍵が同じ時間の長さの中央）
  const span = (f: (t: number) => string) => { const pts: number[] = []; for (let t = FROM; t <= NOW; t += 600e3) pts.push(t); const ks = pts.map(f); const lens: number[] = []; let s = 0; for (let i = 1; i <= ks.length; i++) if (i === ks.length || ks[i] !== ks[i - 1]) { lens.push((i - s) * 10); s = i; } lens.sort((a, b) => a - b); return { median: lens[lens.length >> 1] ?? 0, count: lens.length }; };
  for (const [name, f] of [["旧・ブレイン", (t: number) => `o${oldB(t)}`], ["中身・ブレイン（上限）", (t: number) => `${matAt(t, "brain")}|${bHi(t)}`], ["旧・下書き", (t: number) => `o${oldD(t)}`], ["中身・下書き（上限）", (t: number) => `${matAt(t, "draft")}|${dHi(t)}`]] as const) {
    const s = span(f); console.log(`  鍵の持ち ${name}: ${s.count}区間・中央 ${s.median}分`);
  }
})();

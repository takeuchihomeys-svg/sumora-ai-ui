// 試験の使い回しの鍵の「DB の中身の指紋」（scripts/lib/exam-db-fp.ts）の単体テスト（本物の DB も LLM も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-db-fp.test.ts（全 PASS で exit 0）
import {
  runFpQueryInMemory, readDbContentFingerprint, dbContentReads, contentPartsOf, dbFpMode, dbPartName, reduceKeywordRules, reducePromptRules, problemReadsRent,
  type FpRunner, type Row,
} from "../exam-db-fp";
import { dbKeyOf } from "../exam-brain";
import { dbPartsOf } from "../exam-brain-io";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// 1. 手元で当てる問い合わせ（PostgREST と同じ意味）
{
  const rows: Row[] = [{ id: 1, s: null, t: "失注パターン_a", n: 3 }, { id: 2, s: "rejected", t: "x", n: null }, { id: 3, s: "confirmed", t: "[成約分析] y", n: 5 }];
  const ids = (q: Parameters<typeof runFpQueryInMemory>[1]) => runFpQueryInMemory(rows, { ...q, cols: ["id"] }).map((r) => r.id).join();
  ok("neq は NULL を外す（SQL の <>）", ids({ cols: [], filters: [["neq", "s", "rejected"]] }) === "3");
  ok("neq_or_null は NULL を残す", ids({ cols: [], filters: [["neq_or_null", "s", "rejected"]] }) === "1,3");
  ok("ilike・ilike_any（[ や _ も文字どおり・% は何でも）", ids({ cols: [], filters: [["ilike", "t", "失注パターン%"]] }) === "1" && ids({ cols: [], filters: [["ilike_any", "t", ["[成約分析]%", "zzz%"]]] }) === "3");
  ok("NULL の並び: desc は先・asc は後（nullsFirst の明示はそれ）", ids({ cols: [], order: [["n", "desc"]] }) === "2,3,1" && ids({ cols: [], order: [["n", "asc"]] }) === "1,3,2" && ids({ cols: [], order: [["n", "desc", false]] }) === "3,1,2");
  ok("上限と欄の絞り", JSON.stringify(runFpQueryInMemory(rows, { cols: ["t"], order: [["id", "desc"]], limit: 1 })) === JSON.stringify([{ t: "[成約分析] y" }]));
  const parent = new Map<unknown, Row>([["c1", { id: "c1", status: "applying" }], ["c2", { id: "c2", status: "hearing" }]]);
  ok("親の表で絞る（会話の状態）", runFpQueryInMemory([{ id: 1, conversation_id: "c1" }, { id: 2, conversation_id: "c2" }], { cols: ["id"], join: { table: "conversations", fk: "conversation_id", col: "status", in: ["applying"] } }, parent).map((r) => r.id).join() === "1");
}
// 2. スイッチ・部分の名前
{
  ok("既定は中身・EXAM_DB_FP=fine で旧", dbFpMode({}) === "content" && dbFpMode({ EXAM_DB_FP: "fine" }) === "fine" && dbFpMode({ EXAM_DB_FP: "FINE " }) === "fine");
  const reads = dbContentReads();
  const b = contentPartsOf("brain", reads), d = contentPartsOf("draft", reads);
  ok("ブレインの段は #b だけ・下書きは #b＋#d", b.every((x) => x.endsWith("#b")) && b.every((x) => d.includes(x)) && d.some((x) => x.endsWith("#d")));
  ok("旧の19表は全部どれかの読みがある", ["ai_reply_knowledge", "ai_prompt_rules", "ai_reply_examples", "trigger_action_rules", "aix_action_attribution", "aix_transition_stats", "brain_aix_feedback", "brain_meta_insights", "templates", "winning_patterns", "property_search_knowledge", "rent_observations", "region_map", "station_map", "line_stations", "adaptation_improvement_rules", "ai_prompts", "phrase_dictionary", "template_selection_logs"].every((t) => reads.some((r) => r.table === t)));
  ok("相場の材料は相場を聞く番の問題だけ（rent=false で外す・既定は入れる）", b.includes("rent_observations#b") && !contentPartsOf("brain", reads, { rent: false }).includes("rent_observations#b") && !dbPartsOf("draft", "content", { rent: false }).includes("rent_observations#b") && dbPartsOf("brain", "fine", { rent: false }).includes("rent_observations"));
  ok("相場を聞く番か: 問題の customer と context の最後に続くお客様の発言", problemReadsRent({ customer: "この辺りの家賃相場ってどれくらいですか？" }) && !problemReadsRent({ customer: "もう少し探していただけますか？" })
    && problemReadsRent({ customer: "お願いします", context: [{ s: "staff", t: "x" }, { s: "customer", t: "梅田周辺の1LDKの相場はいくらくらいですか" }] })
    && !problemReadsRent({ customer: "お願いします", context: [{ s: "customer", t: "梅田周辺の1LDKの相場はいくらくらいですか" }, { s: "staff", t: "x" }] }));
  ok("customer が読めない問題は安全側（入れる）", problemReadsRent({}) && problemReadsRent({ customer: null }));
  ok("形で部分の名前が違う（鍵が混ざらない）", dbPartsOf("brain", "fine").includes("ai_reply_knowledge") && dbPartsOf("brain", "content").includes(dbPartName("ai_reply_knowledge", "brain")));
}
// 3. 偽の DB で中身の指紋
const now = Date.parse("2026-10-18T00:00:00Z");
const iso = (d: number) => new Date(now - d * 3600e3).toISOString();
type DB = Record<string, Row[]>;
function baseDb(): DB {
  const imp10 = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, category: "principle", importance: 10, hypothesis_status: "confirmed", title: `決まり${i}`, content: `必ず${i}する`, created_at: iso(500 + i) }));
  return {
    ai_reply_knowledge: [
      ...imp10,
      { id: "p9", category: "principle", importance: 9, hypothesis_status: null, title: "決まりA", content: "Aを先に伝える", created_at: iso(400) },
      { id: "ap", category: "applying_pattern", importance: 9, hypothesis_status: "confirmed", title: "型", content: "型の中身", created_at: iso(300) },
    ],
    ai_reply_examples: [
      { id: "e1", entry_source: "line_reply", is_starred: true, conversation_state: "hearing", customer_message: "探してます", sent_reply: "ありがとうございます！！条件を伺ってもよろしいでしょうか", reply_angle: null, conversation_id: "c1", created_at: iso(100) },
    ],
    conversations: [{ id: "c1", status: "hearing" }, { id: "c2", status: "applying" }],
    ai_prompt_rules: [{ id: 1, rule_key: "HUMAN-1", action_type: null, rule_text: "敬語", condition_key: null, condition_value: null, priority: 9, is_permanent: true, is_active: true, updated_at: iso(50) }],
    brain_aix_feedback: [{ key: "action:x", kind: "action", action: "x", n: 10, pressed: 3, matched: 2, alt_top: [], window_days: 30, updated_at: iso(1) }],
    ai_prompts: [{ key: "smora_rules", content: "ルール", updated_at: iso(10) }, { key: "shadow_eval_latest", content: "集計1", updated_at: iso(1) }],
    property_search_knowledge: [{ id: 1, branch_id: "osaka", kind: "area_profile", key: "station:梅田", evidence_count: 3, payload: { a: 1 }, content: "c", hypothesis_status: "confirmed", is_current: true, use_count: 1, last_used_at: iso(5) }],
    trigger_action_rules: [
      { id: 1, category: "keyword_rule", action_type: "viewing_invite", keyword: "内覧", confidence: 0.95, occurrence_count: 12, conversation_status: null },
      { id: 2, category: "keyword_rule", action_type: "estimate_sheet", keyword: "初期費用", confidence: 0.7, occurrence_count: 3, conversation_status: null },
    ],
  };
}
const runnerOf = (db: DB, broken: string[] = []): FpRunner => async (table, q) => {
  if (broken.includes(table)) throw new Error(`no table ${table}`);
  const parent = q.join ? new Map((db[q.join.table] ?? []).map((r) => [r.id, r])) : undefined;
  return runFpQueryInMemory(db[table] ?? [], q, parent);
};
async function keys(db: DB, broken: string[] = []) {
  const reads = dbContentReads(now);
  const parts = await readDbContentFingerprint(null, reads, runnerOf(db, broken));
  return { parts, brain: dbKeyOf(parts, contentPartsOf("brain", reads)), draft: dbKeyOf(parts, contentPartsOf("draft", reads)) };
}
void (async () => {
  const k0 = await keys(baseDb());
  ok("指紋が読める（全部 ok）", k0.parts.every((p) => p.ok) && !!k0.brain && !!k0.draft, JSON.stringify(k0.parts.filter((p) => !p.ok)));
  ok("同じ中身なら同じ鍵", (await keys(baseDb())).draft === k0.draft);
  const same = async (name: string, f: (db: DB) => void, expect: { brain: boolean; draft: boolean }) => {
    const db = baseDb(); f(db); const k = await keys(db);
    ok(name, (k.brain === k0.brain) === expect.brain && (k.draft === k0.draft) === expect.draft, `brain ${k.brain === k0.brain ? "同じ" : "違う"}・draft ${k.draft === k0.draft ? "同じ" : "違う"}`);
  };
  // 時刻・使った記録は効かない
  await same("時刻だけの書き直し（毎日の cron の updated_at=now）は鍵を変えない", (db) => { db.brain_aix_feedback[0].updated_at = iso(0); db.ai_prompts[0].updated_at = iso(0); }, { brain: true, draft: true });
  await same("使った回数・最後に使った時刻は鍵を変えない", (db) => { db.property_search_knowledge[0].use_count = 99; db.property_search_knowledge[0].last_used_at = iso(0); }, { brain: true, draft: true });
  await same("下書きが使わない ai_prompts の鍵（cron の集計）は鍵を変えない", (db) => { db.ai_prompts[1].content = "集計2"; }, { brain: true, draft: true });
  await same("毎日の学習の大半（phrase・pattern の imp 6〜8）は直に読まない＝鍵を変えない", (db) => { db.ai_reply_knowledge.push({ id: "n1", category: "phrase", importance: 7, hypothesis_status: "hypothesis", title: "フレーズ", content: "新しい言い回し", created_at: iso(0) }, { id: "n2", category: "pattern", importance: 8, hypothesis_status: "hypothesis", title: "next_action", content: "x", created_at: iso(0) }); }, { brain: true, draft: true });
  await same("評価文の原則（題「原則：」・imp9）はブレインに渡らない＝鍵を変えない", (db) => { db.ai_reply_knowledge.push({ id: "n3", category: "principle", importance: 9, hypothesis_status: "hypothesis", title: "原則：内覧", content: "丁寧に伝えている", created_at: iso(0) }); }, { brain: true, draft: true });
  await same("☆の無い手本（RAG だけで引く）は鍵を変えない", (db) => { db.ai_reply_examples.push({ id: "e9", entry_source: "aix_action", is_starred: false, conversation_state: "hearing", customer_message: "a", sent_reply: "b", reply_angle: null, conversation_id: "c1", created_at: iso(0) }); }, { brain: true, draft: true });
  await same("priority 3 以下の決まり（渡らない）は鍵を変えない", (db) => { db.ai_prompt_rules.push({ id: 2, rule_key: "FEEDBACK-old", action_type: "generate_reply", rule_text: "古い", condition_key: null, condition_value: null, priority: 2, is_permanent: false, is_active: true, updated_at: iso(0) }); }, { brain: true, draft: true });
  await same("語のルールの使った回数（竹内さんの回答の印・並びが変わらない）は鍵を変えない", (db) => { db.trigger_action_rules[1].occurrence_count = 4; }, { brain: true, draft: true });
  // 答えに効く変化は拾う
  await same("新しい imp10 の原則は下書きの鍵を変える（ブレインの上位10は imp10 が埋める）", (db) => { db.ai_reply_knowledge.push({ id: "n4", category: "principle", importance: 10, hypothesis_status: "confirmed", title: "新", content: "新しい決まり", created_at: iso(0) }); }, { brain: false, draft: false });
  await same("原則の文の書き換えは拾う", (db) => { db.ai_reply_knowledge[0].content = "書き換えた"; }, { brain: false, draft: false });
  await same("却下された原則は外れる＝拾う", (db) => { db.ai_reply_knowledge[0].hypothesis_status = "rejected"; }, { brain: false, draft: false });
  await same("新しい☆の line_reply の手本は下書きの手本のフォールバックに入る（ブレインは成約の会話でなければ見ない）", (db) => { db.ai_reply_examples.push({ id: "e2", entry_source: "line_reply", is_starred: true, conversation_state: "proposing", customer_message: "高い", sent_reply: "かしこまりました！！もう少しお安いお部屋もお探しさせて頂きます", reply_angle: null, conversation_id: "c1", created_at: iso(0) }); }, { brain: true, draft: false });
  await same("会話が申込に進むと成約の手本としてブレインに入る", (db) => { db.conversations[0].status = "applying"; }, { brain: false, draft: false });
  await same("返信の決まり（generate_reply）はブレインに渡らない＝下書きだけ変える", (db) => { db.ai_prompt_rules.push({ id: 4, rule_key: "DIFF-POLICY-FULL-1", action_type: "generate_reply", rule_text: "新", condition_key: null, condition_value: null, priority: 8, is_permanent: false, is_active: true, updated_at: iso(0) }); }, { brain: true, draft: false });
  await same("アクション別の上位40の外（priority の低い古い行）はブレインに渡らない", (db) => {
    for (let i = 0; i < 40; i++) db.ai_prompt_rules.push({ id: 100 + i, rule_key: `HUMAN-${i}`, action_type: "property_send", rule_text: `r${i}`, condition_key: null, condition_value: null, priority: 9, is_permanent: false, is_active: true, updated_at: iso(10) });
  }, { brain: false, draft: false });
  {
    const db = baseDb(); for (let i = 0; i < 40; i++) db.ai_prompt_rules.push({ id: 100 + i, rule_key: `HUMAN-${i}`, action_type: "property_send", rule_text: `r${i}`, condition_key: null, condition_value: null, priority: 9, is_permanent: false, is_active: true, updated_at: iso(10) });
    const a = await keys(db);
    db.ai_prompt_rules.push({ id: 200, rule_key: "LEARN-AIX-x", action_type: "property_send", rule_text: "低い", condition_key: null, condition_value: null, priority: 6, is_permanent: false, is_active: true, updated_at: iso(0) });
    const b = await keys(db);
    ok("上位40が priority 9 で埋まったアクションに priority 6 を足してもブレインは同じ（下書きは変わる）", a.brain === b.brain && a.draft !== b.draft);
  }
  {
    const mk = () => { const db = baseDb(); db.brain_action_reach_stats = [{ scene_key: "s", stage_bucket: "b", action: "x", n: 10, reached: 2, rate: 0.2, won: 1, computed_at: iso(1) }]; db.winning_pattern_logs = [{ id: 1, customer_id: "pc1", predicted_pattern: "押す", personality_profile: null, was_correct: true, created_at: iso(5) }]; db.property_customers = [{ id: "pc1", ai_summary_json: { personality_profile: "慎重" }, updated_at: iso(3) }]; return db; };
    const a = await keys(mk());
    const d1 = mk(); d1.brain_action_reach_stats[0].computed_at = iso(0); d1.property_customers[0].updated_at = iso(0);
    ok("申込到達率の入れ直し（computed_at だけ）・お客様の行の時刻は鍵を変えない", (await keys(d1)).brain === a.brain);
    const d2 = mk(); d2.brain_action_reach_stats[0].rate = 0.3;
    ok("申込到達率の中身は拾う", (await keys(d2)).brain !== a.brain);
    const d3 = mk(); (d3.property_customers[0].ai_summary_json as Record<string, unknown>).personality_profile = "即決";
    ok("当たった予測の人間性（お客様の要約から補う）は拾う", (await keys(d3)).brain !== a.brain);
  }
  await same("渡る決まり（priority>=4）の追加は拾う", (db) => { db.ai_prompt_rules.push({ id: 3, rule_key: "DIFF-POLICY-AIX-1", action_type: "property_send", rule_text: "新", condition_key: null, condition_value: null, priority: 7, is_permanent: false, is_active: true, updated_at: iso(0) }); }, { brain: false, draft: false });
  await same("統計の中身（一致率）の変化は拾う", (db) => { db.brain_aix_feedback[0].matched = 3; }, { brain: false, draft: false });
  await same("語のルールの確信度・竹内さんの回答の印の変化は拾う", (db) => { db.trigger_action_rules[0].occurrence_count = 5; }, { brain: false, draft: false });
  await same("下書きが使う ai_prompts の中身は拾う", (db) => { db.ai_prompts[0].content = "ルール2"; }, { brain: true, draft: false });
  // 読めない時は使い回さない
  const kb = await keys(baseDb(), ["ai_prompts"]);
  ok("読めない表 → その段の鍵は null（下書きだけ）", kb.draft === null && kb.brain === k0.brain);
  const kb2 = await keys(baseDb(), ["ai_reply_knowledge"]);
  ok("ブレインの表が読めない → どちらも null", kb2.brain === null && kb2.draft === null);
  const db3 = baseDb(); db3.ai_reply_knowledge = db3.ai_reply_knowledge.filter((r) => r.id !== "p0" && r.id !== "p1");
  const k3 = await keys(db3);
  ok("imp10 の原則が12件未満（prompt-cache の上位12に同点の imp9 が混ざる）→ 読めない扱い", k3.draft === null && !!k3.brain);
  // 純関数
  ok("語のルール: 段ごとに上位200・意味の無い語を外す", JSON.stringify(reduceKeywordRules([{ action_type: "x", keyword: "ます", confidence: 1, occurrence_count: 20, conversation_status: null }])) === JSON.stringify({ "*": { set: [], human: [] } }));
  ok("決まり: 並びは一覧の順で入る", JSON.stringify(reducePromptRules([{ rule_key: "a", priority: 5 }, { rule_key: "b", priority: 5 }])) !== JSON.stringify(reducePromptRules([{ rule_key: "b", priority: 5 }, { rule_key: "a", priority: 5 }])));
  ok("決まり: アクション別の恒久は priority 3 以下でも入る（prompt-rules の恒久の枠は priority で絞らない）", JSON.stringify(reducePromptRules([{ rule_key: "p", priority: 2, is_permanent: true, action_type: "generate_reply", rule_text: "x" }])) !== JSON.stringify(reducePromptRules([{ rule_key: "p", priority: 2, is_permanent: true, action_type: "generate_reply", rule_text: "y" }])));
  console.log(`exam-db-fp: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();

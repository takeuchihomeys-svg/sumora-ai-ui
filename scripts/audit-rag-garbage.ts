// scripts/audit-rag-garbage.ts — RAG の置き場のゴミを数え、検索の上位に入った割合と「ゴミが質を下げた番」を結ぶ（読むだけ・LLM なし・埋め込みの API も呼ばない）
//
// 2026-10-08 竹内さん「RAG 検索を行う際のゴミデータが質を下げている可能性もあるので、その点も調査する」
// 型は app/lib/rag-garbage.ts（純関数）。設計知見 803ff07c（RAG の精度の監査手順）の ②本番の問いで測る・③厳密検索との重なり を使う。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-rag-garbage.ts [--days=40] [--kq=300] [--show=5]
//   ① 手本・ナレッジ・成功パターン・テンプレートの全行にゴミの型を当てて数える
//   ② 手本（返信の経路）: 直近 days 日の line_reply（AI の下書きあり・テスト会話を除く）を1番ずつ、
//      本番と同じ RPC match_reply_examples（その行の埋め込み＝save-reply-example が作る「state: [前返信]… [顧客]…」＝本番の問いと同じ形）で引き直し、
//      その番より後の行・自分を除いて、読む側の関門（isUsableExampleText・isCustomerFacingExample・類似度 0.5）と並べ替え（⭐+0.15・角度+0.1・書き手±0.12）を通した上位8件の
//      ゴミを数える。厳密検索（全件の内積）の上位8件とも比べる（ivfflat の取りこぼし）
//   ③ 「ゴミが質を下げた番」: 上位8件の手本にある癖（お待たせ・お客様・従業員の書き方・AIX の番の文）が下書きに出て、実送信には無い番
//   ④ ナレッジ: embedding_cache に残る本番の問い（[TPO:…] で始まる・YUMA を除く）kq 件で match_reply_knowledge を引き直し、上位のゴミの割合
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import {
  exampleGarbageTypes, knowledgeGarbageTypes, POST_APPLY_TEXT_RE, residualHard, dupKey, KNOWLEDGE_HARD,
  type GarbageType, type KnowledgeGarbageType,
} from "../app/lib/rag-garbage";
import { isUsableExampleText, isCustomerFacingExample } from "../app/lib/example-hygiene";
import { writerFromText } from "../app/lib/staff-writer";
import { WAITED_RE } from "../app/lib/greeting";
import { fixSecondPersonOkyaku } from "../app/lib/okyaku-address";
import { isTestConversation } from "../app/lib/test-conversations";
import { aixTurnReason } from "../app/lib/rag-garbage";
import { STATE_SEARCH_ALIASES } from "../app/lib/line-reply-prompts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const arg = (k: string, d: number) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split("=")[1]) : d; };
const DAYS = arg("days", 40), KQ = arg("kq", 300), SHOW = arg("show", 5);
const one = (s: string | null | undefined, n = 110) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

type Ex = {
  id: string; created_at: string; conversation_id: string | null; conversation_state: string; entry_source: string;
  customer_message: string | null; sent_reply: string | null; ai_draft: string | null; is_starred: boolean | null;
  was_ai_used: boolean | null; was_ai_modified: boolean | null; reply_angle: string | null; ai_similarity: number | null;
  embedding?: string | null;
};
type Kn = { id: string; title: string | null; content: string | null; category: string | null; importance: number | null; hypothesis_status: string | null; correct_count: number | null; wrong_count: number | null; source_example_id: string | null; conversation_state: string | null; created_at: string; embedding: string | null };

async function pageAll<T>(table: string, cols: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    let q = sb.from(table).select(cols).order("id").range(i, i + 999);
    if (filter) q = filter(q);
    const r = await q;
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    out.push(...((r.data ?? []) as T[]));
    if ((r.data ?? []).length < 1000) break;
  }
  return out;
}

function countTypes<T extends string>(rows: Array<{ types: T[] }>): Map<T, number> {
  const m = new Map<T, number>();
  for (const r of rows) for (const t of r.types) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
const fmt = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}（${(100 * v / Math.max(1, n)).toFixed(1)}%）`).join("・");

async function main() {
  const t0 = Date.now();
  // ── 会話の事情（申込以降の期間・テスト会話）──
  const outcomes = await pageAll<{ conversation_id: string; applied_at: string | null; ended_at: string | null }>("deal_outcomes", "id, conversation_id, applied_at, ended_at");
  const applyWin = new Map<string, Array<[number, number]>>();
  for (const o of outcomes) {
    if (!o.applied_at) continue;
    const a = Date.parse(o.applied_at), e = o.ended_at ? Date.parse(o.ended_at) : Infinity;
    (applyWin.get(o.conversation_id) ?? applyWin.set(o.conversation_id, []).get(o.conversation_id)!).push([a, e]);
  }
  const isPostApply = (cid: string | null, at: string) => !!cid && (applyWin.get(cid) ?? []).some(([a, e]) => { const t = Date.parse(at); return t >= a && t <= e; });

  // ── ① 手本 ──
  const exs = await pageAll<Ex>("ai_reply_examples", "id, created_at, conversation_id, conversation_state, entry_source, customer_message, sent_reply, ai_draft, is_starred, was_ai_used, was_ai_modified, reply_angle, ai_similarity");
  const exById = new Map(exs.map((e) => [e.id, e]));
  const seen = new Map<string, string>(); // entry_source|dupKey → 最初の id
  const exTypes = new Map<string, GarbageType[]>();
  for (const e of [...exs].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const key = `${e.entry_source}|${dupKey(e.customer_message ?? "")}|${dupKey(e.sent_reply ?? "")}`;
    const isDup = seen.has(key); if (!isDup) seen.set(key, e.id);
    exTypes.set(e.id, exampleGarbageTypes(e, { isTestConv: isTestConversation(e.conversation_id), isPostApply: isPostApply(e.conversation_id, e.created_at), isDup }));
  }
  const groups: Record<string, (e: Ex) => boolean> = {
    "返信の手本 line_reply（match_reply_examples）": (e) => e.entry_source === "line_reply",
    "AIX の手本 aix_template/aix_action/aix_property（match_aix_reply_examples）": (e) => ["aix_template", "aix_action", "aix_property"].includes(e.entry_source),
    "検索の外（aix_adapt・pii_excluded・rejected_example）": (e) => !["line_reply", "aix_template", "aix_action", "aix_property"].includes(e.entry_source),
  };
  console.log(`\n=== ① 手本 ai_reply_examples ${exs.length}行 ===`);
  for (const [g, f] of Object.entries(groups)) {
    const rows = exs.filter(f).map((e) => ({ types: exTypes.get(e.id)! }));
    const anyHard = rows.filter((r) => residualHard(r.types).length > 0).length;
    console.log(`\n■ ${g}: ${rows.length}行・今も効く hard ${anyHard}行（${(100 * anyHard / Math.max(1, rows.length)).toFixed(1)}%）`);
    console.log("  型: " + fmt(countTypes(rows) as Map<string, number>, rows.length));
  }
  // 型ごとの実物（返信の手本・目で読む用）
  const lr = exs.filter((e) => e.entry_source === "line_reply");
  for (const t of ["test_conv", "post_apply", "pii", "mojibake", "aix_turn", "omatase", "okyaku", "dup", "writer_b", "auto_star", "tiny", "long"] as GarbageType[]) {
    const hits = lr.filter((e) => exTypes.get(e.id)!.includes(t));
    if (!hits.length) continue;
    console.log(`\n  [${t}] ${hits.length}行（⭐${hits.filter((h) => h.is_starred).length}）例:`);
    for (const h of hits.slice(-SHOW)) console.log(`    ${h.id.slice(0, 8)} ${h.created_at.slice(0, 10)} ${h.is_starred ? "⭐" : "  "} ${t === "aix_turn" ? `<${aixTurnReason(h.sent_reply ?? "")}> ` : ""}${t === "pii" ? "（伏せて表示しない）" : one(h.sent_reply)}`);
  }

  // ── ① ナレッジ ──
  const kns = await pageAll<Kn>("ai_reply_knowledge", "id, title, content, category, importance, hypothesis_status, correct_count, wrong_count, source_example_id, conversation_state, created_at");
  const knSeen = new Set<string>();
  const knTypes = new Map<string, KnowledgeGarbageType[]>();
  const srcWhy = new Map<string, number>();
  const searchable = (k: Kn, minImp: number) => (k.importance ?? 0) >= minImp && (k.hypothesis_status ?? "hypothesis") !== "rejected";
  for (const k of [...kns].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const key = `${k.category}|${dupKey(k.content ?? "")}`;
    const isDup = searchable(k, 7) && knSeen.has(key); if (searchable(k, 7)) knSeen.add(key);
    const src = k.source_example_id ? exById.get(k.source_example_id) : null;
    const why = !src ? null : ["rejected_example", "pii_excluded"].includes(src.entry_source) ? src.entry_source : isTestConversation(src.conversation_id) ? "test_conv" : isPostApply(src.conversation_id, src.created_at) && POST_APPLY_TEXT_RE.test(k.content ?? "") ? "post_apply" : !isUsableExampleText(src.sent_reply) ? "unusable" : null;
    const srcBad = !!why; if (why && searchable(k, 7)) srcWhy.set(why, (srcWhy.get(why) ?? 0) + 1);
    knTypes.set(k.id, knowledgeGarbageTypes(k, { srcBad, isDup }));
  }
  const knS = kns.filter((k) => searchable(k, 7));
  console.log(`\n=== ① ナレッジ ai_reply_knowledge ${kns.length}行（検索の対象 importance≥7・rejected 以外 ${knS.length}行／ブレインの対象 ≥8 ${kns.filter((k) => searchable(k, 8)).length}行）===`);
  const knRows = knS.map((k) => ({ types: knTypes.get(k.id)! }));
  const knHard = knRows.filter((r) => r.types.some((t) => KNOWLEDGE_HARD.has(t))).length;
  console.log(`  hard ${knHard}行（${(100 * knHard / knS.length).toFixed(1)}%）・型: ` + fmt(countTypes(knRows) as Map<string, number>, knS.length));
  console.log(`  元の手本が外れる理由: ${[...srcWhy.entries()].map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`  元の手本が分かる行 ${knS.filter((k) => k.source_example_id).length}・元の手本が今は無い ${knS.filter((k) => k.source_example_id && !exById.has(k.source_example_id)).length}`);
  for (const t of ["src_bad", "omatase_pos", "okyaku_pos", "night_pos", "wrong_more", "dup", "pii", "writer_b"] as KnowledgeGarbageType[]) {
    const hits = knS.filter((k) => knTypes.get(k.id)!.includes(t));
    if (!hits.length) continue;
    console.log(`\n  [${t}] ${hits.length}行 例:`);
    for (const h of hits.slice(-SHOW)) console.log(`    ${h.id.slice(0, 8)} ${h.created_at.slice(0, 10)} ${h.category}/${h.hypothesis_status ?? "null"}/imp${h.importance} ${t === "pii" ? "（伏せて表示しない）" : `[${one(h.title, 30)}] ${one(h.content)}`}`);
  }

  // ── ① 成功パターン・テンプレート（小さいので全件の型だけ）──
  const wps = await pageAll<{ id: string; situation: string | null; pattern: string | null; importance: number | null; source_conversation_id: string | null; created_at: string }>("winning_patterns", "id, situation, pattern, importance, source_conversation_id, created_at");
  const wpBad = wps.filter((w) => isTestConversation(w.source_conversation_id) || WAITED_RE.test(w.pattern ?? "") || !String(w.pattern ?? "").trim());
  console.log(`\n=== ① 成功パターン winning_patterns ${wps.length}行（importance≥8 ${wps.filter((w) => (w.importance ?? 0) >= 8).length}）: テスト会話・空・お待たせ ${wpBad.length}行 ===`);
  for (const w of wpBad) console.log(`    ${w.id.slice(0, 8)} ${one(w.pattern)}`);
  const tps = await pageAll<{ id: string; category: string; label: string; text: string | null }>("templates", "id, category, label, text");
  const tpBad = tps.map((t) => ({ t, types: exampleGarbageTypes({ sent_reply: t.text, entry_source: "template" }) })).filter((x) => residualHard(x.types).length);
  console.log(`=== ① テンプレート templates ${tps.length}行（検索はカテゴリ＋ラベルの埋め込み）: hard ${tpBad.length}行 ===`);
  for (const x of tpBad) console.log(`    ${x.t.id.slice(0, 8)} ${x.t.category}/${x.t.label} [${residualHard(x.types).join(",")}] ${one(x.t.text, 80)}`);

  {
    const dump: Record<string, string[]> = {};
    for (const e of exs) for (const t of exTypes.get(e.id)!) (dump[`ex:${e.entry_source}:${t}`] ??= []).push(e.id);
    for (const k of kns) for (const t of knTypes.get(k.id)!) if (searchable(k, 7)) (dump[`kn:${t}`] ??= []).push(k.id);
    writeFileSync(process.env.RAG_GARBAGE_DUMP ?? `${process.env.TEMP ?? "."}/rag-garbage-ids.json`, JSON.stringify(dump));
    // 外す SQL の案（--sql=<path> の時だけ書く・実行はしない）。id を1件ずつ並べる（ワイルドカードで消さない）。
    //   控えの表に元の entry_source・理由を残してから印を付け替える＝戻せる（下の「戻し方」）
    const sqlPath = process.argv.find((x) => x.startsWith("--sql="))?.split("=")[1];
    if (sqlPath) {
      const q = (ids: string[]) => ids.map((i) => `'${i}'`).join(",");
      const tier: Array<{ label: string; reason: string; ids: string[] }> = [
        { label: "段1（誤外し0・目で読んだ）文字化け", reason: "rag_garbage:mojibake", ids: dump["ex:line_reply:mojibake"] ?? [] },
        { label: "段1 テスト会話（YUMA・スタッフ同士・業者）", reason: "rag_garbage:test_conv", ids: [...(dump["ex:line_reply:test_conv"] ?? []), ...(dump["ex:aix_action:test_conv"] ?? []), ...(dump["ex:aix_template:test_conv"] ?? []), ...(dump["ex:aix_property:test_conv"] ?? [])] },
        { label: "段2（竹内さん確認）返信の手本の中の AIX の番の文（物件カード・見積書の本体・待ち合わせ・候補日時）", reason: "rag_garbage:aix_turn", ids: (dump["ex:line_reply:aix_turn"] ?? []).filter((i) => !(dump["ex:line_reply:test_conv"] ?? []).includes(i) && !(dump["ex:line_reply:mojibake"] ?? []).includes(i)) },
        { label: "段2（竹内さん確認）申込以降の中身（申込完了・審査・緊急連絡先・契約）", reason: "rag_garbage:post_apply", ids: (dump["ex:line_reply:post_apply"] ?? []).filter((i) => !(dump["ex:line_reply:aix_turn"] ?? []).includes(i) && !(dump["ex:line_reply:test_conv"] ?? []).includes(i)) },
      ];
      const lines: string[] = [
        `-- RAG のゴミを手本の検索から外す案（2026-10-08 scripts/audit-rag-garbage.ts が作成・未実行）`,
        `-- 控え: 元の entry_source / conversation_state を残す。戻し方は末尾`,
        `CREATE TABLE IF NOT EXISTS ai_reply_examples_rag_garbage_backup (id uuid PRIMARY KEY, entry_source text, conversation_state text, reason text, backed_up_at timestamptz DEFAULT now());`,
      ];
      for (const t of tier) {
        if (!t.ids.length) continue;
        lines.push(`\n-- ${t.label}: ${t.ids.length}行`);
        lines.push(`INSERT INTO ai_reply_examples_rag_garbage_backup (id, entry_source, conversation_state, reason) SELECT id, entry_source, conversation_state, '${t.reason}' FROM ai_reply_examples WHERE id IN (${q(t.ids)}) ON CONFLICT (id) DO NOTHING;`);
        // entry_source を検索の外の値にする（match_reply_examples は line_reply・match_aix_reply_examples は aix_* だけを見る）。conversation_state は変えない
        lines.push(`UPDATE ai_reply_examples SET entry_source = 'rag_excluded' WHERE id IN (${q(t.ids)}) AND entry_source <> 'rag_excluded';`);
      }
      lines.push(`\n-- 戻し方（理由ごと）: UPDATE ai_reply_examples a SET entry_source = b.entry_source FROM ai_reply_examples_rag_garbage_backup b WHERE a.id = b.id AND b.reason = 'rag_garbage:aix_turn';`);
      writeFileSync(sqlPath, lines.join("\n") + "\n");
      console.log(`\n（外す SQL の案を ${sqlPath} に書いた・実行はしていない）`);
    }
  }
  // ── ② 手本の検索の再現（返信の経路）──
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const turns = lr.filter((e) => e.created_at >= since && (e.ai_draft ?? "").trim() && !isTestConversation(e.conversation_id) && !isPostApply(e.conversation_id, e.created_at));
  console.log(`\n=== ② 手本の検索の再現: 直近${DAYS}日の返信 ${turns.length}番（AI の下書きあり・テスト会話と申込以降を除く）===`);
  type Hit = { id: string; similarity: number; is_starred: boolean; reply_angle: string | null; sent_reply: string };
  let nWithHard = 0, nTopHard = 0, nSlots = 0, nHardSlots = 0, nSoftSlots = 0;
  const slotTypeCount = new Map<string, number>();
  const simWith: number[] = [], simWithout: number[] = [];
  const harmed: Array<{ turn: Ex; feat: string; ex: Ex }> = [];
  // ③b さらし（上位8件にその型の手本がある）と、下書きに同じ型が出た率（実送信・お客様の発言に無い時だけ）を比べる
  const POST_APPLY_WORD_RE = /審査|緊急連絡先|契約書|ご契約|お申込(?:み)?(?:完了|手続き|頂き)|重要事項説明|鍵(?:の)?お渡し/;
  const expo: Record<string, { exp: number; expHit: number; no: number; noHit: number; cases: Array<{ turn: Ex; ex: Ex | null }> }> = {};
  const bump = (k: string, exposed: boolean, hit: boolean, turn: Ex, ex: Ex | null) => {
    const e = (expo[k] ??= { exp: 0, expHit: 0, no: 0, noHit: 0, cases: [] });
    if (exposed) { e.exp++; if (hit) { e.expHit++; e.cases.push({ turn, ex }); } } else { e.no++; if (hit) e.noHit++; }
  };
  for (const turn of turns) {
    const er = await sb.from("ai_reply_examples").select("embedding").eq("id", turn.id).single();
    const emb = (er.data as { embedding: string | null } | null)?.embedding;
    if (!emb) continue;
    const aliases = STATE_SEARCH_ALIASES[turn.conversation_state] ?? [turn.conversation_state];
    const rpc = await sb.rpc("match_reply_examples", { query_embedding: emb, match_count: 60, filter_states: aliases });
    if (rpc.error) { console.warn("rpc", rpc.error.message); continue; }
    const before = ((rpc.data ?? []) as Hit[]).filter((h) => h.id !== turn.id && (exById.get(h.id)?.created_at ?? "9") < turn.created_at).slice(0, 24);
    const kept = before.filter((h) => h.similarity >= 0.5 && isUsableExampleText(h.sent_reply) && isCustomerFacingExample(h.sent_reply));
    const wb = (t: string) => { const w = writerFromText(t).writer; return w === "takeuchi" ? 0.12 : w === "employee" ? -0.12 : 0; };
    const top = [...kept].sort((a, b) => (b.similarity + (b.is_starred ? 0.15 : 0) + (b.reply_angle ? 0.1 : 0) + wb(b.sent_reply)) - (a.similarity + (a.is_starred ? 0.15 : 0) + (a.reply_angle ? 0.1 : 0) + wb(a.sent_reply))).slice(0, 8);
    // ※ 厳密検索との重なりは SQL で別に測る（scripts の外・報告に記載。RPC は ivfflat probes=1 の近似のまま＝本番が実際に見た物に近い）
    let hardHere = 0;
    for (const h of top) {
      const types = exTypes.get(h.id) ?? [];
      const hard = residualHard(types);
      nSlots++;
      if (hard.length) { nHardSlots++; hardHere++; for (const t of hard) slotTypeCount.set(t, (slotTypeCount.get(t) ?? 0) + 1); }
      if (types.includes("writer_b")) nSoftSlots++;
    }
    if (hardHere) nWithHard++;
    if (top[0] && residualHard(exTypes.get(top[0].id) ?? []).length) nTopHard++;
    if (turn.ai_similarity != null) (hardHere ? simWith : simWithout).push(turn.ai_similarity);
    {
      const d = turn.ai_draft ?? "", sn = turn.sent_reply ?? "", cmx = turn.customer_message ?? "";
      const exOf = (t: GarbageType) => top.map((h) => exById.get(h.id)!).find((e) => (exTypes.get(e.id) ?? []).includes(t)) ?? null;
      const a = exOf("aix_turn"); bump("AIX の番の文（資料・候補日時）", !!a, !!aixTurnReason(d) && !aixTurnReason(sn), turn, a);
      const pa = exOf("post_apply"); bump("申込以降の語（審査・緊急連絡先・契約 等）", !!pa, POST_APPLY_WORD_RE.test(d) && !POST_APPLY_WORD_RE.test(sn) && !POST_APPLY_WORD_RE.test(cmx), turn, pa);
      const om = exOf("omatase"); bump("お待たせ", !!om, WAITED_RE.test(d) && !WAITED_RE.test(sn), turn, om);
    }
    // ③ 癖の伝染: 手本にあって・下書きに出て・実送信に無い
    const draft = turn.ai_draft ?? "", sent = turn.sent_reply ?? "";
    const feats: Array<[string, (s: string) => boolean]> = [
      ["お待たせ", (s) => WAITED_RE.test(s)],
      ["お客様呼び", (s) => fixSecondPersonOkyaku(s).changes.length > 0],
      ["従業員の書き方", (s) => writerFromText(s).writer === "employee"],
      ["AIX の番の文", (s) => !!aixTurnReason(s)],
    ];
    for (const [name, has] of feats) {
      if (!has(draft) || has(sent)) continue;
      if (name === "従業員の書き方" && writerFromText(sent).writer !== "takeuchi") continue;   // 実送信が竹内さんの書き方の番だけ
      const src = top.find((h) => has(h.sent_reply));
      if (src) harmed.push({ turn, feat: name, ex: exById.get(src.id)! });
    }
  }
  const avg = (a: number[]) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : "-";
  console.log(`  上位8件の枠 ${nSlots}・今も効く hard の手本 ${nHardSlots}（${(100 * nHardSlots / Math.max(1, nSlots)).toFixed(1)}%）・従業員の書き方 ${nSoftSlots}（${(100 * nSoftSlots / Math.max(1, nSlots)).toFixed(1)}%）`);
  console.log(`  hard を1件以上含む番 ${nWithHard}/${turns.length}・1位が hard の番 ${nTopHard}`);
  console.log(`  枠の hard の内訳: ${fmt(slotTypeCount, nHardSlots)}`);
  console.log(`  下書き→実送信の近さ（ai_similarity）: hard を含む番 ${avg(simWith)}（${simWith.length}）／含まない番 ${avg(simWithout)}（${simWithout.length}）`);

  console.log(`\n=== ③b さらしと下書きの型（上位8件にその型の手本がある番／無い番で、下書きに同じ型が出て実送信には無い率）===`);
  for (const [k, e] of Object.entries(expo)) {
    console.log(`  ${k}: さらし有り ${e.expHit}/${e.exp}（${(100 * e.expHit / Math.max(1, e.exp)).toFixed(1)}%）／無し ${e.noHit}/${e.no}（${(100 * e.noHit / Math.max(1, e.no)).toFixed(1)}%）`);
    for (const c of e.cases.slice(0, SHOW)) console.log(`    - ${c.turn.created_at.slice(0, 10)} ${c.turn.id.slice(0, 8)} 近さ ${c.turn.ai_similarity?.toFixed(2)}\n        お客様: ${one(c.turn.customer_message, 80)}\n        下書き: ${one(c.turn.ai_draft, 130)}\n        実送信: ${one(c.turn.sent_reply, 130)}\n        手本 ${c.ex?.id.slice(0, 8)}: ${one(c.ex?.sent_reply, 110)}`);
  }
  console.log(`\n=== ③ ゴミが質を下げた番（手本の癖が下書きに出て、実送信には無い）${harmed.length}件・番 ${new Set(harmed.map((h) => h.turn.id)).size} ===`);
  const byFeat = new Map<string, number>(); for (const h of harmed) byFeat.set(h.feat, (byFeat.get(h.feat) ?? 0) + 1);
  console.log("  " + [...byFeat.entries()].map(([k, v]) => `${k} ${v}`).join("・"));
  for (const h of harmed.slice(0, 30)) {
    console.log(`  - ${h.turn.created_at.slice(0, 10)} 番 ${h.turn.id.slice(0, 8)}（${h.feat}・近さ ${h.turn.ai_similarity?.toFixed(2)}）`);
    console.log(`      下書き: ${one(h.turn.ai_draft, 120)}`);
    console.log(`      実送信: ${one(h.turn.sent_reply, 120)}`);
    console.log(`      手本 ${h.ex.id.slice(0, 8)} ${h.ex.created_at.slice(0, 10)} ${h.ex.is_starred ? "⭐" : ""}: ${one(h.ex.sent_reply, 120)}`);
  }

  // ── ④ ナレッジの検索の再現（本番の問い）──
  const cache = await sb.from("embedding_cache").select("text_key, embedding, created_at").like("text_key", "[TPO:%").not("text_key", "like", "%YUMA%").order("created_at", { ascending: false }).limit(KQ);
  if (cache.error) throw cache.error;
  const knById = new Map(kns.map((k) => [k.id, k]));
  let qn = 0, slotsG = 0, hardG = 0, slotsB = 0, hardB = 0;
  const knSlotType = new Map<string, number>();
  for (const c of cache.data ?? []) {
    const tpo = (c.text_key as string).match(/^\[TPO:([^\]]+)\]/)?.[1] ?? null;
    const emb = JSON.stringify(c.embedding);
    const [g, b] = await Promise.all([
      sb.rpc("match_reply_knowledge", { query_embedding: emb, match_count: 100, min_importance: 7, boost_state: tpo }),
      sb.rpc("match_reply_knowledge", { query_embedding: emb, match_count: 12, min_importance: 8, boost_state: tpo }),
    ]);
    if (g.error || b.error) { console.warn("rpc", g.error?.message ?? b.error?.message); continue; }
    qn++;
    // 返信の経路: 類似度 0.5 以上・importance×類似度×鮮度で並べた上位（バケットの合計の上限 ≒ 40）
    const gr = ((g.data ?? []) as Array<{ id: string; similarity: number; importance: number; created_at: string; hypothesis_status: string | null }>)
      .filter((r) => r.similarity >= 0.5)
      .map((r) => ({ ...r, s: r.similarity * (r.importance / 10) * (0.5 + 0.5 * Math.pow(0.5, (Date.now() - Date.parse(r.created_at)) / 86400e3 / 180)) + (r.hypothesis_status === "confirmed" ? 0.05 : 0) }))
      .sort((a, b2) => b2.s - a.s).slice(0, 40);
    for (const r of gr) { slotsG++; const ty = knTypes.get(r.id) ?? []; const h = ty.filter((t) => KNOWLEDGE_HARD.has(t)); if (h.length) { hardG++; for (const t of h) knSlotType.set(t, (knSlotType.get(t) ?? 0) + 1); } }
    for (const r of (b.data ?? []) as Array<{ id: string }>) { slotsB++; if ((knTypes.get(r.id) ?? []).some((t) => KNOWLEDGE_HARD.has(t))) hardB++; }
  }
  void knById;
  console.log(`\n=== ④ ナレッジの検索の再現: 本番の問い ${qn}件 ===`);
  console.log(`  返信の経路（上位40）: 枠 ${slotsG}・hard ${hardG}（${(100 * hardG / Math.max(1, slotsG)).toFixed(1)}%）・内訳 ${fmt(knSlotType, hardG)}`);
  console.log(`  ブレインの今回の発言の層（上位12・importance≥8）: 枠 ${slotsB}・hard ${hardB}（${(100 * hardB / Math.max(1, slotsB)).toFixed(1)}%）`);
  console.log(`\n（${((Date.now() - t0) / 1000).toFixed(0)}秒・LLM・埋め込みの API は呼んでいない＝費用 $0）`);
}
main().catch((e) => { console.error(e); process.exit(1); });

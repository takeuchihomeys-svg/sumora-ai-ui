// scripts/staff-writer-knowledge-sql.ts — 従業員の直しから学んだ phrase・style のナレッジを整理する SQL を作る（DB は読むだけ・書くのは竹内さん）
//   2026-10-08 竹内「竹内のLINEか従業員のLINEかで考える方がかなり分析の質が変わる」「ナレッジどうするかとは？ よく使っている最善の方法でおこなう」
//   業界でよく使う形: 消さずに控えを取る → 書き方だけの行（表記・改行・語尾・定型の挨拶＝従業員の癖）は無効（rejected）→
//   中身（事実・手順・場面の対応）を含む行は残して表記を竹内さんの形に直す（決定論の置換 staff-writer.toTakeuchiNotation）→ 迷う物は残して印（needs_clarification）
//
//   対象: ai_reply_knowledge の category phrase／style・却下されていない行のうち、出所の例（source_example_id）を送ったのが従業員の行。
//     送った人は ①送った端末（--device=<jsonl>＝scripts/audit-staff-device-logs.ts --out、または messages.staff_writer の device／group_speaker）
//     ②無ければ下書きとの差（writerFromEdit・従業員の向きは端末で確かめて 95〜99%）
//   判定（decideKnowledge・純関数）:
//     invalid  … style の行（口調・絵文字・！の使い方の記述）／phrase で定型の言葉（ありがとうございます・かしこまりました・よろしくお願い…）しか無い行
//     unsure   … 「NG/OK構成」「理由：」の指示の形・お客様ごとの値（号室・金額・日付）が入った行 → 中身は触らず印だけ
//     rewrite  … 中身のある phrase で表記が竹内さんの形と違う行 → content を直す（embedding はそのまま＝表記だけの差で近さはほぼ変わらない）
//     keep     … 中身のある phrase で表記が既に竹内さんの形
//   出力: --out（既定 scripts/.replay-out/staff-writer-knowledge.sql）。控えの表 ai_reply_knowledge_writer_backup（全列＋判定＋新しい本文）と戻し方つき
//         --sample=<n> で判定ごとに n 件を画面に出す（目で読む抜き取り）
// 実行: npx tsx --env-file=.env.local scripts/staff-writer-knowledge-sql.ts [--device=<jsonl>] [--sample=20] [--out=...]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { writerFromEdit, toTakeuchiNotation } from "../app/lib/staff-writer";
import { coreOf, dice } from "../app/lib/text-diff-types";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OUT = arg("out", "scripts/.replay-out/staff-writer-knowledge.sql");
const DEVICE = arg("device", "");
const SAMPLE = Number(arg("sample", "0"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export type KnowledgeDecision = "invalid" | "unsure" | "rewrite" | "keep";
/** 定型の言葉（これだけで出来ている phrase は書き方だけ＝中身なし） */
const FORMULA = [
  "ありがとうございます", "ありがとうございました", "かしこまりました", "承知(?:致|いた)しました", "(?:何卒|引き続き)?(?:何卒)?よろしくお願い(?:致|いた)します",
  "お世話になっております", "はじめまして", "初めまして", "はい", "いいえ", "全然です", "お待たせ(?:致|いた)しました", "ご連絡(?:頂|いただ)きありがとうございます",
  "とんでもございません", "申し訳ございません", "失礼(?:致|いた)しました", "お疲れ様です", "こんにちは", "こんばんは", "おはようございます",
  "少々お待ちください", "いつでも", "お気軽に(?:ご連絡|ご相談|お知らせ)ください",
];
const FORMULA_RE = new RegExp(`(?:${FORMULA.join("|")})`, "g");
const stripCore = (s: string) => s.normalize("NFKC")
  .replace(/[〇○◯]{1,2}(?:さん|様)|[^\s、。！!？?]{1,12}(?:さん|様)(?=[、,\s！!]|$)/g, "")
  .replace(/[\p{Extended_Pictographic}\u{FE0F}\s！!？?。、,・…~〜ー「」『』（）()]/gu, "");

export function decideKnowledge(k: { category: string; content: string | null; title?: string | null }): { decision: KnowledgeDecision; newContent: string | null; reason: string } {
  const c = String(k.content ?? "");
  // 指示の形（NG/OK・理由・構成の札・「AIは」「〜すること」）＝ナレッジの書き手（AI）の指示文。中身が混ざるので迷う
  const meta = /NG構成|OK構成|NG[:：\s]|OK[:：\s]|理由[:：]|→|\[(?:情報提供|承認|次アクション|サポート姿勢|提案|共感)[^\]]*\]|AIは|すること[。、]/.test(c);
  // 呼び名と挨拶の行の分け方（従業員の形＝名前の後で改行）の決まりは書き方そのもの・竹内さんの形と逆 → 無効
  if (/(顧客名|お客様名|お名前|名前|呼びかけ|呼び名)[^。]{0,40}(改行|同一行|同じ行|別行|別の行|1行)|(改行|同一行|同じ行|別行)[^。]{0,40}(顧客名|お客様名|お名前|名前|呼びかけ|呼び名)/.test(c))
    return { decision: "invalid", newContent: null, reason: "呼び名の後の改行の決まり（従業員の書き方）" };
  if (k.category === "style") {
    if (meta) return { decision: "unsure", newContent: null, reason: "構成の指示の形（中身を含むかもしれない）" };
    return { decision: "invalid", newContent: null, reason: "口調・表記の記述（書き方だけ）" };
  }
  if (meta) return { decision: "unsure", newContent: null, reason: "NG/OK・理由の指示の形" };
  const rest = stripCore(c).replace(FORMULA_RE, "");
  if (rest.length < 4) return { decision: "invalid", newContent: null, reason: "定型の言葉だけ（書き方だけ）" };
  if (/号室|[¥￥]\s?\d|\d{1,3}[,，]\d{3}\s?円|\d+万円|\d{1,2}月\d{1,2}日|(?<![\d/])\d{1,2}\/\d{1,2}(?![\d/])/.test(c)) return { decision: "unsure", newContent: null, reason: "お客様ごとの値（号室・金額・日付）" };
  const n = toTakeuchiNotation(c);
  return n !== c ? { decision: "rewrite", newContent: n, reason: "表記を竹内さんの形に" } : { decision: "keep", newContent: null, reason: "表記は既に竹内さんの形" };
}

const q = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

async function main() {
  const kn: Array<{ id: string; category: string; title: string | null; hypothesis_status: string | null; source_example_id: string; content: string | null }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("ai_reply_knowledge").select("id, category, title, hypothesis_status, source_example_id, content").in("category", ["phrase", "style"]).not("source_example_id", "is", null).range(i, i + 999);
    if (error) throw new Error(error.message);
    kn.push(...((data ?? []) as typeof kn)); if ((data ?? []).length < 1000) break;
  }
  const live = kn.filter((k) => k.hypothesis_status !== "rejected");
  const ids = [...new Set(live.map((k) => k.source_example_id))];
  const ex = new Map<string, { id: string; conversation_id: string | null; sent_at: string | null; created_at: string; ai_draft: string | null; sent_reply: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("ai_reply_examples").select("id, conversation_id, sent_at, created_at, ai_draft, sent_reply").in("id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const e of (data ?? []) as Array<typeof ex extends Map<string, infer V> ? V : never>) ex.set(e.id, e);
  }
  // 送った端末: --device のファイル＋ messages.staff_writer（device／group_speaker）
  const devWriter = new Map<string, string>();
  if (DEVICE) for (const l of readFileSync(DEVICE, "utf8").split("\n").filter(Boolean)) { const o = JSON.parse(l); if (o.writer && o.confidence === "sure") devWriter.set(o.id, o.writer); }
  const convs = [...new Set([...ex.values()].map((e) => e.conversation_id).filter(Boolean) as string[])];
  const msgsBy = new Map<string, Array<{ id: string; at: number; core: string }>>();
  for (let i = 0; i < convs.length; i += 100) {
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, text, staff_writer, staff_writer_source, staff_writer_confidence").eq("sender", "staff").in("conversation_id", convs.slice(i, i + 100)).range(f, f + 999);
      if (error) throw new Error(error.message);
      for (const m of (data ?? []) as Array<{ id: string; conversation_id: string; created_at: string; text: string | null; staff_writer: string | null; staff_writer_source: string | null; staff_writer_confidence: string | null }>) {
        if (m.staff_writer && (m.staff_writer_source === "device" || m.staff_writer_source === "group_speaker") && m.staff_writer_confidence === "sure" && !devWriter.has(m.id)) devWriter.set(m.id, m.staff_writer);
        (msgsBy.get(m.conversation_id) ?? msgsBy.set(m.conversation_id, []).get(m.conversation_id)!).push({ id: m.id, at: Date.parse(m.created_at), core: coreOf(m.text ?? "") });
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  const writerOfExample = (e: NonNullable<ReturnType<typeof ex.get>>): { writer: string | null; how: string } => {
    const at = Date.parse(e.sent_at ?? e.created_at); const core = coreOf(e.sent_reply ?? "");
    let best: { id: string; d: number } | null = null;
    for (const m of msgsBy.get(e.conversation_id ?? "") ?? []) { if (Math.abs(m.at - at) > 30 * 60_000) continue; const d = dice(m.core, core); if (d >= 0.85 && (!best || d > best.d)) best = { id: m.id, d }; }
    if (best && devWriter.has(best.id)) return { writer: devWriter.get(best.id)!, how: "device" };
    const w = writerFromEdit(e.ai_draft, e.sent_reply);
    return { writer: w.writer, how: "edit" };
  };
  const exWriter = new Map<string, { writer: string | null; how: string }>();
  for (const e of ex.values()) exWriter.set(e.id, writerOfExample(e));
  // 下書きとの差の判定を端末で確かめる
  { let ok = 0, n = 0; const okBy = { employee: [0, 0], takeuchi: [0, 0] } as Record<string, number[]>;
    for (const e of ex.values()) { const w = exWriter.get(e.id)!; if (w.how !== "device") continue; const ed = writerFromEdit(e.ai_draft, e.sent_reply).writer; if (!ed) continue; n++; okBy[ed][1]++; if (ed === w.writer) { ok++; okBy[ed][0]++; } }
    console.log(`下書きとの差の判定 × 端末（出所の例）: 一致 ${ok}/${n}・従業員の向きの精度 ${okBy.employee[0]}/${okBy.employee[1]}・竹内さんの向き ${okBy.takeuchi[0]}/${okBy.takeuchi[1]}`); }

  const target = live.filter((k) => exWriter.get(k.source_example_id)?.writer === "employee");
  const hows = new Map<string, number>(); for (const k of target) { const h = exWriter.get(k.source_example_id)!.how; hows.set(h, (hows.get(h) ?? 0) + 1); }
  console.log(`phrase/style の生きている行 ${live.length}・出所が従業員 ${target.length}（${[...hows].map(([k, v]) => `${k === "device" ? "端末" : "下書きとの差"} ${v}`).join("・")}）`);
  const decided = target.map((k) => ({ k, ...decideKnowledge(k) }));
  const by = new Map<string, number>(); for (const d of decided) { const key = `${d.decision}|${d.k.category}|${d.k.hypothesis_status ?? "-"}`; by.set(key, (by.get(key) ?? 0) + 1); }
  for (const [k, v] of [...by].sort()) console.log(`  ${k.padEnd(32)} ${v}`);
  if (SAMPLE) for (const dec of ["invalid", "unsure", "rewrite", "keep"] as const) {
    const l = decided.filter((d) => d.decision === dec).sort(() => Math.random() - 0.5).slice(0, SAMPLE);
    console.log(`\n■ 抜き取り ${dec}（${decided.filter((d) => d.decision === dec).length}件中 ${l.length}）`);
    for (const d of l) console.log(`  - [${d.k.category}/${d.k.hypothesis_status}] ${d.reason}｜${String(d.k.content ?? "").replace(/\n/g, "⏎").slice(0, 150)}${d.newContent ? `\n      → ${d.newContent.replace(/\n/g, "⏎").slice(0, 150)}` : ""}`);
  }

  const values = decided.map((d) => `(${q(d.k.id)}::uuid, ${q(d.decision)}, ${q(d.newContent)}, ${q(d.reason)})`).join(",\n");
  const tag = "employee_style_20261008";
  const sql = `-- 従業員の直しから学んだ phrase・style のナレッジの整理（${new Date().toISOString().slice(0, 10)}・${decided.length}行・scripts/staff-writer-knowledge-sql.ts）
--   ${[...new Set(decided.map((d) => d.decision))].map((x) => `${x} ${decided.filter((d) => d.decision === x).length}`).join("・")}
BEGIN;
CREATE TABLE IF NOT EXISTS ai_reply_knowledge_writer_backup AS SELECT k.*, NULL::text AS decision, NULL::text AS new_content, NULL::text AS decision_reason, now() AS backed_up_at FROM ai_reply_knowledge k WHERE false;
CREATE TEMP TABLE _kn_writer_plan (id uuid PRIMARY KEY, decision text, new_content text, reason text) ON COMMIT DROP;
INSERT INTO _kn_writer_plan VALUES
${values || "(NULL, NULL, NULL, NULL)"};
-- ① 控え（全列＋判定）
INSERT INTO ai_reply_knowledge_writer_backup SELECT k.*, p.decision, p.new_content, p.reason, now() FROM ai_reply_knowledge k JOIN _kn_writer_plan p ON p.id = k.id;
-- ② 書き方だけの行は無効
UPDATE ai_reply_knowledge k SET hypothesis_status = 'rejected', rejection_reason = '${tag}' FROM _kn_writer_plan p WHERE p.id = k.id AND p.decision = 'invalid';
-- ③ 中身のある行は表記を竹内さんの形に（embedding は表記だけの差なのでそのまま）
UPDATE ai_reply_knowledge k SET content = p.new_content FROM _kn_writer_plan p WHERE p.id = k.id AND p.decision = 'rewrite';
-- ④ 迷う行は残して印（ナレッジの確認の画面 ?mode=ambiguous に出る）
UPDATE ai_reply_knowledge k SET needs_clarification = true FROM _kn_writer_plan p WHERE p.id = k.id AND p.decision = 'unsure';
COMMIT;
-- 戻す（控えから・この整理の分だけ）:
-- UPDATE ai_reply_knowledge k SET hypothesis_status = b.hypothesis_status, rejection_reason = b.rejection_reason, content = b.content, needs_clarification = b.needs_clarification
--   FROM ai_reply_knowledge_writer_backup b WHERE b.id = k.id AND b.backed_up_at = (SELECT max(backed_up_at) FROM ai_reply_knowledge_writer_backup);
`;
  mkdirSync(OUT.replace(/[\\/][^\\/]*$/, "") || ".", { recursive: true });
  writeFileSync(OUT, sql);
  console.log(`\n書き出し ${OUT}（${Math.round(sql.length / 1024)}KB）`);
}
main().catch((e) => { console.error(e); process.exit(1); });

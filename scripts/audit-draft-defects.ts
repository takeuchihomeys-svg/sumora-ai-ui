// スタッフが大きく直した下書きを全部読んで、AI が間違えた型を洗い出す（読み取りのみ）
//
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
// 設計知見「開口語がぶれる根本は…**生成文と実送信の差分が正解データ**」
// 設計知見「【汎用・型】1通の変な文から DB 全体の穴へ広げる — 『この会話だけの話か』を必ず件数で確かめる」
//
// ai_reply_examples は AI の下書き（ai_draft）とスタッフが実際に送った文（sent_reply）を並べて持つ。
// was_ai_used=false / ai_similarity が低い ＝ **AI が間違えてスタッフが直した**の記録。
// ここに AI の失敗の型が全部入っている。既知の対策で落ちるものと、まだ誰も見ていないものを分ける。
import { createClient } from "@supabase/supabase-js";
import { isNotACustomerReply } from "../app/lib/meta-narration";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const DAYS = Number(process.env.DAYS ?? 120);
const SHOW = Number(process.env.SHOW ?? 60);

/** 既知の失敗の型（対策済みかどうかを注記する）。順番に当てて最初に当たったものを採る */
const DEFECTS: Array<{ id: string; note: string; re?: RegExp; fn?: (d: string, s: string) => boolean }> = [
  { id: "メタ文（AIの作業メモ）", note: "対策済: meta-narration isNotACustomerReply", fn: (d) => isNotACustomerReply(d) },
  { id: "プレースホルダ未置換（〇〇さん）", note: "対策済: fixNamePlaceholder（カバーレターのみ）", re: /[〇○]{2,}\s*(?:さん|様)/ },
  { id: "プレースホルダ未置換（{…}）", note: "**未対策**: トークンが展開されずに本文へ", re: /\{(?:name|object|fix|redo|viewingOffer|namedProperty|ledger)\}/ },
  { id: "見出しの写し（【…】の指示語）", note: "対策済: sanitizeCoverLetter", re: /【(?:お客様に送る文|お客様名|お客様の現在の状況|返信文|出力)/ },
  { id: "申込の捏造", note: "2026-09-20 まりあ事例で入口を直した", re: /お?申込(?:み)?(?:情報|書類|内容)[^\n。！!]{0,10}(?:受け取り|受領|拝受|確かに)/ },
  { id: "内覧の捏造（行っていない内覧のお礼）", note: "対策済: 内覧の鮮度14日", re: /本日は?ご?内覧[^\n。！!]{0,8}(?:ありがとう|有難う)/ },
  { id: "金額の創作（下書きだけに金額）", note: "対策済: 入口＋出口（見積）", fn: (d, s) => /[0-9０-９,，]{4,}円/.test(d) && !/[0-9０-９,，]{4,}円/.test(s) },
  { id: "物件名の創作（下書きだけに【物件名】）", note: "竹内方針2: 本文に物件名を出さない", fn: (d, s) => /【[^】]{3,}】/.test(d) && !/【[^】]{3,}】/.test(s) },
  { id: "決まっている内覧に新しい日程を打診", note: "2026-09-20 まりあ事例で直した", re: /ご都合(?:の)?よろしい(?:お日にち|日)/ },
  { id: "「お待たせ致しました」", note: "対策済: 全廃（竹内）", re: /お待たせ(?:致しました|しました|いたしました)/ },
  { id: "スタッフ名をお客様の呼称に", note: "対策済: sanitizeCoverLetter（カバーレターのみ）", re: /^(?:鈴木|田中|竹内|宮下|江籠|竹田)さん(?:お世話|こんにちは)/ },
  { id: "会社名の名乗り", note: "対策済: sanitizeCoverLetter（カバーレターのみ）", re: /(?:ギガ賃貸|イエヤス)(?:です|でございます)/ },
  { id: "敬称の二重", note: "対策済: 敬称を外してから付け直す", re: /さん\s*さん|様\s*様/ },
  { id: "極端に短い（3文字以下）", note: "対策済: sanitizeCoverLetter（カバーレターのみ）", fn: (d) => d.trim().length <= 3 },
];

function classify(draft: string, sent: string): { id: string; note: string } | null {
  for (const d of DEFECTS) {
    if (d.fn ? d.fn(draft, sent) : d.re!.test(draft)) return { id: d.id, note: d.note };
  }
  return null;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 12; p++) {
    const { data } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, customer_message, ai_draft, sent_reply, was_ai_used, was_ai_modified, ai_similarity, conversation_state, aix_action, created_at")
      .gte("created_at", since)
      .not("ai_draft", "is", null)
      .order("created_at", { ascending: false })
      .range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  const usable = rows.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim()
    && String(r.ai_draft) !== "__SHOWN__");
  console.log(`=== 直近${DAYS}日の下書き ${rows.length}件（下書きと実送信が両方ある ${usable.length}件）===`);

  const used = usable.filter((r) => r.was_ai_used === true).length;
  const sims = usable.map((r) => Number(r.ai_similarity ?? NaN)).filter(Number.isFinite).sort((a, b) => a - b);
  const med = sims.length ? sims[Math.floor(sims.length / 2)] : NaN;
  console.log(`  そのまま送信: ${used}件（${((used / usable.length) * 100).toFixed(1)}%）／似ている度の中央値: ${med.toFixed(3)}`);

  // ── 大きく直されたもの（似ている度が低い）＝ AI が間違えた ──
  const rewritten = usable
    .filter((r) => Number.isFinite(Number(r.ai_similarity)) && Number(r.ai_similarity) < 0.5 && r.was_ai_used !== true)
    .sort((a, b) => Number(a.ai_similarity) - Number(b.ai_similarity));
  console.log(`\n=== 大きく書き直された下書き（似ている度 < 0.5）: ${rewritten.length}件 ===`);

  // ── 既知の型に分類 ──
  const byDefect = new Map<string, Array<Record<string, unknown>>>();
  const unknown: Array<Record<string, unknown>> = [];
  for (const r of rewritten) {
    const c = classify(String(r.ai_draft), String(r.sent_reply));
    if (c) { if (!byDefect.has(c.id)) byDefect.set(c.id, []); byDefect.get(c.id)!.push(r); }
    else unknown.push(r);
  }
  console.log(`\n--- 既知の型に当たったもの ---`);
  for (const [id, list] of [...byDefect.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const note = DEFECTS.find((d) => d.id === id)?.note ?? "";
    console.log(`  ${String(list.length).padStart(3)}件  ${id}  （${note}）`);
  }
  console.log(`  ${String(unknown.length).padStart(3)}件  **どの型にも当たらない（未知）**`);

  // ── 全件（大きく直されたもの以外も含む）で既知の型がどれだけ出るか ──
  console.log(`\n=== 下書き全 ${usable.length}件 に既知の型を当てる（送信されたものも含む）===`);
  for (const d of DEFECTS) {
    const hit = usable.filter((r) => (d.fn ? d.fn(String(r.ai_draft), String(r.sent_reply)) : d.re!.test(String(r.ai_draft))));
    const sentToo = hit.filter((r) => d.fn ? d.fn(String(r.sent_reply), String(r.sent_reply)) : d.re!.test(String(r.sent_reply)));
    if (hit.length === 0) continue;
    console.log(`  下書き${String(hit.length).padStart(3)}件 / 実送信にも${String(sentToo.length).padStart(3)}件  ${d.id}`);
    if (hit.length > sentToo.length) {
      const ex = hit.find((r) => !(d.fn ? d.fn(String(r.sent_reply), String(r.sent_reply)) : d.re!.test(String(r.sent_reply))));
      if (ex) console.log(`      例: ${String(ex.ai_draft).replace(/\n/g, " ").slice(0, 88)}`);
    }
  }

  // ── 未知のものを目で読む（件数だけ見ない）──
  console.log(`\n=== どの型にも当たらない書き直し ${unknown.length}件 のうち先頭 ${Math.min(SHOW, unknown.length)}件 ===`);
  for (const r of unknown.slice(0, SHOW)) {
    console.log(`\n[${String(r.created_at).slice(5, 16)} ${r.conversation_state} ${r.aix_action ?? "-"} 似=${Number(r.ai_similarity).toFixed(2)}]`);
    console.log(`  客  : ${String(r.customer_message ?? "").replace(/\n/g, " ").slice(0, 78)}`);
    console.log(`  AI  : ${String(r.ai_draft).replace(/\n/g, " ").slice(0, 150)}`);
    console.log(`  正解: ${String(r.sent_reply).replace(/\n/g, " ").slice(0, 150)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

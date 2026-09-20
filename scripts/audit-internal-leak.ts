// 本文に入ってはいけない「内部のデータ」が下書き・実送信に漏れていないか（読み取りのみ）
//
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
// scripts/audit-draft-defects.ts で3つの危険な型が見えたので、実送信まで含めて全件で数える。
//   ① <<<FINAL_CHECK:{...}  … 生成が本文の後ろに付けるトレーラー（検査結果の JSON）
//   ② （AI返信の生成に失敗しました…） … 生成失敗の文言
//   ③ 【⚠️センシティブ案件…】 … スタッフ向けの注記
// 出口（本文の書き換え）を入れてよいのは「実送信に0通」＝**誤削除0**が言える時だけ。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** お客様の目に入ってはいけないもの（本文に1文字も出てはいけない） */
const LEAKS: Array<{ id: string; re: RegExp }> = [
  { id: "検査トレーラー <<<FINAL_CHECK", re: /<<<\s*FINAL_CHECK/i },
  { id: "その他の <<< トレーラー", re: /<<<[A-Z_]{3,}/ },
  { id: "生成失敗の文言", re: /生成に失敗|再生成をお試し|エラーが発生しました/ },
  { id: "スタッフ向けの注記（⚠️センシティブ等）", re: /【?⚠️?(?:センシティブ|注意|要確認)[^】\n]{0,40}】?/ },
  { id: "「送信前に必ず手動確認」", re: /送信前に必ず|手動確認|参考のみ/ },
  { id: "プロンプトの見出しの写し", re: /【(?:お客様に送る文|お客様名|お客様の現在の状況|返信文|出力|指示|条件)】/ },
  { id: "JSON の断片", re: /\{"(?:ok|issues|severity|code|tpo_|revision)/ },
  { id: "トークン未展開 {…}", re: /\{(?:name|object|fix|redo|viewingOffer|namedProperty|ledger|positiveEvidence|pickupRoundNote|sentNames)\}/ },
  { id: "プレースホルダ 〇〇さん/○○さん", re: /[〇○]{2,}\s*(?:さん|様|サン)/ },
  { id: "AIX の内部ラベル [AIX…]", re: /\[AIX[^\]]{0,12}\]/ },
  { id: "敬称の二重（さんさん・様様）", re: /さんさん|様様|さん\s+さん/ },
  { id: "マークダウンの強調（**）", re: /\*\*[^*\n]{1,40}\*\*/ },
  { id: "英語の指示文", re: /\b(?:I (?:will|cannot|should)|As an AI|Here (?:is|are) the)\b/i },
];

async function scan(table: "messages" | "ai_reply_examples", col: string, days: number) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const texts: Array<{ t: string; at: string; conv: string }> = [];
  for (let p = 0; p < 16; p++) {
    let q = sb.from(table).select(`${col}, created_at, conversation_id`).gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (table === "messages") q = sb.from(table).select(`${col}, created_at, conversation_id`).eq("sender", "staff")
      .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const { data, error } = await q;
    if (error) { console.log(`⚠ ${table}.${col}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    for (const x of r) {
      const t = String(x[col] ?? "");
      if (t && t !== "__SHOWN__") texts.push({ t, at: String(x.created_at), conv: String(x.conversation_id ?? "") });
    }
    if (r.length < 1000) break;
  }
  return texts;
}

async function main() {
  const days = Number(process.env.DAYS ?? 365);
  console.log(`=== 直近${days}日 ===\n`);
  const sent = await scan("messages", "text", days);
  const draft = await scan("ai_reply_examples", "ai_draft", days);
  console.log(`実送信(messages.staff): ${sent.length}通 ／ 下書き(ai_draft): ${draft.length}件\n`);

  console.log(`${"型".padEnd(34)} 実送信 / 下書き   判定`);
  console.log("─".repeat(74));
  for (const l of LEAKS) {
    const s = sent.filter((x) => l.re.test(x.t));
    const d = draft.filter((x) => l.re.test(x.t));
    if (s.length === 0 && d.length === 0) continue;
    const verdict = s.length === 0 ? "🟢 実送信0 → 出口を入れてよい" : `🔴 実送信にも出る（誤削除の危険）`;
    console.log(`${l.id.padEnd(34)} ${String(s.length).padStart(5)} / ${String(d.length).padStart(5)}   ${verdict}`);
    for (const x of s.slice(0, 3)) console.log(`      [実送信 ${x.at.slice(5, 16)}] ${x.t.replace(/\n/g, " ").slice(0, 96)}`);
    for (const x of d.slice(0, 2)) console.log(`      [下書き ${x.at.slice(5, 16)}] ${x.t.replace(/\n/g, " ").slice(0, 96)}`);
    console.log("");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

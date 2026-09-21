// 下書きに「『お客様の文』への返信です。」のような**作業メモ行**が混ざっていないか（読み取りのみ）
//
// 2026-09-21: 引用画像のテスト中、下書きが
//   「かしこまりました😊！！／「こちらもう少し初期費用抑えられませんか？」への返信です。／---／はい！！…」
//   になった。作業メモの除去（stripMetaNarration）は**先頭の地の文**しか見ないので、
//   1行目がお客様への文だとこの行は残る（実際に stripInternalTags を通しても残った）。
//   → 本当に本番で起きているのかを数える（件数が0なら触らない・出口は誤削除0でなければ入れない）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-reply-restate.ts [--days=180]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").split("=")[1]);
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

/** 作業メモの形（お客様の文を引用して「〜への返信です」「返信案」と書く・区切り線だけの行） */
const RESTATE_RE = /^[ \t]*(?:「[^」\n]{4,60}」)?へ?の?(?:返信|返答|回答)(?:案|文)?(?:です|となります|を作成|を生成)[。．]?[ \t]*$/m;
const SEPARATOR_RE = /^[ \t]*-{3,}[ \t]*$/m;

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Array<{ ai_draft: string | null; sent_reply: string | null; created_at: string }> = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("ai_draft, sent_reply, created_at").gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  const drafts = rows.filter((r) => (r.ai_draft ?? "").trim());
  const sents = rows.filter((r) => (r.sent_reply ?? "").trim());
  const hitD = drafts.filter((r) => RESTATE_RE.test(r.ai_draft ?? ""));
  const hitS = sents.filter((r) => RESTATE_RE.test(r.sent_reply ?? ""));
  const sepD = drafts.filter((r) => SEPARATOR_RE.test(r.ai_draft ?? ""));
  const sepS = sents.filter((r) => SEPARATOR_RE.test(r.sent_reply ?? ""));
  console.log(`=== 直近${DAYS}日 ${rows.length}件（下書き ${drafts.length} / 実送信 ${sents.length}）===`);
  console.log(`「〜への返信です」型 : 下書き ${hitD.length}件 ／ 実送信 ${hitS.length}件`);
  console.log(`区切り線だけの行     : 下書き ${sepD.length}件 ／ 実送信 ${sepS.length}件`);
  for (const r of [...hitD, ...sepD].slice(0, 12)) {
    console.log(`\n── ${r.created_at.slice(0, 16)}`);
    console.log(mask(String(r.ai_draft ?? "")).split("\n").slice(0, 6).map((l) => `   ${l}`).join("\n"));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

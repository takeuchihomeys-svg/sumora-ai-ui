// scripts/audit-not-a-reply.ts
// 「お客様への返信になっていない文（社内への確認・報告）」の判定を、本番の
//   ① スタッフ実送信（誤削除が無いか）
//   ② 今ある下書き ai_draft（入力欄に出ている物）
// の両方に当てて数える。
//
// 2026-09-18 竹内「たまに生成するときに勝手にでてくる社内への確認みたいな文は絶対に送らないように。
//   またあの文テキストボックスにはいらないように根本的なとこ改善して」の実装時に作成。
// 判定（app/lib/meta-narration.ts の isNotACustomerReply）を変えたら必ず流す。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-not-a-reply.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { isNotACustomerReply } from "../app/lib/meta-narration";
import { draftToSendableText } from "../app/lib/draft-text";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 365);

async function main() {
  // ① スタッフ実送信に当てる（ここで引っかかる＝誤削除の恐れ。中身を目で確かめる）
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const sent: Array<{ text: string; created_at: string }> = [];
  for (let page = 0; page < 40; page++) {
    const { data, error } = await sb
      .from("messages").select("text, created_at")
      .neq("sender", "customer").gte("created_at", since).not("text", "is", null)
      .order("created_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    if (!data?.length) break;
    sent.push(...(data as typeof sent));
    if (data.length < 1000) break;
  }
  const sentHits = sent.filter((m) => isNotACustomerReply(m.text));
  console.log(`① スタッフ実送信 ${sent.length} 通（直近 ${DAYS} 日）→ 引っかかった ${sentHits.length} 通`);
  for (const h of sentHits) {
    console.log(`   ${new Date(h.created_at).toLocaleDateString("ja-JP")}  ${h.text.replace(/\n/g, " ").slice(0, 100)}`);
  }
  console.log("   ※ ここに「本物のお客様への文」が出たら判定が広すぎる。0 か、社内文が誤送された分だけが正常\n");

  // ② 今ある下書き（入力欄に出ている物）
  const { data: drafts, error: dErr } = await sb
    .from("conversations").select("customer_name, ai_draft, updated_at")
    .not("ai_draft", "is", null).limit(1000);
  if (dErr) throw dErr;
  const rows = (drafts ?? []) as Array<{ customer_name: string; ai_draft: string; updated_at: string }>;
  const blocked = rows.filter((r) => draftToSendableText(r.ai_draft) === null && !["[AIX誘導中]", "__SHOWN__", "[画像のみ]"].includes(r.ai_draft.trim()));
  console.log(`② 今ある下書き ${rows.length} 件 → 本文として使わない ${blocked.length} 件`);
  for (const b of blocked) {
    console.log(`   【${b.customer_name}】${b.ai_draft.replace(/\n/g, " ").slice(0, 110)}`);
  }
  console.log("   ※ ここに出た下書きは、入力欄に出ず自動返信もされない\n");

  // ③ 過去の AI 下書きに当てて「何が消えるか」を見る（下調べのメモが混ざっていた分）
  const { data: hist, error: hErr } = await sb
    .from("ai_reply_examples").select("ai_draft, created_at")
    .not("ai_draft", "is", null).gte("created_at", since).limit(3000);
  if (hErr) throw hErr;
  const hRows = (hist ?? []) as Array<{ ai_draft: string; created_at: string }>;
  let changed = 0, dropped = 0;
  const samples: string[] = [];
  for (const h of hRows) {
    const raw = h.ai_draft.trim();
    if (!raw || ["[AIX誘導中]", "__SHOWN__", "[画像のみ]"].includes(raw)) continue;
    const out = draftToSendableText(raw);
    if (out === null) { dropped++; continue; }
    if (out !== raw) {
      changed++;
      // 行単位で「消えた行」だけを出す（文字列の差分だと ** を外しただけでも全文が出てしまい、
      //   本物の誤削除と見分けが付かない）
      const kept = new Set(out.split("\n").map((s) => s.trim()));
      const gone = raw.split("\n").map((s) => s.trim()).filter(Boolean)
        .filter((l) => !kept.has(l) && !kept.has(l.replace(/\*\*/g, "")));
      if (gone.length && samples.length < 8) {
        samples.push(`${new Date(h.created_at).toLocaleDateString("ja-JP")}  消えた行: ${gone.join(" ／ ").slice(0, 130)}`);
      }
    }
  }
  console.log(`③ 過去の AI 下書き ${hRows.length} 件 → 丸ごと使わない ${dropped} 件 / 一部を削る ${changed} 件`);
  for (const s of samples) console.log("   " + s);
  console.log("   ※ 消えた分に「お客様への文」が混ざっていないか目で確かめる");
}

main().catch((e) => { console.error(e); process.exit(1); });

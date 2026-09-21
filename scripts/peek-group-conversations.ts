// LINE グループから来た会話が今どう保存されているか（読み取りのみ）
//
// 2026-09-21 竹内「これLINEのグループやから、LINEのグループでも送れるように対応する。
//   ちゃんと個人とLINEのグループ分けて認識できるようにもする。
//   LINEのグループにおくるはずが個人のLINEにおくらないように」
//
// 見たいこと:
//   ① conversations.line_user_id は U（個人）か C（グループ）か R（トークルーム）か
//   ② 名前が取れていない会話（「名称未設定」）はどれくらいあるか
//   ③ 直近に作られた会話の中身（スクショの「黒明様お部屋探し」がどう入ったか）
//
// 実行: npx tsx --env-file=.env.local scripts/peek-group-conversations.ts [--days=7]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=7").split("=")[1]);
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

type Conv = { id: string; customer_name: string | null; line_user_id: string | null; account: string | null; status: string | null; created_at: string; updated_at: string; last_message: string | null };

async function main() {
  const rows: Conv[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("conversations")
      .select("id, customer_name, line_user_id, account, status, created_at, updated_at, last_message")
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as Conv[]; rows.push(...r); if (r.length < 1000) break;
  }
  const head = (s: string | null) => (s ?? "").slice(0, 1);
  const byPrefix = new Map<string, number>();
  for (const c of rows) byPrefix.set(head(c.line_user_id) || "(空)", (byPrefix.get(head(c.line_user_id) || "(空)") ?? 0) + 1);
  console.log(`=== conversations ${rows.length}件 の line_user_id の先頭文字 ===`);
  for (const [k, v] of [...byPrefix].sort((a, b) => b[1] - a[1])) {
    const label = k === "U" ? "個人（U）" : k === "C" ? "グループ（C）" : k === "R" ? "トークルーム（R）" : k;
    console.log(`  ${label}: ${v}`);
  }
  const noName = rows.filter((c) => !(c.customer_name ?? "").trim() || /^名称未設定$/.test(c.customer_name ?? ""));
  console.log(`\n名前が空・名称未設定の会話: ${noName.length}件（うち直近${DAYS}日 ${noName.filter((c) => Date.parse(c.created_at) > Date.now() - DAYS * 86400_000).length}件）`);

  const since = Date.now() - DAYS * 86400_000;
  const recent = rows.filter((c) => Date.parse(c.created_at) > since);
  console.log(`\n=== 直近${DAYS}日に作られた会話 ${recent.length}件 ===`);
  for (const c of recent.slice(0, 20)) {
    console.log(`${c.created_at.slice(0, 16)} ${(c.line_user_id ?? "").slice(0, 5)}… acct=${c.account} status=${c.status}`);
    console.log(`   名前: ${c.customer_name ?? "(なし)"} ／ 最後: ${mask(String(c.last_message ?? "")).replace(/\n/g, " ").slice(0, 50)}`);
  }

  // line_contacts 側も見る
  const { data: lc, error: lcErr } = await sb.from("line_contacts")
    .select("line_user_id, account, line_name, last_message_at").order("last_message_at", { ascending: false }).limit(1000);
  if (lcErr) { console.log("⚠ line_contacts:", lcErr.message); return; }
  const contacts = (lc ?? []) as Array<{ line_user_id: string; line_name: string | null }>;
  const cPrefix = new Map<string, number>();
  for (const r of contacts) cPrefix.set(r.line_user_id.slice(0, 1), (cPrefix.get(r.line_user_id.slice(0, 1)) ?? 0) + 1);
  console.log(`\n=== line_contacts 直近1000件の先頭文字 ===`);
  for (const [k, v] of cPrefix) console.log(`  ${k}: ${v}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

// 内覧が終わった後の返信に「明日お会い出来るのを楽しみに」が出た件の材料を再現する（読み取りのみ）
//
// 2026-09-21 竹内（まりあさん事例）「なんでここ明日会えるの楽しみ等今の分からない文がでているのか。
//   ブレインの部分は判断できている。ブレインと文生成の部分にズレが起きている」
//
// 実物: 9/20 22:33 こちら「明日16:00に…現地エントランスお待ち合わせ」→ 9/21 16:00 内覧
//       → 20:13 こちら「本日お時間頂きありがとうございました」→ 21:15 お客様「母に聞いてみます！」
//       → 下書き「はい😊！！明日お会い出来るのを楽しみにしております！！お気をつけてお越しください😌！！」
//
// 行動台帳（生成に「確定事実」として入る）を、生成した時刻で組み立て直して中身を見る。
// 実行: npx tsx --env-file=.env.local scripts/peek-viewing-ledger.ts [--id=<conversation_id>] [--at=<ISO>]
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger, buildActionLedgerNote } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const ID = arg("id", "b50fd451-2393-4826-b61f-34db7aefa55d");
const AT = arg("at", "2026-09-21T12:16:00Z");

async function main() {
  const now = Date.parse(AT);
  const { data } = await sb.from("messages").select("sender, text, created_at, is_aix_generated")
    .eq("conversation_id", ID).lte("created_at", AT).order("created_at", { ascending: false }).limit(25);
  const msgs = ((data ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>).reverse();
  const ledger = buildActionLedger({
    recentAixRows: [],
    messages: msgs.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated, lineMessageId: null })),
    lastCustomerAt: [...msgs].reverse().find((m) => m.sender === "customer")?.created_at ?? null,
    now,
  } as Parameters<typeof buildActionLedger>[0]);
  console.log(`=== 生成時刻 ${AT} の台帳 ===`);
  console.log(`viewingAppointment: ${JSON.stringify(ledger.facts.viewingAppointment)}`);
  console.log(`meetingPlaceSent: ${ledger.facts.meetingPlaceSent}`);
  console.log(`\n── 生成に入る台帳の文 ──`);
  console.log(buildActionLedgerNote(ledger, { customerName: "〈お客様〉" }));
}
main().catch((e) => { console.error(e); process.exit(1); });

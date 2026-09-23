// 調査専用（読み取りのみ）: 「募集出次第お送りします」型のピックアップ約束が
//   ①行動台帳で watch=false になる件数 ②その後スタッフが実際に押した AIX
//   ③約束の後にお客様が非依頼の返信をした時、スタッフが次に何をしたか
import { createClient } from "@supabase/supabase-js";
import { classifyStaffTextForLedger, isPropertyWatchDeclaration } from "../app/lib/action-ledger";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);

// 「出次第お送り」型（確認の語なし）
const SEND_WHEN_FOUND = /(?:新着|募集|条件に合|オススメ|おすすめ)[^\n]{0,40}(?:出|見つかり|募集出)次第[^\n]{0,20}(?:お送り|ご連絡|ご紹介)/;

async function main() {
  const since = new Date(Date.now() - 365 * 864e5).toISOString();
  const rows: { id: string; conversation_id: string; created_at: string; text: string }[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("messages")
      .select("id,conversation_id,created_at,text")
      .eq("sender", "staff").gte("created_at", since)
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as never[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`スタッフ送信 ${rows.length} 通（365日）`);

  const hits = rows.filter((r) => r.text && SEND_WHEN_FOUND.test(r.text));
  let watchTrue = 0, watchFalse = 0;
  const falseIds: typeof hits = [];
  for (const h of hits) {
    const e = classifyStaffTextForLedger(h.text, h.created_at);
    const isPickup = e?.kind === "pickup_declared";
    const w = e?.detail?.watch === true;
    if (!isPickup) continue;
    if (w) watchTrue++; else { watchFalse++; falseIds.push(h); }
  }
  console.log(`\n「出次第お送り」型 ${hits.length} 通 / うち pickup_declared ${watchTrue + watchFalse} 通`);
  console.log(`  watch=true（慶次ルールが拾う）: ${watchTrue}`);
  console.log(`  watch=false（今のルールで落ちる）: ${watchFalse}  ← 次第 で AIX が出ない`);

  // その後スタッフが押した AIX（14日以内で最初の1件）
  const convIds = [...new Set(falseIds.map((r) => r.conversation_id))];
  const { data: aix } = await sb.from("aix_usage_logs")
    .select("conversation_id,aix_type,created_at").in("conversation_id", convIds).gte("created_at", since)
    .order("created_at", { ascending: true });
  const counts: Record<string, number> = {};
  let noneAfter = 0;
  for (const h of falseIds) {
    const t0 = Date.parse(h.created_at);
    const next = (aix ?? []).find((a: { conversation_id: string; created_at: string }) =>
      a.conversation_id === h.conversation_id && Date.parse(a.created_at) > t0 && Date.parse(a.created_at) - t0 < 14 * 864e5);
    if (!next) { noneAfter++; continue; }
    const k = (next as { aix_type: string }).aix_type;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  console.log(`\n約束の後 14日以内に最初に押した AIX（watch=false の ${falseIds.length} 件）:`);
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`  （AIX なし: ${noneAfter}）`);

  console.log(`\n実物（先頭8件の本文・watch=false）:`);
  falseIds.slice(0, 8).forEach((h) => console.log(`  - ${h.created_at.slice(0, 10)} ${h.text.replace(/\n/g, " / ").slice(0, 90)}`));

  // 確認の語を含む物（慶次型）との違いを確認
  console.log(`\nisPropertyWatchDeclaration の内訳（watch=false の文に 確認/お調べ/チェック があるか）:`);
  const withKakunin = falseIds.filter((h) => /確認|お調べ|チェック/.test(h.text)).length;
  console.log(`  確認の語あり: ${withKakunin} / なし: ${falseIds.length - withKakunin}`);
  console.log(`  ※ isPropertyWatchDeclaration は「1文の中に 目的語＋印＋確認の語」を全て要求する`);
  console.log(`  サンプル判定: ${isPropertyWatchDeclaration("新着であっぴさんにオススメ出来るお部屋募集出次第お送りさせて頂きます")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

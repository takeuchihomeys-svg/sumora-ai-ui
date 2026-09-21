// 「完全に締まっていたら下書きを作らない」が、実データで何件止まるかを測る（読み取りのみ）
//
// 2026-09-21 竹内「文締めることなくて完全にしまってたら返信しなくて大丈夫」
//
// 設計知見「全件監査（過去の実送信に当てて、変換の前後を目で読む。件数だけ見ない）」。
//   ここで止めるのは**下書きを作ること**だけなので、外してもお客様に変な文は飛ばない。
//   それでも「止めた場面でスタッフが実際には返信していた」割合は知っておく（＝見落とす手間）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-skip-draft.ts
import { createClient } from "@supabase/supabase-js";
import { shouldSkipDraftAfterClosing } from "../app/lib/previous-send-note";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉").replace(/\n/g, " ／ ");

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const msgs = await page("messages", "conversation_id, sender, text, created_at", "created_at", days);
  console.log(`=== 材料: messages ${msgs.length}件（直近${days}日）===\n`);

  // 申込以降は元々 bg-async が下書きを作らない（BG_ASYNC_SKIP_STATUSES）。
  //   この判定の効果を測る時に混ぜると「止めたのにスタッフは返信していた」が水増しされる。
  const SKIP_STATUSES = new Set(["applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost", "lost"]);
  const convRows = await page("conversations", "id, status", "created_at", 3650);
  const statusOf = new Map<string, string>();
  for (const c of convRows) statusOf.set(String(c.id), String(c.status ?? ""));

  const byConv = new Map<string, Array<{ sender: string; text: string; at: number }>>();
  for (const m of msgs) {
    const cid = String(m.conversation_id ?? ""); const t = String(m.text ?? "").trim();
    if (!cid || !t) continue;
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push({ sender: String(m.sender ?? ""), text: t, at: new Date(String(m.created_at)).getTime() });
  }
  for (const a of byConv.values()) a.sort((x, y) => x.at - y.at);

  // お客様の発言のたびに判定する（＝本番で下書きを作るかどうかを決める瞬間と同じ）
  let turns = 0, skipped = 0, skippedButReplied = 0, skippedAndSilent = 0;
  const reasons = new Map<string, number>();
  const samples: string[] = [];
  const missed: string[] = [];
  // 「その了承への返信」と言えるのは短い窓だけ。6時間後の連絡は別の用件（道が混んでいる・書類の依頼）で、
  //   下書きを作らなかったこととは関係がない。
  const HOURS = Number(process.env.REPLY_WINDOW_HOURS ?? 3);
  const now = Date.now();

  for (const [cid, arr] of byConv) {
    if (SKIP_STATUSES.has(statusOf.get(cid) ?? "")) continue;   // 元々下書きを作らない会話
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].sender !== "customer") continue;
      // 直前のスタッフ送信（スプリット送信は結合）
      let j = i - 1;
      if (arr[j].sender !== "staff") continue;
      const parts: string[] = [];
      while (j >= 0 && arr[j].sender === "staff" && (parts.length === 0 || arr[j + 1].at - arr[j].at < 180_000)) {
        parts.unshift(arr[j].text); j--;
      }
      const prev = parts.join("\n");
      // お客様の連投は結合
      let k = i; const cust: string[] = [];
      while (k < arr.length && arr[k].sender === "customer") { cust.push(arr[k].text); k++; }
      const customerText = cust.join("\n");
      turns++;
      const v = shouldSkipDraftAfterClosing({ prevStaffText: prev, customerText });
      reasons.set(v.reason, (reasons.get(v.reason) ?? 0) + 1);
      if (!v.skip) continue;
      skipped++;
      // 止めた場面で、スタッフは実際に返信したか（24時間以内・まだ返せる分は数えない）
      if (now - arr[k - 1].at < HOURS * 3600_000) continue;
      const next = arr[k];
      const replied = !!next && next.sender === "staff" && next.at - arr[k - 1].at < HOURS * 3600_000;
      if (replied) {
        skippedButReplied++;
        if (missed.length < 10) missed.push(`     締め: ${mask(prev).slice(0, 90)}\n     客  : ${customerText}\n     実際: ${mask(next.text).slice(0, 110)}`);
      } else {
        skippedAndSilent++;
        if (samples.length < 6) samples.push(`     締め: ${mask(prev).slice(0, 90)}\n     客  : ${customerText}\n     実際: （返信していない）`);
      }
    }
  }

  console.log(`=== ① お客様の発言 ${turns}回のうち、下書きを作らないのは何回か ===`);
  console.log(`   止める ${skipped}回 (${(skipped / turns * 100).toFixed(1)}%)`);
  console.log(`\n   判定の内訳（作る理由の多い順）:`);
  for (const [r, c] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`     ${String(c).padStart(6)}回 (${(c / turns * 100).toFixed(1).padStart(5)}%)  ${r}`);
  }

  const judged = skippedButReplied + skippedAndSilent;
  console.log(`\n=== ② 止めた場面で、実際のスタッフはどうしたか（24時間の猶予がある ${judged}回）===`);
  console.log(`   返信していない ${skippedAndSilent}回 (${judged ? (skippedAndSilent / judged * 100).toFixed(1) : "-"}%)  ← 止めて正解`);
  console.log(`   返信していた   ${skippedButReplied}回 (${judged ? (skippedButReplied / judged * 100).toFixed(1) : "-"}%)  ← スタッフが自分で書くことになる`);

  console.log(`\n=== ③ 止めて正解だった実物 ===`);
  for (const s of samples) { console.log(`${"─".repeat(76)}`); console.log(s); }
  console.log(`\n=== ④ 止めたがスタッフは返信していた実物（見落とす手間の中身を目で読む）===`);
  for (const s of missed) { console.log(`${"─".repeat(76)}`); console.log(s); }
}
main().catch((e) => { console.error(e); process.exit(1); });

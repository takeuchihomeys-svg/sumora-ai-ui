// 調査専用（読み取りのみ）: 「募集出次第お送りします」型の約束の後、
//   お客様が物件も依頼も出していない（＝あっぴさんと同じ場面）時に、スタッフが次に押した AIX。
//   watch=true（慶次ルールが既に拾う群）と watch=false（今落ちる群）を並べて比べる。
import { createClient } from "@supabase/supabase-js";
import { classifyStaffTextForLedger } from "../app/lib/action-ledger";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);

const SEND_WHEN_FOUND = /(?:新着|募集|条件に合|オススメ|おすすめ)[^\n]{0,40}(?:出|見つかり|募集出)次第[^\n]{0,20}(?:お送り|ご連絡|ご紹介)/;
/** お客様が「新しい依頼」を出した印（これがあると場面が変わる） */
const CUSTOMER_REQUEST = /https?:\/\/|\[画像\]|\?|？|ですか|でしょうか|お願いし|してほしい|欲しい|見たい|内覧|見積|いくら|教えて|変更|条件/;

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };

async function all<T>(table: string, select: string, apply: (q: ReturnType<typeof sb.from>) => unknown): Promise<T[]> {
  const out: T[] = []; let from = 0;
  for (;;) {
    let q = sb.from(table).select(select) as never;
    q = apply(q as never) as never;
    const { data, error } = await (q as { order: (c: string, o: object) => { range: (a: number, b: number) => Promise<{ data: T[] | null; error: unknown }> } })
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - 365 * 864e5).toISOString();
  const msgs = await all<Msg>("messages", "conversation_id,sender,text,created_at",
    (q) => (q as never as { gte: (a: string, b: string) => unknown }).gte("created_at", since));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }

  const aixRows = await all<{ conversation_id: string; aix_type: string; created_at: string }>(
    "aix_usage_logs", "conversation_id,aix_type,created_at",
    (q) => (q as never as { gte: (a: string, b: string) => unknown }).gte("created_at", since));
  const aixByConv = new Map<string, typeof aixRows>();
  for (const a of aixRows) { const x = aixByConv.get(a.conversation_id) ?? []; x.push(a); aixByConv.set(a.conversation_id, x); }

  const tally: Record<"watchTrue" | "watchFalse", Record<string, number>> = { watchTrue: {}, watchFalse: {} };
  const samples: string[] = [];
  let scenesT = 0, scenesF = 0;

  for (const [, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "staff" || !m.text || !SEND_WHEN_FOUND.test(m.text)) continue;
      const e = classifyStaffTextForLedger(m.text, m.created_at);
      if (e?.kind !== "pickup_declared") continue;
      const watch = e.detail?.watch === true;
      // 約束の後〜次のスタッフ送信までの顧客発言。依頼が混ざっていたら場面が違うので除外
      const after = list.slice(i + 1);
      const nextStaffIdx = after.findIndex((x) => x.sender === "staff");
      const between = (nextStaffIdx < 0 ? after : after.slice(0, nextStaffIdx)).filter((x) => x.sender === "customer");
      if (between.some((c) => CUSTOMER_REQUEST.test(c.text ?? ""))) continue; // 新しい依頼あり＝別の場面
      const t0 = Date.parse(m.created_at);
      const next = (aixByConv.get(m.conversation_id) ?? []).find((a) => Date.parse(a.created_at) > t0 && Date.parse(a.created_at) - t0 < 14 * 864e5);
      const key = next?.aix_type ?? "(AIXなし)";
      const bucket = watch ? "watchTrue" : "watchFalse";
      tally[bucket][key] = (tally[bucket][key] ?? 0) + 1;
      if (watch) scenesT++; else scenesF++;
      if (!watch && samples.length < 10) samples.push(`${m.created_at.slice(0, 10)} [${key}] ${m.text.replace(/\n/g, " / ").slice(0, 80)}`);
    }
  }

  const show = (label: string, t: Record<string, number>, n: number) => {
    console.log(`\n${label}（${n}件）:`);
    const ent = Object.entries(t).sort((a, b) => b[1] - a[1]);
    const prop = (t["property_send"] ?? 0) + (t["property_recommendation"] ?? 0) + (t["property_send_new_arrival"] ?? 0) + (t["property_send_widen"] ?? 0);
    ent.forEach(([k, v]) => console.log(`  ${k}: ${v} (${((v / n) * 100).toFixed(1)}%)`));
    console.log(`  → 物件を送る系（property_send/recommendation/new_arrival/widen）合計: ${prop} / ${n} = ${((prop / n) * 100).toFixed(1)}%`);
  };
  console.log("『出次第お送り』型の約束 → お客様が新しい依頼を出していない場面のみ");
  show("watch=true（慶次ルールが既に AIX をセットする群）", tally.watchTrue, scenesT);
  show("watch=false（今 AIX が出ない群・あっぴさんと同じ）", tally.watchFalse, scenesF);
  console.log("\n実物（watch=false・先頭10件）:");
  samples.forEach((s) => console.log("  - " + s));
}
main().catch((e) => { console.error(e); process.exit(1); });

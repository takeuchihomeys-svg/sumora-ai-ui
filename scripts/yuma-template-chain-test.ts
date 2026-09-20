// 1通目を渡すと2通目は変わるのか（YUMA・生成のみ・LINE へは送らない）
//
// 2026-09-20 竹内「AIX テンプレート、AIX の内容との関係性での生成が重要なので、
//   そこも調査・テストして改善していく」
//
// 同じ場面で **sentMessage（直前に AIX で送った1通目）だけを変えて**生成し、差を見る。
// 設計知見「材料の効果は、同じ場面で材料だけ足した2本を並べて確かめる」。
//
// 実送信の型（scripts/audit-aix-chain-coherence.ts・90日・1,419組）:
//   1通目「ピックアップしました」33.3% → 2通目で未来形にする **0.2%**
//   1通目「ご査収」41.2% → 2通目にも書く **3.1%** ／ 1通目に挨拶 50.8% → 2通目にも書く **2.0%**
//   2通目の中身: 物件名39.7% / 条件の復唱35.5% / 見積書18.2% / 気に召されましたら10.1%
//   2通目の長さ: 中央値120字
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

/** 実送信の1通目（2026-09-20・AIX【物件ピックアップした】） */
const FIRST = "YUMAさんお待たせ致しました！！\n\n難波周辺全域からYUMAさんご希望の家賃10万円以内・1LDK・駅徒歩10分以内のお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";

/** 1通目を踏まえているか（実送信の型と同じ線） */
const CHECKS: Array<{ key: string; re: RegExp; want: "no" | "yes" }> = [
  { key: "⛔ ピックアップを未来形で繰り返す", re: /ピックアップ[^\n。！!]{0,14}(?:させて(?:頂|いただ)き|いたし|致し|し)ます|お送り(?:させて(?:頂|いただ)き|いたし|致し|し)ます|お探し(?:させて(?:頂|いただ)き|いたし|致し|し)ます/, want: "no" },
  { key: "⛔ 「ご査収」を重ねる（実送信3.1%）", re: /ご査収/, want: "no" },
  { key: "⛔ 挨拶を重ねる（実送信2.0%）", re: /お世話になっております|お待たせ(?:致|いた)?しました|はじめまして/, want: "no" },
  { key: "✅ 次の一歩がある（案内・申込・気に召されましたら）", re: /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます|お?申(?:し)?込|お気に召され|ご不明|気になる点/, want: "yes" },
];

async function main() {
  const { data: conv } = await sb.from("conversations").select("id, customer_name, status").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: true }).limit(200);
  const recentMessages = ((ms ?? []) as unknown as Array<Record<string, unknown>>).slice(-15).map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));

  const base = {
    actionType: "property_send",
    actionCategory: "物件ピックアップした【AIX】",
    conversationId: YUMA,
    customerName: String(c.customer_name ?? "YUMA"),
    conversationState: String(c.status ?? "proposing"),
    recentMessages,
    customerConditions: "難波周辺・家賃10万円以内・1LDK・駅徒歩10分以内",
    noEmoji: false,
    staffMessagedToday: true,
  };

  const CASES: Array<{ id: string; body: Record<string, unknown> }> = [
    { id: "① 1通目を渡さない（これまでの動き）", body: base },
    { id: "② 1通目を渡す（今回の改善）", body: { ...base, sentMessage: FIRST } },
  ];

  console.log(`=== YUMA で AIX テンプレートの2通目を生成（送信はしない）===`);
  console.log(`\n【渡す1通目】`);
  console.log(FIRST.split("\n").map((l) => `   ${l}`).join("\n"));

  const results: Array<{ id: string; text: string }> = [];
  for (const cs of CASES) {
    const t0 = Date.now();
    let text = "";
    try {
      const res = await fetch(`${BASE}/api/aix-template-generate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cs.body),
      });
      const raw = await res.text();
      try {
        const j = JSON.parse(raw) as Record<string, unknown>;
        text = String(j.text ?? j.error ?? raw.slice(0, 300));
      } catch { text = raw.slice(0, 300); }
    } catch (e) {
      text = `【エラー】${e instanceof Error ? e.message : String(e)}`;
    }
    results.push({ id: cs.id, text });
    console.log(`\n${"─".repeat(72)}`);
    console.log(`【${cs.id}】(${((Date.now() - t0) / 1000).toFixed(1)}s ・ ${text.length}字 ・ ${text.split("\n").filter((x) => x.trim()).length}行)\n`);
    console.log(text || "（本文なし）");
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log(`=== 1通目を踏まえているか ===`);
  console.log(`   ${"確認項目".padEnd(46)} ①渡さない  ②渡す`);
  for (const ck of CHECKS) {
    const a = ck.re.test(results[0]?.text ?? "");
    const b = ck.re.test(results[1]?.text ?? "");
    const mark = (hit: boolean) => (ck.want === "no" ? (hit ? "  ✗出た" : "  ✓なし") : (hit ? "  ✓あり" : "  ✗なし"));
    console.log(`   ${ck.key.padEnd(46)} ${mark(a)}  ${mark(b)}`);
  }
  console.log(`\n   実送信の2通目: 長さ中央値120字 ／ ①${results[0]?.text.length}字 ②${results[1]?.text.length}字`);
}
main().catch((e) => { console.error(e); process.exit(1); });

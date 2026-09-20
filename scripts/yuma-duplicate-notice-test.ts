// 物件を送る AIX で「前に送った物件」の注意が出るか（YUMA・生成のみ）
//
// 2026-09-21 竹内「拡張の読み込みではなくても物件ピックアップから送る際に、
//   前物件ピックアップから送った物件の可能性がないか、全く同じ物件が含まれていないか確認できるようになっているのか」
//
// 直した形: aix/action の物件を送る3経路（新着物件・物件ピックアップ×2）で
//   生成文に出ている物件を sent_properties と照合し、重複なら **notice** を返す。
//   ・Chrome 拡張（check-property-duplicate）に依存しない（AIX から送る時に必ず通る）
//   ・判定は sent-property-record.isSameProperty（誤って警告しない線 0.95）
//   ・本文は書き換えない（注意は画面のテキストボックスの外）
//
// ⚠ 書き込みを伴う（テスト用の行を入れて最後に消す）。テスト会話 YUMA だけで動かす。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const MARK = "ZZ重複テスト館";

async function main() {
  // ── 準備: 「既に送った物件」を1件入れる ──
  const { data: conv } = await sb.from("conversations").select("customer_name, status, property_customer_id").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  await sb.from("sent_properties").delete().eq("conversation_id", YUMA).like("property_name", `${MARK}%`);
  const { error: insErr } = await sb.from("sent_properties").insert({
    conversation_id: YUMA,
    property_customer_id: (c.property_customer_id as string | null) ?? null,
    property_name: MARK, room_no: "502", source: "test",
  });
  console.log(`=== 準備: 「${MARK} 502号室」を送付済みとして登録 ${insErr ? `失敗(${insErr.message})` : "OK"} ===\n`);

  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: true }).limit(200);
  const recent_messages = ((ms ?? []) as unknown as Array<Record<string, unknown>>).slice(-20).map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""),
    imageUrl: (m.image_url as string | null) ?? undefined,
    rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));

  // ── 生成（物件ピックアップした・会話を合わせる経路に base_message を渡す）──
  const CASES: Array<{ id: string; base: string; want: "出る" | "出ない" }> = [
    {
      id: "① 前に送った物件が含まれる",
      base: `YUMAさんお待たせ致しました！！\n\n🌟${MARK} 502号室\n\n難波周辺からYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！`,
      want: "出る",
    },
    {
      id: "② 初めての物件だけ",
      base: `YUMAさんお待たせ致しました！！\n\n🌟ZZ新しい物件館 101号室\n\n難波周辺からYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！`,
      want: "出ない",
    },
    {
      id: "③ 同じ建物でも号室が違う（別の部屋）",
      base: `YUMAさんお待たせ致しました！！\n\n🌟${MARK} 601号室\n\n難波周辺からYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！`,
      want: "出ない",
    },
  ];

  let ok = 0, ng = 0;
  for (const cs of CASES) {
    let notice = "", text = "";
    try {
      const res = await fetch(`${BASE}/api/aix/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "property_send",
          base_message: cs.base,
          customer_name: String(c.customer_name ?? "YUMA"),
          conversation_id: YUMA,
          recent_messages,
        }),
      });
      const j = await res.json() as Record<string, unknown>;
      notice = String(j.notice ?? "");
      text = String(j.message_text ?? j.error ?? "");
    } catch (e) { text = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
    const hasDup = /以前にお送りした物件が含まれています/.test(notice);
    const judged = (cs.want === "出る") === hasDup;
    if (judged) ok++; else ng++;
    console.log(`${"─".repeat(72)}`);
    console.log(`【${cs.id}】期待「注意が${cs.want}」 → 実際「${hasDup ? "出た" : "出なかった"}」 ${judged ? "✅" : "❌"}`);
    if (notice) console.log(`   注意: ${notice.replace(/\n/g, " ／ ").slice(0, 160)}`);
    console.log(`   本文: ${text.replace(/\n/g, " ／ ").slice(0, 120)}`);
  }

  // ── 後片付け ──
  await sb.from("sent_properties").delete().eq("conversation_id", YUMA).like("property_name", `${MARK}%`);
  const { data: left } = await sb.from("sent_properties").select("id").eq("conversation_id", YUMA).like("property_name", `${MARK}%`);
  console.log(`\n${"─".repeat(72)}`);
  console.log(`=== まとめ: ${ok}/${CASES.length} 期待どおり（後片付けの残り ${(left ?? []).length}件）===`);
}
main().catch((e) => { console.error(e); process.exit(1); });

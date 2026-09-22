// こちらが送った物件をお客様が送り返してきた時の返信（YUMA・本番と同じ generate-reply）
//
// 2026-09-22 竹内（𝓡さん事例）「こっちが送った物件をお客さんが送ってくることもある。判断できるようにする」
//   実物の下書き: 「お送り頂きました3件の募集状況確認させて頂きます！！」
//   実送信:       「ご査収いただきありがとうございます😌！！かしこまりました！！引き続き新着物件を…」
//
// 場面: こちらが物件資料を2件送る → お客様がその2件のスクショ＋「この物件良さそうですが、もう少し見てみたいので、送っていただきたいです」
// ⚠ 書き込みを伴う（YUMA に場面と、架空の画像URLの記録を入れて、確認後に必ず消す）
// 実行: npx tsx --env-file=.env.local scripts/yuma-own-property-test.ts [--runs=2]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RUNS = Number((process.argv.find((a) => a.startsWith("--runs=")) ?? "--runs=2").split("=")[1]);
const CONFIRM_RE = /募集状況(?:を)?確認|空室確認|空き状況(?:を)?確認/;
const FAIL_RE = /生成に失敗|AI返信の生成/;

async function main() {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const urls = [`https://example.invalid/yuma-own-${now}-1.jpg`, `https://example.invalid/yuma-own-${now}-2.jpg`];
  const scene = [
    { sender: "staff", text: "[画像]", image_url: urls[0], created_at: iso(26 * 3600_000) },
    { sender: "staff", text: "[画像]", image_url: urls[1], created_at: iso(26 * 3600_000 - 1000) },
    { sender: "staff", text: "YUMAさんお待たせ致しました！！\n天王寺周辺から敷金礼金なしのお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！", image_url: null, created_at: iso(26 * 3600_000 - 2000) },
    { sender: "customer", text: "[画像] ラクラス阿倍野元町 0507 6.4万円（省なし）(+共 8,000円)\n\n募集中 物探下見", image_url: null, created_at: iso(120_000) },
    { sender: "customer", text: "[画像] floor_plan\n\n物件種目：住居用 マンション\n物件名：エスリードレジデンス大阪天王寺\n号室：1006（10階部分）", image_url: null, created_at: iso(110_000) },
    { sender: "customer", text: "この物件良さそうですが、\nもう少し見てみたいので、送っていただきたいです🙇‍♀️", image_url: null, created_at: iso(100_000) },
  ];
  const ins = await sb.from("messages").insert(scene.map((m) => ({ conversation_id: YUMA, ...m }))).select("id");
  if (ins.error) { console.log("場面を作れず:", ins.error.message); return; }
  const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  // こちらが送った画像の記録（架空の URL なので実データと衝突しない）
  //   ⚠ 記録の時刻は「こちらが送った時刻」にする（照合は、お客様が送るより前にこちらが送った物件だけを見るため。
  //     1回目のテストは記録の時刻が「今」になり、お客様の発言より後と扱われて照合0件だった）
  await sb.from("sent_image_properties").insert([
    { image_url: urls[0], conversation_id: YUMA, property_name: "ラクラス阿倍野元町", room_no: "0507", source: "yuma_test", created_at: iso(26 * 3600_000 - 60_000) },
    { image_url: urls[1], conversation_id: YUMA, property_name: "エスリードレジデンス大阪天王寺", room_no: "1006", source: "yuma_test", created_at: iso(26 * 3600_000 - 60_000) },
  ]);
  const results: Array<{ drafted: boolean; noConfirm: boolean }> = [];
  try {
    for (let i = 0; i < RUNS; i++) {
      let draft = "";
      try {
        const res = await fetch(`${BASE}/api/generate-reply`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: scene.slice(3).map((m) => m.text).join("\n\u2063\n"), // 画面と同じ MSG_SEP でつなぐ（"\n" だと全部が画像の読み取り文の1通になる）
            customerMessages: scene.slice(3).map((m) => m.text),
            state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [],
            recentMessages: scene.map((m) => ({ sender: m.sender, text: m.text, imageUrl: m.image_url ?? undefined, createdAt: m.created_at, isAix: false })),
          }),
          signal: AbortSignal.timeout(300_000),
        });
        const raw = await res.text();
        const nl = raw.indexOf("\n");
        const meta = nl >= 0 ? (JSON.parse(raw.slice(0, nl)) as { ok?: boolean; reason?: string }) : { ok: false };
        draft = meta.ok ? raw.slice(nl + 1) : `（生成されず: ${(meta as { reason?: string }).reason ?? "?"}）`;
      } catch (e) { draft = `（エラー: ${e instanceof Error ? e.message : String(e)}）`; }
      const body = draft.replace(/\n?<<<[A-Z_]+:[\s\S]*?(?:>>>|$)/g, "").trim();
      const drafted = body.length > 5 && !FAIL_RE.test(body) && !/^（/.test(body);
      const noConfirm = drafted && !CONFIRM_RE.test(body) && !/お送り頂きました(?:物件|お部屋|[0-9２-９]件)/.test(body);
      results.push({ drafted, noConfirm });
      console.log(`\n── ${i + 1}回目 ──\n${body.replace(/\n/g, " ／ ").slice(0, 260)}`);
      console.log(`   ${drafted ? "✅ 下書きが出た" : "⚠ 下書きが出ていない"} ／ ${noConfirm ? "✅ 募集状況確認・『お送り頂きました物件』なし" : "⚠ 新しい物件として扱った"}`);
    }
  } finally {
    await sb.from("messages").delete().in("id", made);
    await sb.from("sent_image_properties").delete().in("image_url", urls);
    await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null }).eq("id", YUMA);
  }
  console.log(`\n=== まとめ ===\n   下書きが出た ${results.filter((r) => r.drafted).length}/${RUNS} ／ こちらの物件として受けた ${results.filter((r) => r.noConfirm).length}/${RUNS}`);
  console.log(`   後片付け: 場面 ${made.length}件と架空の記録2件を削除`);
}
main().catch((e) => { console.error(e); process.exit(1); });

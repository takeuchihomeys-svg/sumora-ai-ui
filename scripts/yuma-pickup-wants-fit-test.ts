// 会話を合わせるの物件ピックアップ（会話「し」の形）を YUMA で生成だけ（/api/aix/action は文を返すだけ・LINE へは送らない）
// 束は YUMA の売上サポの行 2676（S-RESIDENCE福島玉川Deux）・2425（ヴィルヌーブ中之島）＝どちらも床3（白基調ではない）・礼金あり
// 実行: BASE_URL=http://localhost:3479 npx tsx --env-file=.env.local scripts/yuma-pickup-wants-fit-test.ts [回数] [ids]
import { requireTestServer } from "./lib/dev-server-test-guard";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3479";
const N = parseInt(process.argv[2] ?? "2", 10);
const IDS = (process.argv[3] ?? "2676,2425").split(",").map(Number);
const SCENE = [
  { sender: "staff", at: "2026-10-04T10:04:00Z", text: "新築で敷金礼金なしのAマンション 0708号室が、かなりオススメ出来るお部屋となります😊！！\n\nお手隙の際にご査収ください😌！！" },
  { sender: "customer", at: "2026-10-04T10:05:00Z", text: "内装白で築浅のところピックアップしてください！" },
  { sender: "customer", at: "2026-10-04T10:06:00Z", text: "初期費用も抑えれるところでお願いします！" },
  { sender: "staff", at: "2026-10-04T10:10:00Z", text: "かしこまりました！！\n内装白・築浅で初期費用も抑えられるお部屋、新たにピックアップしお送りさせて頂きます！！\n引き続き何卒よろしくお願い致します！！" },
  { sender: "customer", at: "2026-10-04T12:47:00Z", text: "福島らへんで" },
  { sender: "customer", at: "2026-10-04T12:48:00Z", text: "こんな感じの条件で福島で探して欲しいです！" },
];
const CONDITIONS = "エリア: 福島区・北区\n家賃: 12万円以内\n築年数: 15年以内\nその他: 内装白・築浅・初期費用抑制[必須]";
(async () => {
  await requireTestServer(BASE, "pickfit-yuma");
  const recent_messages = SCENE.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.at, rawCreatedAt: m.at, isAix: false }));
  for (let i = 0; i < N; i++) {
    const body = {
      action: "property_send", customer_name: "YUMA", account: "sumora", conversation_id: YUMA, recent_messages,
      customer_conditions: CONDITIONS, send_mode: "normal", conversation_match: true, include_viewing_invite: process.env.INVITE === "1",
      pickup_ids: IDS, image_urls: IDS.map((_, k) => `https://example.invalid/test-${k}.jpg`),
    };
    const t0 = Date.now();
    const r = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
    const j = await r.json().catch(() => ({})) as { message_text?: string; message?: string; error?: string; notice?: string };
    const text = String(j.message_text ?? j.message ?? j.error ?? "");
    console.log(`\n── ${i + 1}回目（${Math.round((Date.now() - t0) / 1000)}秒・HTTP ${r.status}）\n${text}\n[notice] ${j.notice ?? ""}`);
    console.log(`  白基調を合う物として: ${/白基調|内装白|白い内装|白内装/.test(text.split("\n").filter((l) => !/では(?:ござ|御座)いません|ではない/.test(l)).join("\n")) ? "あり（×）" : "なし"}／「では御座いませんが」: ${/では(?:ござ|御座)いませんが|ではないですが/.test(text) ? "あり" : "なし"}／件数: ${/2部屋/.test(text) ? "あり" : "なし"}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });

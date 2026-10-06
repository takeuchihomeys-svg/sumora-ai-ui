// scripts/yuma-ack-topic-scope-test.ts — お礼・了承だけの番の「読むべき範囲」（ack-topic-scope.ts）を generate-reply の本物の経路で確かめる（YUMA・書かない呼び方）
//   場面: uran. 10/05 の実物（名前は YUMA）。お客様「あと一人紹介してるので連絡くるかも」→ こちら「お友達のご紹介ありがとうございます…ご連絡いただけましたら迅速に対応」
//         → お客様「よろしくお願いいたします🙇🏼‍♀️」。ブレインの判断は本番の uran. の last_brain_meta（43日前の物件探しの勝ちパターン・成約戦略・note を含む）をそのまま渡す。
//   見る物: 下書きに範囲の外の行為（お部屋を探す宣言 等）が無いか。ACK_TOPIC_SCOPE=off（前）と既定（後）を並べる。
// 手順書 memory/test_protocol_brain.md。実行:
//   LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-ack-topic-scope-test.ts [OFF=2] [ON=3]
//   LLM_TEST_FINAL_CLAUDE=1     npx tsx --env-file=.env.local scripts/yuma-ack-topic-scope-test.ts OFF=0 ON=1
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const argN = (k: string, d: number) => Number((process.argv.find((a) => a.startsWith(`${k}=`)) ?? `${k}=${d}`).split("=")[1]);
let h: LlmTestHarness | null = null;
const made: string[] = [];

const OLD = [
  { sender: "staff", text: "かしこまりました！！\n玉造周辺全域でYUMAさんのご条件に合うお部屋、追加で探させて頂きます😊！！\n\n23日にまとめてご案内出来るよう、ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します😌！！", createdAt: "2026-08-18T08:52:35.589Z" },
  { sender: "customer", text: "暑い中ありがとうございました🙇🏼‍♀️", createdAt: "2026-08-23T04:30:32.090Z" },
  { sender: "staff", text: "こちらこそ本日はお暑い中ご同行頂きありがとうございました😊！！\n\nお友達の方にこちらのLINE追加いただくようご連絡頂けますと幸いです😌！！", createdAt: "2026-08-23T04:35:18.326Z" },
];
const SCENE = [
  { sender: "customer", text: "こんにちは！\n\nあと一人紹介してるので連絡くるかもしれないです🙇🏼‍♀️" },
  { sender: "staff", text: "YUMA さん\nお世話になっております😊！！\nお友達のご紹介ありがとうございます！！\nご連絡いただけましたら私の方で迅速に対応させて頂きます😌！！" },
  { sender: "customer", text: "よろしくお願いいたします🙇🏼‍♀️" },
];

// 本番の uran. の last_brain_meta（10/05 13:10・名前だけ YUMA に置き換え・判断に効く項目だけ）
const URAN_META: Record<string, unknown> = {
 "note": "新着ピックアップを送る",
 "reason": "43日ぶり連絡・物件探し再開の接点づくり",
 "source": "brain_fresh",
 "key_topics": [
  "感謝を受け取る",
  "紹介の方の連絡を待つ姿勢"
 ],
 "next_steps": [
  "Step1（今すぐ）: 紹介のお礼と、ご連絡が来たら迅速に対応する旨を返信する",
  "Step2: 紹介の方からLINEが来たら条件ヒアリング（condition_hearing）を準備する",
  "Step3: YUMAさん自身の物件探しが止まっているため、条件に合う新着を拡張ツールで検索し、見つかり次第ピックアップしてお送りする"
 ],
 "reply_mode": "auto_reply",
 "avoid_topics": [
  "来阪",
  "見積書",
  "初期費用",
  "内覧日の調整",
  "申込誘導"
 ],
 "latent_intent": "友人紹介の約束を履行しつつ、自身の物件探しは一旦止まっている状態",
 "customer_intent": "chat",
 "reply_direction": "お客様の「よろしくお願いします」に感謝を受け取り、ご紹介のお友達が来たら迅速に対応する待ちの姿勢で締める",
 "strategy_source": "combined",
 "winning_pattern": "紹介のお礼を伝え、新規の方からの連絡に迅速対応する宣言をし、YUMAさんの物件探しも継続して新着を送り続ける",
 "checkpoint_stage": "viewing",
 "closing_strategy": "ご紹介のお礼を伝え、お友達からのご連絡をお待ちして迅速に対応させて頂きます。あわせて、YUMAさんの内覧後の物件探しも引き続き全力でサポートさせて頂きます。",
 "customer_emotion": "前向き",
 "recommended_tone": "普通",
 "enforcement_level": "required",
 "customer_questions": [],
 "purchase_signal_level": "soft"
};

async function main() {
  h = await setupLlmTest("yuma-ack-topic-scope-test");
  h.assertYuma(YUMA);
  h.assertSceneSafe([...OLD, ...SCENE].map((m) => m.text), "uran-referral-ack");
  await h.waitUntilYumaQuiet([]);
  const { POST } = await import("../app/api/generate-reply/route");
  const { staffActsOf, STAFF_ACT_JA } = await import("../app/lib/customer-sim-shadow");
  const { resolveAckTopicScope, outOfTopicActs } = await import("../app/lib/ack-topic-scope");
  const meta: Record<string, unknown> = URAN_META;
  const runs: Array<"off" | "on"> = [...Array(argN("OFF", 2)).fill("off"), ...Array(argN("ON", 3)).fill("on")];
  const tally = { off: { n: 0, out: 0 }, on: { n: 0, out: 0 } };
  for (const [ri, mode] of runs.entries()) {
    const times = h.sceneTimes(SCENE.length);
    const ins = await sb.from("messages").insert(SCENE.map((m, i) => ({ conversation_id: YUMA, sender: m.sender, text: m.text, created_at: times[i] }))).select("id");
    if (ins.error) throw new Error(ins.error.message);
    const ids = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    made.push(...ids);
    try {
      if (mode === "off") process.env.ACK_TOPIC_SCOPE = "off"; else delete process.env.ACK_TOPIC_SCOPE;
      const recentMessages = [...OLD, ...SCENE.map((m, i) => ({ ...m, createdAt: times[i] }))].map((m) => ({ ...m, isAix: false }));
      const last = SCENE[SCENE.length - 1].text;
      const body = {
        message: last, customerMessages: [last], state: "property_recommendation", conversationId: YUMA, customerName: "YUMA", hasViewed: true, activeTaskTypes: [], hasStaffReplied: true,
        recentMessages,
        // 本番の uran. と同じ条件の行（物件探しの条件が材料にある）
        customerConditions: ["エリア: 玉造", "間取り: 1DK・1K", "家賃: 8万円以内", "駅徒歩: 10分以内", "入居: 9月", "築年数: 10年以内", "希望: 1Kの場合はかなり広い部屋希望"].join("\n"),
        brainMetaDirect: { meta: { ...meta, analyzed_msg_ts: times[times.length - 1] }, customerName: "YUMA", conversationDirection: null, brainAnalyzedAt: new Date().toISOString() },
        shadowNoWrite: true,
      };
      const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never);
      const raw = await (res as Response).text();
      const text = raw.slice(raw.indexOf("\n") + 1).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
      const scope = resolveAckTopicScope(recentMessages.map((m) => ({ sender: m.sender, text: m.text, created_at: m.createdAt })));
      const out = outOfTopicActs(text, scope);
      tally[mode].n++; if (out.length) tally[mode].out++;
      const acts = [...staffActsOf(text)].map((a) => STAFF_ACT_JA[a]);
      console.log(`\n[${ri + 1}/${runs.length} ${mode === "off" ? "前（ACK_TOPIC_SCOPE=off）" : "後"}] ${out.length ? "❌ 範囲の外: " + out.map((a) => STAFF_ACT_JA[a]).join("・") : "✅ 範囲の中"}${acts.length ? `（行為: ${acts.join("・")}）` : ""}\n   ${text.replace(/\n/g, " ／ ").slice(0, 220)}`);
    } finally {
      await sb.from("messages").delete().in("id", ids);
    }
  }
  console.log(`\n結果: 前 ${tally.off.out}/${tally.off.n} が範囲の外 ／ 後 ${tally.on.out}/${tally.on.n} が範囲の外`);
  if (tally.on.out) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    delete process.env.ACK_TOPIC_SCOPE;
    if (made.length) { await sb.from("messages").delete().in("id", made); console.log(`後片付け: 場面の通 ${made.length}件を id で削除`); }
    if (h) await h.finish();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });

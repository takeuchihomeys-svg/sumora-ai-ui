// AIX の「お世話になっております」は1日1回（固定文の経路・LLM を使わない・読み取りのみ）
// 2026-09-22 竹内「今日初めてのLINEだったらつける／今日初めてじゃないときは使わない」
//   A: YUMA の会話（今日すでにこちらが送っている＝DB で分かる）→ 付かない
//   B: 会話の指定なし・前回の送信は昨日 → 付く
// ⚠ A は aix_generate_log に生成の記録が1行残る（送信はしない）
// 実行: npx tsx scripts/yuma-aix-daily-greeting-test.ts
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const y = new Date(Date.now() - 26 * 3600_000).toISOString();
const base = {
  action: "property_check_result", check_pattern: "unavailable", customer_name: "YUMA", property_name: "テストハイツ",
  recent_messages: [
    { sender: "staff", text: "YUMAさんお世話になっております！！\nピックアップさせて頂きました！！", rawCreatedAt: y },
    { sender: "customer", text: "テストハイツ空いてますか？", rawCreatedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
  ],
};
async function main() {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["A YUMA（今日すでに送った）", { ...base, conversation_id: "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7" }, false],
    ["B 会話の指定なし（今日はじめて）", base, true],
  ];
  for (const [label, body, want] of cases) {
    const r = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    const msg = String(j.message_text ?? j.message ?? j.text ?? (Array.isArray(j.messages) ? (j.messages as unknown[]).join("\n") : "") ?? j.error ?? "");
    const has = /お世話になっております/.test(msg);
    console.log(`── ${label} (${r.status})\n${msg.replace(/\n/g, " ／ ").slice(0, 200)}\n   ${has === want ? "✅" : "⚠"} お世話になっております${has ? "あり" : "なし"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

// YUMA で AIX の物件ピックアップの文を生成し、実送信の型と比べる（生成のみ・LINE へは送らない）
//
// 2026-09-20 竹内「これは次からちゃんとできるってことかな？ ちゃんと生成されるのか
//   実際送ってる AIX の物件ピックアップの文のように送られるのか テストして確認」
//
// 比較の基準は scripts/audit-pickup-text-style.ts が出した実送信913通の型:
//   ピックアップ過去形 47.4% ／ ご査収ください 43.7% ／ 家賃・条件の復唱 31.7% ／ 物件名を本文に 30.3%
//   名前呼びかけ 29.4% ／ お世話になっております 19.6% ／ エリア名 9.6%
//   かしこまりました **2.3%** ／ 全力サポート 0.3% ／ 何卒 0.8% ／ いつでもお気軽に 0.2%
//   長さ 中央値136字・3行
//
// ⚠ /api/aix/action は**文を返すだけ**（LINE 送信は別 API）。ここでは送信しないので安全。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

/** 実送信913通で測った型（この率に近いほど「スタッフが送っている文」に近い） */
const ELEMENTS: Array<{ key: string; re: RegExp; sent: number }> = [
  { key: "ピックアップ（過去形）", re: /ピックアップ(?:させて(?:頂|いただ)き|いたし|致し)ました|お送り(?:させて(?:頂|いただ)き|いたし|致し)ました/, sent: 47.4 },
  { key: "ご査収ください", re: /ご査収/, sent: 43.7 },
  { key: "家賃・条件の復唱", re: /[0-9０-９]{1,3}[\.．]?[0-9０-９]{0,2}万|[0-9０-９]{1,2}[LDKSldks]{1,4}|築[0-9０-９]{1,2}/, sent: 31.7 },
  { key: "物件名を本文に書く", re: /[0-9０-９]{2,4}号室|🌟/, sent: 30.3 },
  { key: "名前呼びかけ 〇〇さん", re: /さん/, sent: 29.4 },
  { key: "お世話になっております", re: /お世話になっております/, sent: 19.6 },
  { key: "エリア名を書く", re: /(?:市|区|町|駅|沿線|周辺|エリア)[^\n。！!]{0,10}(?:から|周辺|全域)/, sent: 9.6 },
  { key: "⚠ かしこまりました", re: /^かしこまりました/, sent: 2.3 },
  { key: "⚠ 全力サポート", re: /全力でサポート/, sent: 0.3 },
  { key: "⚠ 何卒よろしく", re: /何卒(?:よろしく|宜しく)お願い/, sent: 0.8 },
  { key: "⚠ いつでもお気軽に", re: /いつでもお気軽|何時でもお気軽/, sent: 0.2 },
  { key: "⛔ お待たせ（禁止語）", re: /お待たせ(?:致|いた)?しました/, sent: 4.3 },
];

async function main() {
  const { data: conv } = await sb.from("conversations").select("id, customer_name, status, account").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: true }).limit(200);
  const all = (ms ?? []) as unknown as Array<Record<string, unknown>>;
  const recent_messages = all.slice(-25).map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""),
    imageUrl: (m.image_url as string | null) ?? undefined,
    createdAt: String(m.created_at), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));

  // 画面が AIX を押した時と同じ形（物件ピックアップは物件データを画面が持たないので渡さない＝本番と同じ）
  const CASES: Array<{ id: string; body: Record<string, unknown> }> = [
    {
      id: "① 物件ピックアップした（property_send）",
      body: { action: "property_send", customer_name: c.customer_name ?? "YUMA", account: c.account ?? "sumora", conversation_id: YUMA, recent_messages },
    },
    {
      id: "② 物件オススメ（property_recommendation）",
      body: { action: "property_recommendation", customer_name: c.customer_name ?? "YUMA", account: c.account ?? "sumora", conversation_id: YUMA, recent_messages },
    },
    {
      id: "③ 物件を探す（property_search）",
      body: { action: "property_search", customer_name: c.customer_name ?? "YUMA", account: c.account ?? "sumora", conversation_id: YUMA, recent_messages },
    },
    {
      // 2026-09-20 竹内の仮説の直接検証:
      //   「物件ピックアップで送った物件に対して DeepSeek が読みとれば…ちゃんとお客さんに対して
      //     適切な文を生成できる可能性が高い」
      //   ①と同じ場面で**物件データだけ足して**生成し、文が実送信のように具体的になるかを見る。
      //   実送信の型: 家賃・条件の復唱 31.7% ／ 物件名を本文に 30.3% ／ エリア名 9.6%（①では全部0だった）
      id: "④ ①と同じだが物件データを渡す",
      body: {
        action: "property_send", customer_name: c.customer_name ?? "YUMA", account: c.account ?? "sumora",
        conversation_id: YUMA, recent_messages,
        property_names: ["スプランディッド大阪EAST 204号室", "グレース畑中 202号室"],
        prop_statuses: ["available", "vacating"],
        property_count: 2,
      },
    },
  ];

  console.log(`=== YUMA [${c.status}] で AIX の物件ピックアップを生成（送信はしない）===\n`);
  const results: Array<{ id: string; text: string; ms: number }> = [];
  for (const cs of CASES) {
    const t0 = Date.now();
    let text = "", raw = "";
    try {
      const res = await fetch(`${BASE}/api/aix/action`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cs.body),
      });
      raw = await res.text();
      try {
        const j = JSON.parse(raw) as Record<string, unknown>;
        text = String(j.message ?? j.text ?? j.message_text ?? j.generated_text ?? "");
        if (!text) text = raw.slice(0, 400);
      } catch { text = raw.slice(0, 400); }
    } catch (e) {
      text = `【エラー】${e instanceof Error ? e.message : String(e)}`;
    }
    const ms = Date.now() - t0;
    results.push({ id: cs.id, text, ms });
    console.log(`${"─".repeat(72)}`);
    console.log(`【${cs.id}】(${(ms / 1000).toFixed(1)}s ・ ${text.length}字 ・ ${text.split("\n").filter((x) => x.trim()).length}行)\n`);
    console.log(text || "（本文なし）");
    console.log("");
  }

  // 型の突き合わせ
  console.log(`${"─".repeat(72)}`);
  console.log(`=== 実送信913通の型と比べる ===`);
  console.log(`   ${"要素".padEnd(26)} 実送信   生成（①②③のどれに出たか）`);
  for (const e of ELEMENTS) {
    const hits = results.filter((r) => e.re.test(r.text)).map((r) => r.id.slice(0, 2));
    console.log(`   ${e.key.padEnd(26)} ${String(e.sent).padStart(5)}%   ${hits.length ? hits.join(",") : "－"}`);
  }
  console.log(`\n   ※ 「⚠」は実送信でほとんど使われない語（生成に出たら実送信とズレている）`);
  console.log(`   ※ 「⛔」は禁止語（1つでも出たら不具合）`);
  console.log(`   実送信の長さ: 中央値136字・3行`);
}
main().catch((e) => { console.error(e); process.exit(1); });

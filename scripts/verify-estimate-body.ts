// scripts/verify-estimate-body.ts
// 実行: VERIFY_BASE_URL=http://localhost:3000 npx tsx --env-file=.env.local scripts/verify-estimate-body.ts
//
// 2026-09-20 竹内（H さん事例）「見積書の文…きめられた AIX のテンプレートの文の構成と違う」:
//   AIX【見積書送る】の**1枚の経路**（割引と節約を抱き合わせにしていた所）を本番の経路で通す。
//   見積書の読み取り結果を `estimate` で直接渡せる口があるので、OCR を挟まずに
//   **実物の数字**（H さんの見積書・実送信の見積書）で組み立てだけを確かめる。
//   会話はテスト用の「YUMA」だけを使う（竹内さんのルール）。
export {};
const BASE = process.env.VERIFY_BASE_URL ?? "https://sumora-ai-ui.vercel.app";
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA（竹内さん本人のテスト会話）

type Case = { name: string; estimate: Record<string, number | string>; want: { discountLine: boolean; savingsLine: boolean } };

const CASES: Case[] = [
  {
    // ★ 竹内さんが見つけた実物（2026-09-20 のスクショ）
    //   スモ割0円・差引請求 178,090円・見積書の画像には「61,920円節約出来ます」と印字
    name: "★ H さんの見積書（スモ割 0円）",
    estimate: { property_name: "ハイツカトレア B", room_number: "202", rent: 59000, management_fee: 0, total: 178090, discount: 0, commission: 2990, commission_tax: 0 },
    want: { discountLine: false, savingsLine: true },   // 割引行は出ない・節約行は出る
  },
  {
    // 実送信 2026-09-19（主流の形・319通中292通がこれ）
    name: "割引あり＋節約あり（栄美グランドハイツ 211号室）",
    estimate: { property_name: "栄美グランドハイツ", room_number: "211", rent: 39000, management_fee: 3000, total: 107610, discount: 12000, commission: 2990, commission_tax: 299 },
    want: { discountLine: true, savingsLine: true },
  },
  {
    // 金額が読めなかった時（Vision 失敗）→ 数字を作らず受け皿の1文に倒れるか
    name: "金額が読めない（受け皿の1文に倒れるか）",
    estimate: { property_name: "", room_number: "", rent: 0, management_fee: 0, total: 0, discount: 0, commission: 0, commission_tax: 0 },
    want: { discountLine: false, savingsLine: false },
  },
];

async function main() {
  console.log(`── 生成先: ${BASE}  会話: YUMA\n`);
  let ng = 0;
  for (const c of CASES) {
    const res = await fetch(`${BASE}/api/aix/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "estimate_sheet", conversation_id: CONV, customer_name: "YUMA", parsed_estimate: c.estimate }),
      signal: AbortSignal.timeout(180_000),
    });
    const raw = await res.text();
    console.log(`═══ ${c.name} ═══`);
    if (!res.ok) { console.log(`  ⚠ HTTP ${res.status}: ${raw.slice(0, 300)}\n`); ng++; continue; }
    const body = JSON.parse(raw) as Record<string, unknown>;
    const text = String(body.message_text ?? "");
    console.log("  ━━━━━━ 生成された金額文 ━━━━━━");
    console.log(text.split("\n").map((l) => `    ${l}`).join("\n"));
    console.log("  ━━━━━━━━━━━━━━━━━━━");

    const hasDiscount = /🌟[0-9,]+円割引させて頂き/.test(text);
    const hasSavings = /なら一般的な不動産業者より[0-9,]+円節約出来ます！！/.test(text);
    const hasNote = /※ご入居日によって日割家賃が発生致します。/.test(text);
    const broken = /NaN|undefined|null|：0円|より0円/.test(text);
    const ok = (cond: boolean) => { if (!cond) ng++; return cond ? "✅" : "⚠"; };
    console.log(`  ${ok(hasDiscount === c.want.discountLine)} 割引行 ${hasDiscount ? "あり" : "なし"}（期待: ${c.want.discountLine ? "あり" : "なし"}）`);
    console.log(`  ${ok(hasSavings === c.want.savingsLine)} 節約行 ${hasSavings ? "あり" : "なし"}（期待: ${c.want.savingsLine ? "あり" : "なし"}）`);
    console.log(`  ${ok(hasNote)} 日割家賃の注記`);
    console.log(`  ${ok(!broken)} 壊れた数字・0円が無い`);
    // 2通目（カバーレター）も見る（作業メモが混ざっていないか）
    const cover = String(body.cover_letter ?? body.coverLetter ?? "");
    if (cover) {
      console.log(`  ─ カバーレター ─`);
      console.log(cover.split("\n").map((l) => `    ${l}`).join("\n"));
      console.log(`  ${ok(!/^\s*[-*#]|⚠|節約出来ます|初期費用：/m.test(cover))} カバーレターに金額文・作業メモが混ざっていない`);
    }
    console.log("");
  }
  console.log(ng === 0 ? "✅ 全部そろっている" : `⚠ ${ng}件 合っていない`);
  if (ng > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

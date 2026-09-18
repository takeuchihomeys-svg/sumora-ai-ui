// scripts/verify-cost-explain-convmatch.ts
// 2026-09-19 竹内「初期費用を説明のところ会話を合わせるボタンをつける文もちゃんと会話合わせて生成されるように」
// AIX【初期費用を説明】× 会話を合わせる を**本番**で数回生成して中身を確かめる。
//   ・お客様の不安（他社の金額・仲介手数料）に直接答えているか
//   ・金額は入力値だけか（入力に無い金額が〇〇円になっていないか＝そもそも書かれていないか）
//   ・スモラで「仲介手数料0円」と書いていないか
// 会話はテスト用の YUMA。送信はしない（生成だけ）。
//
// 実行: npx tsx --env-file=.env.local scripts/verify-cost-explain-convmatch.ts [--n=3] [--mode=fee|no_fee|mechanism]
const BASE = process.env.VERIFY_BASE_URL || "https://sumora-ai-ui.vercel.app";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const N = Number(process.argv.find((a) => a.startsWith("--n="))?.split("=")[1] ?? 3);
const MODE = (process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "fee") as "fee" | "no_fee" | "mechanism";

// あやさんの実際の質問（2026-09-12）をそのまま。画面と同じ形（sender / text / rawCreatedAt）で渡す
const iso = (jst: string) => new Date(`${jst}+09:00`).toISOString();
const RECENT = [
  { sender: "staff", text: "【プレアール遠里小野 203号室】\n\n初期費用さらに\n🌟22,000円割引させて頂き\n初期費用：67,000円", rawCreatedAt: iso("2026-09-19T21:40:00") },
  { sender: "customer", text: "ありがとうございます🙇🏻‍♀️՞\n仲介手数料無しで大丈夫でしょうか？\n他の不動産屋さんに問い合わせると\n初期費用31万プラス日割り家賃と\n伺っているので、、、💦\n安いのには何か理由があるのでしょうか？", rawCreatedAt: iso("2026-09-19T22:54:00") },
];

async function gen(): Promise<string> {
  const body: Record<string, unknown> = {
    action: "cost_explain",
    conversation_id: YUMA,
    customer_name: "YUMA",
    conversation_match: true,
    account_key: "sumora",
    cost_mode: MODE,
    recent_messages: RECENT,
  };
  if (MODE === "fee") { body.landlord_fee_yen = 67000; body.refund_yen = 22000; body.landlord_fee_label = "家賃1ヶ月分"; }
  if (MODE === "no_fee") { body.saving_yen = 29150; }
  const res = await fetch(`${BASE}/api/aix/action`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const d = data as { message_text?: string; message?: string };
  return String(d.message_text ?? d.message ?? JSON.stringify(data).slice(0, 300));
}

function check(text: string) {
  const ok: string[] = [], bad: string[] = [];
  (/仲介手数料[^。\n]{0,6}(0円|無料|なし)/.test(text) ? bad : ok).push("スモラで「仲介手数料0円」と書いていない");
  (text.includes("〇〇円") ? bad : ok).push("伏せ字（入力に無い金額）が無い");
  (/31万|310,000|198,000/.test(text) ? bad : ok).push("他社の金額を書いていない");
  (/割引.{0,6}(させて|いたし|致し)/.test(text) && /仲介手数料.{0,10}割引/.test(text) ? bad : ok).push("「仲介手数料を割引」と書いていない");
  if (MODE === "fee") {
    (text.includes("67,000") ? ok : bad).push("入力した報酬 67,000円");
    (text.includes("22,000") ? ok : bad).push("入力した還元 22,000円");
  }
  if (MODE === "mechanism") {
    (/[\d,]+円/.test(text.replace(/2,980円/g, "")) ? bad : ok).push("物件ごとの金額を書いていない");
  }
  (/仲介手数料|広告(料|費)|還元/.test(text) ? ok : bad).push("お客様の質問（仲介手数料・安さ）に触れている");
  return { ok, bad };
}

async function main() {
  console.log(`本番 ${BASE} で ${N} 回生成（mode=${MODE}・会話: YUMA・送信はしない）\n`);
  for (let i = 1; i <= N; i++) {
    try {
      const text = await gen();
      const { ok, bad } = check(text);
      console.log(`── ${i}回目 ─────────────────────────────`);
      console.log(text);
      console.log(`   OK: ${ok.join(" / ")}`);
      if (bad.length) console.log(`   ★NG: ${bad.join(" / ")}`);
      console.log();
    } catch (e) {
      console.log(`── ${i}回目 失敗: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

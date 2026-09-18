// scripts/verify-viewing-vacancy-convmatch.ts
// 2026-09-19 竹内「AIXの内覧調整のところ会話を合わせるボタンつくる。複雑な場合に対応するために」
// AIX【内覧へ！】退去予定物件 × 会話を合わせる を**本番**で数回生成して中身を確かめる。
//   ・退去予定日と内覧解禁日が入っているか
//   ・解禁日より前の日付を候補に出していないか
//   ・場面（お客様の言い方）に合わせた形になっているか
// 会話はテスト用の YUMA（竹内さん本人）。送信はしない（生成だけ）。
//
// 実行: npx tsx --env-file=.env.local scripts/verify-viewing-vacancy-convmatch.ts [--n=3]
const BASE = process.env.VERIFY_BASE_URL || "https://sumora-ai-ui.vercel.app";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const N = Number(process.argv.find((a) => a.startsWith("--n="))?.split("=")[1] ?? 3);

// a🤫 さん 9/18 の場面をそのまま（お客様は日付を言わず「内覧したい」とだけ）
const RECENT = [
  { sender: "staff", text: "お送り頂きました物件の中で\n・ジュネスニッコー 1003号室\n・生野西一丁目戸建\nこちら2件現在募集中です！！" },
  { sender: "customer", text: "そうなんですね😭" },
  { sender: "customer", text: "ココの物件内覧したいんですが いけますか？" },
];

const VACANCY = { name: "ジュネスニッコー1003号室", moveOut: "9月27日" };
// 画面が渡す候補（解禁日 9/28 以降のみ）
const CALENDAR = "9/28(月) 12:00〜14:00\n9/29(火) 15:00〜17:00\n9/30(水) 15:00〜17:00";

async function gen(i: number): Promise<string> {
  const res = await fetch(`${BASE}/api/aix/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "viewing_invite",
      conversation_id: YUMA,
      customer_name: "YUMA",
      conversation_match: true,
      vacancy_property_name: VACANCY.name,
      vacancy_move_out: VACANCY.moveOut,
      calendar_info: CALENDAR,
      recent_messages: RECENT,
    }),
  });
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return String((data as { message?: string }).message ?? JSON.stringify(data).slice(0, 300));
}

function check(text: string) {
  const bad: string[] = [];
  const ok: string[] = [];
  (text.includes("9月27日") || text.includes("9/27") ? ok : bad).push("退去予定日（9月27日）");
  (text.includes("9月28日") || text.includes("9/28") ? ok : bad).push("内覧解禁日（9月28日）");
  // 解禁日より前の候補（9/18〜9/27 の日付＋時間の行）
  const early = text.split("\n").filter((l) => /^\s*9\s*[\/月]\s*(1[89]|2[0-7])\s*日?\s*(?:[（(].[）)])?[\s、,]*\d{1,2}:\d{2}/.test(l));
  (early.length === 0 ? ok : bad).push(`退去前の候補なし${early.length ? `（出た: ${early.join(" / ")}）` : ""}`);
  (/割引[^\n]{0,10}少な|かかってしま/.test(text) ? bad : ok).push("費用のマイナスの説明なし");
  const cal = ["9/28", "9/29", "9/30"].filter((d) => text.includes(d));
  ok.push(`渡した候補のうち本文にある物: ${cal.join("・") || "なし"}`);
  return { ok, bad };
}

async function main() {
  console.log(`本番 ${BASE} で ${N} 回生成（会話: YUMA・送信はしない）\n`);
  for (let i = 1; i <= N; i++) {
    try {
      const text = await gen(i);
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

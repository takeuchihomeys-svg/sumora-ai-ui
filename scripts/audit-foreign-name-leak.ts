// 例文に残っていた他のお客様の名前が、実際の下書き・実送信に漏れたか（読み取りのみ）
//
// 2026-09-20 竹内（まりあさん事例）「他のお客さんのデータがはいりこんでいるのか」
//   PAIR_MATRIX の example に実名が25箇所残っていた（みく／あや／瑞希／あみ／タクミ／あい／愛乃／慶次）。
//   例文は生成プロンプトに渡るので、別のお客様の返信を作る時に他人の名前が材料として入っていた。
//   本文にまで漏れたかをここで測る（漏れていれば重大・漏れていなくても材料の汚染は事実）。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const NAMES = ["みく", "あや", "瑞希", "あみ", "タクミ", "あい", "愛乃", "慶次"];

async function main() {
  const { data: convs } = await sb.from("conversations").select("id, customer_name").limit(5000);
  const nameOf = new Map<string, string>();
  // LINE の表示名は「あ や」「愛 乃」のように分かち書きされるので、空白を落としてから比べる
  //   （落とさないと本人の名前を「他人の名前」と誤検出する）
  const norm = (s: string) => s.replace(/[\s　]/g, "");
  for (const c of ((convs ?? []) as Array<{ id: string; customer_name: string | null }>)) nameOf.set(c.id, norm(c.customer_name ?? ""));

  const { data } = await sb.from("ai_reply_examples")
    .select("id, conversation_id, ai_draft, sent_reply, created_at, was_ai_used")
    .order("created_at", { ascending: false }).limit(4000);
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  let draftLeak = 0, sentLeak = 0, checked = 0;
  const samples: string[] = [];
  for (const r of rows) {
    const own = nameOf.get(String(r.conversation_id ?? "")) ?? "";
    if (!own) continue;
    checked++;
    for (const [col, label] of [["ai_draft", "下書き"], ["sent_reply", "実送信"]] as const) {
      const t = String(r[col] ?? "");
      if (!t) continue;
      for (const n of NAMES) {
        // その会話のお客様自身の名前なら当然 OK
        if (own.includes(n)) continue;
        if (!t.includes(`${n}さん`)) continue;
        if (label === "下書き") draftLeak++; else sentLeak++;
        if (samples.length < 15) {
          samples.push(`  [${String(r.created_at).slice(5, 16)}] ${label} 会話のお客様=「${own}」に「${n}さん」\n      ${t.replace(/\n/g, " ").slice(0, 100)}`);
        }
        break;
      }
    }
  }
  console.log(`=== 手本 ${checked}件（お客様名が分かるもの）で他のお客様の名前を探す ===`);
  console.log(`  対象の名前: ${NAMES.join("／")}（往復文脈セルの例文に残っていた実名）`);
  console.log(`\n  下書き(ai_draft) への漏れ : ${draftLeak}件`);
  console.log(`  実送信(sent_reply) への漏れ: ${sentLeak}件`);
  if (samples.length) { console.log(`\n  --- 実例 ---`); for (const s of samples) console.log(s); }
  else console.log(`\n  ✅ 本文への漏れは見つからなかった（材料の汚染は事実なので例文は {name} に直した）`);
}
main().catch((e) => { console.error(e); process.exit(1); });

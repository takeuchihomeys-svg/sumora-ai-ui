// scripts/audit-condition-format.ts
// 「うちのフォーマットが埋まって返ってきたか」の決定論判定（app/lib/condition-format.ts）を
// 本番のお客様メッセージ全件に当て、拾い漏れ（false negative）と誤発火（false positive）を測る。
//
// 2026-09-18 竹内（💋chibi💋 事例）「お客さんから物件の条件送られたのに条件として読みとってない／
//   物件検索の拡張ツールにも反映されていない」の実装時に作成。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-format.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
import { analyzeSumoraForm } from "../app/lib/condition-format";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 120);

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; text: string; created_at: string }> = [];
  for (let page = 0; page < 60; page++) {
    const { data, error } = await sb
      .from("messages")
      .select("conversation_id, text, created_at")
      .eq("sender", "customer")
      .gte("created_at", since)
      .not("text", "is", null)
      .order("created_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as typeof rows));
    if (data.length < 1000) break;
  }

  // 目で見た正解: テンプレートの見出しか項目名が本文にある＝うちのフォーマットの返信
  const looksLikeForm = (t: string) => /【ご入居の時期】|お部屋探しご条件/.test(t);

  let hit = 0, miss = 0, falsePositive = 0;
  const missSamples: string[] = [];
  const fpSamples: string[] = [];
  for (const m of rows) {
    const v = analyzeSumoraForm(m.text);
    const looks = looksLikeForm(m.text);
    if (v.isFilledForm && looks) hit++;
    else if (!v.isFilledForm && looks) {
      // 空のまま返した（記入なし）は拾わないのが正しいので、記入があるのに落ちた物だけ数える
      if (/[⇒→](?![\s]*$)[^\n]*\S/.test(m.text)) { miss++; if (missSamples.length < 5) missSamples.push(m.text.replace(/\n/g, " ").slice(0, 150)); }
    } else if (v.isFilledForm && !looks) {
      falsePositive++;
      if (fpSamples.length < 8) fpSamples.push(m.text.replace(/\n/g, " ").slice(0, 150));
    }
  }

  console.log(`お客様メッセージ ${rows.length} 通（直近 ${DAYS} 日）`);
  console.log(`  うちのフォーマット（記入あり）として拾った: ${hit} 通`);
  console.log(`  拾い漏れ（フォームらしいのに落ちた）      : ${miss} 通`);
  console.log(`  誤発火（フォームでないのに拾った）        : ${falsePositive} 通\n`);
  if (missSamples.length) { console.log("── 拾い漏れの例"); for (const s of missSamples) console.log("  " + s); console.log(); }
  if (fpSamples.length) { console.log("── 誤発火の例（これがあれば判定が甘い）"); for (const s of fpSamples) console.log("  " + s); }
}

main().catch((e) => { console.error(e); process.exit(1); });

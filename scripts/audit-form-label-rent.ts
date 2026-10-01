// scripts/audit-form-label-rent.ts
// 2026-10-02 ⑫（竹内「DEEPSEEKで一連の流れを実際にYUMAにLINEで送りまくって、弱い部分あるか見つける」）の1巡目で見つけた穴:
//   お客様が家賃を「②【ご希望の家賃（7万円〜10万円）】⇒」のように見出しの括弧の ◯ を数字に書き換えて答える形を、
//   analyzeSumoraForm が「家賃は空欄」と読み → pickupConditionsReady が家賃なし → ブレインの 物件ピックアップ を 条件ヒアリング に倒していた
//   （再生 thanks_06・スタッフは 物件オススメ を送っていた）。
// 365日のお客様の発言で、家賃の見出しの括弧の中に数字がある通を全部数え、矢印の後ろが空か・括弧の中が本当にお客様の値かを目で読む。
// 読むだけ・LLM なし。実行: npx tsx --env-file=.env.local scripts/audit-form-label-rent.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { analyzeSumoraForm } from "../app/lib/condition-format";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=365").slice(7));

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; text: string; created_at: string; sender: string }> = [];
  for (let f = 0; f < 400_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, created_at, sender").gte("created_at", since).ilike("text", "%家賃%").order("created_at").range(f, f + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  let forms = 0, labelDigits = 0, emptyAfter = 0, nowMissed = 0;
  const staffTemplateDigits = new Map<string, number>();
  for (const r of rows) {
    const t = String(r.text ?? "");
    const f = analyzeSumoraForm(t);
    if (f.labelCount < 3) continue;
    const line = t.split("\n").find((l) => /ご?希望(?:の)?家賃|家賃帯/.test(l.slice(0, Math.max(0, l.indexOf("】") + 1) || l.length)));
    if (!line) continue;
    const paren = line.match(/[（(]([^）)]*)[）)]/)?.[1] ?? "";
    if (r.sender !== "customer") { if (/[0-9０-９]/.test(paren)) staffTemplateDigits.set(paren, (staffTemplateDigits.get(paren) ?? 0) + 1); continue; }
    forms++;
    if (!/[0-9０-９]/.test(paren)) continue;
    labelDigits++;
    const after = line.includes("】") ? line.slice(line.indexOf("】") + 1).replace(/^[\s⇒→=＝:：]+/, "").trim() : "";
    if (!after) emptyAfter++;
    if (!f.filled.includes("rent")) nowMissed++;
    console.log(`${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 10)} 括弧「${paren}」 後ろ「${after}」 今の判定=${f.filled.includes("rent") ? "記入あり" : "空欄"}`);
  }
  console.log(`\nお客様のフォーム ${forms}通・家賃の見出しの括弧に数字 ${labelDigits}・うち矢印の後ろが空 ${emptyAfter}・今は空欄と読む ${nowMissed}`);
  console.log(`スタッフの送る見出しの括弧に数字（テンプレートそのものに数字がある形）: ${JSON.stringify([...staffTemplateDigits])}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

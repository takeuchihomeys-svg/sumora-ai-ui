// scripts/audit-form-next-line-value.ts
// 2026-10-02 ⑫ の1巡目で見つけた穴（再生 pet_parking_36・c795e4d7 9/20）: お客様が「②【ご希望の家賃（◯万円〜◯万円）】⇒」の行を矢印で終え、
//   値を次の行（「〜11万」「大国町、日本橋…」）に書く形を analyzeSumoraForm が空欄と読む（次の行が矢印で始まる形だけ読んでいた）
//   → 家賃・エリアなし → rule:conditions_incomplete_hearing が 物件ピックアップ を 条件ヒアリング に倒した（スタッフは初回で条件を復唱済み）。
// 365日のお客様のフォームで「見出しの行が矢印で終わり・次の行が見出しでない文字」の行を全部数え、次の行が本当にその項目の値かを目で読む。
// 読むだけ・LLM なし。実行: npx tsx --env-file=.env.local scripts/audit-form-next-line-value.ts [--days=365] [--show=80]
import { createClient } from "@supabase/supabase-js";
import { analyzeSumoraForm, SUMORA_FORM_LABELS } from "../app/lib/condition-format";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "365"));
const SHOW = Number(arg("show", "80"));
const isLabel = (l: string) => { const head = l.includes("】") ? l.slice(0, l.indexOf("】") + 1) : (l.match(/^(.*?)[⇒→=＝:：]/)?.[1] ?? l); return SUMORA_FORM_LABELS.some((x) => x.re.test(head)); };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; text: string; created_at: string }> = [];
  for (let f = 0; f < 400_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, created_at").eq("sender", "customer").gte("created_at", since).ilike("text", "%】%").order("created_at").range(f, f + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  let forms = 0, cands = 0, missedNow = 0, shown = 0;
  const byKey = new Map<string, number>();
  for (const r of rows) {
    const t = String(r.text ?? "");
    const f = analyzeSumoraForm(t);
    if (f.labelCount < 3) continue;
    forms++;
    const lines = t.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const l = lines[i];
      if (!isLabel(l) || !l.includes("】")) continue;
      const after = l.slice(l.indexOf("】") + 1);
      if (!/^[\s]*[⇒→=＝:：][\s]*$/.test(after)) continue; // 見出しの行が矢印で終わる
      const next = lines[i + 1].trim();
      if (!next || isLabel(next) || /^[_＿ー-]{4,}|^※/.test(next) || /^[⇒→=＝:：]/.test(next)) continue;
      cands++;
      const key = SUMORA_FORM_LABELS.find((x) => x.re.test(l.slice(0, l.indexOf("】") + 1)))?.key ?? "?";
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
      if (!f.filled.includes(key)) missedNow++;
      if (shown++ < SHOW) console.log(`${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 10)} [${key}] 「${l.trim().slice(0, 30)}」→ 次の行「${next.slice(0, 40)}」 今=${f.filled.includes(key) ? "記入あり" : "空欄"}`);
    }
  }
  console.log(`\nお客様のフォーム ${forms}通・見出しの行が矢印で終わり次の行に文字 ${cands}行（項目別 ${JSON.stringify([...byKey])}）・今は空欄と読む ${missedNow}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

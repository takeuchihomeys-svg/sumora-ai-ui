// 作業メモ判定の「お客様への言葉の特徴」から【…】の中身（絵文字入りの印）を外す変更の誤削除監査
//
// 2026-09-23 YUMA の DeepSeek 実測で、下書きの先頭に
//   「「緊急連絡先は必ず必要ですか？」への返信です。会話履歴（【🏢】ブロック）にある会社の確定事実に基づき、疑問に直接答えます。」
//   「【✅ 確認対象（決定論）】と【🔗 写真/URL要求検出】を踏まえ、室内写真の要求には受付・確認の一言のみで返します。」
// が残った。形の判定（isPlainNarrationLine）は絵文字を「お客様への言葉の特徴」と見るため、
// **システムの印【🏢】の中の絵文字**で作業メモがお客様向けと誤認されていた。
//
// この監査: スタッフの実送信（365日・全件）と AI 下書きに stripMetaNarration を当て、変わる通を全部出す。
//   変更前後で2回走らせ、増えた通を目で読む（件数だけで判断しない）。読み取りのみ。
// 実行: npx tsx --env-file=.env.local scripts/audit-meta-bracket-emoji.ts [--days=365] [--show=30]
import { createClient } from "@supabase/supabase-js";
import { stripMetaNarration } from "../app/lib/meta-narration";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "365"));
const SHOW = Number(arg("show", "30"));

async function all(table: string, cols: string, filter: (q: any) => any): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(sb.from(table).select(cols)).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as Array<Record<string, unknown>>));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const sent = await all("messages", "id, text", (q) => q.eq("sender", "staff").gte("created_at", since).not("text", "is", null));
  const drafts = await all("conversations", "id, ai_draft", (q) => q.not("ai_draft", "is", null));
  const report = (label: string, rows: Array<Record<string, unknown>>, key: string) => {
    const changed: Array<{ id: string; removed: string[] }> = [];
    for (const r of rows) {
      const t = String(r[key] ?? "");
      if (!t) continue;
      const m = stripMetaNarration(t);
      if (m.text !== t) changed.push({ id: String(r.id), removed: m.removed });
    }
    console.log(`\n=== ${label}: ${rows.length}件のうち stripMetaNarration で変わる通 ${changed.length} ===`);
    for (const c of changed.slice(0, SHOW)) console.log(`  ${c.id.slice(0, 8)}  落ちた行: ${c.removed.map((s) => s.replace(/[0-9]/g, "#").slice(0, 70)).join(" ／ ")}`);
    return changed;
  };
  const a = report(`スタッフ実送信（${DAYS}日）`, sent, "text");
  const b = report("AI 下書き（conversations.ai_draft）", drafts, "ai_draft");
  console.log(`\n合計: 実送信で変わる ${a.length} ／ 下書きで変わる ${b.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

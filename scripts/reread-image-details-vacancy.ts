// scripts/reread-image-details-vacancy.ts — 今日の読み直しで書いた資料の画像の中身の行のうち、取り違えの型に当たる物を直した読み方（SHEET_READ_R2）で読み直す（本番 DB に書く）
// 2026-10-13 竹内さん承認。型（目読みで見つけた物）:
//   ・現況が退去予定・空き予定なのに退去の日付の行が無い（備考・特記事項・案内方法の「9/30退去予定」「8月末空き予定」を落とした）
//   ・入居可能日に「即日指定」「期日指定」（字の書き換え）
// 読めた時だけ書く（読めなかった物は今の行を残す）。申込以降の線は送った時刻で見る（ensureImageDetail と同じ線）。
// 実行: npx tsx --env-file=.env.local scripts/reread-image-details-vacancy.ts [--since=2026-10-13T00:15:00Z] [--limit=400] [--conc=6] [--apply]
// 既定は数えるだけ（LLM も DB の書き込みもしない）。読み直して書くのは --apply の時だけ（2026-10-13 レビュー: fix-sheet-vacancy-stored と同じ形）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];

async function main() {
  const { readPropertyImageDetailByTranscript } = await import("../app/lib/property-image-read");
  const { loadDeepseekCutoff, isAfterCutoff } = await import("../app/lib/post-apply");
  const { supabase } = await import("../app/lib/supabase-server");
  const rows: Array<{ image_url: string; conversation_id: string | null; lines: unknown }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("image_details").select("image_url, conversation_id, lines").gte("read_at", arg("since", "2026-10-13T00:15:00Z")).range(f, f + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const target = rows.filter((r) => {
    const ls = Array.isArray(r.lines) ? (r.lines as string[]) : [];
    const st = ls.find((l) => /^現況/.test(l)) ?? "";
    const mv = ls.find((l) => /^入居可能日/.test(l)) ?? "";
    const vacNoDate = /退去予定|空き?予定/.test(st) && !ls.some((l) => /^退去予定\s*[:：]/.test(l)) && !/\d/.test(st);
    return vacNoDate || /即日指定|期日指定/.test(mv);
  }).slice(0, Number(arg("limit", "400")));
  console.log(`今日の中身の行 ${rows.length}・読み直す型 ${target.length}`);
  if (!process.argv.includes("--apply")) { console.log("（数えるだけ。読み直して書く時は --apply・竹内さんの承認の後）"); return; }
  let ok = 0, skip = 0, fail = 0, changed = 0; let idx = 0;
  async function worker() {
    while (idx < target.length) {
      const r = target[idx++];
      const { data: sip } = await sb.from("sent_image_properties").select("created_at").eq("image_url", r.image_url).maybeSingle();
      if (r.conversation_id && !isAfterCutoff((sip as { created_at?: string } | null)?.created_at ?? new Date().toISOString(), await loadDeepseekCutoff(supabase, r.conversation_id))) { skip++; continue; }
      const d = await readPropertyImageDetailByTranscript(r.image_url, { timeoutMs: 90_000, conversationId: r.conversation_id });
      if (d.kind !== "property" || d.lines.length === 0) { fail++; continue; }
      if (JSON.stringify(d.lines) !== JSON.stringify(r.lines)) changed++;
      const { error } = await sb.from("image_details").update({ lines: d.lines, kind: d.kind, read_at: new Date().toISOString() }).eq("image_url", r.image_url);
      if (!error) ok++;
    }
  }
  const t0 = new Date().toISOString();
  await Promise.all(Array.from({ length: Number(arg("conc", "6")) }, () => worker()));
  console.log(`読み直して書いた ${ok}（行が変わった ${changed}）・申込以降で飛ばした ${skip}・読めず ${fail}・開始 ${t0}`);
}
main().then(() => setTimeout(() => process.exit(0), 1500)).catch((e) => { console.error(e); process.exit(1); });

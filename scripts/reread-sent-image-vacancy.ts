// scripts/reread-sent-image-vacancy.ts — 送った資料の画像の中身の行（image_details・元の文字が保存されていない物）のうち、
// 現況・退去予定・入居可能日の取り違えの型に当たる行を、今の読み方（書き写し → 文字の読み取り → 欄で合わせる）で読み直す。
//
// 2026-10-13 竹内さん承認（物件資料の読み直しの B）。fix-sheet-vacancy-stored.ts の (C) と同じ対象:
//   ・送った画像（/property-images/）だけ。売上サポの画像（文字層がある＝(A)(B) で LLM なしに直した物）は読まない
//   ・型: 現況が退去予定・空き予定で退去日の行なし／入居可能日に即日指定・期日指定／入居可能日に退去・解約の字／退去予定の行が年月日で入居可能日なし
//   ・申込以降・線より前は読まない（送った時刻で loadDeepseekCutoff）
// 既定は数えるだけ（LLM も DB の書き込みもしない）。--apply の時だけ読んで書く。読めた時だけ書く（読めなかった物は今の行を残す）。
// 再開: 書いた行は read_at が新しくなる → 同じ --before（既定は「最初に流した時刻」を指定する）で流し直すと済んだ行を飛ばして続きから。
//   進み具合は1枚ごとに1行出る（バックグラウンドで流して tail で見る）。
// 実行（数えるだけ）: npx tsx --env-file=.env.local scripts/reread-sent-image-vacancy.ts [--days=90]
//      （書く）     : npx tsx --env-file=.env.local scripts/reread-sent-image-vacancy.ts --apply --before=2026-10-13T14:30:00Z [--days=90] [--conc=2] [--limit=300]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");

/** (C) の型（fix-sheet-vacancy-stored.ts と同じ）。当たらなければ null */
export function rereadKind(ls: string[]): string | null {
  const st = ls.find((l) => /^現況/.test(l)) ?? "", mv = ls.find((l) => /^入居可能日/.test(l)) ?? "", vc = ls.find((l) => /^退去予定\s*[:：]/.test(l)) ?? "";
  if (/退去予定|空き?予定/.test(st) && !vc && !/\d/.test(st)) return "現況が退去予定・空き予定で退去日の行なし";
  if (/即日指定|期日指定/.test(mv)) return "入居可能日に即日指定・期日指定";
  if (/退去|解約/.test(mv)) return "入居可能日に退去・解約の字";
  if (/\d{4}年/.test(vc) && !mv) return "退去予定の行が年月日で入居可能日なし";
  return null;
}

async function main() {
  const days = Number(arg("days", "90")), apply = process.argv.includes("--apply");
  const before = arg("before", new Date().toISOString());
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<{ image_url: string; conversation_id: string | null; lines: unknown; read_at: string }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("image_details").select("image_url, conversation_id, lines, read_at").eq("kind", "property")
      .like("image_url", "%/property-images/%").gte("read_at", since).range(f, f + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const kinds: Record<string, number> = {};
  let done = 0;
  const target = rows.flatMap((r) => {
    const k = rereadKind(Array.isArray(r.lines) ? (r.lines as unknown[]).map(String) : []);
    if (!k) return [];
    if (r.read_at >= before) { done++; return []; } // もう読み直した（再開）
    kinds[k] = (kinds[k] ?? 0) + 1;
    return [{ ...r, kind: k }];
  }).slice(0, Number(arg("limit", "1000")));
  console.log(`送った資料の画像の中身の行（${days}日）${rows.length}・読み直す ${target.length}（読み直し済みで飛ばす ${done}・--before=${before}）`);
  console.log(`  型: ${JSON.stringify(kinds)}`);
  console.log(`  見込み: DeepSeek 書き写し＋文字の読み取り 1枚 約$0.001〜0.002 ＝ 約$${(target.length * 0.0015).toFixed(2)}・1枚 10〜20秒 ÷ 並び ${arg("conc", "2")} ＝ 約${Math.ceil(target.length * 15 / Number(arg("conc", "2")) / 60)}分`);
  if (!apply) { console.log("（数えるだけ。読み直して書く時は --apply --before=<最初に流した時刻>）"); return; }

  const { readPropertyImageDetailByTranscript } = await import("../app/lib/property-image-read");
  const { detailModelLabel } = await import("../app/lib/property-detail-source");
  const { loadDeepseekCutoff, isAfterCutoff } = await import("../app/lib/post-apply");
  const { supabase } = await import("../app/lib/supabase-server");
  const model = (process.env.PROPERTY_IMAGE_MODEL ?? "deepseek-flash").trim();
  const t0 = new Date().toISOString();
  console.log(`開始 ${t0}（再開する時は --before=${before} をそのまま付ける）`);
  const res = { ok: 0, changed: 0, skip: 0, fail: 0, gone: 0 };
  let idx = 0, n = 0;
  async function worker() {
    while (idx < target.length) {
      const r = target[idx++];
      const no = ++n;
      try {
        const head = await fetch(r.image_url, { method: "HEAD" }).catch(() => null);
        if (!head?.ok) { res.gone++; console.log(`[${no}/${target.length}] 置き場に無い ${r.image_url.slice(-36)}`); continue; }
        const { data: sip } = await sb.from("sent_image_properties").select("created_at").eq("image_url", r.image_url).order("created_at", { ascending: true }).limit(1);
        const sentAt = ((sip ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? r.read_at;
        if (r.conversation_id && !isAfterCutoff(sentAt, await loadDeepseekCutoff(supabase, r.conversation_id))) { res.skip++; console.log(`[${no}/${target.length}] 申込以降・線より前で飛ばす ${r.image_url.slice(-36)}`); continue; }
        const d = await readPropertyImageDetailByTranscript(r.image_url, { timeoutMs: 90_000, conversationId: r.conversation_id });
        if (d.kind !== "property" || d.lines.length === 0) { res.fail++; console.log(`[${no}/${target.length}] 読めず（今の行を残す） ${r.image_url.slice(-36)}`); continue; }
        const before0 = (Array.isArray(r.lines) ? (r.lines as unknown[]).map(String) : []).filter((l) => /^(現況|退去予定|入居可能日|内覧可能日)/.test(l));
        const after = d.lines.filter((l) => /^(現況|退去予定|入居可能日|内覧可能日|入居の別の記載)/.test(l));
        const changed = JSON.stringify(before0) !== JSON.stringify(after);
        const { error } = await sb.from("image_details").update({ lines: d.lines, kind: d.kind, model: detailModelLabel(d.via === "transcribe" ? "transcribe" : "image", model), read_at: new Date().toISOString() }).eq("image_url", r.image_url);
        if (error) { res.fail++; console.log(`[${no}/${target.length}] 書けず ${error.message}`); continue; }
        res.ok++; if (changed) res.changed++;
        console.log(`[${no}/${target.length}] ${changed ? "変わった" : "同じ"} ${r.image_url.slice(-36)}  前: ${before0.join(" ／ ") || "（なし）"}  後: ${after.join(" ／ ") || "（なし）"}`);
      } catch (e) {
        res.fail++; console.log(`[${no}/${target.length}] 失敗 ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Number(arg("conc", "2"))) }, () => worker()));
  console.log(`\n読み直して書いた ${res.ok}（現況・退去予定・入居可能日が変わった ${res.changed}）・申込以降で飛ばした ${res.skip}・読めず ${res.fail}・置き場に無い ${res.gone}・開始 ${t0}（費用は llm_usage_logs の property_image_transcribe / property_text_detail をこの時刻から）`);
}
main().then(() => setTimeout(() => process.exit(0), 1500)).catch((e) => { console.error(e); process.exit(1); });

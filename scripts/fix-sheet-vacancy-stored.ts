// scripts/fix-sheet-vacancy-stored.ts — 保存済みの資料の読み取りの行（現況・退去予定・入居可能日）を、資料の欄で読んだ値に直す案（既定は数えるだけ・--apply で本番 DB に書く）
//
// 2026-10-13 竹内「退去予定日がどこに書いていて…読み取る箇所を間違えていた部分等も」の既存データの直し。
//   (A) 売上サポの行 property_pickups.image_lines … 同じ行の文字層（pdf_text）の欄に合わせる（alignVacancyLines・LLM なし・$0）
//   (B) その行の画像の image_details（売上サポの画像 URL＝page/agent/trim）… 同じく文字層の欄に合わせる（LLM なし・$0）
//   (C) 送った画像の image_details（元の文字が保存されていない）… 欄に合わせられないので、取り違えの型に当たる行を数え、
//       読み直す（書き写し→文字の読み取り・DeepSeek 1枚 約$0.002）対象として出す。読み直しは scripts/reread-image-details-vacancy.ts（--since を広げて）
//   ⚠ 書くのは竹内さんの承認の後（--apply）。--apply の前に --show で前後を目で読む。
// 実行: npx tsx --env-file=.env.local scripts/fix-sheet-vacancy-stored.ts [--days=90] [--show=10] [--apply]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const VAC = /^(現況|退去予定|入居可能日|内覧可能日)/;

async function main() {
  const days = Number(arg("days", "90")), show = Number(arg("show", "10")), apply = process.argv.includes("--apply");
  const { alignVacancyLines } = await import("../app/lib/sheet-vacancy");
  const { normalizeVacancyLines } = await import("../app/lib/property-detail-source");
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Pk = { id: number; pdf_text: string | null; image_lines: unknown; page_image_url: string | null; agent_image_url: string | null; trim_image_url: string | null };
  const rows: Pk[] = [];
  for (let f = 0; ; f += 500) {
    const { data, error } = await sb.from("property_pickups").select("id, pdf_text, image_lines, page_image_url, agent_image_url, trim_image_url").gte("created_at", since).not("pdf_text", "is", null).range(f, f + 499);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Pk[]));
    if (!data || data.length < 500) break;
  }
  const fix = (lines: string[], text: string | null) => normalizeVacancyLines(alignVacancyLines(lines, text).lines);
  let aChanged = 0, aWritten = 0, shown = 0, lostVac = 0, lostOther = 0;
  const urlText = new Map<string, string>();
  for (const r of rows) {
    for (const u of [r.page_image_url, r.agent_image_url, r.trim_image_url]) if (u && r.pdf_text) urlText.set(u, r.pdf_text);
    const il = Array.isArray(r.image_lines) ? (r.image_lines as unknown[]).map(String) : [];
    if (!il.length) continue;
    const next = fix(il, r.pdf_text);
    if (JSON.stringify(next) === JSON.stringify(il)) continue;
    aChanged++;
    // 退去予定の行が消える行（入居時期を退去予定にした行のはず）を数え、入居時期と同じ値でない物は見せる
    const vOf = (ls: string[]) => ls.find((l) => /^退去予定\s*[:：]/.test(l))?.replace(/^[^:：]+[:：]\s*/, "") ?? null;
    const mOf = (ls: string[]) => ls.find((l) => /^入居可能日\s*[:：]/.test(l))?.replace(/^[^:：]+[:：]\s*/, "") ?? null;
    if (vOf(il) && !vOf(next)) { lostVac++; if (mOf(next)?.replace(/\s/g, "") !== vOf(il)?.replace(/\s/g, "")) { lostOther++; console.log(`(A!) #${r.id} 退去予定「${vOf(il)}」が消えた・入居可能日「${mOf(next) ?? "なし"}」`); } }
    if (shown++ < show) console.log(`(A) #${r.id}\n    前: ${il.filter((l) => VAC.test(l)).join(" ／ ") || "（なし）"}\n    後: ${next.filter((l) => VAC.test(l)).join(" ／ ") || "（なし）"}`);
    if (apply) { const { error } = await sb.from("property_pickups").update({ image_lines: next }).eq("id", r.id); if (!error) aWritten++; }
  }
  // (B)(C) image_details
  const det: Array<{ image_url: string; lines: unknown; model: string | null }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("image_details").select("image_url, lines, model").eq("kind", "property").gte("read_at", since).range(f, f + 999);
    if (error) throw new Error(error.message);
    det.push(...((data ?? []) as typeof det));
    if (!data || data.length < 1000) break;
  }
  let bChanged = 0, bWritten = 0; shown = 0;
  const reread: Record<string, number> = { "現況が退去予定・空き予定で退去日の行なし": 0, "入居可能日に即日指定・期日指定": 0, "入居可能日に退去・解約の字": 0, "退去予定の行が年月日で入居可能日なし（入居時期を写した恐れ）": 0 };
  const rereadUrls = new Set<string>();
  for (const d of det) {
    const ls = Array.isArray(d.lines) ? (d.lines as unknown[]).map(String) : [];
    const text = urlText.get(d.image_url);
    if (text) {
      const next = fix(ls, text);
      if (JSON.stringify(next) !== JSON.stringify(ls)) {
        bChanged++;
        if (shown++ < show) console.log(`(B) ${d.image_url.slice(-40)}\n    前: ${ls.filter((l) => VAC.test(l)).join(" ／ ")}\n    後: ${next.filter((l) => VAC.test(l)).join(" ／ ")}`);
        if (apply) { const { error } = await sb.from("image_details").update({ lines: next }).eq("image_url", d.image_url); if (!error) bWritten++; }
      }
      continue;
    }
    const st = ls.find((l) => /^現況/.test(l)) ?? "", mv = ls.find((l) => /^入居可能日/.test(l)) ?? "", vc = ls.find((l) => /^退去予定\s*[:：]/.test(l)) ?? "";
    const hit = (k: string) => { reread[k]++; rereadUrls.add(d.image_url); };
    if (/退去予定|空き?予定/.test(st) && !vc && !/\d/.test(st)) hit("現況が退去予定・空き予定で退去日の行なし");
    if (/即日指定|期日指定/.test(mv)) hit("入居可能日に即日指定・期日指定");
    if (/退去|解約/.test(mv)) hit("入居可能日に退去・解約の字");
    if (/\d{4}年/.test(vc) && !mv) hit("退去予定の行が年月日で入居可能日なし（入居時期を写した恐れ）");
  }
  console.log(`\n(A) 売上サポの行（文字層あり・${days}日）${rows.length}行のうち 行が変わる ${aChanged}（退去予定の行が消える ${lostVac}・うち入居時期と同じ値でない ${lostOther}）${apply ? `・書いた ${aWritten}` : ""}`);
  console.log(`(B) 売上サポの画像の image_details ${[...urlText.keys()].length}枚の URL のうち 行が変わる ${bChanged}${apply ? `・書いた ${bWritten}` : ""}`);
  console.log(`(C) 送った画像の image_details（元の文字なし）で読み直す候補 ${rereadUrls.size}枚: ${JSON.stringify(reread)}（読み直し 1枚 約$0.002 ＝ 約$${(rereadUrls.size * 0.002).toFixed(2)}）`);
  if (!apply) console.log("（数えるだけ。書く時は --apply・竹内さんの承認の後）");
}
main().catch((e) => { console.error(e); process.exit(1); });

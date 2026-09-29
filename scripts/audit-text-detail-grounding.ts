// scripts/audit-text-detail-grounding.ts — 文字層の読み取りの行に dropUngroundedLines を当て、落ちる行を目で読む（誤削除0の確認）
//
// 2026-09-29: 文字層の読み取り（property_text_detail・推論なし）が文字層に言葉の無い可否（「ペット: 不可」）を作っていた。
//   出口で「可否の項目で文字層にその言葉が1つも無い行」を落とす前に、本番の行（売上サポの image_lines・文字層から読んだ物）に当てて、
//   落ちる行が本当に文字層に無いか（書き方の違い・康煕部首で見落としていないか）を1行ずつ出す。⚠ DB には書かない。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-text-detail-grounding.ts [--since=2026-09-29T07:30:00Z] [--limit=400]
import { supabase as sb } from "../app/lib/supabase";
import { dropUngroundedLines, DETAIL_TEXT_MAX_CHARS, detailSourceFor } from "../app/lib/property-detail-source";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const SINCE = arg("since", "2026-09-29T07:30:00Z");   // 9/29 16:30 JST（文字層の読み取りの本番反映）より後の行
const LIMIT = Number(arg("limit", "400"));

async function main() {
  const { data, error } = await sb.from("property_pickups").select("id, property_name, room_no, pdf_text, image_lines, created_at")
    .gte("created_at", SINCE).not("pdf_text", "is", null).not("image_lines", "is", null).order("created_at", { ascending: false }).limit(LIMIT);
  if (error) throw new Error(error.message);
  let rows = 0, lines = 0, dropped = 0; const byLabel: Record<string, number> = {};
  for (const r of (data ?? []) as Array<{ id: number; property_name: string; room_no: string | null; pdf_text: string; image_lines: unknown }>) {
    if (!Array.isArray(r.image_lines) || detailSourceFor(r.pdf_text, false) !== "text") continue;   // 文字層から読んだ行だけ
    rows++;
    const ls = (r.image_lines as unknown[]).map(String);
    lines += ls.length;
    const g = dropUngroundedLines(ls, r.pdf_text.slice(0, DETAIL_TEXT_MAX_CHARS));
    if (g.dropped.length === 0) continue;
    dropped += g.dropped.length;
    for (const l of g.dropped) { const k = l.split(/[:：]/)[0]; byLabel[k] = (byLabel[k] ?? 0) + 1; }
    console.log(`■ #${r.id} ${r.property_name} ${r.room_no ?? ""}  落ちる: ${g.dropped.join(" ／ ")}`);
  }
  console.log(`\n=== 文字層から読んだ行 ${rows}件・${lines}行のうち落ちる ${dropped}行（${Object.entries(byLabel).map(([k, n]) => `${k}${n}`).join("・")}）===`);
  console.log("（落ちる行の項目の言葉が文字層に本当に無いかは scripts の出力の #id で pdf_text を開いて確かめる）");
}
main().catch((e) => { console.error(e); process.exit(1); });

// scripts/verify-extract-vacancy-date.ts — AIX【物件確認した】の画像から退去予定日を読む（/api/extract-vacancy-date・Claude Haiku）を、
// 取り違えやすい物件資料の画像（物件の資料だけ・個人情報なし）で前（SHEET_VACANCY_FIELDS=off＝Haiku に判断させる）と後（欄を書き写す→sheet-vacancy）で比べる（DB に書かない）。
// 1枚ずつ順に。Haiku 1回 約$0.002（usage から計算して出す）。
// 実行: npx tsx --env-file=.env.local scripts/verify-extract-vacancy-date.ts [--modes=before,after]
import Anthropic from "@anthropic-ai/sdk";
const B = "https://wfwsmwxakhyxobytszoq.supabase.co/storage/v1/object/public/property-images/aix";
const P = "https://eggcrp3ajyl21x7a.public.blob.vercel-storage.com/pickups";
const SAMPLES = [
  { id: "b1", url: `${P}/%E7%89%A9%E4%BB%B6%E3%81%BE%E3%81%A8%E3%82%81_2026-9-28_1790573595220_1_1790573598428_p2.png`, want: null, note: "退去予定 / 2026年10月20日（入居時期）" },
  { id: "b2", url: `${P}/%E7%89%A9%E4%BB%B6%E3%81%BE%E3%81%A8%E3%82%81_2026-9-28_1790573653849_7_1790573658787_p2.png`, want: null, note: "退去予定 / 2026年11月28日（入居時期）" },
  { id: "s5", url: `${B}/f193d13d-7da3-4460-ae4e-25d9bed5a8e8/1789743123164_05fjy.jpeg`, want: "9月30日", note: "備考【現況】空き予定(9/30退去予定)" },
  { id: "a5", url: `${B}/ba1527de-d06a-4d4e-a889-2977b0d78e04/1787741261812_0_xgyjb.png`, want: "8月末", note: "案内方法 8月末空き予定・入居時期 期日指定(2026年09月上旬)" },
];
async function main() {
  const { extractVacancyDateSystem, parseExtractVacancyResponse, EXTRACT_VACANCY_USER_TEXT } = await import("../app/lib/extract-vacancy-date-prompt");
  const modes = (process.argv.find((a) => a.startsWith("--modes=")) ?? "--modes=before,after").slice(8).split(",");
  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let inTok = 0, outTok = 0, n = 0;
  for (const mode of modes) {
    const env: Record<string, string> = mode === "before" ? { SHEET_VACANCY_FIELDS: "off" } : {};
    const system = extractVacancyDateSystem(env);
    let ok = 0;
    for (const s of SAMPLES) {
      const img = await fetch(s.url); const buf = Buffer.from(await img.arrayBuffer());
      const mt = s.url.endsWith(".png") ? "image/png" : "image/jpeg";
      const r = await ai.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: mode === "before" ? 128 : 600, system,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } }, { type: "text", text: mode === "before" ? "この物件資料から物件名と退去予定日を抽出してください。" : EXTRACT_VACANCY_USER_TEXT }] }] });
      n++; inTok += r.usage.input_tokens; outTok += r.usage.output_tokens;
      const t = r.content.find((b) => b.type === "text") as { text: string } | undefined;
      const pr = parseExtractVacancyResponse(t?.text ?? "", env);
      const got = pr.vacancyDate;
      const right = got === s.want;
      if (right) ok++;
      console.log(`[${mode}] ${s.id} ${right ? "○" : "✕"} got=${got} want=${s.want}（${s.note}）${pr.fields ? `\n   写し: ${pr.fields.join(" ／ ")}` : ""}`);
    }
    console.log(`[${mode}] ${ok}/${SAMPLES.length}`);
  }
  // Haiku 4.5: 入力 $1/MTok・出力 $5/MTok
  console.log(`Haiku ${n}回・入力 ${inTok}・出力 ${outTok}・約 $${(inTok / 1e6 * 1 + outTok / 1e6 * 5).toFixed(4)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

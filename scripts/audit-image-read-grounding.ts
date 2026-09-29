// scripts/audit-image-read-grounding.ts — 画像の読み取りの行が「資料に書いてあるか」を PDF の文字層で確かめる（作った行・落ちた行）
//
// 2026-09-29 竹内「更に節約できないか」（送る側の画像の読み取り・scripts/audit-sent-image-combined-read.ts の続き）:
//   保存済みの行どうしを比べる監査では、旧の読み方（推論あり）も「楽器: 不可」を作っていた（資料に楽器の欄が無い）ので、
//   保存済みを正解にできない。売上サポの行は同じ資料の PDF の文字層（pdf_text）を持っているので、それを正解の元にする:
//     作った行 … 行の項目（ペット・楽器・連帯保証人…）の見出しが文字層のどこにも無い（＝資料に書いていない可否を作った）
//     落ちた行 … 文字層に見出しがあるのに行が無い（洗濯機置場・駐輪場・保証会社…）
//   読み方の案を同じ画像（agent_image_url＝元付の資料）で並べる:
//     old    … 旧の条件の行の読み方（推論 low・readPropertyImageDetail）
//     both   … 1回で両方（推論なし・PROPERTY_IMAGE_BOTH_PROMPT・今の本番）
//     detailNR … 旧の条件の行の指示のまま推論なし（比較用）
//     text   … 文字層の読み取り（readPropertyDetailFromText・売上サポの行の property_text_detail）
//   ⚠ DB には書かない。件数は --n（既定 24）で最小に。鍵は表示しない。
//   【結果 2026-09-29・24件】old（推論 low）作った 1〜5・落ちた 15〜27／97 ／ detailNR（推論なし）作った 33（ペット10・楽器11・連帯保証人9＝例の「ペット: 不可」を写す）
//     ／ both（1回で両方・推論なし・例を可否でない物に）作った 6〜10・落ちた 30〜49 ／ text（文字層）作った 4〜6 → 出口で dropUngroundedLines を足して 0。
//     → 画像の条件の行は推論 low のまま（本番）。文字層の読み取りには言葉の無い可否を落とす出口を足した。
//   【結果 2026-09-29（その2）・30件】ocr（書き写し→文字の読み取り・readPropertyImageDetailByTranscript＝本番と同じ関数）:
//     old（推論 low）作った 4（フリーレント4）・落ちた 28/119・出力 6,223・31秒 ／ ocr 作った 0〜4・落ちた 22〜26/124・出力 1,055〜1,434・13〜15秒（指示の版を替えて3回）
//     作った行の中身: #1357「ペット: 不可」（※プレサポ安心24 の読み違い・推論 low も同じ所を「ペット飼育不可」と読む）・#1652「楽器相談」「保証人不要」・#1360「フリーレント」（ファイテック）
//     → 送った画像の条件の行を ocr にした（property-image-read.ts の④）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-image-read-grounding.ts [--n=24] [--v=old,both] [--show]
import { createClient } from "@supabase/supabase-js";
import { PROPERTY_IMAGE_DETAIL_PROMPT, parseDetailResult, readPropertyImageDetail } from "../app/lib/property-image-read";
import { PROPERTY_IMAGE_BOTH_PROMPT, parseBothResult } from "./audit-image-both-prompt";
import { callDeepSeek } from "../app/lib/vision-alt-provider";
import { readPropertyDetailFromText } from "../app/lib/property-detail-source";
import { readPropertyImageDetailByTranscript } from "../app/lib/property-image-read";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const N = Number(arg("n", "24"));
const VARIANTS = arg("v", "old,both").split(",").filter(Boolean);
const SHOW = process.argv.includes("--show");

/** 項目 → 文字層でその項目が「書いてある」と言える見出し（どれか1つ）。可否の項目だけ見る（設備・入居条件・構造などは書き方が自由なので見ない） */
export const GROUND_KEYS: Record<string, RegExp> = {
  ペット: /ペット|犬|猫/,
  楽器: /楽器|ピアノ/,
  連帯保証人: /保証人/,
  駐車場: /駐車/,
  駐輪場: /駐輪|自転車/,
  バイク置場: /バイク|原付|二輪|オートバイ/,
  洗濯機置場: /洗濯/,
  フリーレント: /フリーレント/,
  保証会社: /保証/,
  退去予定: /退去|解約予定|解約日/,
  入居可能日: /入居|即/,
  現況: /現況|空室|空家|居住中|退去/,
};
const norm = (s: string) => s.replace(/\s+/g, "").replace(/[：]/g, ":");
const labelOf = (l: string) => norm(l).split(":")[0] ?? "";

type Variant = (url: string, pdfText: string) => Promise<{ lines: string[]; out: number; ms: number } | null>;
const VARIANT_FNS: Record<string, Variant> = {
  old: async (url) => {
    const t0 = Date.now();
    const r = await readPropertyImageDetail(url, { timeoutMs: 90_000 });
    if (r.kind === "other" && r.lines.length === 0) return null;
    return { lines: r.lines, out: r.usage?.output ?? 0, ms: Date.now() - t0 };
  },
  detailNR: async (url) => {
    const t0 = Date.now();
    const r = await callDeepSeek(null, [{ type: "text", text: PROPERTY_IMAGE_DETAIL_PROMPT }, { type: "image_url", image_url: { url } }], { maxTokens: 3000, timeoutMs: 60_000, thinking: false, temperature: 0 });
    if (!r) return null;
    return { lines: parseDetailResult(r.text).lines, out: r.usage.output, ms: Date.now() - t0 };
  },
  both: async (url) => bothWith(PROPERTY_IMAGE_BOTH_PROMPT, url),
  // 文字層の読み取り（売上サポの行・property_text_detail）も同じ物差しで見る（文字しか見ていないので、見出しの無い行は必ず作った行）
  // 2026-09-29（B・その2）: 画像を推論なしで「書き写す」だけ（可否を判断させない）→ 写しを文字層と同じ読み方（readPropertyDetailFromText・出口の dropUngroundedLines 込み）で行にする
  ocr: async (url) => {
    // 本番と同じ関数（readPropertyImageDetailByTranscript・失敗した時は旧の画像読みに倒す＝倒れた回は数に出る）
    const t0 = Date.now();
    const r = await readPropertyImageDetailByTranscript(url, { timeoutMs: 90_000 });
    if (r.kind === "other" && r.lines.length === 0) return null;
    if (r.via !== "transcribe") console.log(`      〔旧の画像読みに倒れた〕`);
    return { lines: r.lines, out: r.usage?.output ?? 0, ms: Date.now() - t0 };
  },
  text: async (_url, pdfText) => {
    const r = await readPropertyDetailFromText(pdfText);
    if (r.failed) return null;
    return { lines: r.lines, out: r.usage?.output ?? 0, ms: r.ms };
  },
};
async function bothWith(prompt: string, url: string) {
  const t0 = Date.now();
  const r = await callDeepSeek(null, [{ type: "text", text: prompt }, { type: "image_url", image_url: { url } }], { maxTokens: 3000, timeoutMs: 60_000, thinking: false, temperature: 0 });
  const p = r ? parseBothResult(r.text) : null;
  if (!r || !p) return null;
  return { lines: p.detail.lines, out: r.usage.output, ms: Date.now() - t0 };
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) { console.error("DEEPSEEK_API_KEY が無い"); process.exit(1); }
  const { data, error } = await sb.from("property_pickups").select("id, conversation_id, agent_image_url, pdf_text, created_at")
    .not("agent_image_url", "is", null).not("pdf_text", "is", null).order("created_at", { ascending: false }).limit(600);
  if (error) throw new Error(error.message);
  // 会話と日をばらす（同じ束の資料ばかりにしない）・文字層が 600字以上ある物だけ（正解の元にならない薄い資料は外す）
  const seen = new Set<string>();
  const rows = ((data ?? []) as Array<{ id: number; conversation_id: string | null; agent_image_url: string; pdf_text: string; created_at: string }>)
    .filter((r) => r.pdf_text.length >= 600)
    .filter((r) => { const k = `${r.conversation_id}:${r.created_at.slice(0, 10)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, N);
  console.log(`── 資料 ${rows.length}件（売上サポの行・元付の資料の画像と PDF の文字層）で読み方を比べる: ${VARIANTS.join(" / ")}\n`);

  const sum: Record<string, { ok: number; made: number; dropped: number; lines: number; out: number; ms: number; madeBy: Record<string, number>; dropBy: Record<string, number>; groundable: number }> = {};
  for (const v of VARIANTS) sum[v] = { ok: 0, made: 0, dropped: 0, lines: 0, out: 0, ms: 0, madeBy: {}, dropBy: {}, groundable: 0 };
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < rows.length) {
      const r = rows[i++];
      const text = r.pdf_text.normalize("NFKC").replace(/\s+/g, "");   // 文字層は康煕部首（⼈・⾞）や途中の空白で入っている事がある
      const outs = await Promise.all(VARIANTS.map((v) => VARIANT_FNS[v](r.agent_image_url, text).catch(() => null)));
      const log: string[] = [`■ pickup #${r.id}`];
      VARIANTS.forEach((v, k) => {
        const o = outs[k]; const s = sum[v];
        if (!o) { log.push(`  [${v}] 読めなかった`); return; }
        s.ok++; s.out += o.out; s.ms += o.ms; s.lines += o.lines.length;
        const got = new Set(o.lines.map(labelOf));
        const made: string[] = []; const dropped: string[] = [];
        for (const l of o.lines) { const k2 = labelOf(l.normalize("NFKC")); const re = GROUND_KEYS[k2]; if (re && !re.test(text)) { made.push(l); s.made++; s.madeBy[k2] = (s.madeBy[k2] ?? 0) + 1; } }
        for (const [k2, re] of Object.entries(GROUND_KEYS)) {
          if (!re.test(text)) continue;
          if (k2 === "退去予定" || k2 === "現況" || k2 === "入居可能日" || k2 === "保証会社") continue;   // 書き方が割れる（現況の中に退去予定が入る等）ので落ちの数に入れない
          s.groundable++;
          // 行の項目が無くても、他の行（入居条件・設備）にその言葉が写っていれば中身は残っている＝落ちたに数えない
          if (!got.has(k2) && !o.lines.some((l) => re.test(l.normalize("NFKC")))) { dropped.push(k2); s.dropped++; s.dropBy[k2] = (s.dropBy[k2] ?? 0) + 1; }
        }
        log.push(`  [${v}] ${o.ms}ms 出力 ${o.out} 行 ${o.lines.length}${made.length ? `  ⚠作った: ${made.join(" ／ ")}` : ""}${dropped.length ? `  −落ちた: ${dropped.join("・")}` : ""}`);
        if (SHOW) log.push(`      ${o.lines.join(" ／ ")}`);
      });
      console.log(log.join("\n"));
    }
  }));
  console.log(`\n=== まとめ（作った＝資料に見出しが無い可否の行／落ちた＝見出しがあるのに行が無い）===`);
  for (const v of VARIANTS) {
    const s = sum[v];
    console.log(`[${v}] 読めた ${s.ok}/${rows.length}・平均 ${s.ok ? Math.round(s.ms / s.ok) : 0}ms・出力 ${s.ok ? Math.round(s.out / s.ok) : 0}・行 ${s.lines}・作った ${s.made}（${Object.entries(s.madeBy).map(([k, n]) => `${k}${n}`).join("・")}）・落ちた ${s.dropped}/${s.groundable}（${Object.entries(s.dropBy).map(([k, n]) => `${k}${n}`).join("・")}）`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

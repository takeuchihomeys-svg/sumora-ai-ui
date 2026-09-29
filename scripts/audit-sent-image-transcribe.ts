// scripts/audit-sent-image-transcribe.ts — 送った画像の条件の行を「書き写し（推論なし）→ 文字の読み取り」に替えて漏れが無いかの監査
//
// 2026-09-29（B・その2）竹内「更に節約できないか」: 送った画像1枚の条件の行（property_image_detail・推論 low）は出力 6,000〜7,000・30秒。
//   推論なしで条件の行を直接書かせる案は資料に無い可否を作った（audit-image-read-grounding.ts の detailNR・both）。
//   書き写すだけ（判断させない）→ 文字層と同じ読み方（readPropertyDetailFromText・出口の dropUngroundedLines）の2段なら、
//   PDF の文字層を正解にした監査で 作った 0（旧 3）・落ちた 9/48（旧 11/48）・出力 1,139（旧 7,103）・11.6秒（旧 36秒）だった。
//   ここでは**本番で送った画像**（売上サポの行に無いレインズ・ITANDI 等の資料も含む＝文字層の正解が無い物）を新しい読み方で読み、
//   保存済みの行（image_details＝旧の読み方）と項目ごとに1行ずつ見比べる。
//   見る項目: 駐車場・ペット・保証会社・入居可能日・設備・現況・楽器・連帯保証人・入居条件・退去予定・洗濯機置場・フリーレント・駐輪場・バイク置場。
//   可/不可・有/無の反転は別に数える。--baseline で旧の読み方でも読み直し、旧どうしの揺れ（基準の揺れ）も出す。
//   ⚠ DB には書かない（llm_usage_logs に費用の行だけ残る）。鍵は表示しない。
//   【結果 2026-09-29・30枚】旧どうしの揺れ（--baseline・同じ画像を旧の読み方で読み直す）: 保存済みだけ 22・反転 2・出力 6,472
//     新（最終の版）: 読めた 30/30・旧に倒した 1・出力 1,362・11.1秒・同じ 185・違う 9・保存済みだけ 19（退去予定7 は現況・入居可能日の行に入った物が6）・新だけ 44（設備20 ほか）
//     目で見て直した物: Goパレス福島の部屋の一覧「状況 10/末」→ 現況の1行に／保存済み（旧）の誤り: 高殿サンク「ペット: 不可」「所在階: 3階」・難波クレア「洗濯機置場: 室外」
//     残る落ち: コンチネンタル東小橋の設備欄の末尾「ペット相談」（120字で切った後ろ・旧どうしの揺れでもペットは 2件落ちる）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-sent-image-transcribe.ts [--n=30] [--days=14] [--baseline] [--show]
import { createClient } from "@supabase/supabase-js";
import { readPropertyImageDetail, readPropertyImageDetailByTranscript } from "../app/lib/property-image-read";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const N = Number(arg("n", "30"));
const DAYS = Number(arg("days", "14"));
const BASELINE = process.argv.includes("--baseline");
const SHOW = process.argv.includes("--show");
const FOCUS = ["駐車場", "ペット", "保証会社", "入居可能日", "設備", "現況", "楽器", "連帯保証人", "入居条件", "退去予定", "洗濯機置場", "フリーレント", "駐輪場", "バイク置場"];

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").replace(/[：]/g, ":");
const labelOf = (line: string) => norm(line).split(":")[0] ?? "";
const valueOf = (line: string) => norm(line).split(":").slice(1).join(":");
const byLabel = (lines: string[]) => { const m = new Map<string, string>(); for (const l of lines) { const k = labelOf(l); if (k && !m.has(k)) m.set(k, valueOf(l)); } return m; };
/** 可否・有無の向き（+1 可/有／-1 不可/無/なし／0 どちらとも言えない） */
function polarity(v: string): number {
  if (/不可|無し|なし|無$|空無|空:無|空きなし|満車|不要/.test(v)) return -1;
  if (/可|有|あり|空有|空き有|要|必須/.test(v)) return 1;
  return 0;
}
/** 値が「だいたい同じ」か（片方がもう片方を含む・同じ語が半分以上） */
function similar(a: string, b: string): boolean {
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const bi = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const A = bi(a), B = bi(b); if (A.size === 0 || B.size === 0) return false;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size) >= 0.5;
}

type Row = { image_url: string; lines: string[]; conversation_id: string | null; pickup: boolean };

async function sample(): Promise<Row[]> {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data, error } = await sb.from("image_details").select("image_url, lines, kind, model, conversation_id, read_at")
    .gte("read_at", since).eq("kind", "property").order("read_at", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{ image_url: string; lines: unknown; model: string | null; conversation_id: string | null }>)
    .filter((r) => Array.isArray(r.lines) && (r.lines as unknown[]).length > 0)
    .filter((r) => !r.model || r.model === "deepseek-flash" || r.model.startsWith("image:"))   // 旧の画像読みの行だけ（写し・文字層は比べない）
    .filter((r) => !r.image_url.includes("/aix/") || true);
  // 売上サポの行（その会話の物件名・号室）に当たるかは見ない。会話が偏らないよう1会話2枚まで
  const perConv = new Map<string, number>();
  const out: Row[] = [];
  for (const r of rows) {
    const c = r.conversation_id ?? "-";
    if ((perConv.get(c) ?? 0) >= 2) continue;
    perConv.set(c, (perConv.get(c) ?? 0) + 1);
    out.push({ image_url: r.image_url, lines: (r.lines as unknown[]).map(String), conversation_id: r.conversation_id, pickup: false });
    if (out.length >= N) break;
  }
  return out;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) { console.error("DEEPSEEK_API_KEY が無い"); process.exit(1); }
  const rows = await sample();
  console.log(`── 本番で送った画像 ${rows.length}枚（旧の読み方の行が残っている物）を書き写し→文字の読み取りで読み直す${BASELINE ? "（旧の読み方でも読み直す）" : ""}\n`);
  const tot = { ok: 0, fail: 0, fallback: 0, out: 0, ms: 0, same: 0, differ: 0, oldOnly: 0, newOnly: 0, flip: 0, oldLines: 0, newLines: 0 };
  const base = { ok: 0, out: 0, ms: 0, same: 0, differ: 0, oldOnly: 0, newOnly: 0, flip: 0 };
  const oldOnlyBy: Record<string, number> = {}; const newOnlyBy: Record<string, number> = {}; const flipBy: string[] = [];
  const baseOldOnlyBy: Record<string, number> = {};
  let i = 0;
  const cmp = (oldL: string[], newL: string[], acc: typeof base, oob?: Record<string, number>, nob?: Record<string, number>, flips?: string[]) => {
    const o = byLabel(oldL), n = byLabel(newL); const log: string[] = [];
    for (const k of FOCUS) {
      const a = o.get(k), b = n.get(k);
      if (a === undefined && b === undefined) continue;
      if (a !== undefined && b === undefined) { acc.oldOnly++; if (oob) oob[k] = (oob[k] ?? 0) + 1; log.push(`    − ${k}: ${a}`); continue; }
      if (a === undefined && b !== undefined) { acc.newOnly++; if (nob) nob[k] = (nob[k] ?? 0) + 1; log.push(`    ＋ ${k}: ${b}`); continue; }
      const pa = polarity(a!), pb = polarity(b!);
      if (pa !== 0 && pb !== 0 && pa !== pb && k !== "設備" && k !== "入居条件") { acc.flip++; flips?.push(`${k}: ${a} → ${b}`); log.push(`    ⚠反転 ${k}: ${a} → ${b}`); continue; }
      if (similar(a!, b!)) acc.same++; else { acc.differ++; log.push(`    ≠ ${k}: ${a} → ${b}`); }
    }
    return log;
  };
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < rows.length) {
      const r = rows[i++];
      const t0 = Date.now();
      const [nw, bl] = await Promise.all([
        readPropertyImageDetailByTranscript(r.image_url, { timeoutMs: 90_000 }).catch(() => null),
        BASELINE ? readPropertyImageDetail(r.image_url, { timeoutMs: 90_000 }).catch(() => null) : Promise.resolve(null),
      ]);
      const ms = Date.now() - t0;
      const log: string[] = [`■ ${r.image_url.slice(-48)}（会話 ${String(r.conversation_id).slice(0, 8)}）`];
      if (!nw || (nw.kind === "other" && nw.lines.length === 0)) { tot.fail++; log.push(`  [新] 読めなかった（kind=${nw?.kind ?? "-"}）`); console.log(log.join("\n")); continue; }
      tot.ok++; tot.out += nw.usage?.output ?? 0; tot.ms += ms; if (nw.via === "image_fallback") tot.fallback++;
      tot.oldLines += r.lines.length; tot.newLines += nw.lines.length;
      log.push(`  [新] ${ms}ms 出力 ${nw.usage?.output ?? 0} 行 ${nw.lines.length}（保存済み ${r.lines.length}）kind=${nw.kind} via=${nw.via}`);
      log.push(...cmp(r.lines, nw.lines, tot as unknown as typeof base, oldOnlyBy, newOnlyBy, flipBy));
      if (bl && !(bl.kind === "other" && bl.lines.length === 0)) {
        base.ok++; base.out += bl.usage?.output ?? 0;
        const bLog = cmp(r.lines, bl.lines, base, baseOldOnlyBy);
        log.push(`  [旧の読み直し] 出力 ${bl.usage?.output ?? 0} 行 ${bl.lines.length}${bLog.length ? "" : "（保存済みと同じ）"}`);
        if (SHOW) log.push(...bLog.map((s) => "  " + s));
      }
      if (SHOW) { log.push(`    保存済み: ${r.lines.join(" ／ ")}`); log.push(`    新      : ${nw.lines.join(" ／ ")}`); }
      console.log(log.join("\n"));
    }
  }));
  console.log(`\n=== まとめ（項目 ${FOCUS.length}種・保存済み＝旧の読み方 vs 新）===`);
  console.log(`新: 読めた ${tot.ok}/${rows.length}（読めない ${tot.fail}・旧に倒した ${tot.fallback}）・平均 ${tot.ok ? Math.round(tot.ms / tot.ok) : 0}ms・出力 ${tot.ok ? Math.round(tot.out / tot.ok) : 0}（書き写し＋文字の読み取り）・行 ${tot.newLines}（保存済み ${tot.oldLines}）`);
  console.log(`  同じ ${tot.same}・違う ${tot.differ}・反転 ${tot.flip}・保存済みだけ ${tot.oldOnly}（${Object.entries(oldOnlyBy).map(([k, n]) => `${k}${n}`).join("・")}）・新だけ ${tot.newOnly}（${Object.entries(newOnlyBy).map(([k, n]) => `${k}${n}`).join("・")}）`);
  if (flipBy.length) console.log(`  反転: ${flipBy.join(" ／ ")}`);
  if (BASELINE) console.log(`旧の読み直し（基準の揺れ）: 読めた ${base.ok}・出力 ${base.ok ? Math.round(base.out / base.ok) : 0}・同じ ${base.same}・違う ${base.differ}・反転 ${base.flip}・保存済みだけ ${base.oldOnly}（${Object.entries(baseOldOnlyBy).map(([k, n]) => `${k}${n}`).join("・")}）・新だけ ${base.newOnly}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

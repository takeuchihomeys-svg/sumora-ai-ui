// scripts/fix-reread-b-current.ts — B の読み直し（reread-sent-image-vacancy.ts・2026-10-13T14:24:35Z〜）で書いた image_details のうち、
// 「現況:」の値が現況の欄の値として成り立たない行（金額・面積・号室だけ／状態の語が無い「相談」なのに退去予定の行がある）を直す。
//   原因: 書き写しの「現況:」が空で、次の行（隣の欄＝駐車場の「7,700円/月」）を現況の値として取った／「相談(2026年7月17日退去予定)」の括弧を外して「相談」を現況にした
//   （sheet-vacancy.ts の takeCurrent を直した・2026-10-13）
// 直し方（行だけ・LLM なし）: ①ログ（--log）に読み直す前の「現況:」があり、それが成り立つ値なら戻す ②退去予定の行があれば「現況: 退去予定」 ③どちらも無ければ「現況:」の行を外す
// 既定は数えるだけ。--apply の時だけ書く（lines だけ・read_at は変えない）。
// 実行: npx tsx --env-file=.env.local scripts/fix-reread-b-current.ts [--since=2026-10-13T14:24:35Z] [--log=<reread のログ>] [--apply]
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");

const REAL_STATE_RE = /空室|空き|空家|退去|解約予定|居住中|入居中|賃貸中|予定|新築|建築中|建設中|改装中|内装中|リフォーム中|完成|未入居|清掃中|申込|商談|審査|募集/;
const SOFT_STATE_RE = /相談|即入|即時|即日|入居可/;
/** 現況の値として成り立たないか（純関数） */
export function badCurrent(value: string, hasVacateLine: boolean): string | null {
  const v = value.normalize("NFKC").trim();
  if (/円|㎡|m2|m²|帖|畳/.test(v)) return "金額・面積";
  if (REAL_STATE_RE.test(v)) return null;
  if (/^[\d,.\s/]+$/.test(v) || /^\d{2,4}号室?$/.test(v)) return "数字・号室だけ";
  if (SOFT_STATE_RE.test(v)) return hasVacateLine ? "状態の語が無く退去予定の行がある（相談・即入居だけ）" : null;
  return "状態の語が無い";
}

async function main() {
  const since = arg("since", "2026-10-13T14:24:35Z"), apply = process.argv.includes("--apply");
  const logPath = arg("log", "");
  const prevCur = new Map<string, string>(); // URL の末尾 → 前の「現況:」の値
  if (logPath && existsSync(logPath)) {
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      const m = line.match(/^\[\d+\/\d+\] (?:変わった|同じ) (\S+)\s+前: (.*?)\s+後: /);
      if (!m) continue;
      const cur = m[2].split(" ／ ").find((x) => /^現況\s*[:：]/.test(x));
      if (cur) prevCur.set(m[1], cur.replace(/^現況\s*[:：]\s*/, ""));
    }
  }
  const { data, error } = await sb.from("image_details").select("image_url, lines, read_at").gte("read_at", since).like("image_url", "%/property-images/%").eq("kind", "property").limit(2000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ image_url: string; lines: unknown; read_at: string }>;
  let bad = 0, written = 0;
  for (const r of rows) {
    const ls = Array.isArray(r.lines) ? (r.lines as unknown[]).map(String) : [];
    const ci = ls.findIndex((l) => /^現況\s*[:：]/.test(l));
    if (ci < 0) continue;
    const hasVac = ls.some((l) => /^退去予定\s*[:：]\s*\S*\d/.test(l));
    const why = badCurrent(ls[ci].replace(/^現況\s*[:：]\s*/, ""), hasVac);
    if (!why) continue;
    bad++;
    const prev = [...prevCur.entries()].find(([k]) => r.image_url.endsWith(k))?.[1] ?? null;
    const next = [...ls];
    let how: string;
    if (prev && !badCurrent(prev, hasVac)) { next[ci] = `現況: ${prev}`; how = "前の値に戻す"; }
    else if (hasVac) { next[ci] = "現況: 退去予定"; how = "退去予定の行から"; }
    else { next.splice(ci, 1); how = "現況の行を外す"; }
    console.log(`- ${r.image_url.slice(-46)}（${why}）${how}\n    前: ${ls.filter((l) => /^(現況|退去予定|入居可能日)/.test(l)).join(" ／ ")}\n    後: ${next.filter((l) => /^(現況|退去予定|入居可能日)/.test(l)).join(" ／ ")}`);
    if (apply) { const { error: e2 } = await sb.from("image_details").update({ lines: next }).eq("image_url", r.image_url); if (!e2) written++; }
  }
  console.log(`\n${since} 以降に書いた送った画像の中身の行 ${rows.length}・現況が成り立たない ${bad}${apply ? `・書いた ${written}` : "（数えるだけ。書く時は --apply）"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

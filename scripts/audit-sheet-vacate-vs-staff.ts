// scripts/audit-sheet-vacate-vs-staff.ts — スタッフが AIX【物件確認した】で送った退去予定日・入居可能日と、資料の画像の読み取り（image_details）の値を物件ごとに比べる（読むだけ・LLM なし・$0）
// 2026-10-13 竹内「退去予定日がどこに書いていて空室がどこに書いているか…正確に読み取る場所が分かるように」の物差し。
//   スタッフの値: aix_usage_logs（property_check_result）の generated_text の「〇月〇日退去予定」「〇月〇日以降ご入居」「〇月末退去」。
//   資料の値: 同じ会話の送った資料の画像（sent_image_properties の物件名が AIX の property_names と同じ建物）の image_details.lines の 退去予定・現況・入居可能日。
//   日付は「月/日」か「月+上中下旬/末」に丸めて比べる。資料に日付が無い物は「資料に無い」で数える（食い違いではない）。
// 実行: npx tsx --env-file=.env.local scripts/audit-sheet-vacate-vs-staff.ts [--days=120] [--show=8]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];

/** 文の中の日付（M/D・M月D日・M月上中下旬・M月末）を「M/D」か「M/上旬」等に */
export function dateKeys(t: string): string[] {
  const s = String(t ?? "").normalize("NFKC");
  const out = new Set<string>();
  for (const m of s.matchAll(/(?:20\d{2}\s*[年/.-]\s*)?(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?/g)) { const mo = Number(m[1]), d = Number(m[2]); if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.add(`${mo}/${d}`); }
  for (const m of s.matchAll(/(?:20\d{2}\s*[年/.-]\s*)?(\d{1,2})\s*[月/]\s*(上旬|中旬|下旬|末)/g)) out.add(`${Number(m[1])}/${m[2]}`);
  return [...out];
}
const near = (a: string, b: string) => {
  if (a === b) return true;
  const [am, ad] = a.split("/"), [bm, bd] = b.split("/");
  if (am !== bm) return false;
  const band = (d: string) => (/上旬/.test(d) ? [1, 10] : /中旬/.test(d) ? [11, 20] : /下旬|末/.test(d) ? [21, 31] : [Number(d), Number(d)]);
  const [a1, a2] = band(ad), [b1, b2] = band(bd);
  return a1 <= b2 && b1 <= a2;
};

async function main() {
  const days = Number(arg("days", "120")), show = Number(arg("show", "8"));
  const { buildingKeyOf } = await import("../app/lib/customer-state");
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: logs } = await sb.from("aix_usage_logs").select("conversation_id, created_at, generated_text, property_names")
    .eq("aix_type", "property_check_result").gte("created_at", since).not("generated_text", "is", null).limit(2000);
  type L = { conversation_id: string; created_at: string; generated_text: string; property_names: string[] | null };
  const cand = ((logs ?? []) as L[]).filter((l) => /退去|ご入居|入居可能/.test(l.generated_text) && dateKeys(l.generated_text).length);
  let same = 0, diff = 0, noSheet = 0, noDate = 0; const diffs: string[] = [];
  for (const l of cand) {
    const names = (l.property_names ?? []).map((n) => buildingKeyOf(n.replace(/\s*\d{2,4}号室?$/, ""))).filter((k) => k.length >= 3);
    if (!names.length) continue;
    const { data: sip } = await sb.from("sent_image_properties").select("image_url, property_name").eq("conversation_id", l.conversation_id);
    const urls = ((sip ?? []) as Array<{ image_url: string; property_name: string | null }>).filter((s) => names.some((k) => buildingKeyOf(s.property_name ?? "").includes(k) || k.includes(buildingKeyOf(s.property_name ?? "")))).map((s) => s.image_url);
    if (!urls.length) { noSheet++; continue; }
    const { data: det } = await sb.from("image_details").select("lines").in("image_url", urls.slice(0, 20));
    const sheet = ((det ?? []) as Array<{ lines: unknown }>).flatMap((d) => (Array.isArray(d.lines) ? (d.lines as string[]) : [])).filter((x) => /^(現況|退去予定|入居可能日)/.test(x));
    if (!sheet.length) { noSheet++; continue; }
    const sk = dateKeys(sheet.join("\n"));
    if (!sk.length) { noDate++; continue; }
    const tk = dateKeys(l.generated_text.split("\n").filter((x) => /退去|入居/.test(x)).join("\n"));
    if (tk.some((a) => sk.some((b) => near(a, b)))) same++;
    else { diff++; diffs.push(`${l.conversation_id.slice(0, 8)} ${l.created_at.slice(0, 10)} スタッフ「${l.generated_text.split("\n").filter((x) => /退去|入居/.test(x)).join(" / ").slice(0, 80)}」 資料「${sheet.join(" / ").slice(0, 120)}」`); }
  }
  console.log(`AIX【物件確認した】で日付つきの退去・入居を送った ${cand.length}件: 資料と同じ ${same}・食い違い ${diff}・資料に日付なし ${noDate}・資料の読み取りなし ${noSheet}`);
  for (const d of diffs.slice(0, show)) console.log("  - " + d);
}
main().catch((e) => { console.error(e); process.exit(1); });

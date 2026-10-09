// scripts/audit-r12-pickup-condition-count.ts — 竹内さんがピックアップの文に添える条件の数を、お客様が出した条件の数と並べて数える（読むだけ・LLM なし）
// 2026-10-08 竹内さん「物件ピックアップの時に添える条件の数は、実際の竹内さんの LINE を参考にする（決め打ちの数を置かない）」
//   ・宣言（返信）: 「…からピックアップしてお送りさせて頂きます」（初回の条件の復唱・条件を変えた時の約束）
//   ・届けた行（AIX）: 「…からピックアップさせて頂きました」
//   お客様の条件の数 = 直前の条件のフォーム（①〜⑧）の書かれた欄（②家賃 ③間取り ④築年数 ⑥徒歩 ⑧その他は 、・ で分けて数える／①入居時期 ⑤エリア ⑦初期費用は数えない）
// 実行: npx tsx --env-file=.env.local scripts/audit-r12-pickup-condition-count.ts [--show]
import { createClient } from "@supabase/supabase-js";
import { countEchoedConditions, countFormConditions } from "../app/lib/pickup-condition-count";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
const SHOW = process.argv.includes("--show");
(async () => {
  const staff = await readAll((f, t) => sb.from("messages").select("conversation_id, created_at, is_aix_generated, text").eq("sender", "staff").eq("staff_writer", "takeuchi").ilike("text", "%ピックアップ%").order("created_at").range(f, t));
  const convs = [...new Set(staff.map((m) => m.conversation_id))];
  const forms: any[] = [];
  for (let i = 0; i < convs.length; i += 80) forms.push(...await readAll((f, t) => sb.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").in("conversation_id", convs.slice(i, i + 80)).ilike("text", "%②%").order("created_at").range(f, t)));
  const table: Record<string, Record<string, number>> = {};
  const bump = (row: string, col: string) => { (table[row] ??= {}); table[row][col] = (table[row][col] ?? 0) + 1; };
  const shows: string[] = [];
  for (const m of staff) {
    const line = String(m.text ?? "").split("\n").find((x: string) => /ピックアップ/.test(x) && /から|で、|で(?:〇|[^\s]{1,8}さん)/.test(x)) ?? "";
    if (!line) continue;
    const kind = /ピックアップ(?:さ|し)せて頂きました|ピックアップさせていただきました/.test(line) ? "届けた行(AIX)" : /お送りさせて頂きます|お送りさせていただきます/.test(line) ? "宣言(返信)" : null;
    if (!kind) continue;
    const echoed = countEchoedConditions(line);
    const form = forms.filter((f) => f.conversation_id === m.conversation_id && f.created_at < m.created_at).pop();
    const fn = form ? countFormConditions(form.text) : null;
    const fcol = fn == null ? "フォーム無し" : `フォーム${Math.min(fn, 6)}${fn >= 6 ? "+" : ""}`;
    bump(`${kind} ${fcol}`, `添えた${Math.min(echoed, 6)}${echoed >= 6 ? "+" : ""}`);
    const period = m.created_at >= "2026-09-15" ? "9/15〜" : "〜9/14";
    const initial = form && Date.parse(m.created_at) - Date.parse(form.created_at) < 36 * 3600_000 ? "フォーム直後" : "その後";
    if (fn != null) bump(`${kind} 割合 ${period} ${initial}`, echoed >= fn ? "全部" : echoed === 0 ? "0" : echoed >= Math.ceil(fn / 2) ? "半分以上" : "半分未満");
    if (SHOW) shows.push(`${kind} form=${fn ?? "-"} echo=${echoed} | ${line.slice(0, 110)}`);
  }
  for (const [row, cols] of Object.entries(table).sort()) console.log(`${row.padEnd(22)} ${Object.entries(cols).sort().map(([k, v]) => `${k}:${v}`).join("  ")}`);
  if (SHOW) for (const s of shows) console.log("  " + s);
})();

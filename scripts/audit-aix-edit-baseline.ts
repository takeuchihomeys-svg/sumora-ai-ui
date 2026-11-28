// scripts/audit-aix-edit-baseline.ts — #827 の物差し: スタッフが AIX の文を直した割合と直した中身（読むだけ・軽い読み・LLM なし・2026-11-28 作業員A）
//   ai_template_candidates（直近 N日）の直す前の AI の文（original_text）と送った文（template_text）を行で比べる。
//   aix_usage_logs.generated_text は送った文で上書きされていて使えない（11/28 に突き合わせると 476通すべて同じだった）。
//   source=aix_edit_count … 物件オススメの直しの組（#839・数えるためだけ・伏せた形・AIX_EDIT_COUNT_RECOMMENDATION=on の時だけ）
//   source=aix_edit … スタッフが直して送った（original_text＝直す前）／source=auto … そのまま送った
//   直した中身は、足した行・消した行を種類に分ける（誘い・次の一手／確認・約束／金額・日付／挨拶・締め／その他）。本文は出さない（数だけ）。
//   実行: npx tsx --env-file=.env.local scripts/audit-aix-edit-baseline.ts [--days=30] [--json=<out>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const days = Number(arg("days", "30"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "", { auth: { persistSession: false } });

const norm = (s: string) => s.normalize("NFKC").replace(/[！!。、．\s😊😌🙇‍♀️🙏✨]+/g, "").trim();
const linesOf = (t: string) => t.split(/\n+/).map(norm).filter((l) => l.length >= 4);
export const KIND_RE: Array<[string, RegExp]> = [
  ["誘い・次の一手", /内覧|内見|ご案内|お申込|申し込み|お部屋抑え|お気に召されましたら|ご検討/],
  ["確認・約束", /確認(?:させて|いたし|致し)|ご連絡させて|次第|お調べ|管理会社/],
  ["金額・日付", /[0-9]+(?:万|円|月|日|時)|初期費用|家賃|礼金|敷金/],
  ["挨拶・締め", /お世話になっております|ありがとうございます|よろしくお願い|お待たせ/],
];
export const kindOf = (l: string) => KIND_RE.find(([, re]) => re.test(l))?.[0] ?? "その他";

type Agg = { n: number; edited: number; sameLineShare: number; added: Record<string, number>; removed: Record<string, number> };
async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: rows, error } = await sb.from("ai_template_candidates").select("action_type, source, template_text, original_text")
    .gte("created_at", since).in("source", ["aix_edit", "aix_edit_count", "auto"]).limit(3000);
  if (error) throw error;
  const by: Record<string, Agg> = {};
  for (const r of rows ?? []) {
    const a = (by[r.action_type ?? "?"] ??= { n: 0, edited: 0, sameLineShare: 0, added: {}, removed: {} });
    a.n++;
    if ((r.source !== "aix_edit" && r.source !== "aix_edit_count") || !r.original_text) { a.sameLineShare += 1; continue; }
    a.edited++;
    const g = linesOf(r.original_text), t = linesOf(r.template_text ?? "");
    const gs = new Set(g), ts = new Set(t);
    a.sameLineShare += t.length ? t.filter((x) => gs.has(x)).length / t.length : 1;
    for (const x of t) if (!gs.has(x)) a.added[kindOf(x)] = (a.added[kindOf(x)] ?? 0) + 1;
    for (const x of g) if (!ts.has(x)) a.removed[kindOf(x)] = (a.removed[kindOf(x)] ?? 0) + 1;
  }
  const pct = (x: number, n: number) => Math.round((x / n) * 1000) / 10;
  // 2026-11-28 作業員A: 直した割合は aix_usage_logs.was_edited（送った時に画面が下書きと比べて付ける・絵文字だけの差は直しにしない）で数える。
  //   ai_template_candidates の source=auto は「そのまま送った」ではなく夜の cron（auto-template-candidates）が作った候補＝割合の分母に使えない。
  //   物件オススメは画面が直しの組を残さない（AixModal: 物件固有の文のため除外）＝直した中身は数えられない
  const { data: logs } = await sb.from("aix_usage_logs").select("aix_type, was_edited").gte("created_at", since).not("sent_at", "is", null).not("was_edited", "is", null).limit(5000);
  const rate: Record<string, { n: number; e: number }> = {};
  for (const l of logs ?? []) { const r = (rate[l.aix_type ?? "?"] ??= { n: 0, e: 0 }); r.n++; if (l.was_edited) r.e++; }
  console.log(`### 直した割合（aix_usage_logs.was_edited・${days}日）`);
  for (const [k, r] of Object.entries(rate).sort((x, y) => y[1].n - x[1].n)) console.log(`- ${k}: ${r.n}通・直した ${r.e}（${pct(r.e, r.n)}%）`);
  const out = Object.entries(by).sort((x, y) => y[1].n - x[1].n).map(([k, a]) => ({ aix: k, n: a.n, edited: a.edited, editedPct: pct(a.edited, a.n), sameLinePct: pct(a.sameLineShare, a.n), added: a.added, removed: a.removed }));
  console.log(`### 直した中身（${days}日・ai_template_candidates の aix_edit の組。下の「直した」は候補の表の中の割合で、割合そのものは上の was_edited を見る）`);
  for (const o of out) console.log(`- ${o.aix}: ${o.n}通・直した ${o.edited}（${o.editedPct}%）・送った文の行のうち AI の行のまま ${o.sameLinePct}%・足した行 ${JSON.stringify(o.added)}・消した行 ${JSON.stringify(o.removed)}`);
  const j = arg("json"); if (j) writeFileSync(j, JSON.stringify({ at: new Date().toISOString(), days, rows: out }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });

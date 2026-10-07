// scripts/audit-brain-model-by-scene.ts — 場面ごとにモデルを分けられるか（読むだけ・LLM なし）
//   2026-10-07 竹内「この3つもはかって！！質は絶対に落ちないように」の②。
//   同じ本番の過去の番で、①本番の Sonnet の判断（スタッフの最初の返事より前に作られた最後の判断・brain_decision_logs）と
//   ②再生の DeepSeek の判断（3巡目 yuma-r3-replay の出力・brain_off*＝今の材料・6回）を、スタッフの道（返信か・どの AIX か・2段の約束を含む）と比べる。
//   場面ごとに: 一致の平均と 95% の幅（番を単位）・DeepSeek 同士の揺れ（回の対で道が同じ割合）・Sonnet と DeepSeek の道が同じ割合。
//   ⚠ 再生（YUMA に写した場面）と本番の材料は同じではない（台帳・物件・条件の一部が写らない）。差には再生のずれも混ざる → 結論は「下がる側に出るか」だけに使う。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-model-by-scene.ts <r3 の jsonl> [--key=brain_off]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const KEY = process.argv.find((a) => a.startsWith("--key="))?.slice(6) ?? "brain_off";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type B = { action?: string | null; reply_mode?: string | null; src?: string | null };
type R = { id: string; conv: string; at: string; scene: string; staffPath: string[]; error?: string; skip?: string } & Record<string, unknown>;
const PROP = /^property_(send|recommendation|pickup|search)$/;
const sameAix = (a: string, b: string) => a === b || (PROP.test(a) && PROP.test(b));
const pathOf = (x: B | null) => (x && x.reply_mode === "aix" && x.action ? x.action : "reply");
function pathOk(x: B | null, staff: string[]): boolean {
  const brain = pathOf(x);
  if (brain === "reply" ? staff[0] === "reply" : staff.some((s) => sameAix(s, brain))) return true;
  const m = /two_stage_promise\((pickup|check|check_question|estimate)\)/.exec(x?.src ?? "");
  if (!m || x?.reply_mode === "aix") return false;
  const k = m[1];
  return staff.some((a) => (k === "pickup" && /^property_(send|recommendation|search)$/.test(a)) || (k.startsWith("check") && (a === "property_check_result" || a === "acknowledge_check")) || (k === "estimate" && a === "estimate_sheet"));
}
const samePath = (a: B | null, b: B | null) => { const x = pathOf(a), y = pathOf(b); return x === y || (PROP.test(x) && PROP.test(y)); };
const meanCi = (xs: number[]) => { const n = xs.length; if (!n) return "-"; const m = xs.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1)); return `${Math.round(m * 100)}%±${Math.round((1.96 * sd / Math.sqrt(n)) * 100)}`; };

(async () => {
  const seen = new Set<string>();
  const rows = files.flatMap((f) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as R))
    .filter((r) => !r.error && !r.skip && r.staffPath?.length && Object.keys(r).some((k) => k.startsWith(KEY)))
    .filter((r) => { const k = `${r.conv}|${r.at}`; if (seen.has(k)) return false; seen.add(k); return true; });
  console.log(`番 ${rows.length}（${files.join(", ")}・${KEY}*）`);
  type Out = { scene: string; prod: B | null; ds: B[]; staff: string[] };
  const outs: Out[] = [];
  for (const r of rows) {
    const { data: ds } = await sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action, suggested_reply_mode, decision_source")
      .eq("analyzed_msg_ts", r.at).like("conversation_id", `${r.conv}%`).order("created_at");
    const decs = (ds ?? []) as Array<{ conversation_id: string; created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; decision_source: string | null }>;
    let prod: B | null = null;
    if (decs.length) {
      const conv = decs[0].conversation_id;
      const { data: st } = await sb.from("messages").select("created_at").eq("conversation_id", conv).neq("sender", "customer").gt("created_at", r.at).order("created_at").limit(1);
      const { data: pr } = await sb.from("aix_usage_logs").select("created_at").eq("conversation_id", conv).gt("created_at", r.at).order("created_at").limit(1);
      const firsts = [st?.[0]?.created_at, pr?.[0]?.created_at].filter(Boolean).map((x) => Date.parse(String(x)));
      const first = firsts.length ? Math.min(...firsts) : Infinity;
      const pre = decs.filter((d) => Date.parse(d.created_at) < first);
      const d = pre[pre.length - 1] ?? null;
      if (d) prod = { action: d.suggested_action, reply_mode: d.suggested_reply_mode, src: d.decision_source };
    }
    const dsx = Object.keys(r).filter((k) => k === KEY || new RegExp(`^${KEY}_\\d+$`).test(k)).map((k) => r[k] as B).filter(Boolean);
    outs.push({ scene: r.scene, prod, ds: dsx, staff: r.staffPath });
    await sleep(150);
  }
  console.log("場面 | 番(本番あり) | 本番 Sonnet の一致 | 再生 DeepSeek の一致（6回の平均） | 対の差 DS−Sonnet | DeepSeek 同士の揺れ（道が同じ） | Sonnet と DeepSeek の道が同じ");
  for (const s of [...new Set(outs.map((o) => o.scene)), "全体"]) {
    const os = outs.filter((o) => (s === "全体" || o.scene === s) && o.prod && o.ds.length);
    const son = os.map((o) => (pathOk(o.prod, o.staff) ? 1 : 0));
    const dsr = os.map((o) => o.ds.filter((x) => pathOk(x, o.staff)).length / o.ds.length);
    const diff = os.map((o, i) => dsr[i] - son[i]);
    const self = os.map((o) => { let a = 0, n = 0; for (let i = 0; i < o.ds.length; i++) for (let j = i + 1; j < o.ds.length; j++) { n++; if (samePath(o.ds[i], o.ds[j])) a++; } return n ? a / n : 1; });
    const cross = os.map((o) => o.ds.filter((x) => samePath(x, o.prod)).length / o.ds.length);
    console.log(`${s.padEnd(15)} | ${os.length} | ${meanCi(son)} | ${meanCi(dsr)} | ${(() => { const m = diff.reduce((a, b) => a + b, 0) / Math.max(1, diff.length); return `${m >= 0 ? "+" : ""}${Math.round(m * 100)}pt（${meanCi(diff).split("±")[1] ?? "-"}）`; })()} | ${meanCi(self)} | ${meanCi(cross)}`);
  }
  console.log(`本番の判断が見つからない番: ${outs.filter((o) => !o.prod).length}`);
})().catch((e) => { console.error(e); process.exit(1); });

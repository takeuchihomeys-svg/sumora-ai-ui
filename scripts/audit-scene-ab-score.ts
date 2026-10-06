// scripts/audit-scene-ab-score.ts — 2巡目: yuma-scene-materials-ab.ts の出力を、スタッフの実送信との誤差で比べる（読むだけ・LLM なし）
// 実行: npx tsx scripts/audit-scene-ab-score.ts <jsonl> [<jsonl> ...] [--show=<scene>]
import { readFileSync } from "node:fs";
import { bigramSim, editCore, classifyEdit } from "../app/lib/edit-diff";
import { judgeTurn, isAgree } from "../app/lib/line-watch-judge";
import { staffActsOf } from "../app/lib/customer-sim-shadow";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const show = process.argv.find((a) => a.startsWith("--show="))?.slice(7);
type R = { id: string; scene: string; customer?: string[]; staff?: string; prod?: string; brain?: { action?: string | null; reply_mode?: string | null }; error?: string; skip?: string } & Record<string, unknown>;
const rows: R[] = files.flatMap((f) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as R));
const N = (s: string) => s.normalize("NFKC");
const CHECK = /確認(?:させて|致し|いたし|して|し(?:ご連絡|次第|て)|出来次第)|お調べ|問い合わせ|問合せ/;
const EXTRA = /見つかるまで|全力で|サポートさせて|尽力|最善の|ご安心|安心です|楽しみ|嬉しく思/;
const APPEAL = /内覧|ご案内|お申込|申込|抑え|押さえ/;
const nSent = (s: string) => s.split(/\n+/).flatMap((l) => l.split(/(?<=[!！]{2}|。)(?=[^!！。\s])/u)).filter((p) => editCore(p).length >= 2).length;

function score(draft: string | null | undefined, staff: string) {
  if (!draft) return null;
  const now = new Date().toISOString();
  const j = judgeTurn({ draft, brainAction: null, brainReplyMode: "reply", hasBrain: true, window: { closed: true, texts: [{ at: now, text: staff, burst: true }], presses: [], aixMessages: 0, aixMessagesBurst: 0 } });
  const e = classifyEdit(draft, staff);
  const A = staffActsOf(draft), B = staffActsOf(staff);
  return {
    verdict: j.verdict, reason: j.detail.reason, agree: isAgree(j.verdict), sim: bigramSim(editCore(draft), editCore(staff)), close: e.amount === "none" || e.amount === "tiny" || e.amount === "small",
    lenRatio: editCore(draft).length / Math.max(1, editCore(staff).length), sents: nSent(draft),
    checkEscape: CHECK.test(N(draft)) && !CHECK.test(N(staff)), extra: EXTRA.test(draft) && !EXTRA.test(staff), appealExtra: APPEAL.test(draft) && !APPEAL.test(staff),
    actMiss: [...B].filter((x) => !A.has(x)).length, actExtra: [...A].filter((x) => !B.has(x)).length,
  };
}
type S = NonNullable<ReturnType<typeof score>>;
// 回数（draft_on と draft_on_1 …）は同じ版にまとめる
const baseOf = (k: string) => k.slice(6).replace(/_\d+$/, "");
const variants = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k.startsWith("draft_")).map(baseOf)))];
const cols = ["prod", ...variants];
const agg = new Map<string, Map<string, S[]>>(); // scene → variant → scores
const usable = rows.filter((r) => !r.error && !r.skip && r.staff);
for (const r of usable) {
  for (const v of cols) {
    const drafts = v === "prod" ? [r.prod] : Object.keys(r).filter((k) => k.startsWith("draft_") && baseOf(k) === v).map((k) => r[k] as string | null | undefined);
    for (const d of drafts) {
      const s = score(d, r.staff!);
      if (!s) continue;
      for (const k of [r.scene, "全体"]) {
        if (!agg.has(k)) agg.set(k, new Map());
        const m = agg.get(k)!;
        m.set(v, [...(m.get(v) ?? []), s]);
      }
    }
  }
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: boolean[]) => `${Math.round((xs.filter(Boolean).length / Math.max(1, xs.length)) * 100)}%`;
console.log(`番 ${usable.length}（エラー ${rows.filter((r) => r.error).length}・飛ばし ${rows.filter((r) => r.skip).length}）  列: ${cols.join(" / ")}（prod＝本番の当時の下書き・環境が違うので参考）`);
console.log("場面 | n | 一致(same+same_meaning) | 近い(none/tiny/small) | 似ている度 | 長さ AI/人 | 文の数 | 確認に逃げる | 余計な一文 | 訴求を足す | 行為の不足 | 行為の余り");
for (const [k, m] of [...agg].sort((a, b) => (a[0] === "全体" ? -1 : b[0] === "全体" ? 1 : (b[1].get(cols[1])?.length ?? 0) - (a[1].get(cols[1])?.length ?? 0)))) {
  const cell = (f: (xs: S[]) => string) => cols.map((v) => f(m.get(v) ?? [])).join(" / ");
  console.log(`${k} | ${cell((x) => String(x.length))} | ${cell((x) => pct(x.map((s) => s.agree)))} | ${cell((x) => pct(x.map((s) => s.close)))} | ${cell((x) => avg(x.map((s) => s.sim)).toFixed(2))} | ${cell((x) => avg(x.map((s) => s.lenRatio)).toFixed(2))} | ${cell((x) => avg(x.map((s) => s.sents)).toFixed(1))} | ${cell((x) => pct(x.map((s) => s.checkEscape)))} | ${cell((x) => pct(x.map((s) => s.extra)))} | ${cell((x) => pct(x.map((s) => s.appealExtra)))} | ${cell((x) => avg(x.map((s) => s.actMiss)).toFixed(2))} | ${cell((x) => avg(x.map((s) => s.actExtra)).toFixed(2))}`);
}
if (show) for (const r of usable.filter((x) => show === "all" || x.scene === show)) {
  console.log(`\n==== ${r.id} [${r.scene}] brain=${r.brain?.action ?? "-"}/${r.brain?.reply_mode ?? "-"}`);
  console.log(`客: ${(r.customer ?? []).join(" ⏎ ").replace(/\n/g, " ").slice(0, 160)}`);
  console.log(`人: ${(r.staff ?? "").replace(/\n/g, " / ").slice(0, 220)}`);
  for (const k of Object.keys(r).filter((x) => x.startsWith("draft_"))) console.log(`${k.slice(6).padEnd(6)}: ${String(r[k] ?? "").replace(/\n/g, " / ").slice(0, 220)}`);
}

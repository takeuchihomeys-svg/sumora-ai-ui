// scripts/audit-hold-soft-next.ts — 物件をお送りした後の「検討します・相談します・確認します」の番で、竹内さんが扉の文に添える
//   「柔らかい次の一手」（お気に召されましたら〜ご案内／お申込みで抑える）の率を数える（読むだけ・LLM なし）
//
// 2026-10-15 竹内さん（7番 営業マンの思考）: audit-sales-mind.ts の 60日で一番多かった差の型の1つ＝
//   保留の番で AI は扉だけ（「ごゆっくりご検討ください・いつでもお気軽に」）・竹内さんは扉＋「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます」。
//   ブレインの HESITATION_MOVE（家族相談・保留＝押さずに扉を開けて待つ）は「押さない」だけで、次の一手を置かない形になっていた。
// 実行: npx tsx --env-file=.env.local scripts/audit-hold-soft-next.ts [--days=180] [--show=12]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { holdTurnKind, softNextMoveOf, viewedAlready, notViewableYet } from "../app/lib/hold-soft-next";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DAYS = Number(arg("days") ?? 180);
const SHOW = Number(arg("show") ?? 0);
async function page<T>(fn: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 800; p++) {
    const { data, error } = await fn(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
type M = { id: string; conversation_id: string; sender: string; text: string; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };

(async () => {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const ms = await page<M>((a, b) => sb.from("messages").select("id,conversation_id,sender,text,created_at,staff_writer,is_aix_generated").gte("created_at", since).order("created_at").range(a, b));
  const ex = await page<Record<string, unknown>>((a, b) => sb.from("ai_reply_examples").select("conversation_id,ai_draft,sent_reply,sent_at,created_at").eq("entry_source", "line_reply").not("ai_draft", "is", null).gte("created_at", since).range(a, b));
  const byConv = new Map<string, M[]>();
  for (const m of ms) { if (isTestConversation(m.conversation_id)) continue; if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const draftOf = new Map<string, string>();
  for (const r of ex) { const s = String(r.sent_reply ?? "").trim(); if (s) draftOf.set(`${r.conversation_id}|${s.slice(0, 30)}`, String(r.ai_draft ?? "")); }

  type Row = { conv: string; at: string; kind: string; cust: string; sent: string; draft: string | null; viewed: boolean; notViewable: boolean; sentMove: string | null; draftMove: string | null; writer: string; prevAppeal?: boolean; ptype?: string; pos?: boolean };
  const rows: Row[] = [];
  for (const [conv, arr] of byConv) {
    for (let i = 1; i < arr.length; i++) {
      const m = arr[i];
      if (m.sender !== "staff" || m.is_aix_generated || arr[i - 1].sender !== "customer") continue;
      // 束: お客様の連投・こちらの連投（3分以内）
      let k = i - 1; while (k > 0 && arr[k - 1].sender === "customer") k--;
      const cust = arr.slice(k, i).map((x) => x.text ?? "").join("\n");
      const kind = holdTurnKind(cust);
      if (!kind) continue;
      const prior = arr.slice(Math.max(0, k - 6), k).filter((x) => x.sender === "staff");
      // 物件をお送りした後（直前のこちらの送信に物件の AIX・物件名・見積）だけ
      if (!prior.some((x) => x.is_aix_generated || /🌟|号室|御見積書|オススメ/.test(x.text ?? ""))) continue;
      let j = i; while (j + 1 < arr.length && arr[j + 1].sender === "staff" && Date.parse(arr[j + 1].created_at) - Date.parse(arr[j].created_at) < 180_000) j++;
      const sent = arr.slice(i, j + 1).filter((x) => !x.is_aix_generated).map((x) => x.text ?? "").join("\n");
      const writer = arr.slice(i, j + 1).find((x) => x.staff_writer)?.staff_writer ?? "";
      const hist = arr.slice(0, k);
      const draft = draftOf.get(`${conv}|${sent.trim().slice(0, 30)}`) ?? null;
      const last = prior[prior.length - 1]?.text ?? "";
      const prevAppeal = prior.slice(-2).some((x) => softNextMoveOf(x.text) !== null);
      const ptype = /御見積書/.test(last) ? "見積" : /全て|ピックアップ/.test(prior.map((x) => x.text).join(" ")) && (prior.filter((x) => /🌟/.test(x.text ?? "")).length >= 2) ? "束" : "1件";
      rows.push({ conv, at: m.created_at, kind, cust, sent, draft, viewed: viewedAlready(hist), notViewable: notViewableYet(hist), sentMove: softNextMoveOf(sent), draftMove: draft ? softNextMoveOf(draft) : null, writer, prevAppeal, ptype, pos: /いいですね|良いですね|良さそう|よさそう|素敵|気に入|魅力|候補/.test(cust) });
    }
  }
  const tk = rows.filter((r) => r.writer === "takeuchi");
  const pct = (a: number, b: number) => `${a}/${b}（${b ? Math.round(a / b * 100) : 0}%）`;
  console.log(`=== 物件をお送りした後の保留の番（${DAYS}日）: 全 ${rows.length}・竹内さん ${tk.length}・会話 ${new Set(tk.map((r) => r.conv)).size}`);
  for (const [label, f] of [
    ["全部", () => true], ["内覧前", (r: Row) => !r.viewed && !r.notViewable], ["内覧の後", (r: Row) => r.viewed], ["まだ内覧できない", (r: Row) => r.notViewable],
    ["直前に柔らかい一手あり", (r: Row) => !!r.prevAppeal], ["直前に無し・内覧前", (r: Row) => !r.prevAppeal && !r.viewed && !r.notViewable], ["見積の後", (r: Row) => r.ptype === "見積"], ["束の後", (r: Row) => r.ptype === "束"], ["1件の後", (r: Row) => r.ptype === "1件"], ["評価の語あり", (r: Row) => !!r.pos],
    ["検討します", (r: Row) => r.kind === "検討"], ["相談します", (r: Row) => r.kind === "相談"], ["確認・見てから返信", (r: Row) => r.kind === "確認"],
  ] as Array<[string, (r: Row) => boolean]>) {
    const g = tk.filter(f);
    const v = g.filter((r) => r.sentMove === "viewing").length, a = g.filter((r) => r.sentMove === "apply").length;
    const gd = g.filter((r) => r.draft !== null);
    const dv = gd.filter((r) => r.draftMove).length, sv = gd.filter((r) => r.sentMove).length;
    console.log(`${label.padEnd(10)} 竹内さん 柔らかい次の一手 ${pct(v + a, g.length)}（内覧 ${v}・申込で抑える ${a}）｜下書きのある番 ${gd.length}: 下書き ${pct(dv, gd.length)} → 竹内さん ${pct(sv, gd.length)}`);
  }
  const emp = rows.filter((r) => r.writer === "employee");
  console.log(`（参考）従業員 ${pct(emp.filter((r) => r.sentMove).length, emp.length)}`);
  // 前と後の再生の番（yuma-repeat-replay.ts の --src）: {conv, at, scene, staffText, src}
  const JS = arg("json");
  if (JS) writeFileSync(JS, tk.map((r) => JSON.stringify({ conv: r.conv, at: r.at, scene: "considering", staffText: r.sent, src: `hold-${r.conv.slice(0, 8)}`, writer: "takeuchi", kind: r.kind, sentMove: r.sentMove, draftMove: r.draftMove, hasDraft: r.draft !== null, viewed: r.viewed, notViewable: r.notViewable })).join("\n") + "\n");
  if (SHOW) for (const r of tk.slice(-SHOW)) {
    const m = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様)/g, "〈名〉").replace(/\n+/g, " ／ ").slice(0, 220);
    console.log(`\n==== ${r.at.slice(0, 16)} [${r.kind}${r.viewed ? "・内覧の後" : ""}${r.notViewable ? "・まだ内覧できない" : ""}] 竹=${r.sentMove ?? "-"} AI=${r.draft === null ? "（下書きなし）" : r.draftMove ?? "-"}`);
    console.log(`客: ${m(r.cust)}`); if (r.draft) console.log(`AI: ${m(r.draft)}`); console.log(`竹: ${m(r.sent)}`);
  }
})();

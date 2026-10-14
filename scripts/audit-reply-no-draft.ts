// scripts/audit-reply-no-draft.ts — 「返信を送ったのに下書きが出ていなかった番」を数え、なぜ出なかったかを型で分ける（読むだけ・LLM なし・費用0）
//
// 2026-10-14 竹内さん「返信なのに下書きが無い番をブレイン基準に直す」:
//   番は scripts/audit-split-reply-aix.ts の --out（番ごとの jsonl・個人情報を伏せた行）をそのまま使う（同じ番の切り方・同じブレインの判断）。
//   人が文を送った番（返信・約束の文・人の文に AIX の中身）のうち、送った例の記録に下書きが無い（手打ち）／記録なし の番を、
//   見張りの控え line_watch_turns（会話×番の最初のお客様の通）で なぜ下書きが無かったか に分ける:
//     ・[AIX誘導中]（ブレインが AIX と決めた＝残す）・[返信不要]（締めの後の受けだけの規則 shouldSkipDraftAfterClosing / 連絡待ち）
//     ・下書きはできたがスタッフが先に送った（間に合わない）・夜（22〜9時）の先送り・控えが無い（起動されず・失敗）
//   それぞれをブレインの判断（返信／2段／なし／AIX）と並べ、「ブレインは返信なのに規則で止めた」番を出す。
// 実行:
//   npx tsx --env-file=.env.local scripts/audit-split-reply-aix.ts --days=30 --out=<scratch>/split30.jsonl
//   npx tsx --env-file=.env.local scripts/audit-reply-no-draft.ts --in=<scratch>/split30.jsonl [--samples=3]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { shouldSkipDraftAfterClosing } from "../app/lib/previous-send-note";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IN = arg("in");
const SAMPLES = Number(arg("samples", "3"));
/** line_watch_turns が下書き・印を控え始めたのは 2026-10-01（それより前の番は「控えに下書きが無い」が分からない） */
const SINCE = arg("since", "2026-10-01T00:00:00Z");
if (!IN) { console.error("--in=<audit-split-reply-aix の --out の jsonl>"); process.exit(1); }
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

type Row = {
  conv: string; at: string; turnAt?: string; staffFirstAt?: string | null; writer: string; sub: string; intent: string; ack: boolean;
  brain: string; brainKey: string; brainDir: string; brainLate: boolean; truth: string; truthKey: string; aixByText?: boolean;
  replyKind: string | null; customer: string; staffText: string; prevStaff: string;
};
type Lw = { conversation_id: string; customer_turn_at: string; customer_last_at: string | null; draft_first: string | null; draft_first_at: string | null; draft_sentinel: string | null; draft_sentinel_at: string | null; brain_reply_mode: string | null; brain_action: string | null; brain_at: string | null; staff_first_at: string | null; draft_ready_before_staff: boolean | null };

const jstHour = (t: number) => new Date(t + 9 * 3_600_000).getUTCHours();
const isNight = (t: number) => { const h = jstHour(t); return h >= 22 || h < 9; };

(async () => {
  const rows: Row[] = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const textTurns = rows.filter((r) => (r.truth === "返信" || r.truth === "2段" || r.aixByText) && ms(r.turnAt ?? r.at) >= ms(SINCE));
  const noDraft = textTurns.filter((r) => r.replyKind === "手打ち（下書きなし）" || r.replyKind === "記録なし");
  const convs = [...new Set(noDraft.map((r) => r.conv))];
  const since = new Date(Math.min(...noDraft.map((r) => ms(r.turnAt ?? r.at))) - 86_400_000).toISOString();
  const lws: Lw[] = [];
  for (let i = 0; i < convs.length; i += 80) {
    const { data, error } = await sb.from("line_watch_turns")
      .select("conversation_id, customer_turn_at, customer_last_at, draft_first, draft_first_at, draft_sentinel, draft_sentinel_at, brain_reply_mode, brain_action, brain_at, staff_first_at, draft_ready_before_staff")
      .in("conversation_id", convs.slice(i, i + 80)).gte("customer_turn_at", since);
    if (error) throw new Error(error.message);
    lws.push(...((data ?? []) as Lw[]));
  }
  const lwOf = (r: Row): Lw | null => {
    const t = ms(r.turnAt ?? r.at), last = ms(r.at);
    const cand = lws.filter((x) => x.conversation_id === r.conv && ms(x.customer_turn_at) >= t - 2000 && ms(x.customer_turn_at) <= last + 2000);
    return cand.sort((a, b) => ms(a.customer_turn_at) - ms(b.customer_turn_at))[0] ?? null;
  };
  // ブレインの判断を大きく: 返信（答える・お礼）／2段（約束の返信）／なし（連絡待ち）／AIX／判断なし
  const brainOf = (r: Row) => (r.brain === "AIX" ? "ブレインAIX" : r.brain === "2段" ? "ブレイン2段" : r.brain === "返信" ? "ブレイン返信" : r.brain === "なし" ? "ブレインなし（連絡待ち）" : "判断なし");
  const reasonOf = (r: Row): string => {
    const lw = lwOf(r);
    const staff = ms(r.staffFirstAt ?? lw?.staff_first_at ?? null);
    const custLast = ms(r.at);
    if (!lw) return isNight(custLast) && Number.isFinite(staff) && (isNight(staff) || staff - custLast < 12 * 3_600_000 && jstHour(staff) < 9) ? "夜の先送り（控えなし）" : "控えなし（起動されず・失敗）";
    if (lw.draft_sentinel && /AIX誘導中/.test(lw.draft_sentinel)) return "[AIX誘導中]";
    if (lw.draft_sentinel && /返信不要/.test(lw.draft_sentinel)) return "[返信不要]（締めの後の受けだけ・連絡待ちの規則）";
    if (lw.draft_first_at && Number.isFinite(staff) && ms(lw.draft_first_at) > staff) return "下書きが間に合わない（スタッフが先に送った）";
    if (lw.draft_first_at) return "下書きはあったが送った例に無い（画面の外・別の通で送った）";
    if (isNight(custLast) && (!Number.isFinite(staff) || isNight(staff))) return "夜の先送り";
    if (lw.brain_at && Number.isFinite(staff) && ms(lw.brain_at) > staff) return "ブレインも間に合わない（スタッフが先に送った）";
    return "ブレインのみ・下書きなし（生成の失敗・ゲート）";
  };
  const count = <T>(xs: T[], f: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) { const k = f(x); m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  const pct = (a: number, b: number) => (b ? `${a}/${b}（${Math.round((a / b) * 100)}%）` : `${a}/0`);

  console.log(`# 返信を送ったのに下書きが無かった番（${IN.split(/[\\/]/).pop()}）`);
  console.log(`  人が文を送った番 ${textTurns.length}（返信 ${textTurns.filter((r) => r.truth === "返信").length}・約束の文 ${textTurns.filter((r) => r.truth === "2段").length}・文に AIX の中身 ${textTurns.filter((r) => r.aixByText).length}）`);
  console.log(`  そのうち下書きが無い ${pct(noDraft.length, textTurns.length)}（手打ち ${noDraft.filter((r) => r.replyKind === "手打ち（下書きなし）").length}・記録なし ${noDraft.filter((r) => r.replyKind === "記録なし").length}）`);
  console.log(`\n## 1. なぜ出なかったか × ブレインの判断`);
  for (const [k, n] of count(noDraft, reasonOf)) {
    const xs = noDraft.filter((r) => reasonOf(r) === k);
    console.log(`  ■ ${k} ${n}（竹内さん ${xs.filter((r) => r.writer === "takeuchi").length}）: ${count(xs, brainOf).map(([b, v]) => `${b} ${v}`).join("・")}`);
  }
  console.log(`\n## 2. ブレインは返信／2段なのに規則で止めた番（直す対象）`);
  const fixable = noDraft.filter((r) => /返信不要/.test(reasonOf(r)) && (r.brain === "返信" || r.brain === "2段"));
  console.log(`  [返信不要] × ブレイン返信/2段: ${fixable.length}（竹内さん ${fixable.filter((r) => r.writer === "takeuchi").length}）`);
  const rule = noDraft.filter((r) => /返信不要/.test(reasonOf(r)));
  console.log(`  [返信不要] 全体のブレイン: ${count(rule, brainOf).map(([b, v]) => `${b} ${v}`).join("・")}`);
  const aixStop = noDraft.filter((r) => reasonOf(r) === "[AIX誘導中]");
  console.log(`  [AIX誘導中] の番の分析時のブレイン: ${count(aixStop, brainOf).map(([b, v]) => `${b} ${v}`).join("・")}（ブレイン AIX＝残す。それ以外はブレインの判断が後で AIX に変わった／やることのタスク）`);
  console.log(`  [AIX誘導中] × 人の行動: ${count(aixStop, (r) => `${r.truth}`).map(([b, v]) => `${b} ${v}`).join("・")}`);
  // 規則が今の版でも止めるか（前の通・お客様の文は伏せた文なので目安）
  const ruleNow = rule.filter((r) => shouldSkipDraftAfterClosing({ prevStaffText: r.prevStaff.replace(/ ／ /g, "\n"), customerText: r.customer.replace(/ ／ /g, "\n") }).skip).length;
  console.log(`  [返信不要] のうち今の規則でも止まる（伏せた文で目安）: ${ruleNow}/${rule.length}`);
  console.log(`\n## 3. 間に合わない番の遅れ（お客様の最後の通→下書き／スタッフ）`);
  const late = noDraft.filter((r) => /間に合わない/.test(reasonOf(r)));
  const lag = late.map((r) => { const lw = lwOf(r)!; return { d: (ms(lw.draft_first_at ?? lw.brain_at) - ms(r.at)) / 1000, s: (ms(r.staffFirstAt ?? lw.staff_first_at) - ms(r.at)) / 1000 }; }).filter((x) => Number.isFinite(x.d) && Number.isFinite(x.s));
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  console.log(`  ${late.length}番: 下書き／ブレインの中央値 ${med(lag.map((x) => x.d)).toFixed(0)}秒・スタッフの中央値 ${med(lag.map((x) => x.s)).toFixed(0)}秒・スタッフが60秒以内 ${lag.filter((x) => x.s < 60).length}`);
  console.log(`\n## 4. 小場面（下書きなしの番・上位）: ${count(noDraft, (r) => r.sub).slice(0, 10).map(([k, v]) => `${k} ${v}`).join("・")}`);
  if (SAMPLES) {
    console.log(`\n## 見本（伏せた文）`);
    for (const [k] of count(noDraft, reasonOf)) {
      console.log(`  --- ${k}`);
      for (const r of noDraft.filter((x) => reasonOf(x) === k).slice(0, SAMPLES)) {
        console.log(`    ${new Date(ms(r.at) + 9 * 3_600_000).toISOString().slice(5, 16)}JST ${r.conv.slice(0, 8)} ${r.sub} 書き手=${r.writer} ブレイン=${r.brainKey}「${r.brainDir.slice(0, 40)}」\n      前「${r.prevStaff.slice(-60)}」\n      客「${r.customer.slice(0, 90)}」\n      人=${r.truthKey}「${r.staffText.slice(0, 90)}」`);
      }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });

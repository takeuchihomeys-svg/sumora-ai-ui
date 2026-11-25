// scripts/audit-promise-lifecycle.ts — 約束の一生を段ごとに数える（台帳 #664・2026-11-25 作業員L・読むだけ・LLM なし・DB なし）
//   段: 見つける → 期日 → 記録 → 統括 → 果たす → 閉じる → 見張り → 試験。元の数えは前に流した台本の出力（JSON）を読むだけ:
//     見つける・記録: scripts/audit-promise-kinds.ts --wide --out（約束の文の種類・「その他」の分け・記録の有無）
//     期日・果たす: scripts/audit-promise-kept.ts --out（B1・期限の決め方・期限内に果たした）
//     閉じる: scripts/list-done-at-backfill.ts --out（果たした時刻の入った行）
//     試験: scripts/brain-exam/spec.json（答え方 promise の依頼）
//   「見つける」の網の穴は、「その他」の「残り」（申込以降・気持ち・約束でない・内覧当日を除いた物）を言い回しの動詞ごとに分け、入るはずの種類の案を付ける。
//   会話の文は出さない（伏せた形の頭だけ・会話は頭8字）。
// 実行: npx tsx scripts/audit-promise-lifecycle.ts --kinds=<kinds.json> --b1=<b1.json> --done=<done-at.json> [--spec=scripts/brain-exam/spec.json]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const rd = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

/** 「残り」の動詞 → 入るはずの種類の案（コードの種類の名前・推した案なので「案」と書く） */
export const HOLE_GUESS: Record<string, string> = {
  お送り: "探す（新着・募集に出次第お送り＝ピックアップの約束）", ご連絡: "連絡（種類はあるが1件も入っていない）", 確認: "確認（最終確認・募集状況確認）",
  交渉: "交渉（減額・日程の交渉＝種類が無い）", 共有: "連絡（管理会社に共有）", ご用意: "見積（御見積書をご用意）・持参", 手配: "内覧・申込の手配",
  お申込: "申込以降に寄る（申込の手配）", "（動詞なし）": "動詞の取り出しが外れた（割引・条件に加える・探し続ける）",
};

const kinds = rd(arg("kinds")), b1 = rd(arg("b1")), done = rd(arg("done")), spec = rd(arg("spec", "scripts/brain-exam/spec.json"));
if (!kinds || !b1) { console.error("--kinds と --b1 の JSON が要る"); process.exit(1); }
type KRow = { type: string; bucket?: string | null; key?: string | null; shape?: string | null; fact?: boolean; calendar?: boolean };
const rows = (kinds.rows ?? []) as KRow[];
const other = rows.filter((r) => r.type === "その他");
const notPromise = other.filter((r) => ["申込以降", "気持ち", "約束でない"].includes(String(r.bucket))).length;
const rest = other.filter((r) => r.bucket === "残り");
const scope = rows.length - notPromise;
const typed = rows.filter((r) => r.type !== "その他");
const b1r = (b1.rows ?? []) as Array<{ deadlineBy?: string; state?: string; writer?: string }>;
const judged = b1r.filter((r) => ["in_time", "late", "overdue"].includes(String(r.state)));
const inTime = b1r.filter((r) => r.state === "in_time").length;
const words = b1r.filter((r) => r.deadlineBy === "words").length;
const sp = (Array.isArray(spec) ? spec : spec?.problems ?? []) as Array<{ id: string; asks?: unknown[] }>;
const promiseAsks = sp.flatMap((x) => (x.asks ?? []).filter((a) => /promise/.test(JSON.stringify(a))).map(() => x.id));

console.log(`# 約束の一生（${kinds.days ?? "?"}日・約束の文 ${rows.length}・B1 の約束 ${b1r.length}）\n`);
console.log("| 段 | 今の数 | 割合 | 何を見たか |");
console.log("|---|---|---|---|");
console.log(`| ① 見つける | 種類が付いた ${typed.length}・網の外れ（その他の残り）${rest.length} | 外れ ${pct(rest.length, scope)}（約束の範囲 ${scope}） | audit-promise-kinds（申込以降・気持ち・約束でないは範囲外・内覧当日は別に数える） |`);
console.log(`| ② 期日 | 約束の文に期限あり ${words}・72時間の決めで見た ${b1r.length - words} | 文に期限 ${pct(words, b1r.length)} | B1 の deadlineBy |`);
const fact = typed.filter((r) => r.fact).length, cal = typed.filter((r) => r.calendar).length;
console.log(`| ③ 記録 | 行動台帳 ${fact}・カレンダー ${cal}（種類の付いた ${typed.length} のうち） | 台帳 ${pct(fact, typed.length)}・カレンダー ${pct(cal, typed.length)} | audit-promise-kinds の記録の有無 |`);
console.log(`| ④ 統括 | 期限を過ぎた約束を統括に渡す（CONDUCTOR_OVERDUE_PROMISES 既定 on） | 渡った数の物差しが無い | 読む所はある・番ごとに渡ったかを数える欄が無い |`);
console.log(`| ⑤ 果たす | 期限内 ${inTime}（判定 ${judged.length}） | ${pct(inTime, judged.length)} | B1 |`);
if (done) console.log(`| ⑥ 閉じる | 果たした時刻あり ${done.withTime}・時刻なし ${done.noTime}（${done.rows}行） | ${pct(done.withTime, done.rows)} | list-done-at-backfill |`);
console.log(`| ⑦ 見張り | 期限を過ぎて果たしていない約束を見張りの窓で取りこぼした 0（core:window_miss:promise.14d） | — | 毎朝の1枚（quality_daily） |`);
console.log(`| ⑧ 試験 | 答え方 promise の依頼 ${promiseAsks.length}（${new Set(promiseAsks).size}問） | 試験の問題 ${sp.length}問のうち ${pct(new Set(promiseAsks).size, sp.length)} | spec.json |`);

console.log(`\n## ① 見つけるの網の穴（その他の残り ${rest.length}・動詞ごと・入るはずの種類は案）`);
const by = new Map<string, KRow[]>();
for (const r of rest) by.set(String(r.key ?? "（動詞なし）"), [...(by.get(String(r.key ?? "（動詞なし）")) ?? []), r]);
for (const [k, xs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
  const heads = new Map<string, number>();
  for (const x of xs) { const h = String(x.shape ?? "").replace(/[＊0-9０-９〇]+/g, "").replace(/[😊😌!！。、\s]/g, "").slice(0, 16); heads.set(h, (heads.get(h) ?? 0) + 1); }
  const top = [...heads].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h, n]) => `「${h}…」${n}`).join("・");
  console.log(`- ${k} ${xs.length}: ${HOLE_GUESS[k] ?? "—"}（多い形 ${top}）`);
}

// ─── 2026-11-25 作業員L（統括役の頼み・#664）: 段ごとの表（決まり・材料・物差し・試験の問題・統括に届くか）と空き ───
//   決まりの欄はコードの場所（読むだけ・変わったら直す）。試験の問題は spec.json の正解の文の言葉で数える（目安）。
//   試験の物差し: 前の基準の答え（--results の main-*.jsonl の新しい20本）で、正解の答え方が promise の依頼を、答案が扱えたか（covered）・答え方が合ったか（route）
{
  const specById = new Map(sp.map((p) => [p.id, p as { id: string; asks?: Array<{ route?: string }> }]));
  const has = (p: unknown, re: RegExp) => re.test(JSON.stringify(p));
  const exOverdue = sp.filter((p) => has(p, /期限|過ぎ|まだ届|まだ来|遅れ|催促|返信はまだ|どうなりました/)).length;
  const exDeadline = sp.filter((p) => has(p, /明日|本日中|週明け|までに|翌営業日/)).length;
  const exClosed = sp.filter((p) => has(p, /済み|果たし|お送り済|送付済/)).length;
  const pr = { asks: 0, covered: 0, route: 0, files: 0 };
  const dir = arg("results", "");
  if (dir) {
    const files = readdirSync(dir).filter((f) => /^main-.*\.jsonl$/.test(f)).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, Number(arg("results-files", "20")) || 20); // 2026-11-25: 基準の1本は積んだ問題だけ＝新しい20本を合わせる
    for (const { f } of files) {
      pr.files++;
      for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!l) continue;
        let r: { id?: string; asks?: Array<{ covered?: boolean; route?: boolean }> } = {};
        try { r = JSON.parse(l); } catch { continue; }
        const s = r.id ? specById.get(r.id) : undefined;
        (s?.asks ?? []).forEach((a, i) => { if (a.route !== "promise") return; const x = r.asks?.[i]; if (!x) return; pr.asks++; if (x.covered) pr.covered++; if (x.route) pr.route++; });
      }
    }
  }
  const fact = typed.filter((r) => r.fact).length, cal = typed.filter((r) => r.calendar).length;
  console.log("\n## 段ごとの表（決まり・材料・物差し・試験の問題・統括に届くか）");
  console.log("| 段 | 決まり（コード） | 材料 | 物差し（今の数） | 試験の問題 | 統括に届くか | 空き |");
  console.log("|---|---|---|---|---|---|---|");
  console.log(`| 見つける | promise-drop-watch.promiseKindNameOf・promiseDropKindOf（PROMISE_KIND_WIDE・WIDE2 は既定 off） | こちらの手打ちの通 | 外れ ${pct(rest.length, scope)} | 答え方 promise ${new Set(promiseAsks).size}問 | ○ 見張りと統括は同じ網 | 連絡・交渉の種類が無い（果たした判定が無い） |`);
  console.log(`| 期日 | promise-due.promiseDueDay・promise-drop-watch.promiseDeadlineMs（PROMISE_DUE_WIDE・DUE_BY_KIND は既定 off） | 約束の文 | 文に期限 ${pct(words, b1r.length)} | 期限の言葉 ${exDeadline}問（目安） | ○ 統括の1行に期限 | 期限を言わない約束が約9割＝72時間の決め |`);
  console.log(`| 記録 | action-ledger.classifyStaffTextFacts（sent_facts）・カレンダーの【必ず】 | 行動台帳・calendar_events | 台帳 ${pct(fact, typed.length)}・カレンダー ${pct(cal, typed.length)} | 写しの台帳（sent_facts） | ○ 事実の帳面 | — |`);
  console.log(`| 統括 | brain-core の conductor_intake の overduePromisesFor（OVERDUE_NOW_CLOCK は shadow） | 1会話分の通・AIX・送付 | digest.odp・odn（毎朝の1枚） | 催促・期限 ${exOverdue}問（目安） | △ 時計の差で渡り損ね（shadow で数え中） | 試験は時刻が止まり時計の差を見られない・期日超えの番の問題が少ない |`);
  console.log(`| 果たす | promise-drop-watch.promiseFulfilledBy | 通・AIX・sent_properties | 期限内 ${pct(inTime, judged.length)}（B1） | promise の依頼の扱い ${pr.asks ? `${pct(pr.covered, pr.asks)}（答え方 ${pct(pr.route, pr.asks)}・${pr.asks}件・基準 ${pr.files}本）` : "—"} | ○ digest.odp の fulfil | — |`);
  if (done) console.log(`| 閉じる | calendar-done-at（done_at・#663） | calendar_events | 時刻あり ${pct(done.withTime, done.rows)} | 済みの言葉 ${exClosed}問（目安） | ○ 今の状況の開いている約束 | — |`);
  console.log(`| 見張り | promise-drop-watch（朝 5:25・記録だけ） | 30日の約束の会話 | 取りこぼし 0（core:window_miss） | —（LLM なし） | ○ 同じ決め | 売上番長への送付は竹内さんの OK 待ち |`);
  // 2026-11-25 作業員L（台帳 #727）: --write で段ごとの数を quality_daily に（scope=all・metric=promise_life:<段>・記録だけ）。毎朝の1枚が1行で出す
  if (argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const v = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const kv: Array<[string, number | null, number]> = [
      ["find_miss", v(rest.length, scope), scope], ["due_words", v(words, b1r.length), b1r.length], ["record_fact", v(fact, typed.length), typed.length], ["record_calendar", v(cal, typed.length), typed.length],
      ["kept_in_time", v(inTime, judged.length), judged.length], ["closed_with_time", done ? v(done.withTime, done.rows) : null, done?.rows ?? 0],
      ["exam_promise_covered", v(pr.covered, pr.asks), pr.asks], ["exam_promise_route", v(pr.route, pr.asks), pr.asks],
    ];
    const rowsQ = kv.filter(([, x]) => x != null).map(([k, x, n]) => ({ day, metric: `promise_life:${k}`, scope: "all", value: x as number, n, source: "scripts/audit-promise-lifecycle.ts" }));
    void (async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
      const { error } = await sb.from("quality_daily").upsert(rowsQ, { onConflict: "day,metric,scope" });
      console.log(error ? `quality_daily に書けない: ${error.message}` : `quality_daily に ${rowsQ.length}行（${day}・promise_life:*）`);
    })();
  }
  console.log(`| 試験 | spec の答え方 promise・判定の route | 試験の写し | promise の依頼の扱い ${pr.asks ? pct(pr.covered, pr.asks) : "—"} | ${new Set(promiseAsks).size}問 | — | 物差しが毎朝に出ていない |`);
}

/**
 * 統括の「判断 → 実行 → 確認」の輪を測る（2026-11-15 竹内さん）
 *
 *   竹内さん「ほかにも統括が連携弱い部分等あれば土台作って強化する」
 *     「学習も弱い部分を見つけて強化できるようにするために」
 *     「実際の人間の動きのようになるために」
 *
 * ★ 実測で見つけた3つの弱さ（2026-11-15）
 *   ① **統括が判断しても現場で実行されていない**
 *      現場への指示（直近100件）= pending 61件・error 39件・**誰も拾っていない 0件**。
 *      error の理由は39回とも「AIXモードのPCが3時間なかったため未実行で終了」。
 *      ＝ 拡張のPCが AIX モードになっていないので、指示が拾われない。
 *      ⚠ 統括は「指示を出した」と言うが、**実際に動いたかを見ていなかった**。
 *   ② **actions が1種類に偏っている**
 *      「欄の種類が分からない」が **77回**（他は12回以下）。
 *      同じ指摘を何度も出し続けている＝**直ったかを確かめていない**。
 *   ③ **強化の記録（learn_improvements）が古い**
 *      直近10件が 11-14 の物ばかり（11-15 の作業が入っていない）。
 *
 * ★ この土台がやること
 *   統括の判断（`learn_supervisor_log`）と、現場の実行（`automation_commands`）と、
 *   強化の実績（`learn_improvements`）を**1つの表にまとめて**、
 *   「判断したのに動いていない」「同じ指摘を出し続けている」を**数で**見せる。
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/audit-supervisor-loop.ts
 *   npx tsx --env-file=.env.local scripts/audit-supervisor-loop.ts --days=3
 *
 * ⚠ 読むだけ（DBを変えない）。
 */
import { supabase } from "../app/lib/supabase-server";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const days = Math.max(1, Math.min(30, Number(argOf("days", "7")) || 7));
const since = new Date(Date.now() - days * 86400_000).toISOString();
const jst = (i: unknown) => new Date(new Date(String(i)).getTime() + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ");

void (async () => {
  console.log(`統括の「判断 → 実行 → 確認」の輪（${days}日）`);
  console.log("─".repeat(72));

  // ① 統括の判断
  const { data: logs } = await supabase.from("learn_supervisor_log")
    .select("created_at,scope,verdict,coverage,weak_n,actions").gte("created_at", since)
    .order("created_at", { ascending: false }).limit(300);
  const logRows = (logs ?? []) as Array<Record<string, unknown>>;
  const actCount: Record<string, number> = {};
  for (const r of logRows) {
    const acts = r.actions as Array<Record<string, unknown>> | null;
    for (const a of Array.isArray(acts) ? acts : []) {
      const k = String(a.what || a.name || "?").slice(0, 34);
      actCount[k] = (actCount[k] || 0) + 1;
    }
  }
  console.log(`① 統括の判断: ${logRows.length}回`);
  if (logRows.length) {
    console.log(`   最新: ${jst(logRows[0].created_at)} ${logRows[0].verdict}（材料 ${logRows[0].coverage}・弱い所 ${logRows[0].weak_n}）`);
  }

  // ② 現場の実行（指示が拾われたか・終わったか）
  const { data: cmds } = await supabase.from("automation_commands")
    .select("created_at,status,error_message,picked_install_id,picked_up_at,completed_at,payload,sites")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(500);
  const cmdRows = (cmds ?? []) as Array<Record<string, unknown>>;
  const st: Record<string, number> = {};
  const errs: Record<string, number> = {};
  let picked = 0;
  let oldestPendingMin = 0;
  for (const r of cmdRows) {
    st[String(r.status)] = (st[String(r.status)] || 0) + 1;
    if (r.picked_install_id) picked++;
    const e = String(r.error_message || "").trim();
    if (e) { const k = e.slice(0, 56); errs[k] = (errs[k] || 0) + 1; }
    if (String(r.status) === "pending") {
      const min = Math.round((Date.now() - new Date(String(r.created_at)).getTime()) / 60000);
      if (min > oldestPendingMin) oldestPendingMin = min;
    }
  }
  console.log(`\n② 現場への指示: ${cmdRows.length}件  ${JSON.stringify(st)}`);
  console.log(`   ⚠ 誰かが拾った: ${picked}件（${cmdRows.length ? Math.round((picked / cmdRows.length) * 100) : 0}%）`);
  if (oldestPendingMin) console.log(`   ⚠ 一番古い pending: ${oldestPendingMin}分前（拾われていない）`);
  if (Object.keys(errs).length) {
    console.log("   失敗の理由（上位）:");
    for (const [k, n] of Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`     ${n}回  ${k}`);
  }

  // ③ 強化の実績（直ったか）
  const { data: imps } = await supabase.from("learn_improvements")
    .select("at,area,title,effect").gte("at", since).order("at", { ascending: false }).limit(100);
  const impRows = (imps ?? []) as Array<Record<string, unknown>>;
  console.log(`\n③ 強化の実績: ${impRows.length}件`);
  const byArea: Record<string, number> = {};
  for (const i of impRows) byArea[String(i.area)] = (byArea[String(i.area)] || 0) + 1;
  if (Object.keys(byArea).length) console.log("   分野: " + JSON.stringify(byArea));
  for (const i of impRows.slice(0, 4)) console.log(`   ${jst(i.at)} [${i.area}] ${String(i.title).slice(0, 48)}`);

  /**
   * ④ 輪が切れている所を名指しする（ここが土台の目的）
   *   ⚠ 「判断したのに動いていない」「同じ指摘を出し続けている」を**数で**言う。
   */
  console.log("\n" + "═".repeat(72));
  console.log("④ 輪が切れている所（数で言う）");
  console.log("═".repeat(72));
  const cuts: string[] = [];

  // (a) 拾われていない指示
  if (cmdRows.length && picked / cmdRows.length < 0.5) {
    cuts.push(
      `⚠ **指示が拾われていない**（${cmdRows.length}件中 拾われたのは ${picked}件・${Math.round((picked / cmdRows.length) * 100)}%）\n`
      + `     → 拡張のPCが自動/AIXモードになっていない可能性（実測の失敗理由: 「AIXモードのPCが3時間なかったため未実行で終了」）\n`
      + `     → 統括の判断ではなく**運用**の問題。PCをモードにしておく／期限を延ばす`,
    );
  }
  // (b) 同じ指摘を出し続けている
  const topAct = Object.entries(actCount).sort((a, b) => b[1] - a[1])[0];
  if (topAct && topAct[1] >= Math.max(5, Math.round(logRows.length * 0.5))) {
    cuts.push(
      `⚠ **同じ指摘を出し続けている**（「${topAct[0]}」が ${topAct[1]}回）\n`
      + `     → 統括は「直ったか」を確かめていない。**直す→確かめる→消える**の輪を作る`,
    );
  }
  // (c) 強化の実績が無い
  if (!impRows.length) {
    cuts.push(`⚠ **強化の実績が ${days}日で0件**（判断はしているが、直した記録が無い）\n     → 判断を実行に移す側（supervisor-do.ts）が動いていない`);
  }

  if (!cuts.length) {
    console.log("   ✅ 大きな切れは見つかりません");
  } else {
    for (const c of cuts) console.log("  " + c + "\n");
  }

  // ⑤ 次にやる事（優先順）
  console.log("⑤ 次にやる事（この順）");
  if (cuts.length) {
    let i = 1;
    if (cmdRows.length && picked / cmdRows.length < 0.5) {
      console.log(`  ${i++}. 拡張を自動/AIXモードにしておく（指示が拾われるようにする・運用）`);
    }
    if (topAct && topAct[1] >= 5) {
      console.log(`  ${i++}. 「${topAct[0]}」を直す → 次に統括が同じ事を言わないか確かめる`);
    }
    if (!impRows.length) {
      console.log(`  ${i++}. supervisor-do.ts で判断を1つ実行する（実績を残す）`);
    }
  } else {
    console.log("  （なし）");
  }
})();

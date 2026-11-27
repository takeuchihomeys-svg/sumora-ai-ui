// scripts/audit-pending-check-answered.ts — #829 PENDING_CHECK_ANSWERED_GUARD の線の監査（過去の実送信・読むだけ・LLM なし）
// 2026-11-27 作業員A（竹内さんの決定 KB 212e2945・統括役「誤検出0の線を監査してから試験へ」）
//   本番で効く時と同じ形でなぞる: line_tasks の property_check（直近 N日）の確認中の間（作成〜完了・取り消し・無ければ +7日）に
//   お客様の番が来るたび、その時までのこちらの通だけで pendingCheckAnsweredByStaff を当てる（＝返信の下書きを作る時に見える物だけ）。
//   「答え済み」と見た番で、スタッフが実際に送った次のこちらの文の通が、まだ確認中として振る舞っていた（確認出来次第・確認中・募集状況を確認させて頂きます）
//   ＝その番で「確認中」を外すのは誤り＝誤検出。0 でなければ入れない（おかしな文の手順⑤）。
//   --show で誤検出の番と、外した番の見本を目で読む用に出す（60字まで・お客様の名前は伏せる・お客様の通は出さない）
//   実行: npx tsx --env-file=.env.local scripts/audit-pending-check-answered.ts [--days=60] [--show]
import { createClient } from "@supabase/supabase-js";
import { pendingCheckAnsweredByStaff, type PcaMessage } from "../app/lib/pending-check-answered";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const days = Number(arg("days", "60"));
const show = process.argv.includes("--show");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", key);
const mask = (t: string) => t.replace(/\s+/g, " ").replace(/[一-龠ァ-ヶa-zA-Zー]+(?:さん|様)/g, "◯さん").slice(0, 60);
/** スタッフがまだ確認中として振る舞った通（誤検出の目印） */
const STILL_CHECKING_RE = /確認(?:出来|でき)次第|確認中|募集状況(?:を)?(?:確認|お調べ)(?:させて(?:頂|いただ)き|いたし|致し)ます|確認が(?:取れ|とれ)(?:次第|ましたら)/;

/** 次の通が、このお客様の番の新しい依頼への新しい約束（「〜確認させて頂きます」・お送り頂きました・かしこまりました）＝前の確認の続きではない。新しい約束は two-stage／ブレインが作るので「確認中」のヒントとは別 */
const NEW_PROMISE_RE = /かしこまりました|承知(?:いたし|致し)ました|お送り(?:頂|いただ)き(?:ました|ありがとう)|(?:確認|交渉|お調べ|お問い合わせ)(?:させて(?:頂|いただ)き|いたし|致し)ます/;

async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: tasks, error } = await sb.from("line_tasks").select("id, conversation_id, status, created_at, completed_at, resolved_at, result")
    .eq("task_type", "property_check").gte("created_at", since).order("created_at", { ascending: true }).limit(1000);
  if (error) throw error;
  let fpNew = 0;
  let n = 0, turns = 0, answeredTurns = 0, fp = 0, staffNextChecking = 0, tasksAnswered = 0;
  const fpLines: string[] = [], okLines: string[] = [];
  for (const t of tasks ?? []) {
    n++;
    const endMs = Date.parse(t.completed_at ?? t.resolved_at ?? "") || Date.parse(t.created_at) + 7 * 86_400_000;
    const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated")
      .eq("conversation_id", t.conversation_id).gte("created_at", t.created_at).lte("created_at", new Date(endMs + 6 * 3600_000).toISOString())
      .order("created_at", { ascending: true }).limit(300);
    const msgs: PcaMessage[] = (ms ?? []).map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated }));
    let anyAnswered = false;
    for (let k = 0; k < msgs.length; k++) {
      const c = msgs[k];
      const cAt = Date.parse(c.createdAt ?? "");
      if (c.sender !== "customer" || !(cAt > Date.parse(t.created_at)) || cAt > endMs) continue;
      if (msgs[k + 1]?.sender === "customer") continue; // 連投は最後の通で1番
      turns++;
      const v = pendingCheckAnsweredByStaff({ taskCreatedAt: t.created_at, messages: msgs.slice(0, k) });
      const next = msgs.slice(k + 1).find((m) => m.sender === "staff" && !m.isAix && !/^\[(?:画像|スタンプ|動画|ファイル)\]$/.test(m.text.trim()));
      const checking = !!next && STILL_CHECKING_RE.test(next.text);
      if (checking) staffNextChecking++;
      if (!v.answered) continue;
      answeredTurns++; anyAnswered = true;
      const hit = msgs.find((m) => m.createdAt === v.at);
      const line = `${String(t.conversation_id).slice(0, 8)} ${t.status}${t.result ? "/" + t.result : ""} 答え(${v.by}): ${mask(hit?.text ?? "")}\n    次のこちらの通: ${next ? mask(next.text) : "（無し）"}`;
      if (checking && NEW_PROMISE_RE.test(next!.text)) { fpNew++; } else if (checking) { fp++; fpLines.push(line); } else if (okLines.length < 15) okLines.push(line);
    }
    if (anyAnswered) tasksAnswered++;
  }
  console.log(`property_check ${days}日: ${n}件・確認中の間のお客様の番 ${turns}（そのうちスタッフの次の通がまだ確認中 ${staffNextChecking}）`);
  console.log(`  答え済みと見て「確認中」を外す番: ${answeredTurns}（タスク ${tasksAnswered}件）`);
  console.log(`  誤検出（外したのにスタッフの次の通は前の確認の続きでまだ確認中）: ${fp}`);
  console.log(`  （参考）次の通がこの番の新しい依頼への新しい約束: ${fpNew}＝別の依頼・前の確認とは別に two-stage が約束を作る`);
  if (show) {
    console.log("\n── 誤検出 ──\n" + [...new Set(fpLines)].join("\n"));
    console.log("\n── 外した番の見本 ──\n" + [...new Set(okLines)].join("\n"));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

// scripts/audit-ack-fulfil-timing.ts — こちらの約束が開いている「お礼・了承だけ」の番で、竹内さん本人が何を・何分後に送ったか（読むだけ・LLM なし・費用0）
//
// 2026-11-23 作業員A（統括役の頼み b・KB 120721d0「30分以内の AIX 2.7%＝2択にしない・外れと数えない」の読みの確かめ）。
//   120721d0 は 30分の窓だけを見て「何も送らない 84%」と数えた。竹内さんの約束を果たす AIX は 30分より後が多い疑い（60日の数え直しで判断→AIX の中央 約100分）。
//   ここでは次のお客様の発言まで（最大24時間）の竹内さんの最初の一手を、時間の帯ごとに数える。
//   竹内さん本人の番 = 窓のこちらの送信が全部、端末の記録（messages.staff_writer・device/group_speaker）で takeuchi（staff-writer.deviceWriterOfWindow）。
//   窓に送信が無い番は「何も送らない」で別に数える（書き手は決まらないので竹内さん本人の番には入れず、全体の数として出す）。申込以降は外す（combo-daily と同じ）。
// 実行（22時以降）: npx tsx --env-file=<env> scripts/audit-ack-fulfil-timing.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { isAckOnlyTurn } from "../app/lib/draft-repeat";
import { aixFulfilsPrevPromise } from "./lib/combo-of-moves";
import { POST_APPLY_RE } from "./lib/combo-daily";
import { deviceWriterOfWindow, type DeviceWriterMsg } from "../app/lib/staff-writer";
import { NO_LINE_TEST_CONVERSATION_IDS, STAFF_INTERNAL_CONVERSATION_IDS, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SELF_CHECK_AS_ACK = process.argv.includes("--self-check-as-ack");
/** お客様自身の確認の言い方（こちらへの依頼ではない） */
const CUSTOMER_SELF_CHECK_RE = /(?:確認|拝見|検討)(?:させて(?:い|頂)ただ?きます|させて頂きます|します|致します|いたします)[！!。.〜~]*|(?:見て|見させて)(?:み|いただき|頂き)ます[！!。.〜~]*/g;
type M = DeviceWriterMsg & { conversation_id: string; text: string | null; is_aix_generated: boolean | null };
const BUCKETS = [["≤30分", 30], ["30分〜2時間", 120], ["2〜6時間", 360], ["6〜24時間", 1440]] as const;
const bucketOf = (min: number) => BUCKETS.find(([, hi]) => min <= hi)?.[0] ?? "24時間より後";

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  let days = Number(arg("days", "90")) || 90;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 3); console.log(`営業時間なので --days=${days} に絞った`); }
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const skip = new Set<string>([YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS, ...STAFF_INTERNAL_CONVERSATION_IDS]);
  // 会話は見張りの番のある会話（全会話を読まない）
  const convs = new Set<string>();
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("conversation_id").gte("customer_turn_at", since).range(i, i + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ conversation_id: string }>) if (!skip.has(r.conversation_id)) convs.add(r.conversation_id);
    if ((data ?? []).length < 1000) break;
  }
  const tally: Record<string, Record<string, number>> = {};
  const add = (row: string, col: string) => { (tally[row] = tally[row] ?? {})[col] = (tally[row][col] ?? 0) + 1; };
  let turns = 0, takeuchiTurns = 0, silent = 0, other = 0;
  for (const c of convs) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer, staff_writer_source").eq("conversation_id", c).gte("created_at", new Date(Date.parse(since) - 864e5).toISOString()).order("created_at").limit(5000);
    if (error) throw new Error(error.message);
    const ms = (data ?? []) as M[];
    for (let i = 1; i < ms.length; i++) {
      // 番 = お客様の束の最後の通（次がこちらの通か窓の終わり）
      if (ms[i].sender !== "customer" || (ms[i + 1] && ms[i + 1].sender === "customer")) continue;
      if (Date.parse(ms[i].created_at) < Date.parse(since)) continue;
      let j = i; const burst: string[] = [];
      while (j >= 0 && ms[j].sender === "customer") { burst.unshift(String(ms[j].text ?? "")); j--; }
      // 2026-11-23 作業員A（N2 の照らし①・82c4d3e8 11/22）: お客様自身の確認（「確認させていただきます」「見てみます」）だけを足したお礼は、
      //   こちらへの問い・依頼が無い＝了承の番として数える（--self-check-as-ack の時だけ・既定は今の数え方のまま＝KB b385e315 の数を変えない）
      const ackHere = isAckOnlyTurn(burst) || (SELF_CHECK_AS_ACK && isAckOnlyTurn(burst.map((b) => b.replace(CUSTOMER_SELF_CHECK_RE, "")).filter((b) => b.trim())));
      if (j < 0 || !ackHere) continue;
      const at = Date.parse(ms[i].created_at);
      const prevStaff = ms.slice(0, j + 1).filter((m) => m.sender !== "customer" && at - Date.parse(m.created_at) <= 864e5).map((m) => String(m.text ?? ""));
      const kinds = (["property_send", "property_check_result", "estimate_sheet"] as const).filter((k) => aixFulfilsPrevPromise(k, prevStaff));
      if (!kinds.length) continue;
      if (ms.slice(0, i + 1).some((m) => m.sender !== "customer" && POST_APPLY_RE.test(String(m.text ?? "")))) continue;
      turns++;
      const promise = kinds.map((k) => (k === "property_send" ? "ピックアップ" : k === "property_check_result" ? "確認" : "見積")).join("+");
      const next = ms.slice(i + 1).find((m) => m.sender === "customer");
      const end = Math.min(next ? Date.parse(next.created_at) : Infinity, at + 864e5);
      const win = ms.slice(i + 1).filter((m) => m.sender !== "customer" && Date.parse(m.created_at) <= end);
      if (!win.length) { silent++; add(`約束:${promise}`, "何も送らない（次の発言まで・24時間）"); continue; }
      const w = deviceWriterOfWindow(win, ms[i].created_at, new Date(end).toISOString());
      if (w?.writer !== "takeuchi") { other++; continue; }
      takeuchiTurns++;
      const first = win[0];
      const min = Math.round((Date.parse(first.created_at) - at) / 6e4);
      add(`約束:${promise}`, `${first.is_aix_generated ? "AIX" : "返信"} ${bucketOf(min)}`);
    }
  }
  console.log(`約束が開いているお礼・了承だけの番（${days}日・申込以降を外す）: ${turns}番＝竹内さん本人 ${takeuchiTurns}・従業員か混ざり ${other}・何も送らない ${silent}`);
  for (const [k, o] of Object.entries(tally)) {
    const tot = Object.entries(o).filter(([x]) => !x.startsWith("何も")).reduce((s, [, n]) => s + n, 0);
    console.log(`${k}（竹内さん本人 ${tot}）`);
    for (const [x, n] of Object.entries(o).sort((a, b) => b[1] - a[1])) console.log(`  ${x}: ${n}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });

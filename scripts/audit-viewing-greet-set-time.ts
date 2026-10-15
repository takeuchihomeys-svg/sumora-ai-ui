// scripts/audit-viewing-greet-set-time.ts — 内覧当日の内覧挨拶を「10:00（11時より前の内覧は2時間前）」にセットした場合の前と後（読むだけ・LLM なし・登録/通知しない）
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-greet-set-time.ts [--days=30]
//   2026-10-15 竹内さん「内覧日の10時には内覧挨拶がセットされるようにする。そうしたら内覧あることをちゃんと確認できるため」
//   過去の各日 JST 6:00 の時点で runViewingMorningGreeting（dryRun・probe＝セットの時刻で止めない・その時刻より後の材料は読まない）が
//   「その日に確定した内覧があり、まだ挨拶していない」と読んだ会話について、
//     ・その日にスタッフが実際に当日の挨拶（物差し＝竹内さん達の実送信）を送ったか・送った時刻
//     ・新しい仕組みのセットの時刻（10:00／内覧の2時間前）・旧（9:15）・内覧の時刻
//   を並べる。セットの時刻より前に送っていた番＝セットされる前にもう送っていた（その日はボタンが出ない＝邪魔しない）。
import { runViewingMorningGreeting } from "../app/lib/viewing-morning-greeting-server";
import { VIEWING_DAY_GREETING_DONE_RE } from "../app/lib/aix-item-cleanup";
import { appointmentMinutes, viewingGreetingSetMinute, minuteLabel } from "../app/lib/viewing-day-greeting";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);
const DAY = 86_400_000;
const hm = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

async function main() {
  const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const lines: string[] = [];
  const tally: Record<string, number> = {};
  const sendMins: number[] = [];
  let n = 0, sentBeforeSet = 0, sentAfterSet = 0, notSent = 0, sentBeforeLegacy = 0, earlySlots = 0;
  for (let d = days; d >= 1; d--) {
    const ymd = new Date(Date.parse(`${todayJst}T00:00:00Z`) - d * DAY).toISOString().slice(0, 10);
    const nowMs = Date.parse(`${ymd}T06:00:00+09:00`);
    const r = await runViewingMorningGreeting({ nowMs, dryRun: true, ignorePending: true, probe: true });
    for (const row of r.rows) tally[row.why] = (tally[row.why] ?? 0) + 1;
    for (const row of r.rows.filter((x) => x.why === "due")) {
      n++;
      const dayEnd = new Date(Date.parse(`${ymd}T00:00:00+09:00`) + DAY).toISOString();
      const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", row.conversationId)
        .gt("created_at", new Date(nowMs).toISOString()).lt("created_at", dayEnd).order("created_at").limit(80);
      const ms = (data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>;
      const g = ms.find((m) => m.sender !== "customer" && VIEWING_DAY_GREETING_DONE_RE.test(String(m.text ?? "").normalize("NFKC")));
      const c = ms.find((m) => m.sender === "customer");
      const time = (row.appointment ?? "").match(/\d{1,2}:\d{2}/)?.[0] ?? null;
      const setMin = viewingGreetingSetMinute(time, {});
      const apptMin = appointmentMinutes(time);
      if (apptMin != null && apptMin < 11 * 60) earlySlots++;
      let kind: string;
      if (!g) { notSent++; kind = "挨拶なし"; }
      else {
        const gm = hm(g.created_at); sendMins.push(gm);
        if (gm < setMin) { sentBeforeSet++; kind = "セットの前に送った"; } else { sentAfterSet++; kind = "セットの後に送った"; }
        if (gm < 9 * 60 + 15) sentBeforeLegacy++;
      }
      const custFirst = c && (!g || Date.parse(c.created_at) < Date.parse(g.created_at)) ? `・お客様の発言 ${minuteLabel(hm(c.created_at))}` : "";
      lines.push(`${ymd}\t${row.conversationId.slice(0, 8)}\t内覧 ${time ?? "?"}\tセット ${minuteLabel(setMin)}\t${kind}${g ? ` ${minuteLabel(hm(g.created_at))}「${String(g.text ?? "").replace(/\s+/g, " ").slice(0, 30)}」` : ""}${custFirst}\t${row.appointment ?? ""}`);
    }
  }
  sendMins.sort((a, b) => a - b);
  const med = sendMins.length ? minuteLabel(sendMins[Math.floor(sendMins.length / 2)]) : "-";
  console.log(`=== ${days}日（各日 6:00 に読んだ・その日に確定した内覧・挨拶まだ）===`); console.log(tally);
  console.log(`内覧の当日の番: ${n}（11時より前の内覧 ${earlySlots}）`);
  console.log(`実際に当日の挨拶を送った: ${n - notSent}（送った時刻の中央 ${med}・最も早い ${sendMins.length ? minuteLabel(sendMins[0]) : "-"}・最も遅い ${sendMins.length ? minuteLabel(sendMins[sendMins.length - 1]) : "-"}）`);
  console.log(`  新: セットの時刻より前に送った ${sentBeforeSet}（その日はボタンが出ない）・セットの後に送った ${sentAfterSet}（ボタンが出てから送る番）`);
  console.log(`  旧（9:15）より前に送った ${sentBeforeLegacy}`);
  console.log(`挨拶を送らなかった: ${notSent}（ボタンがその日ずっと出る番＝変更・取りやめ・送り忘れ）`);
  for (const l of lines) console.log(l);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));

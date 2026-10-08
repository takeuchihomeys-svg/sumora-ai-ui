// scripts/audit-r8-greeting-day.ts
// 2026-10-08 返信の質 8巡目「挨拶は日にちごと」（竹内さん「スタッフは日にちをまたいだら挨拶（お世話になっております）を入れている。日にち意識」）
//   スタッフの手打ち（AIX ではない・資料文ではない・テストの会話を除く）を、その送信の直前の状態で分けて「お世話になっております」の割合を見る。
//     (a) その JST の日にこちらが既に会話文を送っている（同じ日の2通目以降）
//     (b) その日の最初の会話文・前のこちらの発言は前日以前・お客様の未返信の頭がこちらの前の発言と同じ日（旧 continuedSameDay＝挨拶なし。朱莉の型）
//     (c) その日の最初の会話文・お客様の未返信の頭が今日
//     (c2) その日の最初の会話文・お客様の頭は前日以前で、こちらの前の発言とも別の日
//     (d) その日の最初の会話文・お客様の未返信なし（こちらから）
//     (x) この会話でこちらの最初の会話文
//   本文の長さ（60字未満／以上）・最後のお客様の文から何時間空いたか でも割る。
//   判定の前後: 旧（alreadyGreetedToday→continuedSameDay→挨拶）／新（その JST の日の最初のこちらの送信か だけ）で、人の実送信と合う通数。
//   読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-r8-greeting-day.ts [--days=180] [--examples=10]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { continuedSameDay, computeAlreadyGreetedToday } from "../app/lib/greeting";
import { isMaterialOnlyText, staffTalkedToday } from "../app/lib/daily-greeting";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "180"));
const EX = Number(arg("examples", "10"));
const jstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
const GREET = /お世話になっております/;
const greets = (t: string) => GREET.test(t.split("\n").filter((l) => l.trim()).slice(0, 2).join("\n").slice(0, 60));
const mask = (t: string) => t.replace(/^[^\n！!。]{0,15}(?:さん|様)/, "〇〇さん").replace(/\d{2,4}-?\d{3,4}-?\d{3,4}/g, "***").replace(/\s+/g, " ").slice(0, 70);

type Row = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };

(async () => {
  const since = new Date(Date.now() - (DAYS + 14) * 86_400_000).toISOString();
  const evalSince = Date.now() - DAYS * 86_400_000;
  const all: Row[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated")
      .gte("created_at", since).order("created_at").order("id").range(f, f + 999);
    if (error) throw error;
    all.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, Row[]>();
  for (const r of all) { if (isTestConversation(r.conversation_id)) continue; (byConv.get(r.conversation_id) ?? byConv.set(r.conversation_id, []).get(r.conversation_id)!).push(r); }

  type Cell = { n: number; g: number };
  const cells = new Map<string, Cell>();
  const add = (k: string, g: boolean) => { const c = cells.get(k) ?? { n: 0, g: 0 }; c.n++; if (g) c.g++; cells.set(k, c); };
  const examples = new Map<string, string[]>();
  const ex = (k: string, s: string) => { const a = examples.get(k) ?? []; if (a.length < EX) a.push(s); examples.set(k, a); };
  // 判定の前後
  let delOld = 0, delNew = 0, delNew2 = 0;
  let oldL = 0, newL = 0, new2L = 0;
  let c2Good = 0, c2Bad = 0; const c2Ex: string[] = [];
  let oldAgree = 0, newAgree = 0, new2Agree = 0, total = 0, changed = 0, changedToGood = 0, changedToBad = 0, changed2 = 0;
  const changedEx: string[] = [];

  for (const [, rows] of byConv) {
    for (let i = 0; i < rows.length; i++) {
      const m = rows[i];
      if (m.sender !== "staff" || m.is_aix_generated || isMaterialOnlyText(m.text)) continue;
      if (Date.parse(m.created_at) < evalSince) continue;
      // 直前の連続したこちらの通（同じ秒の分割送信）は「同じ日の2通目以降」に入る
      const before = rows.slice(0, i);
      const now = Date.parse(m.created_at);
      const text = m.text ?? "";
      const g = greets(text);
      const msgs = before.map((r) => ({ sender: r.sender === "staff" ? "staff" : "customer", text: r.text ?? "", createdAt: r.created_at, isAix: !!r.is_aix_generated }));
      const talkedToday = staffTalkedToday(msgs, now);
      const prevStaffTalk = [...before].reverse().find((r) => r.sender === "staff" && !isMaterialOnlyText(r.text));
      let lastStaffIdx = -1; for (let k = before.length - 1; k >= 0; k--) if (before[k].sender === "staff") { lastStaffIdx = k; break; }
      const unreplied = before.slice(lastStaffIdx + 1).filter((r) => r.sender !== "staff");
      const head = unreplied[0];
      const lastCust = [...before].reverse().find((r) => r.sender !== "staff");
      const gapH = lastCust ? (now - Date.parse(lastCust.created_at)) / 3600_000 : null;
      const today = jstDay(m.created_at);
      let cat: string;
      if (talkedToday) cat = "(a) 同じ日の2通目以降";
      else if (!prevStaffTalk) cat = "(x) この会話でこちらの最初";
      else if (!head) cat = "(d) その日の最初・お客様の未返信なし";
      else if (continuedSameDay(msgs)) cat = "(b) その日の最初・お客様の頭がこちらの前の発言と同じ日（旧=挨拶なし）";
      else if (jstDay(head.created_at) === today) cat = "(c) その日の最初・お客様の頭が今日";
      else cat = "(c2) その日の最初・お客様の頭は前日以前（こちらの前の発言とは別の日）";
      const len = text.replace(/\s/g, "").length >= 60 ? "60字以上" : "60字未満";
      const gap = gapH === null ? "-" : gapH < 3 ? "3時間未満" : gapH < 12 ? "3〜12時間" : gapH < 24 ? "12〜24時間" : "24時間以上";
      add(cat, g); add(`${cat} × ${len}`, g); add(`${cat} × ${gap}`, g);
      ex(`${cat}|${g ? "挨拶あり" : "挨拶なし"}`, `${m.created_at.slice(0, 16)} 空き${gapH === null ? "-" : gapH.toFixed(1)}h 頭「${head ? mask(head.text ?? "") : "-"}」(${head ? head.created_at.slice(5, 16) : "-"}) → 「${mask(text)}」`);

      if (cat.startsWith("(x)")) continue; // 初回は別の判定（はじめまして）
      total++;
      // 旧: computeAlreadyGreetedToday（画像以外のこちらのテキストすべて・資料文も数える）→ continuedSameDay → 挨拶
      process.env.GREETING_TALK_ONLY_R8 = "off"; const already = computeAlreadyGreetedToday(msgs, now) ?? false; delete process.env.GREETING_TALK_ONLY_R8;
      const alreadyTalk = computeAlreadyGreetedToday(msgs, now) ?? false; // 8巡目の既定（資料文を数えない）
      const oldGreet = !already && !continuedSameDay(msgs);
      const newGreet = !already; // 新: その JST の日の最初のこちらの送信か だけ
      const new2Greet = !alreadyTalk; // 新2＝8巡目の既定: 続きの線を外す＋資料文を数えない
      const long = len === "60字以上"; if ((oldGreet && long) === g) oldL++; if ((newGreet && long) === g) newL++; if ((new2Greet && long) === g) new2L++;
      if (g && !oldGreet) delOld++; if (g && !newGreet) delNew++; if (g && !new2Greet) delNew2++;
      if (oldGreet === g) oldAgree++;
      if (newGreet === g) newAgree++;
      if (new2Greet === g) new2Agree++;
      if (oldGreet !== newGreet) { changed++; if (newGreet === g) changedToGood++; else changedToBad++; if (changedEx.length < EX * 2) changedEx.push(`${newGreet === g ? "○" : "×"} ${m.created_at.slice(0, 16)} 頭(${head?.created_at.slice(5, 16)})「${mask(head?.text ?? "")}」→「${mask(text)}」`); }
      if (newGreet !== new2Greet) { changed2++; if (new2Greet === g) c2Good++; else c2Bad++; if (c2Ex.length < EX * 2) c2Ex.push(`${new2Greet === g ? "○" : "×"} ${m.created_at.slice(0, 16)} 今日のこちらの通「${mask([...before].reverse().find((r) => r.sender === "staff" && jstDay(r.created_at) === today)?.text ?? "")}」→「${mask(text)}」`); }
    }
  }
  console.log(`=== スタッフの手打ちの会話文 直近${DAYS}日（テストの会話を除く）: 「お世話になっております」を冒頭に入れた割合 ===`);
  const pct = (c: Cell) => `${c.g}/${c.n}（${Math.round((c.g / Math.max(1, c.n)) * 100)}%）`;
  for (const k of [...cells.keys()].sort()) console.log(`${k.includes(" × ") ? "    " : ""}${k}: ${pct(cells.get(k)!)}`);
  console.log(`\n=== 判定の前後（(x) を除く ${total}通・人の実送信と合った通数）===`);
  console.log(`旧（当日のテキスト送信済み→続き→挨拶・GREETING_BY_DAY_R8=off GREETING_TALK_ONLY_R8=off）: ${oldAgree}/${total}（${(oldAgree / total * 100).toFixed(1)}%）`);
  console.log(`新1（続きの線を外す・GREETING_TALK_ONLY_R8=off）: ${newAgree}/${total}（${(newAgree / total * 100).toFixed(1)}%）`);
  console.log(`新2＝8巡目の既定（＋資料文を数えない）: ${new2Agree}/${total}（${(new2Agree / total * 100).toFixed(1)}%）・新と食い違う ${changed2}通`);
  console.log(`  新→新2で変わる ${changed2}通（人と合う側へ ${c2Good}・外れる側へ ${c2Bad}）`); for (const x of c2Ex) console.log("    " + x);
  console.log(`（挨拶の番＝standard は「必須ではない」の注記なので、60字以上だけ挨拶と見なした一致: 旧 ${oldL}・新 ${newL}・新2 ${new2L} / ${total}）`);
  console.log(`出口（kind=none は冒頭の挨拶を消す）が人の挨拶を消す通数: 旧 ${delOld}・新 ${delNew}・新2 ${delNew2}（新で増える物は 0＝none→standard の向きだけ）`);
  console.log(`旧→新で判定が変わる: ${changed}通（人と合う側へ ${changedToGood}・外れる側へ ${changedToBad}）`);
  for (const s of changedEx) console.log("  " + s);
  console.log(`\n=== 例（各型・名前は伏せる）===`);
  for (const k of [...examples.keys()].sort()) { console.log(`--- ${k}`); for (const s of examples.get(k)!) console.log("  " + s); }
})();

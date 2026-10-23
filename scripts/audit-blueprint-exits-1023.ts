// scripts/audit-blueprint-exits-1023.ts — 計画7（文の設計図 既定 on）の出口2つと「続きの番」の型を本番に当てて数える（読むだけ・LLM なし）
//   ①出口: fixKasaOnPromiseOnly（約束だけの番のご査収）・mirrorClosingNotation（致します/いたします）を見張りの下書き＋竹内さんの実送信に当てる
//   ②続きの番（continuation）: 14日のお客様の番で型が出る数と、その番の竹内さんの実送信が挨拶・締めを省いているか
// 実行: npx tsx --env-file=.env.local scripts/audit-blueprint-exits-1023.ts [--days=14] [--show]
import { createClient } from "@supabase/supabase-js";
import { lastStaffBlockHasAttachment as lastBlockAttach, fixKasaOnPromiseOnly, mirrorClosingNotation, customerOnegaiForm, detectBlueprintPatterns, type PatternMsg } from "../app/lib/writing-blueprint-patterns";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=14").slice(7)) || 14;
const show = process.argv.includes("--show");
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null };
const mask = (s: string) => s.replace(/[一-龯ぁ-んァ-ヶA-Za-z]{1,8}さん/g, "〇〇さん").replace(/[0-9]{3,}/g, "###").replace(/https?:\/\/\S+/g, "URL").slice(0, 220).replace(/\n/g, "⏎");

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await q(f, f + 999); if (error) throw error; const d = (data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}

async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const pre = new Date(Date.now() - (days + 7) * 86400_000).toISOString();
  const rows = await readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated, image_url").gte("created_at", pre).order("created_at").order("id").range(f, t));
  const byConv = new Map<string, M[]>();
  for (const r of rows) { if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []); byConv.get(r.conversation_id)!.push(r); }
  const toP = (m: M): PatternMsg => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated, imageUrl: m.image_url });
  const isAttach = (m: M) => m.sender === "staff" && (!!m.image_url || !!m.is_aix_generated || /^\s*\[(?:画像|動画|ファイル)\]|^（室内イメージ）|^https?:\/\/\S+$/.test((m.text ?? "").trim()));

  // ── 竹内さんの実送信（手打ち・is_aix でない文）に出口を当てる＝その番の「正解」を壊すか
  let staffTurns = 0, kasaInStaff = 0, kasaRemoved = 0, kasaRemovedButSentSameTurn = 0, mirrorChanged = 0;
  let mirrorKanaCustomer = 0, mirrorKanaStaffWroteKana = 0, mirrorKanaStaffWroteKanji = 0;
  // ── 続きの番
  let contNoTextToday = 0, contNoTextTodayGreet = 0, contNoTextTodayReplied = 0;
  let contKasaThanks = 0, contKasaThanksAttach = 0, contAttachPrev = 0, contNameFirst = 0;
  let custTurns = 0, contFire = 0, contStaffSkipGreeting = 0, contStaffGreeting = 0, contStaffClosing = 0, contNoStaff = 0;
  const contGreetEx: string[] = [], kasaEx: string[] = [], mirrorEx: string[] = [];
  for (const msgs of byConv.values()) {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.created_at < since || m.sender !== "customer") continue;
      // お客様の連投の最後だけ（次が staff の番）
      let j = i; while (j + 1 < msgs.length && msgs[j + 1].sender === "customer") j++;
      if (j !== i) continue;
      const window = msgs.slice(Math.max(0, i - 40), i + 1).map(toP);
      // その番のこちらの返し（30分以内の staff の固まり）
      const t0 = Date.parse(m.created_at);
      const reply: M[] = []; for (let k = i + 1; k < msgs.length && msgs[k].sender === "staff"; k++) { if (Date.parse(msgs[k].created_at) - t0 > 30 * 60_000) break; reply.push(msgs[k]); }
      const typed = reply.filter((r) => !r.is_aix_generated && !isAttach(r) && (r.text ?? "").trim());
      const typedText = typed.map((r) => r.text ?? "").join("\n");
      const sentInTurn = reply.some(isAttach);
      custTurns++;
      const hits = detectBlueprintPatterns({ scene: null, customerText: m.text ?? "", messages: window, nowMs: t0 });
      if (hits.some((h) => h.id === "continuation")) {
        contFire++;
        const jst = (x: string) => new Date(Date.parse(x) + 9 * 3600_000).toISOString().slice(0, 10);
        const textToday = msgs.slice(0, i).some((x) => x.sender === "staff" && !isAttach(x) && (x.text ?? "").trim() && jst(x.created_at) === jst(m.created_at));
        if (!textToday) { contNoTextToday++; if (typed.length) { contNoTextTodayReplied++; if (/お世話になっております/.test(typedText)) contNoTextTodayGreet++; } }
        if (!typed.length) contNoStaff++;
        else {
          const greet = /お世話になっております|ありがとうございます/.test(typedText.split("\n").slice(0, 2).join("\n"));
          const close = /何卒|よろしくお願い/.test(typedText);
          if (greet) { contStaffGreeting++; if (contGreetEx.length < 8) contGreetEx.push(`客「${mask(m.text ?? "")}」→竹内「${mask(typedText)}」`); } else contStaffSkipGreeting++;
          if (close) contStaffClosing++;
          if (/ご査収(?:いただき|頂き)ありがとう/.test(typedText)) { contKasaThanks++; if (lastBlockAttach(window)) contKasaThanksAttach++; }
          if (lastBlockAttach(window)) contAttachPrev++;
          if (/^[^\n]{1,12}さん/.test(typedText)) contNameFirst++;
        }
      }
      if (!typed.length) continue;
      staffTurns++;
      if (/ご査収(?:くださ|下さ)い/.test(typedText)) {
        kasaInStaff++;
        const k = fixKasaOnPromiseOnly(typedText, { sentThisTurn: false, messages: window });
        if (k.changed) { kasaRemoved++; if (sentInTurn) kasaRemovedButSentSameTurn++; if (kasaEx.length < 10) kasaEx.push(`${sentInTurn ? "[同じ番で送った]" : "[送っていない]"} 客「${mask(m.text ?? "")}」→竹内「${mask(typedText)}」`); }
      }
      const form = customerOnegaiForm({ customerText: m.text ?? "", messages: window.slice(0, -1) });
      const mn = mirrorClosingNotation(typedText, form);
      if (mn.changed) { mirrorChanged++; if (mirrorEx.length < 6) mirrorEx.push(`${mn.changed} 竹内「${mask(typedText)}」`); }
      if (form === "kana" && /お願い(?:致し|いたし)/.test(typedText)) { mirrorKanaCustomer++; if (/お願いいたし/.test(typedText)) mirrorKanaStaffWroteKana++; if (/お願い致し/.test(typedText)) mirrorKanaStaffWroteKanji++; }
    }
  }

  // ── 見張りの下書きに出口を当てる
  type W = { conversation_id: string; customer_last_at: string; draft_last: string | null; staff_texts: Array<{ text?: string }> | null; staff_aix: unknown[] | null };
  const turns = await readAll<W>((f, t) => sb.from("line_watch_turns").select("conversation_id, customer_last_at, draft_last, staff_texts, staff_aix").gte("created_at", since).not("draft_last", "is", null).order("created_at").range(f, t));
  let drafts = 0, dKasa = 0, dKasaRemoved = 0, dKasaRemovedStaffKeptKasa = 0, dKasaRemovedAixPressed = 0, dMirror = 0, dMirrorAgainstStaff = 0;
  const dEx: string[] = [];
  for (const w of turns) {
    const msgs = byConv.get(w.conversation_id) ?? [];
    const window = msgs.filter((m) => m.created_at <= w.customer_last_at).slice(-41).map(toP);
    const draft = w.draft_last ?? ""; drafts++;
    const staff = (w.staff_texts ?? []).map((s) => s.text ?? "").join("\n");
    if (/ご査収(?:くださ|下さ)い/.test(draft)) {
      dKasa++;
      const k = fixKasaOnPromiseOnly(draft, { sentThisTurn: false, messages: window });
      if (k.changed) { dKasaRemoved++; if (/ご査収/.test(staff)) dKasaRemovedStaffKeptKasa++; if ((w.staff_aix ?? []).length) dKasaRemovedAixPressed++; if (dEx.length < 10) dEx.push(`下書き「${mask(draft)}」／竹内「${mask(staff)}」／AIX ${(w.staff_aix ?? []).length}`); }
    }
    const custText = [...window].reverse().find((m) => m.sender === "customer")?.text ?? "";
    const form = customerOnegaiForm({ customerText: custText, messages: window.slice(0, -1) });
    const mn = mirrorClosingNotation(draft, form);
    if (mn.changed) { dMirror++; const to = mn.changed.slice(1); if (staff && /お願い(?:致し|いたし)/.test(staff) && !staff.includes(to)) dMirrorAgainstStaff++; }
  }
  console.log(JSON.stringify({ days,
    staffSends: { custTurns, staffTurns, kasaInStaff, kasaRemoved, kasaRemovedButSentSameTurn, mirrorChanged, kanaCustomer_staffOnegai: mirrorKanaCustomer, staffWroteKana: mirrorKanaStaffWroteKana, staffWroteKanji: mirrorKanaStaffWroteKanji },
    continuation: { fire: contFire, ofCustTurns: custTurns, noStaffReply: contNoStaff, staffSkipGreeting: contStaffSkipGreeting, staffGreeting: contStaffGreeting, staffClosing: contStaffClosing, staffKasaThanks: contKasaThanks, kasaThanksAfterAttach: contKasaThanksAttach, prevBlockAttach: contAttachPrev, staffNameFirst: contNameFirst, noStaffTextToday: contNoTextToday, noTextTodayReplied: contNoTextTodayReplied, noTextTodayGreeted: contNoTextTodayGreet },
    drafts: { drafts, dKasa, dKasaRemoved, dKasaRemovedStaffKeptKasa, dKasaRemovedAixPressed, dMirror, dMirrorAgainstStaff } }, null, 1));
  if (show) { console.log("── 続きの番で竹内さんが挨拶した例"); contGreetEx.forEach((x) => console.log(x)); console.log("── 竹内さんの文でご査収が外れる例"); kasaEx.forEach((x) => console.log(x)); console.log("── 下書きでご査収が外れる例"); dEx.forEach((x) => console.log(x)); console.log("── 書き方の変更例"); mirrorEx.forEach((x) => console.log(x)); }
}
main().catch((e) => { console.error(e); process.exit(1); });

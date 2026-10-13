// 返信の下書きの「繰り返し（もう言った事の言い直し・オウム返し）」を数える（読むだけ・LLM なし）
//
// 2026-10-13 竹内さん「同じ事を何度も繰り返してしまう所。ブレイン基準に考えたらその文がおかしいと気づくのではないか」
//   質の物差し＝竹内さんの実送信（staff_writer=takeuchi の手打ち）。下書きの文が「前にこちらが言った文」と同じ時、
//   同じ番の実送信もそれを言い直していれば「正しい言い直し」、削っていれば「余計な繰り返し」。
//
// 測り方:
//   - 下書き＝ai_reply_examples(entry_source=line_reply) の ai_draft。番の実送信＝sent_reply・書き手は messages.staff_writer（送信時刻の近くの同じ本文）
//   - 前に言った事＝その番より前のこちらの文（AIX を含む・14日以内・最大8通）。何通前か（1＝直前）も控える
//   - 文の近さ＝正規化（絵文字・記号・空白・〇〇さん を除く）した2文字の組の Dice。0.72 以上を同じ文とする
//   - 型＝約束（〜させて頂きます・次第）／案内・誘い（ご案内・如何でしょうか）／確認（確認）／お礼・お詫び／定型の締め（何卒・全力でサポート・ご査収 等）／その他
//   - オウム返し＝お客様のこの番の発言の文と 0.6 以上の近さ（8字以上）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-repeat.ts [--days=30] [--json=<file>] [--samples=12] [--draft-field=ai_draft]
//   --file=<json> で下書きを差し替えて数える（{id, draft}[]・前と後の比べ用）
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { repeatSentences, splitSentencesJa, sentenceSimilarity, promiseTopics, topicRepeats, isAckOnlyTurn, ackReplyShape, priorPromiseForm, type RepeatHit } from "../app/lib/draft-repeat";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DAYS = Number(arg("days") ?? 30);
const SAMPLES = Number(arg("samples") ?? 12);

type Msg = { id: string; sender: string; text: string; at: number; writer: string | null; aix: boolean };

async function page<T>(fn: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await fn(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as T[];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈名〉").replace(/0\d{1,4}-?\d{2,4}-?\d{3,4}/g, "〈番号〉").replace(/\n+/g, " ／ ");

export type Turn = {
  id: string; conv: string; at: number; draft: string; sent: string; writer: string | null;
  priorStaff: { text: string; back: number }[]; customer: string[]; tpo: string | null; scene: string | null; hasContract: boolean;
};

export async function loadTurns(days: number): Promise<Turn[]> {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const ex = await page<Record<string, unknown>>((a, b) => sb.from("ai_reply_examples")
    .select("id,conversation_id,ai_draft,sent_reply,sent_at,created_at,reply_context_snapshot")
    .eq("entry_source", "line_reply").not("ai_draft", "is", null).gte("created_at", since).order("created_at").range(a, b));
  const convs = [...new Set(ex.map((r) => String(r.conversation_id ?? "")).filter(Boolean))];
  const byConv = new Map<string, Msg[]>();
  const msgSince = new Date(Date.now() - (days + 15) * 86400e3).toISOString();
  for (let i = 0; i < convs.length; i += 40) {
    const ids = convs.slice(i, i + 40);
    const ms = await page<Record<string, unknown>>((a, b) => sb.from("messages")
      .select("id,conversation_id,sender,text,created_at,staff_writer,is_aix_generated")
      .in("conversation_id", ids).gte("created_at", msgSince).order("created_at").range(a, b));
    for (const m of ms) {
      const c = String(m.conversation_id);
      if (!byConv.has(c)) byConv.set(c, []);
      byConv.get(c)!.push({ id: String(m.id), sender: String(m.sender ?? ""), text: String(m.text ?? "").trim(), at: Date.parse(String(m.created_at)), writer: (m.staff_writer as string | null) ?? null, aix: !!m.is_aix_generated });
    }
  }
  const out: Turn[] = [];
  for (const r of ex) {
    const conv = String(r.conversation_id ?? "");
    const draft = String(r.ai_draft ?? "").trim();
    const sent = String(r.sent_reply ?? "").trim();
    const arr = byConv.get(conv);
    if (!arr || !draft) continue;
    const at = Date.parse(String(r.sent_at ?? r.created_at));
    // この番の送信（送信時刻 ±3分のこちらの文で、sent_reply に含まれる物）
    const sentMsgs = arr.filter((m) => m.sender === "staff" && Math.abs(m.at - at) < 180_000 && m.text && sent.includes(m.text.slice(0, 20)));
    const firstSentAt = sentMsgs.length ? Math.min(...sentMsgs.map((m) => m.at)) : at;
    const sentIds = new Set(sentMsgs.map((m) => m.id));
    const writer = sentMsgs.find((m) => m.writer)?.writer ?? null;
    const before = arr.filter((m) => m.at < firstSentAt - 1000 && !sentIds.has(m.id));
    // この番のお客様の発言＝最後のこちらの文の後のお客様の文
    let lastStaffIdx = -1;
    for (let i = before.length - 1; i >= 0; i--) if (before[i].sender === "staff") { lastStaffIdx = i; break; }
    const customer = before.slice(lastStaffIdx + 1).filter((m) => m.sender === "customer" && m.text).map((m) => m.text);
    const staffPrior = before.filter((m) => m.sender === "staff" && m.text && m.text !== "[画像]" && at - m.at < 14 * 86400e3);
    const priorStaff = staffPrior.slice(-8).reverse().map((m, i) => ({ text: m.text, back: i + 1 }));
    const snap = (r.reply_context_snapshot ?? {}) as Record<string, unknown>;
    out.push({
      id: String(r.id), conv, at, draft, sent, writer, priorStaff, customer,
      tpo: (snap.tpo_label as string) ?? null, scene: ((snap.replyScene as Record<string, unknown> | undefined)?.scene as string) ?? (typeof snap.replyScene === "string" ? snap.replyScene as string : null),
      hasContract: !!(snap.turnContract && typeof snap.turnContract === "object" && Object.keys(snap.turnContract as object).length),
    });
  }
  return out;
}

export type Judged = RepeatHit & { sentAlso: boolean };
export function judgeTurn(t: Turn, draft = t.draft): Judged[] {
  const hits = repeatSentences(draft, t.priorStaff, t.customer);
  // 実送信も同じ事を言ったか＝実送信の文のどれかが「前の文」か「下書きの文」に 0.6 以上で近い（言い換えも言い直しに数える）
  const sentSs = splitSentencesJa(t.sent);
  return hits.map((h) => ({ ...h, sentAlso: sentSs.some((x) => sentenceSimilarity(x, h.ref) >= 0.6 || sentenceSimilarity(x, h.sentence) >= 0.6) }));
}

/** 竹内さんの手打ちだけで: お客様が受けだけの番に、前のこちらの約束（何通前か）を言い直したか（下書きの有無に関わらず） */
async function takeuchiBaseline(days: number) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const tkMsgs = await page<Record<string, unknown>>((a, b) => sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").gte("created_at", since).range(a, b));
  const convs = [...new Set(tkMsgs.map((m) => String(m.conversation_id)))];
  const agg = new Map<string, { n: number; re: number }>();
  const samples: string[] = [];
  const shapes = new Map<string, number>();
  const shapeSamples: string[] = [];
  let ackTurns = 0, ackWithPrior = 0, lines: number[] = [];
  for (let i = 0; i < convs.length; i += 40) {
    const ms = await page<Record<string, unknown>>((a, b) => sb.from("messages").select("conversation_id,sender,text,created_at,staff_writer")
      .in("conversation_id", convs.slice(i, i + 40)).gte("created_at", new Date(Date.now() - (days + 15) * 86400e3).toISOString()).order("created_at").range(a, b));
    const by = new Map<string, Msg[]>();
    for (const m of ms) { const c = String(m.conversation_id); if (!by.has(c)) by.set(c, []); by.get(c)!.push({ id: "", sender: String(m.sender), text: String(m.text ?? "").trim(), at: Date.parse(String(m.created_at)), writer: (m.staff_writer as string) ?? null, aix: false }); }
    for (const arr of by.values()) {
      for (let k = 1; k < arr.length; k++) {
        const m = arr[k];
        if (m.sender !== "staff" || m.writer !== "takeuchi" || m.at < Date.parse(since)) continue;
        if (arr[k - 1].sender !== "customer") continue;   // 番の最初の1通だけ
        // この番の返信（3分以内の続きの手打ちも1つに）
        let reply = m.text; for (let j = k + 1; j < arr.length && arr[j].sender === "staff" && arr[j].at - m.at < 180_000; j++) reply += "\n" + arr[j].text;
        let s = k - 1; const cust: string[] = [];
        while (s >= 0 && arr[s].sender === "customer") { cust.unshift(arr[s].text); s--; }
        if (!isAckOnlyTurn(cust)) continue;
        // 届け物（物件・見積の送付・確認の結果）はこの番の返事ではない＝外す（受けへの返事だけを見る）
        if (/\[画像\]|🌟|https?:\/\/|お待たせ|初期費用：|募集中とな|となっております|でした[！!。]/.test(reply)) continue;
        ackTurns++;
        lines.push(reply.split("\n").filter((x) => x.trim()).length);
        const prior = arr.slice(0, s + 1).filter((x) => x.sender === "staff" && x.text && x.text !== "[画像]").slice(-8).reverse().map((x, idx) => ({ text: x.text, back: idx + 1 }));
        const pTopics = new Map<string, number>();
        for (const p of prior) for (const ss of splitSentencesJa(p.text)) for (const t of promiseTopics(ss)) if (!pTopics.has(t) || pTopics.get(t)! > p.back) pTopics.set(t, p.back);
        if (pTopics.size) ackWithPrior++;
        const rTopics = new Set<string>(splitSentencesJa(reply).flatMap(promiseTopics));
        // 返事の形（直前1通に約束がある時だけ）
        if ([...pTopics.values()].some((b) => b <= 1)) {
          const sh = ackReplyShape(reply, prior[0]?.text ?? "");
          shapes.set(sh, (shapes.get(sh) ?? 0) + 1);
          // 前の約束の形（待ちの形＝次第・日付で言い終えた／言い切り）×中身ごと
          const pf = priorPromiseForm(prior[0]?.text ?? "");
          if (pf) { const k2 = `前=${pf.form}・${pf.topic}→${sh}`; shapes.set(k2, (shapes.get(k2) ?? 0) + 1); }
          if (shapeSamples.length < 40) shapeSamples.push(`${sh}｜前: ${mask(prior[0].text).slice(-70)}｜竹内: ${mask(reply).slice(0, 80)}`);
        }
        for (const [t, b] of pTopics) {
          const key = `${b <= 1 ? "1" : b <= 2 ? "2" : b <= 4 ? "3-4" : "5+"}通前・${t}`;
          const a = agg.get(key) ?? { n: 0, re: 0 }; a.n++; if (rTopics.has(t)) a.re++; agg.set(key, a);
          if (b <= 1 && samples.length < 30) samples.push(`${rTopics.has(t) ? "言い直す" : "言わない"} ${t}｜前: ${mask(prior[0].text).slice(0, 70)}｜客: ${mask(cust.join("／")).slice(0, 30)}｜竹内: ${mask(reply).slice(0, 90)}`);
        }
      }
    }
  }
  lines.sort((a, b) => a - b);
  console.log(`\n=== 竹内さんの手打ち（${days}日）: お客様が受けだけの番 ${ackTurns}（前に約束あり ${ackWithPrior}）・行 p50 ${lines[Math.floor(lines.length / 2)] ?? "-"} p90 ${lines[Math.floor(lines.length * 0.9)] ?? "-"} ===`);
  console.log(`   前の約束（何通前・中身）→ 竹内さんが同じ約束を言い直した割合`);
  for (const [k, a] of [...agg.entries()].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`   ${k.padEnd(16)} ${String(a.re).padStart(3)}/${String(a.n).padEnd(4)}（${(a.re / a.n * 100).toFixed(0)}%）`);
  for (const s of samples) console.log(`   ${s}`);
  console.log(`\n   直前1通に約束がある受けだけの番の竹内さんの返事の形`);
  for (const [k, v] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(28)} ${v}`);
  for (const s of shapeSamples) console.log(`   ${s}`);
}

/** 最終チェックの決定論（repeat-brain-align.contractAlreadySaidRepeat）を過去の下書きに当てる: 指摘した文を実送信も言っていたら誤り（誤って消させる） */
async function detectorAudit(turns: Turn[], replace: Map<string, string> | null) {
  const { contractAlreadySaidRepeat } = await import("../app/lib/repeat-brain-align");
  const { repeatCandidates } = await import("../app/lib/reply-style-r11");
  let n = 0, hit = 0, fp = 0, tkHit = 0, tkFp = 0;
  const out: string[] = [];
  const onSent = process.argv.includes("--on-sent");   // 人の実送信に当てる（当たったら全部誤り＝人の文を書き直させる）
  for (const t of turns) {
    const draft = onSent ? t.sent : (replace?.get(t.id) ?? t.draft);
    const last2 = t.priorStaff.filter((p) => p.back <= 2).sort((a, b) => b.back - a.back).map((p) => p.text);
    const already = repeatCandidates(last2);
    if (!already.length) continue;
    n++;
    const h = contractAlreadySaidRepeat(draft, already, { customerAddsContent: !t.customer.length || !isAckOnlyTurn(t.customer), env: {} });
    if (!h) continue;
    hit++;
    const sentAlso = onSent || splitSentencesJa(t.sent).some((x) => sentenceSimilarity(x, h.ref) >= 0.6 || sentenceSimilarity(x, h.sentence) >= 0.6);
    if (sentAlso) fp++;
    if (t.writer === "takeuchi") { tkHit++; if (sentAlso) tkFp++; }
    out.push(`${sentAlso ? "✗誤り" : "○"} ${t.id.slice(0, 8)} ${t.writer ?? "?"} ${new Date(t.at).toISOString().slice(0, 10)}｜客: ${mask(t.customer.join("／")).slice(0, 40)}｜下書きの文: ${mask(h.sentence).slice(0, 70)}｜もう言った: ${mask(h.ref).slice(0, 50)}｜実送信: ${mask(t.sent).slice(0, 90)}`);
  }
  console.log(`\n=== 最終チェックの「もう言った事」の言い直しの決定論（直前2通の候補がある番 ${n}）===`);
  console.log(`   指摘 ${hit}（実送信も言った＝誤り ${fp}）・竹内さんの番 指摘 ${tkHit}（誤り ${tkFp}）`);
  for (const s of out) console.log(`   ${s}`);
}

async function main() {
  if (process.argv.includes("--detector")) {
    const turns = await loadTurns(DAYS);
    const replace = arg("file") ? new Map<string, string>((JSON.parse(fs.readFileSync(arg("file")!, "utf8")) as { id: string; draft: string }[]).map((x) => [x.id, x.draft])) : null;
    await detectorAudit(replace ? turns.filter((t) => replace.has(t.id)) : turns, replace);
    return;
  }
  if (process.argv.includes("--takeuchi-baseline")) { await takeuchiBaseline(Number(arg("days") ?? 60)); return; }
  const turns = await loadTurns(DAYS);
  const replace = arg("file") ? new Map<string, string>((JSON.parse(fs.readFileSync(arg("file")!, "utf8")) as { id: string; draft: string }[]).map((x) => [x.id, x.draft])) : null;
  const use = replace ? turns.filter((t) => replace.has(t.id)) : turns;
  console.log(`=== 下書きの繰り返し（直近${DAYS}日・line_reply の下書き ${turns.length}番${replace ? `・差し替え ${use.length}番` : ""}）===`);
  const tk = use.filter((t) => t.writer === "takeuchi");
  console.log(`   竹内さんの手打ちの番 ${tk.length}／他 ${use.length - tk.length}`);
  type Agg = { draft: number; sentAlso: number; extra: number; tkDraft: number; tkSentAlso: number; tkExtra: number };
  const agg = new Map<string, Agg>();
  const turnsWithExtra = { all: 0, tk: 0 };
  const samples: { type: string; ok: boolean; t: Turn; h: Judged }[] = [];
  const byBack = new Map<number, { all: number; tkSentAlso: number; tkExtra: number }>();
  const byTpo = new Map<string, { n: number; extra: number }>();
  const sentRepeat = new Map<string, { tk: number }>();
  for (const t of use) {
    const draft = replace?.get(t.id) ?? t.draft;
    const js = judgeTurn(t, draft);
    let anyExtra = false;
    for (const h of js) {
      if (h.type === "定型の締め" || h.type === "挨拶") continue;
      const a = agg.get(h.type) ?? { draft: 0, sentAlso: 0, extra: 0, tkDraft: 0, tkSentAlso: 0, tkExtra: 0 };
      a.draft++; if (h.sentAlso) a.sentAlso++; else { a.extra++; anyExtra = true; }
      if (t.writer === "takeuchi") { a.tkDraft++; if (h.sentAlso) a.tkSentAlso++; else a.tkExtra++; }
      agg.set(h.type, a);
      if (h.kind === "staff") {
        const b = byBack.get(h.back) ?? { all: 0, tkSentAlso: 0, tkExtra: 0 }; b.all++;
        if (t.writer === "takeuchi") { if (h.sentAlso) b.tkSentAlso++; else b.tkExtra++; }
        byBack.set(h.back, b);
      }
      samples.push({ type: h.type, ok: h.sentAlso, t, h });
    }
    if (anyExtra) { turnsWithExtra.all++; if (t.writer === "takeuchi") turnsWithExtra.tk++; }
    const k = t.tpo ?? "(なし)"; const tp = byTpo.get(k) ?? { n: 0, extra: 0 }; tp.n++; if (anyExtra) tp.extra++; byTpo.set(k, tp);
    // 竹内さんの実送信そのものの言い直し（基準）
    if (t.writer === "takeuchi") for (const h of repeatSentences(t.sent, t.priorStaff, t.customer)) {
      if (h.type === "定型の締め" || h.type === "挨拶") continue;
      const s = sentRepeat.get(h.type) ?? { tk: 0 }; s.tk++; sentRepeat.set(h.type, s);
    }
  }
  console.log(`\n   余計な繰り返しのある番: ${turnsWithExtra.all}/${use.length}（${(turnsWithExtra.all / Math.max(1, use.length) * 100).toFixed(1)}%）・竹内さんの番 ${turnsWithExtra.tk}/${tk.length}（${(turnsWithExtra.tk / Math.max(1, tk.length) * 100).toFixed(1)}%）`);
  console.log(`\n   型ごと（下書きで言い直した文の数 → 実送信も言い直した＝正しい／削った＝余計）`);
  console.log(`   ${"型".padEnd(10)} 全 下書き/正しい/余計 ｜ 竹内さんの番 下書き/正しい/余計 ｜ 竹内さんの実送信そのものの言い直し`);
  for (const [k, a] of [...agg.entries()].sort((x, y) => y[1].draft - x[1].draft)) {
    console.log(`   ${k.padEnd(10)} ${String(a.draft).padStart(4)}/${String(a.sentAlso).padStart(3)}/${String(a.extra).padStart(3)} ｜ ${String(a.tkDraft).padStart(4)}/${String(a.tkSentAlso).padStart(3)}/${String(a.tkExtra).padStart(3)} ｜ ${sentRepeat.get(k)?.tk ?? 0}`);
  }
  console.log(`\n   何通前のこちらの文の言い直しか（竹内さんの番: 正しい／余計）`);
  for (const [b, v] of [...byBack.entries()].sort((x, y) => x[0] - y[0])) console.log(`   ${b}通前: 全 ${v.all} ｜ 竹内さん 正しい ${v.tkSentAlso}・余計 ${v.tkExtra}`);
  console.log(`\n   場面の札（tpo_label）ごとの余計な繰り返しのある番`);
  for (const [k, v] of [...byTpo.entries()].sort((x, y) => y[1].extra - x[1].extra).slice(0, 12)) if (v.extra) console.log(`   ${String(v.extra).padStart(3)}/${String(v.n).padEnd(4)} ${k}`);
  // ── 約束の中身（言い換えの言い直し）: 下書きの約束の topic が前のこちらの約束にもある時、実送信も同じ topic を約束したか ──
  console.log(`\n=== 約束の中身の言い直し（言い換えも数える・お客様が受けだけの番／中身のある番）===`);
  type TA = { n: number; sent: number; tkN: number; tkSent: number };
  const tAgg = new Map<string, TA>();
  const tSamples: { key: string; ok: boolean; t: Turn; topic: string; d: string; p: string }[] = [];
  let tkSentRepeatTopics = 0, tkSentTopics = 0;
  for (const t of use) {
    const draft = replace?.get(t.id) ?? t.draft;
    const ackOnly = isAckOnlyTurn(t.customer);
    const tr = topicRepeats(draft, t.priorStaff);
    const sentT = new Set(splitSentencesJa(t.sent).flatMap(promiseTopics));
    for (const r of tr) {
      const bb = r.back <= 1 ? "1" : r.back <= 2 ? "2" : r.back <= 4 ? "3-4" : "5+";
      for (const key of [`${ackOnly ? "受けだけ" : "中身あり"}・${r.topic}`, `${ackOnly ? "受けだけ" : "中身あり"}・${bb}通前`]) {
        const a = tAgg.get(key) ?? { n: 0, sent: 0, tkN: 0, tkSent: 0 };
        a.n++; if (sentT.has(r.topic)) a.sent++;
        if (t.writer === "takeuchi") { a.tkN++; if (sentT.has(r.topic)) a.tkSent++; }
        tAgg.set(key, a);
      }
      tSamples.push({ key: `${ackOnly ? "受けだけ" : "中身あり"}・${r.topic}・${r.back}通前`, ok: sentT.has(r.topic), t, topic: r.topic, d: r.sentence, p: r.ref });
    }
    if (t.writer === "takeuchi") {
      const sr = topicRepeats(t.sent, t.priorStaff);
      tkSentRepeatTopics += sr.length; tkSentTopics += [...sentT].length;
    }
  }
  console.log(`   鍵: 下書きで言い直した数 → 実送信も同じ約束（全／竹内さんの番）`);
  for (const [k, a] of [...tAgg.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    console.log(`   ${k.padEnd(18)} 全 ${String(a.n).padStart(3)}→${String(a.sent).padStart(3)}（${(a.sent / Math.max(1, a.n) * 100).toFixed(0)}%） ｜ 竹内さん ${String(a.tkN).padStart(3)}→${String(a.tkSent).padStart(3)}（${(a.tkSent / Math.max(1, a.tkN) * 100).toFixed(0)}%）`);
  }
  console.log(`   参考: 竹内さんの実送信の約束 ${tkSentTopics} のうち前の約束の言い直し ${tkSentRepeatTopics}`);
  const tExtraTurns = new Set(tSamples.filter((s) => !s.ok).map((s) => s.t.id));
  console.log(`   約束の言い直しで実送信が言わなかった（余計）番: ${tExtraTurns.size}/${use.length}・竹内さんの番 ${[...tExtraTurns].filter((id) => use.find((t) => t.id === id)?.writer === "takeuchi").length}/${tk.length}`);
  if (SAMPLES > 0) {
    for (const ok of [false, true]) {
      console.log(`\n--- 約束の言い直しの見本: ${ok ? "実送信も言った" : "実送信は言わなかった"}（竹内さんの番）---`);
      for (const s of tSamples.filter((x) => x.ok === ok && x.t.writer === "takeuchi").sort((a, b) => b.t.at - a.t.at).slice(0, SAMPLES)) {
        console.log(`── ${s.t.id.slice(0, 8)} ${new Date(s.t.at).toISOString().slice(0, 16)} ${s.key} tpo=${(s.t.tpo ?? "-").slice(0, 40)}`);
        console.log(`   お客様: ${mask(s.t.customer.join(" ／ ")).slice(0, 110)}`);
        console.log(`   前の文: ${mask(s.p).slice(0, 100)}`);
        console.log(`   下書き: ${mask(s.d).slice(0, 100)}`);
        console.log(`   実送信: ${mask(s.t.sent).slice(0, 150)}`);
      }
    }
  }
  if (SAMPLES > 0) {
    for (const ok of [false, true]) {
      console.log(`\n=== 見本: ${ok ? "正しい言い直し（実送信も言った）" : "余計な繰り返し（実送信は削った）"}（竹内さんの番を先に）===`);
      const ss = samples.filter((s) => s.ok === ok).sort((a, b) => Number(b.t.writer === "takeuchi") - Number(a.t.writer === "takeuchi") || b.t.at - a.t.at).slice(0, SAMPLES);
      for (const s of ss) {
        console.log(`── ${s.t.id.slice(0, 8)} ${new Date(s.t.at).toISOString().slice(0, 16)} ${s.t.writer ?? "?"} ${s.type}${s.h.kind === "staff" ? `（${s.h.back}通前）` : s.h.kind === "self" ? "（下書きの中）" : "（オウム返し）"} tpo=${s.t.tpo ?? "-"}`);
        console.log(`   お客様: ${mask(s.t.customer.join(" ／ ")).slice(0, 120)}`);
        console.log(`   前の文: ${mask(s.h.ref).slice(0, 110)}`);
        console.log(`   下書き: ${mask(s.h.sentence).slice(0, 110)}`);
        console.log(`   実送信: ${mask(s.t.sent).slice(0, 160)}`);
      }
    }
  }
  if (arg("json")) fs.writeFileSync(arg("json")!, JSON.stringify(use.map((t) => ({ ...t, hits: judgeTurn(t, replace?.get(t.id) ?? t.draft) })), null, 1));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

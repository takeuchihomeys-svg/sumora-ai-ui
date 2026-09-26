// 「済んだ事・もう言った約束・今こちらを待っている事」の入口の直し（app/lib/done-state.ts・action-ledger の報告の語彙）を
// 過去の実物に当てて、前後を目で読む監査（読み取りのみ・LLM は呼ばない・本文は名前と電話を伏せて出す）
// 2026-09-26 竹内「ここの部分改善する根本的に」（約束の言い直し／前に送った物の中身を知らない／お客様の返事をこちらの問いへの答えとして読めない）
//
// SEC=ledger   手打ちの確認結果の報告（広い候補）を台帳の分類に当てる（報告として記録されるか）。SNAP=<file> で前後比較用に保存・BEFORE=<file> で差分
// SEC=wait     直前のこちらの塊が「待ちの形の約束」の場面 × お客様の短い了承 → スタッフの手打ちが言い直したか（線）
//              ＋ 下書き×実送信で、新しい入口が当たる組（言い直しをスタッフが消した／残した）
// SEC=block    直前のこちらの塊を6時間で区切ると外れる組（外れた発言に約束があったか）
// SEC=viewing  決まった内覧（台帳の待ち合わせ／viewing-thread の scheduled）× 発言全体が短い了承 → 新しい判定の発火と下書きの定型
// SEC=all（既定）上の全部。EX=5 で例の件数
//
// 実行: npx tsx --env-file=.env.local scripts/audit-reply-context-fix.ts   （DAYS=60・SEC=all・EX=5）
//
// 2026-09-26 の結果（この変更を入れた時）:
//   ledger  広い候補119通: 報告として記録 55.1% → 97.5%。残りは推量（可能性・と思われ）と「現状募集中で…のみ」の1通（止めた）。
//           台帳の語彙の変更は全部の手打ちでも前後比較した（180日 6,710通・変わった293通を全部目で読む）: やり方は
//           `git show <変更前>:app/lib/action-ledger.ts` を scripts/ に置いて import を ../app/lib/ に書き換え、新旧の classifyStaffTextFacts を並べる。
//           誤りは旧AI時代（✨💪の文体）の「とのことでしたので」の復唱の数通だけ（今のスタッフの文体では0）
//   wait    短い了承×直前に待ちの形の約束 6組・下書きの言い直し4件は4件ともスタッフが消していた（残した0＝入口で受けだけに倒して外れる恐れ0）。
//           実送信の線（60日）: 手打ち20通のうち言い直し2（10%）＝受けだけが90%
//   block   6時間で区切ると外れる発言がある組 85/835（10.2%）・外れた側に約束の語 53（6.3%）。外れたのは前日のピックアップ・見積の宣言など、今日の送付で果たした物
//   viewing 決まった内覧×発言全体が短い了承 33組（旧判定は 44組中3組）。下書きの定型（ご都合よろしいお日にち／詳細は改めてご連絡）4件はスタッフが全部消した。
//           実送信で同じ定型を使ったのは1件（決まった内覧とは別のお部屋の案内）
//   ⚠ 出口（本文の書き換え）は1つも足していない（言い直しを含む下書きの そのまま送信 33〜52%＝誤削除0が示せない）。
//     出口で変えたのは validate-reply の「待ち合わせ確定」の置換を**しない**方向の免除だけ（決まった時刻の復唱を消さない＝削除が減る向き）
//
// 2026-09-26 反証レビュー（同日・判定そのものの正しさを目で読んだ。件数だけでは見えなかった物）:
//   viewing  viewing-thread の scheduled 16組のうち候補の日時が無い10組はほぼ全部が誤り（費用の説明の「最安値のお日にち」への「わかりました／お願いします」、
//            「こちらはやめときます」、内覧後の「今日はありがとうございました」）→ 候補の日時を出した打診だけを数える＋逆提案（「18:30以降しか間に合わず」）を外す。
//            台帳の待ち合わせ82組のうち、当日で始まりから60分を過ぎた15組は全部、実送信が「本日お時間頂きありがとうございました」（内覧後）→ 外す。
//            直した後: 決まった内覧 72組（待ち合わせ 67・打診の後の待ち合わせ文 2・受諾 3）・短い了承 28組。下書きの定型4件は全部残る（スタッフが全部消した物）
//   ledger   送信時の約束カレンダー（sent-facts → planPromiseCompletion）: 要件が空・相手だけの報告は開いている確認の【必ず】を全部閉じる。
//            旧新の分類器で90日の手打ちを再生すると、新だけ閉じる21件のうち「募集中となります」でペット・初期費用・退去時費用の【必ず】が閉じる誤り＋
//            「探させていただきましたが〇〇が1番オススメ」（物件探しの報告）での誤りがあった → 新しい語彙の報告は要件を持たせる（reportObjectOf）・「探」を外す。
//            直した後: 新だけ閉じる13件（全部を読んで正しい履行）・旧だけ閉じる0件（旧の語彙の報告は旧と同じ要件）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { classifyStaffTextFacts, buildActionLedger } from "../app/lib/action-ledger";
import { findWaitFormPromises, withoutWaitFormPromises, latestStaffBlock, isWholeShortAck, resolveViewingScheduled, type TimedLine } from "../app/lib/done-state";
import { resolveViewingThread } from "../app/lib/viewing-thread";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type Msg = { conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; t: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page<T>(table: string, cols: string, since: string, extra?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) {
    let q = sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (extra) q = extra(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\n/g, " / ");
const short = (s: string, n = 110) => { const m = mask(s); return m.length > n ? m.slice(0, n) + "…" : m; };
const YUMA = "dd34f5b0";
const DAYS = Number(process.env.DAYS ?? 60);
const SEC = process.env.SEC ?? "all";
const EX = Number(process.env.EX ?? 5);
const on = (s: string) => SEC === "all" || SEC === s;

/** 確認結果の報告の広い候補（台帳が報告として記録すべき形）。条件付きの約束（お送り頂けますと確認）は別に数える */
const REPORT_CAND_RE = /確認させて(?:頂|いただ)きました(?:ところ|所|が)|確認(?:しました|いたしました|致しました)(?:ところ|所|が)|との(?:こと|事)(?:で|です|でした)|調べさせて(?:頂|いただ)きましたが|募集に出ていない|(?:お)?申込み?が入り|募集(?:終了|中)(?:と|で|となって)|ご契約が決ま|専任/;
const IS_MEDIA = (s: string) => /^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\]\s*)+$/.test(s);

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const since2 = new Date(Date.now() - (DAYS + 30) * 86400e3).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convs = await page<any>("conversations", "id, line_source_type, created_at", "2000-01-01");
  const groupIds = new Set(convs.filter((c) => c.line_source_type === "group").map((c) => c.id));
  const skip = (id: string) => !id || id.startsWith(YUMA) || groupIds.has(id);
  const msgs = (await page<Msg>("messages", "conversation_id, sender, text, image_url, created_at, is_aix_generated", since2)).map((m) => ({ ...m, t: Date.parse(m.created_at) })).filter((m) => !skip(m.conversation_id));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const textOf = (m: Msg) => m.text ?? (m.image_url ? "[画像]" : "");

  // ── SEC=ledger ──────────────────────────────────────────────────────────
  if (on("ledger")) {
    const cands = msgs.filter((m) => m.sender !== "customer" && !m.is_aix_generated && m.t >= Date.parse(since) && REPORT_CAND_RE.test(m.text ?? ""));
    const cls = cands.map((m) => ({ id: m.conversation_id.slice(0, 8), text: m.text ?? "", kinds: classifyStaffTextFacts(m.text ?? "", m.created_at).map((e) => `${e.kind}`) }));
    const tally = new Map<string, number>();
    for (const c of cls) { const k = c.kinds.length ? (c.kinds.includes("confirmation_reported") ? "報告として記録" : c.kinds.join("+")) : "何も記録しない"; tally.set(k, (tally.get(k) ?? 0) + 1); }
    console.log(`\n=== SEC=ledger 手打ちの確認結果の報告（広い候補）${cands.length}通 ===`);
    for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${n} (${pct(n, cands.length)})`);
    if (process.env.SNAP) { writeFileSync(process.env.SNAP, JSON.stringify(cls)); console.log(`  保存: ${process.env.SNAP}`); }
    if (process.env.BEFORE && existsSync(process.env.BEFORE)) {
      const before = JSON.parse(readFileSync(process.env.BEFORE, "utf8")) as typeof cls;
      const bmap = new Map(before.map((b) => [b.id + b.text, b.kinds.join("+")]));
      const changed = cls.filter((c) => bmap.has(c.id + c.text) && bmap.get(c.id + c.text) !== c.kinds.join("+"));
      console.log(`  前後で分類が変わった ${changed.length}通（全部を目で読む）:`);
      for (const c of changed) console.log(`   ${c.id} [${bmap.get(c.id + c.text) || "なし"} → ${c.kinds.join("+") || "なし"}] ${short(c.text, 160)}`);
    }
    const none = cls.filter((c) => !c.kinds.includes("confirmation_reported")).slice(0, EX * 3);
    console.log(`  報告として記録されない例（最大${EX * 3}）:`);
    for (const c of none) console.log(`   ${c.id} [${c.kinds.join("+") || "なし"}] ${short(c.text, 140)}`);
  }

  // ── 下書き × 実送信（wait / viewing で使う）──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ex = (await page<any>("ai_reply_examples", "id, conversation_id, sent_reply, ai_draft, was_ai_used, entry_source, sent_at, created_at", since, (q) => q.not("ai_draft", "is", null)))
    .filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim() && r.entry_source === "line_reply" && !skip(r.conversation_id));
  type Pair = { r: { conversation_id: string; ai_draft: string; sent_reply: string }; before: Msg[]; anchor: number };
  const pairs: Pair[] = [];
  for (const r of ex) {
    const list = byConv.get(r.conversation_id) ?? [];
    const sentT = Date.parse(r.sent_at ?? r.created_at);
    const head = String(r.sent_reply).replace(/\s+/g, "").slice(0, 12);
    const hit = list.find((m) => m.sender !== "customer" && Math.abs(m.t - sentT) < 15 * 60e3 && (m.text ?? "").replace(/\s+/g, "").startsWith(head));
    const anchor = hit ? hit.t : sentT;
    pairs.push({ r, before: list.filter((m) => m.t < anchor - 1000), anchor });
  }
  const toLines = (before: Msg[]): TimedLine[] => before.map((m) => ({ sender: m.sender === "customer" ? "customer" : "staff", text: textOf(m), t: m.t }));
  const lastCustomerText = (before: Msg[]) => { const out: string[] = []; for (let i = before.length - 1; i >= 0 && before[i].sender === "customer"; i--) out.unshift(textOf(before[i])); return out.join("\n"); };
  // 同じ種類の約束（audit-reply-relation と同じ語彙）
  const PROMISE: Array<[string, RegExp]> = [
    ["確認", /確認(?:させて|して|致|いた)[^。！!\n]{0,6}(?:頂|いただ)?き?ます|確認(?:致|いた)します|確認(?:出来|でき)次第/],
    ["連絡", /(?:ご)?連絡(?:させて)?(?:頂|いただ)きます|ご連絡(?:致|いた)します/],
    ["見積", /(?:見積|御見積)[^。！!\n]{0,12}(?:作成|お送り|送らせ)/],
  ];
  const kinds = (s: string) => new Set(PROMISE.filter(([, re]) => re.test(s)).map(([k]) => k));
  const SHORT_ACK = (s: string) => { const c = s.replace(/[\p{Extended_Pictographic}‍️\s]/gu, ""); return c.length > 0 && c.length < 40 && /ありがと|よろしく|宜しく|お願いします|承知|了解|わかりました|分かりました|はい|大丈夫です|OK/i.test(c) && !/[?？]|いつ|どこ|どちら|いくら/.test(c); };

  // ── SEC=wait ────────────────────────────────────────────────────────────
  if (on("wait")) {
    console.log(`\n=== SEC=wait 待ちの形の約束 × 短い了承（下書き×実送信 ${pairs.length}組）===`);
    let hit = 0, restated = 0, staffRemoved = 0, staffKept = 0; const exR: string[] = [], exK: string[] = [], exOther: string[] = [];
    for (const p of pairs) {
      if (!p.before.length || p.before[p.before.length - 1].sender !== "customer") continue;
      const cust = lastCustomerText(p.before);
      if (!SHORT_ACK(cust)) continue;
      const blk = latestStaffBlock(toLines(p.before));
      const wf = findWaitFormPromises(blk.text);
      if (!wf.length) continue;
      hit++;
      const rest = withoutWaitFormPromises(blk.text).text;
      const wk = new Set(wf.map((w) => w.kind));
      const dk = kinds(p.r.ai_draft), sk = kinds(p.r.sent_reply);
      const draftRestates = [...wk].some((k) => dk.has(k)) || (wk.has("確認") && dk.has("連絡")) || (wk.has("連絡") && dk.has("確認"));
      const staffRestates = [...wk].some((k) => sk.has(k)) || (wk.has("確認") && sk.has("連絡")) || (wk.has("連絡") && sk.has("確認"));
      const line = `${p.r.conversation_id.slice(0, 8)} 直前「${short(wf.map((w) => w.sentence).join(" "), 70)}」残り「${short(rest, 40)}」 客「${short(cust, 30)}」\n      下書き「${short(p.r.ai_draft, 90)}」\n      実送信「${short(p.r.sent_reply, 90)}」`;
      if (draftRestates) { restated++; if (!staffRestates) { staffRemoved++; exR.push(line); } else { staffKept++; exK.push(line); } }
      else exOther.push(line);
    }
    console.log(`  当たる組（短い了承×直前に待ちの形の約束）: ${hit}`);
    console.log(`  うち下書きが同じ種類の約束を書いた: ${restated}（スタッフが消した ${staffRemoved}／スタッフも書いた ${staffKept}）`);
    console.log(`  → 新しい入口で「受けだけ」に倒すと: 直る見込み ${staffRemoved}・スタッフの形から外れる恐れ ${staffKept}`);
    console.log(`  [スタッフが消した（直る側）] 最大${EX}`); exR.slice(0, EX).forEach((l) => console.log(`   ${l}`));
    console.log(`  [スタッフも書いた（外れる恐れ）] 全部`); exK.forEach((l) => console.log(`   ${l}`));
    console.log(`  [下書きは言い直していない] 最大${EX}`); exOther.slice(0, EX).forEach((l) => console.log(`   ${l}`));

    // 実送信の線（下書きの有無によらず・スタッフの手打ち）: 待ちの形の約束 → お客様の短い了承 → こちらの次の手打ち
    let scenes = 0, typed = 0, typedRestate = 0; const ackShapes = new Map<string, number>(); const exLine: string[] = [];
    for (const [, list] of byConv) {
      for (let i = 1; i < list.length; i++) {
        const m = list[i];
        if (m.sender === "customer" || m.is_aix_generated || m.t < Date.parse(since) || IS_MEDIA(m.text ?? "")) continue;
        const prev = list[i - 1];
        if (prev.sender !== "customer") continue;
        const before = list.slice(0, i);
        const cust = lastCustomerText(before);
        if (!SHORT_ACK(cust)) continue;
        const blk = latestStaffBlock(toLines(before));
        const wf = findWaitFormPromises(blk.text);
        if (!wf.length) continue;
        // 間に AIX・報告・画像を挟んだ場面は約束を果たしたものとして外す（診断と同じ区切り）
        scenes++; typed++;
        const wk = new Set(wf.map((w) => w.kind)); const sk = kinds(m.text ?? "");
        const re = [...wk].some((k) => sk.has(k)) || (wk.has("確認") && sk.has("連絡")) || (wk.has("連絡") && sk.has("確認"));
        if (re) { typedRestate++; if (exLine.length < EX) exLine.push(`${m.conversation_id.slice(0, 8)} 「${short(m.text ?? "", 90)}」`); }
        const shape = /気になる点/.test(m.text ?? "") ? "気になる点〜ご連絡ください" : /何卒/.test(m.text ?? "") ? "何卒で締める" : "その他";
        if (!re) ackShapes.set(shape, (ackShapes.get(shape) ?? 0) + 1);
      }
    }
    console.log(`  実送信の線（直近${DAYS}日・待ちの形の約束→短い了承→こちらの手打ち）: ${typed}通のうち言い直し ${typedRestate}（${pct(typedRestate, typed)}）`);
    console.log(`   言い直さなかった手打ちの形: ${[...ackShapes].map(([k, n]) => `${k} ${n}`).join("／")}`);
    exLine.forEach((l) => console.log(`   言い直した例 ${l}`));
  }

  // ── SEC=block ───────────────────────────────────────────────────────────
  if (on("block")) {
    let n = 0, cut = 0, cutPromise = 0; const exB: string[] = [];
    for (const p of pairs) {
      if (!p.before.length) continue;
      n++;
      const blk = latestStaffBlock(toLines(p.before));
      if (!blk.dropped) continue;
      cut++;
      const dropped = blk.droppedTexts.join("\n");
      if (/次第|確認させて|ご連絡|お送りさせて頂きます|ピックアップ/.test(dropped)) { cutPromise++; if (exB.length < EX) exB.push(`${p.r.conversation_id.slice(0, 8)} 外れた「${short(dropped, 80)}」／残る「${short(blk.text ?? "", 60)}」`); }
    }
    console.log(`\n=== SEC=block 直前のこちらの塊を6時間で区切る（${n}組）===`);
    console.log(`  外れる発言がある組 ${cut}（${pct(cut, n)}）・うち外れた側に約束の語 ${cutPromise}（${pct(cutPromise, n)}）`);
    exB.forEach((l) => console.log(`   ${l}`));
  }

  // ── SEC=viewing ─────────────────────────────────────────────────────────
  if (on("viewing")) {
    const FIXED_PHRASE = /ご都合(?:の)?よろしいお日にち|内覧の詳細[^\n。！!]{0,10}ご連絡|詳細[^\n。！!]{0,8}(?:改めて|追って)[^\n。！!]{0,6}ご連絡|集合場所[^\n。！!]{0,12}改めて/;
    let sched = 0, ack = 0, draftBad = 0, staffBad = 0, bySrc = new Map<string, number>(); const exV: string[] = [], exS: string[] = [];
    let propAck = 0;
    for (const p of pairs) {
      if (!p.before.length || p.before[p.before.length - 1].sender !== "customer") continue;
      const cust = lastCustomerText(p.before);
      const thread = resolveViewingThread(p.before.map((m) => ({ sender: m.sender === "customer" ? "customer" : "staff", text: textOf(m), rawCreatedAt: m.created_at })), { nowMs: p.anchor });
      const ledger = buildActionLedger({ messages: p.before.map((m) => ({ sender: m.sender === "customer" ? "customer" : "staff", text: textOf(m), createdAt: m.created_at, isAix: !!m.is_aix_generated })), lastCustomerAt: [...p.before].reverse().find((m) => m.sender === "customer")?.created_at ?? null, now: p.anchor });
      const v = resolveViewingScheduled({ appointment: ledger.facts.viewingAppointment, viewingDone: ledger.facts.viewingDone, thread, customerText: cust, nowMs: p.anchor });
      if (thread.kind === "proposed_waiting_reply" && isWholeShortAck(cust)) { propAck++; if (process.env.SHOWPROP) console.log(`   [提案中] ${p.r.conversation_id.slice(0, 8)} 提案「${short(thread.proposalText, 60)}」 客「${short(cust, 30)}」 下書き「${short(p.r.ai_draft, 70)}」 実送信「${short(p.r.sent_reply, 70)}」`); }
      if (!v.scheduled) continue;
      sched++; bySrc.set(v.source ?? "?", (bySrc.get(v.source ?? "?") ?? 0) + 1);
      if (!isWholeShortAck(cust)) continue;
      ack++;
      const d = FIXED_PHRASE.test(p.r.ai_draft), s = FIXED_PHRASE.test(p.r.sent_reply);
      if (d) draftBad++; if (s) staffBad++;
      const line = `${p.r.conversation_id.slice(0, 8)} [${v.source}${v.label ? " " + v.label : ""}] 客「${short(cust, 30)}」 下書き「${short(p.r.ai_draft, 80)}」 実送信「${short(p.r.sent_reply, 80)}」`;
      if (d && exV.length < EX * 2) exV.push(line);
      if (s) exS.push(line);
    }
    console.log(`\n=== SEC=viewing 決まった内覧（新しい判定）===`);
    console.log(`  決まった内覧への返答 ${sched}組（${[...bySrc].map(([k, n]) => `${k} ${n}`).join("／")}）`);
    console.log(`  うち発言全体が短い了承 ${ack}組 → 新しい「内覧日程確定後シンプル締め」が発火する組`);
    console.log(`   下書きに定型（ご都合よろしいお日にち／詳細は改めてご連絡）${draftBad}・実送信に同じ定型 ${staffBad}（誤りの恐れ＝スタッフが使った）`);
    exV.forEach((l) => console.log(`   [下書きの定型] ${l}`));
    exS.forEach((l) => console.log(`   [実送信も定型] ${l}`));
    console.log(`  （参考）提案中のまま×発言全体が短い了承 ${propAck}組（受諾の形でない了承。新しい判定は当てない）`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

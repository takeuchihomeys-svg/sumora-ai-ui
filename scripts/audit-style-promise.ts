// 文の3点を「場面 × 実送信／成約／AI 下書き→スタッフの直し」で数える（読み取りのみ）
//
// 2026-09-22 竹内「設計知見と協力してこの３点について会話や成約データから分析して場面改善する」
//   ① かしこまりました・何卒よろしくお願い致します 等を入れる場面
//   ② 絵文字を使うタイミング・使わないタイミング（お客様の LINE に応じて）
//   ③ 約束している場面（どれだけ約束しているか・約束を守っているか・約束すべき場面で約束しているか）
//
// 場面は「直前のお客様の発言」（audit-opener-by-scene.ts と同じ）＋「こちらの返信の中身」で見る。
// 実行: npx tsx --env-file=.env.local scripts/audit-style-promise.ts [DAYS=180]
import { createClient } from "@supabase/supabase-js";
import { isShortAckOnly } from "../app/lib/previous-send-note";
import { isConditionFormMessage } from "../app/lib/reply-context";
import { customerSceneOf } from "../app/lib/sent-shape";
import { PROMISE_DEADLINE_RE, PROMISE_NEXT_RE, promiseSentences } from "../app/lib/promise-tracker";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number | null) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (days) q = q.gte(order, new Date(Date.now() - days * 86400_000).toISOString());
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

// ── 場面（直前のお客様の発言）: 生成の材料と同じ関数（sent-shape customerSceneOf＝四者同名）──
const sceneOf = (t: string) => customerSceneOf(t, { isConditionForm: isConditionFormMessage, isShortAck: isShortAckOnly });

// ── ① 語 ──
const KASHIKO_RE = /かしこまりました/;
const KASHIKO_HEAD_RE = /^\s*(?:[^\n]{0,20}さん)?[^\n]{0,20}かしこまりました/;
const NANISOTSU_RE = /何卒よろしくお願い(?:致|いた)します/;
const KIGARU_RE = /(?:いつでも)?お気軽にご(?:連絡|相談)/;

// ── ② 絵文字（u フラグ必須） ──
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const LINE_EMOJI_RE = /\((?:emoji|bow|ぺこり|笑|泣|汗)[^)]{0,10}\)|\(T\s?\^\s?T\)|（笑）|笑$/u;
const emojiCount = (t: string) => (t.match(EMOJI_RE) ?? []).length;
const emojis = (t: string) => t.match(EMOJI_RE) ?? [];

// ── ③ 約束（こちらがこれからする事の宣言） ──
//   「〜させて頂きます」系の未来の行動（確認・ご連絡・お送り・ピックアップ・交渉・作成・ご案内・手配）
// 約束の取り出しはブレインの材料と同じ関数（promise-tracker＝四者同名）
function promiseKind(s: string): string {
  if (/交渉/.test(s)) return "交渉";
  if (/ピックアップ|お探し|探させ|新着/.test(s)) return "物件探し・ピックアップ";
  if (/見積/.test(s)) return "見積書";
  if (/(?:募集状況|空室|空き|入居|ペット|駐車|保証|審査|可否)[^\n]{0,10}確認|確認[^\n]{0,6}(?:させて|致し|いたし)/.test(s)) return "確認";
  if (/ご案内|内覧/.test(s)) return "内覧・ご案内";
  if (/抑え|押さえ|申込/.test(s)) return "申込・部屋を押さえる";
  if (/お送り|送付/.test(s)) return "資料の送付";
  if (/ご連絡|連絡|お伝え/.test(s)) return "ご連絡";
  return "その他";
}
// 約束を果たした形跡（後のスタッフ発言）
function fulfilled(kind: string, later: string[]): boolean {
  const j = later.join("\n");
  switch (kind) {
    case "確認": return /確認(?:させて(?:頂|いただ)きました|致しました|いたしました|しました|取れ)|確認しましたところ|募集中|空室|募集終了|埋ま|申込(?:が)?入|ご入居(?:可能|いただけ)|可能(?:です|となります)|不可/.test(j);
    case "物件探し・ピックアップ": return /\[画像\]|https?:\/\/|ピックアップさせて(?:頂|いただ)きました|お送りさせて(?:頂|いただ)きました|ご査収/.test(j);
    case "見積書": return /見積|\[画像\]/.test(j);
    case "資料の送付": return /\[画像\]|https?:\/\/|ご査収|お送りさせて(?:頂|いただ)きました/.test(j);
    case "交渉": return /交渉(?:させて(?:頂|いただ)きました|しました|の結果|したところ)|承諾|可能|難しい|不可|下が|値下/.test(j);
    default: return later.length > 0;
  }
}

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const msgs = await page("messages", "conversation_id, sender, text, created_at, is_aix_generated", "created_at", days);
  const convs = await page("conversations", "id, status", "created_at", null);
  const statusOf = new Map<string, string>();
  for (const c of convs) statusOf.set(String(c.id), String(c.status ?? ""));
  const WON = new Set(["closed_won", "contract", "approved"]);
  console.log(`=== 材料: messages ${msgs.length}件（直近${days}日）/ conversations ${convs.length}件 ===`);

  type M = { sender: string; text: string; at: number; aix: boolean };
  const byConv = new Map<string, M[]>();
  for (const m of msgs) {
    const cid = String(m.conversation_id ?? ""); const t = String(m.text ?? "").trim();
    if (!cid || !t) continue;
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push({ sender: String(m.sender ?? ""), text: t, at: new Date(String(m.created_at)).getTime(), aix: !!m.is_aix_generated });
  }
  for (const a of byConv.values()) a.sort((x, y) => x.at - y.at);

  // 往復の組: お客様の連投 → 次のスタッフの文（画像・URLだけの送信は除く）
  type Turn = { cid: string; won: boolean; scene: string; cust: string; reply: string; at: number; aix: boolean; laterStaff: string[]; laterCust: string[] };
  const turns: Turn[] = [];
  for (const [cid, arr] of byConv) {
    const won = WON.has(statusOf.get(cid) ?? "");
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].sender !== "customer") continue;
      let k = i; const cust: string[] = [];
      while (k < arr.length && arr[k].sender === "customer") { cust.push(arr[k].text); k++; }
      // スタッフの連投をまとめる（画像・URL・スタンプだけの通は本文から外す）
      const staffTexts: string[] = []; let at = 0; let aix = false; let e = k;
      while (e < arr.length && arr[e].sender === "staff") { if (!/^\s*(?:\[画像\]|\[スタンプ\]|https?:\/\/\S+)\s*$/.test(arr[e].text)) staffTexts.push(arr[e].text); at = at || arr[e].at; aix = aix || arr[e].aix; e++; }
      if (staffTexts.length === 0) { i = k - 1; continue; }
      const horizon = at + 14 * 86400_000;
      const later = arr.slice(e).filter((x) => x.at <= horizon);
      turns.push({ cid, won, scene: sceneOf(cust.join("\n")), cust: cust.join("\n"), reply: staffTexts.join("\n"), at, aix, laterStaff: later.filter((x) => x.sender === "staff").map((x) => x.text), laterCust: later.filter((x) => x.sender === "customer").map((x) => x.text) });
      i = e - 1;
    }
  }
  const manual = turns.filter((t) => !t.aix);
  console.log(`往復 ${turns.length}組（うち AIX を除く手打ち・AI下書き経由 ${manual.length}組・成約 ${manual.filter((t) => t.won).length}組）\n`);

  // ───────────────────────── ① ─────────────────────────
  console.log(`${"═".repeat(80)}\n① かしこまりました・何卒・お気軽に（手打ちの返信・場面別）\n${"═".repeat(80)}`);
  const scenes = [...new Set(manual.map((t) => t.scene))];
  const row = (label: string, arr: Turn[]) => {
    const n = arr.length; if (n < 10) return;
    const k = arr.filter((t) => KASHIKO_RE.test(t.reply)).length;
    const kh = arr.filter((t) => KASHIKO_HEAD_RE.test(t.reply)).length;
    const na = arr.filter((t) => NANISOTSU_RE.test(t.reply)).length;
    const naLast = arr.filter((t) => { const ls = t.reply.split("\n").map((l) => l.trim()).filter(Boolean); return NANISOTSU_RE.test(ls[ls.length - 1] ?? ""); }).length;
    const kg = arr.filter((t) => KIGARU_RE.test(t.reply)).length;
    console.log(`   ${label.padEnd(18)} ${String(n).padStart(5)}組  かしこまりました ${pct(k, n).padStart(6)}（冒頭 ${pct(kh, n)}） 何卒 ${pct(na, n).padStart(6)}（最終行 ${pct(naLast, Math.max(na, 1))}） お気軽に ${pct(kg, n)}`);
  };
  console.log(`\n【全体】`); for (const s of scenes.sort()) row(s, manual.filter((t) => t.scene === s));
  console.log(`\n【成約した会話だけ】`); for (const s of scenes.sort()) row(s, manual.filter((t) => t.scene === s && t.won));
  // 返信の中身別の何卒
  console.log(`\n【返信の中身別】`);
  const kindOf = (r: string) => /待ち合わせ|現地|エントランス|集合/.test(r) ? "内覧の待ち合わせ" : /ご案内させて|ご内覧/.test(r) ? "内覧の案内" : /ピックアップ|新着|出次第/.test(r) ? "物件探しの約束" : /見積/.test(r) ? "見積書" : /申込|審査|書類/.test(r) ? "申込・審査" : PROMISE_NEXT_RE.test(r) || /確認させて(?:頂|いただ)きます/.test(r) ? "確認の約束" : /ご査収/.test(r) ? "ご査収" : r.length <= 40 ? "短い返し" : "その他";
  const kinds = [...new Set(manual.map((t) => kindOf(t.reply)))];
  for (const k of kinds.sort()) row(k, manual.filter((t) => kindOf(t.reply) === k));

  // ───────────────────────── ② ─────────────────────────
  console.log(`\n${"═".repeat(80)}\n② 絵文字（手打ちの返信）\n${"═".repeat(80)}`);
  const withE = manual.filter((t) => emojiCount(t.reply) > 0);
  console.log(`   返信に絵文字あり ${pct(withE.length, manual.length)}（${withE.length}/${manual.length}）`);
  const dist = new Map<string, number>(); for (const t of manual) for (const e of emojis(t.reply)) dist.set(e, (dist.get(e) ?? 0) + 1);
  console.log(`   使われた絵文字: ${[...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([e, c]) => `${e}${c}`).join(" ")}`);
  const cnt = new Map<number, number>(); for (const t of manual) { const c = Math.min(emojiCount(t.reply), 4); cnt.set(c, (cnt.get(c) ?? 0) + 1); }
  console.log(`   1通の個数: ${[...cnt.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c}${c === 4 ? "+" : ""}個 ${pct(n, manual.length)}`).join(" ／ ")}`);
  // お客様の絵文字との関係
  const custE = manual.filter((t) => emojiCount(t.cust) > 0 || LINE_EMOJI_RE.test(t.cust));
  const custN = manual.filter((t) => !(emojiCount(t.cust) > 0 || LINE_EMOJI_RE.test(t.cust)));
  console.log(`   お客様が絵文字を使った時 → こちらも絵文字 ${pct(custE.filter((t) => emojiCount(t.reply) > 0).length, custE.length)}（${custE.length}組）`);
  console.log(`   お客様が絵文字なし       → こちらも絵文字 ${pct(custN.filter((t) => emojiCount(t.reply) > 0).length, custN.length)}（${custN.length}組）`);
  console.log(`\n   【場面別の絵文字あり率】`);
  for (const s of scenes.sort()) { const a = manual.filter((t) => t.scene === s); if (a.length < 10) continue; const w = a.filter((t) => emojiCount(t.reply) > 0).length; const top = new Map<string, number>(); for (const t of a) for (const e of emojis(t.reply)) top.set(e, (top.get(e) ?? 0) + 1); console.log(`     ${s.padEnd(18)} ${String(a.length).padStart(5)}組  ${pct(w, a.length).padStart(6)}  多い: ${[...top.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([e, c]) => `${e}${c}`).join(" ")}`); }
  console.log(`\n   【返信の中身別の絵文字あり率】`);
  for (const k of kinds.sort()) { const a = manual.filter((t) => kindOf(t.reply) === k); if (a.length < 10) continue; const w = a.filter((t) => emojiCount(t.reply) > 0).length; console.log(`     ${k.padEnd(18)} ${String(a.length).padStart(5)}組  ${pct(w, a.length)}`); }
  // 絵文字の位置: どの行に付くか
  let lineWith = 0, lineTotal = 0, onKashiko = 0, kashikoLines = 0, onNani = 0, naniLines = 0, onApology = 0, apologyLines = 0;
  for (const t of manual) for (const l of t.reply.split("\n").map((x) => x.trim()).filter(Boolean)) {
    lineTotal++; const has = emojiCount(l) > 0; if (has) lineWith++;
    if (/^かしこまりました/.test(l)) { kashikoLines++; if (has) onKashiko++; }
    if (NANISOTSU_RE.test(l)) { naniLines++; if (has) onNani++; }
    if (/申し訳/.test(l)) { apologyLines++; if (has) onApology++; }
  }
  console.log(`\n   【行ごと】絵文字の付く行 ${pct(lineWith, lineTotal)} ／「かしこまりました」の行 ${pct(onKashiko, kashikoLines)}（${kashikoLines}行） ／「何卒」の行 ${pct(onNani, naniLines)}（${naniLines}行） ／「申し訳」の行 ${pct(onApology, apologyLines)}（${apologyLines}行）`);
  // お客様の気持ち（不安・不満・謝罪）の時
  const neg = manual.filter((t) => /不安|心配|困|残念|怒|遅い|まだですか|返信ない|すみません|申し訳|ごめん/.test(t.cust));
  console.log(`   お客様が不安・不満・謝罪の時 → こちらの絵文字あり ${pct(neg.filter((t) => emojiCount(t.reply) > 0).length, neg.length)}（${neg.length}組）`);

  // ───────────────────────── ③ ─────────────────────────
  console.log(`\n${"═".repeat(80)}\n③ 約束（こちらがこれからする事の宣言・手打ちの返信）\n${"═".repeat(80)}`);
  const withP = manual.filter((t) => promiseSentences(t.reply).length > 0);
  console.log(`   約束を含む返信 ${pct(withP.length, manual.length)}（${withP.length}/${manual.length}） 成約した会話では ${pct(withP.filter((t) => t.won).length, manual.filter((t) => t.won).length)}`);
  const byKind = new Map<string, { n: number; dl: number; next: number; ok: number; custAsked: number }>();
  for (const t of withP) for (const s of promiseSentences(t.reply)) {
    const k = promiseKind(s); const b = byKind.get(k) ?? { n: 0, dl: 0, next: 0, ok: 0, custAsked: 0 };
    b.n++; if (PROMISE_DEADLINE_RE.test(s)) b.dl++; if (PROMISE_NEXT_RE.test(s)) b.next++; if (fulfilled(k, t.laterStaff)) b.ok++;
    byKind.set(k, b);
  }
  console.log(`\n   約束の種類        件数   期限つき  「〜次第」  14日以内に果たした形跡`);
  for (const [k, b] of [...byKind.entries()].sort((a, c) => c[1].n - a[1].n)) console.log(`   ${k.padEnd(16)} ${String(b.n).padStart(5)}   ${pct(b.dl, b.n).padStart(6)}   ${pct(b.next, b.n).padStart(6)}    ${pct(b.ok, b.n)}`);
  console.log(`\n   【場面別: 約束を含む率】（全体 ／ 成約）`);
  for (const s of scenes.sort()) { const a = manual.filter((t) => t.scene === s); if (a.length < 10) continue; const w = a.filter((t) => t.won); console.log(`     ${s.padEnd(18)} ${String(a.length).padStart(5)}組  ${pct(a.filter((t) => promiseSentences(t.reply).length > 0).length, a.length).padStart(6)} ／ ${pct(w.filter((t) => promiseSentences(t.reply).length > 0).length, w.length)}（${w.length}組）`); }
  // 約束の後にお客様が催促した（まだですか・どうなりましたか）
  const nudged = withP.filter((t) => t.laterCust.some((c) => /まだ|どうなり|いかがでしょう|その後|返信|連絡(?:ください|まだ)/.test(c)));
  console.log(`\n   約束の後にお客様が「その後どうなりましたか」系で催促した ${pct(nudged.length, withP.length)}（${nudged.length}組）`);
  // 成約と約束の関係（会話単位）: 会話あたりの約束数・果たした率
  const convP = new Map<string, { won: boolean; p: number; ok: number }>();
  for (const t of withP) { const b = convP.get(t.cid) ?? { won: t.won, p: 0, ok: 0 }; for (const s of promiseSentences(t.reply)) { b.p++; if (fulfilled(promiseKind(s), t.laterStaff)) b.ok++; } convP.set(t.cid, b); }
  const cw = [...convP.values()].filter((x) => x.won), cl = [...convP.values()].filter((x) => !x.won);
  const avg = (a: number[]) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "-");
  console.log(`   会話あたりの約束: 成約 ${avg(cw.map((x) => x.p))}件・果たした ${pct(cw.reduce((a, x) => a + x.ok, 0), cw.reduce((a, x) => a + x.p, 0))}（${cw.length}会話） ／ それ以外 ${avg(cl.map((x) => x.p))}件・果たした ${pct(cl.reduce((a, x) => a + x.ok, 0), cl.reduce((a, x) => a + x.p, 0))}（${cl.length}会話）`);

  // ───────────── AI 下書き → スタッフの直し（3点すべて） ─────────────
  console.log(`\n${"═".repeat(80)}\nAI の下書き → スタッフが実際に送った文（ai_reply_examples・直近120日）\n${"═".repeat(80)}`);
  const ex = await page("ai_reply_examples", "conversation_id, customer_message, ai_draft, sent_reply, was_ai_used, created_at", "created_at", 120);
  const pairs = ex.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim() && !/^\s*\[画像\]/.test(String(r.sent_reply)));
  console.log(`   組 ${pairs.length}件`);
  const diff = (label: string, test: (s: string) => boolean) => {
    let aiOnly = 0, staffOnly = 0, both = 0;
    const scAi = new Map<string, number>(), scSt = new Map<string, number>();
    for (const r of pairs) {
      const a = test(String(r.ai_draft)), s = test(String(r.sent_reply));
      const sc = sceneOf(String(r.customer_message ?? ""));
      if (a && s) both++; else if (a) { aiOnly++; scAi.set(sc, (scAi.get(sc) ?? 0) + 1); } else if (s) { staffOnly++; scSt.set(sc, (scSt.get(sc) ?? 0) + 1); }
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k}${v}`).join("・");
    console.log(`   ${label.padEnd(20)} AI だけ書いた(スタッフが消した) ${String(aiOnly).padStart(4)} ／ スタッフだけ書いた(AI が書けていない) ${String(staffOnly).padStart(4)} ／ 両方 ${both}`);
    if (aiOnly) console.log(`      消された場面: ${top(scAi)}`);
    if (staffOnly) console.log(`      足された場面: ${top(scSt)}`);
  };
  diff("かしこまりました", (s) => KASHIKO_RE.test(s));
  diff("何卒", (s) => NANISOTSU_RE.test(s));
  diff("お気軽に", (s) => KIGARU_RE.test(s));
  diff("絵文字あり", (s) => emojiCount(s) > 0);
  diff("絵文字2個以上", (s) => emojiCount(s) >= 2);
  diff("約束あり", (s) => promiseSentences(s).length > 0);
  diff("期限つきの約束", (s) => promiseSentences(s).some((x) => PROMISE_DEADLINE_RE.test(x)));
  diff("「〜次第」の約束", (s) => promiseSentences(s).some((x) => PROMISE_NEXT_RE.test(x)));
  // スタッフが足した約束の実例（個人名は伏せる）
  const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様)/g, "〈お客様〉").replace(/\n/g, " ／ ");
  console.log(`\n   【スタッフが足した約束の実例（AI 下書きに約束が無く、実送信にある）】`);
  let shown = 0;
  for (const r of pairs) {
    if (shown >= 14) break;
    const a = promiseSentences(String(r.ai_draft)), s = promiseSentences(String(r.sent_reply));
    if (a.length === 0 && s.length > 0) { shown++; console.log(`   客: ${mask(String(r.customer_message ?? "")).slice(0, 60)}\n     AI: ${mask(String(r.ai_draft)).slice(0, 90)}\n     送: ${mask(s.join(" "))}`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

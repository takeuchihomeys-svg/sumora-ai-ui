// scripts/audit-customer-mindset.ts — お部屋探しに特化した「お客様の状態」を竹内さんの番の実データで調べる（本番 DB は読むだけ）
//
// 2026-10-09 竹内「ブレインはその状況でのお客さんの反応によって感情を読み取れるようになっているか…状況と感情を理解して、
//   それに合った考察をして AIX-META を作り、文の生成を RAG ですれば、かなりずれない事になるのでは？」
//   追加の方針: 感情は一般の「前向き/不安/迷い」ではなく、この LINE に特化した状態で（刺さっている／興味が薄い／急いでいる／
//   審査が通るか不安＝前向きな不安／先に申込が入るのが不安＝抑えたい／安くしたい／内覧に行きたいが時間が無い…）。不安は本質（何が・向き）で見る。
//
// 段:
//   --phase=build   竹内さんの番（staff_writer=takeuchi・直近 --days 日）と手本の置き場（ai_reply_examples line_reply）を作る（LLM なし）
//   --phase=label   DeepSeek で状態のラベルを付ける（キャッシュ scripts/.replay-out/cstate-labels-*.json・続きから）。LLM_TEST_MODE=deepseek-all が要る
//   --phase=analyze 数える（①状態ごとの返し方と次の一手 ②ブレインの emo との対応 ③手本の検索を状態で並べ替えた時の近さ）
// 個人情報: 申込の書類・個人の値の通から先は会話ごとに切る（applicationMaterialReason・piiValueSignal）・申込（deal_outcomes.applied_at）以降は使わない・
//   名前・番号は maskExamText で伏せてから DeepSeek に送る。YUMA・グループ・テストの会話は外す。
// 実行:
//   npx tsx --env-file=.env.local scripts/audit-customer-mindset.ts --phase=build --days=60
//   LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/audit-customer-mindset.ts --phase=label [--max-usd=2.5]
//   npx tsx --env-file=.env.local scripts/audit-customer-mindset.ts --phase=analyze [--show=審査の不安]
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { isTestConversation } from "../app/lib/test-conversations";
import { applicationMaterialReason, piiValueSignal } from "../app/lib/test-pii-guard";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { detectAppeal } from "../app/lib/appeal-timing";
import { bigramSim, editCore } from "../app/lib/edit-diff";
import { writerFromText } from "../app/lib/staff-writer";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const PHASE = arg("phase", "build");
const DAYS = Number(arg("days", "60"));
const OUT = path.join(__dirname, ".replay-out");
const TAG = arg("tag", ""); const sfx = TAG ? `-${TAG}` : "";
const TURNS_FILE = path.join(OUT, `cstate-turns${sfx}.json`);
const POOL_FILE = path.join(OUT, "cstate-pool.json");
const LABEL_FILE = path.join(OUT, `cstate-labels-turns${sfx}.json`);
const HLABEL_FILE = path.join(OUT, `cstate-labels-hesitation${sfx}.json`);
const PLABEL_FILE = path.join(OUT, "cstate-labels-pool.json");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost", (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "x"));

type M = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null; line_message_id: string | null };
async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 2_000_000; i += 1000) { const { data, error } = await q(i); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  return out;
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ── 竹内さんの文の形（決まった計算） ─────────────────────────────
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
export type ReplyShape = {
  chars: number; lines: number; sentences: number; emoji: number; nanitozo: boolean;
  opener: string; empathy: boolean; reassure: boolean; considerDoor: boolean;
  promise: string | null; appealApply: boolean; appealViewing: boolean; kind: string;
};
export function replyShape(t: string): ReplyShape {
  const s = String(t ?? "");
  const lines = s.split(/\n/).map((x) => x.trim()).filter(Boolean);
  const first = (lines.find((l) => !/^[^\s]{1,12}(?:さん|様)$/.test(l)) ?? "").replace(EMOJI_RE, "");
  const opener =
    /^(?:ご連絡|ご返信|ご回答|ご確認|お返事|早速|ご丁寧)?.{0,8}ありがとうございます/.test(first) ? "ありがとうございます"
    : /^かしこまりました/.test(first) ? "かしこまりました"
    : /^承知/.test(first) ? "承知"
    : /^お世話になっております/.test(first) ? "お世話になっております"
    : /^(?:左様でございますか|そうなんですね|なるほど)/.test(first) ? "左様で/そうなんですね"
    : /^(?:申し訳|大変申し訳)/.test(first) ? "申し訳"
    : /^(?:おはようございます|こんにちは|こんばんは)/.test(first) ? "時刻の挨拶"
    : /^(?:とんでもない|いえいえ)/.test(first) ? "とんでもない"
    : /^(?:大丈夫|問題)/.test(first) ? "大丈夫です"
    : "その他";
  const promise = /確認させて(?:頂|いただ)き|お調べ|確認(?:致し|いたし)ます|確認次第/.test(s) ? "確認"
    : /ピックアップ(?:させて頂|致し|いたし|して)|お探し(?:させて頂|致し)|出次第|新着/.test(s) ? "ピックアップ"
    : /見積書?(?:を)?(?:作成|お送り)/.test(s) ? "見積" : null;
  const ap = detectAppeal(s);
  const considerDoor = /ごゆっくり|ご検討|いつでも|お気軽に/.test(s);
  const kind = ap.apply ? "申込誘導" : ap.viewing ? "内覧誘導" : promise ? `約束:${promise}` : considerDoor ? "扉を開けて締め" : s.length <= 60 ? "短い受け" : "答え・説明";
  return {
    chars: s.length, lines: lines.length, sentences: s.split(/[。！!？?\n]+/).filter((x) => x.trim().length > 3).length,
    emoji: (s.match(EMOJI_RE) ?? []).length, nanitozo: /何卒/.test(s), opener,
    empathy: /ですよね|かと思います|お気持ち|ご不安|ご心配|心配ですよね|嬉しい|良かったです|よかったです/.test(s),
    reassure: /ご安心|安心して|サポートさせて|全力で|お任せ/.test(s),
    considerDoor, promise, appealApply: ap.apply, appealViewing: ap.viewing, kind,
  };
}

// ── build ─────────────────────────────────────────────
type Turn = {
  id: string; cid: string; at: string; customer: string; prevStaff: string[]; scene: string; state: string | null;
  firstIsAix: boolean; aixType: string | null; checkPattern: string | null; anyAix: boolean; reply: string | null;
  brainEmo: string | null; brainAction: string | null; brainMatched: boolean | null;
  /** お客様の次の反応: 返事までの時間（7日以内・無ければ null）・その返事の束の始まり（次の番の id を引く用）・申込（30日）・内覧（14日） */
  nextReplyH: number | null; nextTurnId: string | null; applied30: boolean; viewing14: boolean; observable: boolean;
};
async function build() {
  const since = new Date(Date.now() - (DAYS + 20) * 86_400_000).toISOString();
  const turnSince = Date.now() - DAYS * 86_400_000;
  const msgs = await all<M>((i) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer, line_message_id").gte("created_at", since).order("created_at").order("id").range(i, i + 999));
  const convs = await all<{ id: string; line_source_type: string | null; status: string | null; customer_name: string | null }>((i) => sb.from("conversations").select("id, line_source_type, status, customer_name").range(i, i + 999));
  const convBy = new Map(convs.map((c) => [c.id, c]));
  const outs = await all<{ conversation_id: string; applied_at: string | null }>((i) => sb.from("deal_outcomes").select("conversation_id, applied_at").not("applied_at", "is", null).range(i, i + 999));
  const appliedAt = new Map<string, number>(); for (const o of outs) { const t = Date.parse(o.applied_at!); const p = appliedAt.get(o.conversation_id); if (p == null || t < p) appliedAt.set(o.conversation_id, t); }
  const aix = await all<{ conversation_id: string; aix_type: string | null; check_pattern: string | null; sent_at: string | null; created_at: string }>((i) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at, created_at").gte("created_at", since).not("sent_at", "is", null).range(i, i + 999));
  const aixBy = new Map<string, typeof aix>(); for (const a of aix) (aixBy.get(a.conversation_id) ?? aixBy.set(a.conversation_id, []).get(a.conversation_id)!).push(a);
  const vws = await all<{ conversation_id: string; created_at: string }>((i) => sb.from("viewings").select("conversation_id, created_at").gte("created_at", since).range(i, i + 999));
  const vh = await all<{ conversation_id: string; created_at: string }>((i) => sb.from("viewing_history").select("conversation_id, created_at").gte("created_at", since).range(i, i + 999));
  const viewBy = new Map<string, number[]>(); for (const v of [...vws, ...vh]) (viewBy.get(v.conversation_id) ?? viewBy.set(v.conversation_id, []).get(v.conversation_id)!).push(Date.parse(v.created_at));
  const outs2 = await all<{ conversation_id: string; viewing_at: string | null }>((i) => sb.from("deal_outcomes").select("conversation_id, viewing_at").not("viewing_at", "is", null).range(i, i + 999));
  for (const o of outs2) (viewBy.get(o.conversation_id) ?? viewBy.set(o.conversation_id, []).get(o.conversation_id)!).push(Date.parse(o.viewing_at!));
  const logs = await all<{ conversation_id: string; created_at: string; suggested_action: string | null; matched: boolean | null; digest: { emo?: string } | null }>((i) => sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action, matched, digest").gte("created_at", since).order("created_at").range(i, i + 999));
  const logBy = new Map<string, typeof logs>(); for (const l of logs) (logBy.get(l.conversation_id) ?? logBy.set(l.conversation_id, []).get(l.conversation_id)!).push(l);

  const by = new Map<string, M[]>();
  for (const m of msgs) {
    const c = convBy.get(m.conversation_id);
    if (isTestConversation(m.conversation_id) || c?.line_source_type === "group") continue;
    (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  }
  const turns: Turn[] = [];
  let cutConvs = 0;
  for (const [cid, list0] of by) {
    // 申込の書類・個人の値の手前で切る／申込以降を切る
    const ap = appliedAt.get(cid) ?? Infinity;
    let cut = list0.length;
    for (let i = 0; i < list0.length; i++) {
      const m = list0[i];
      if (Date.parse(m.created_at) >= ap || (m.sender === "customer" && (applicationMaterialReason(m.text) || piiValueSignal(m.text)))) { cut = i; cutConvs++; break; }
    }
    const list = list0.slice(0, cut);
    const names = addressNamesOf(list.filter((m) => m.sender !== "customer").map((m) => m.text ?? ""));
    const mask = (t: string | null) => maskExamText(t, convBy.get(cid)?.customer_name ?? null, names);
    for (let i = 0; i < list.length; i++) {
      if (list[i].sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
      let j = i; while (j + 1 < list.length && list[j + 1].sender === "customer") j++;
      const bStart = Date.parse(list[i].created_at), bEnd = Date.parse(list[j].created_at);
      const k = j + 1;
      if (k >= list.length || bStart < turnSince) { i = j; continue; }
      const first = list[k];
      if (Date.parse(first.created_at) - bEnd > 48 * 3600_000 || first.staff_writer !== "takeuchi") { i = j; continue; }
      let e = k; while (e + 1 < list.length && list[e + 1].sender !== "customer") e++;
      const resp = list.slice(k, e + 1);
      const custText = list.slice(i, j + 1).map((m) => m.text ?? "").filter(Boolean).join("\n");
      if (!custText.trim()) { i = j; continue; }
      const prevStaff = list.slice(Math.max(0, i - 6), i).filter((m) => m.sender !== "customer").slice(-2).map((m) => `${m.is_aix_generated ? "【AIX】" : ""}${mask(m.text).slice(0, 220)}`);
      const respEnd = e + 1 < list.length ? Date.parse(list[e + 1].created_at) : Date.parse(resp[resp.length - 1].created_at) + 60_000;
      const ax = (aixBy.get(cid) ?? []).filter((a) => { const t = Date.parse(a.sent_at!); return t >= bEnd - 60_000 && t <= respEnd; }).sort((a, b) => Date.parse(a.sent_at!) - Date.parse(b.sent_at!));
      const manual = resp.find((m) => !m.is_aix_generated && (m.text ?? "").length > 5);
      const bl = (logBy.get(cid) ?? []).filter((l) => { const t = Date.parse(l.created_at); return t >= bStart - 60_000 && t <= Date.parse(first.created_at); });
      const lastLog = [...bl].reverse().find((l) => l.digest?.emo) ?? bl[bl.length - 1] ?? null;
      const respLast = Date.parse(resp[resp.length - 1].created_at);
      const nextCust = list0.slice(e + 1).find((m) => m.sender === "customer");   // 切った後の通も反応の有無としては見る（中身は使わない）
      const nextMs = nextCust ? Date.parse(nextCust.created_at) : null;
      const nextReplyH = nextMs != null && nextMs - respLast <= 7 * 86_400_000 ? (nextMs - respLast) / 3600_000 : null;
      const apMs = appliedAt.get(cid);
      turns.push({
        nextReplyH, nextTurnId: nextCust && nextReplyH != null ? `${cid.slice(0, 8)}-${nextCust.id.slice(0, 8)}` : null,
        applied30: apMs != null && apMs > bStart && apMs - respLast <= 30 * 86_400_000,
        viewing14: (viewBy.get(cid) ?? []).some((v) => v > respLast && v - respLast <= 14 * 86_400_000),
        observable: Date.now() - respLast > 7 * 86_400_000,
        id: `${cid.slice(0, 8)}-${list[i].id.slice(0, 8)}`, cid, at: list[i].created_at,
        customer: mask(custText).slice(0, 600), prevStaff, scene: resolveReplyScene({ customerText: custText }).scene,
        state: convBy.get(cid)?.status ?? null,
        firstIsAix: !!first.is_aix_generated, aixType: ax[0]?.aix_type ?? (first.is_aix_generated ? "unknown" : null), checkPattern: ax[0]?.check_pattern ?? null,
        anyAix: resp.some((m) => m.is_aix_generated), reply: manual ? (manual.text ?? "") : null,
        brainEmo: lastLog?.digest?.emo ?? null, brainAction: lastLog?.suggested_action ?? null, brainMatched: lastLog?.matched ?? null,
      });
      i = j;
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(TURNS_FILE, JSON.stringify(turns));
  console.log(`竹内さんの番 ${turns.length}（会話 ${new Set(turns.map((t) => t.cid)).size}・書類/申込で切った会話 ${cutConvs}）→ ${TURNS_FILE}`);
  console.log(`  最初が AIX ${turns.filter((t) => t.firstIsAix).length}・返信 ${turns.filter((t) => !t.firstIsAix).length}・ブレインの emo あり ${turns.filter((t) => t.brainEmo).length}`);

  if (arg("pool", "1") === "0") return;
  // 手本の置き場（line_reply・埋め込みつき）
  type P = { id: string; conversation_id: string | null; customer_message: string; sent_reply: string; conversation_state: string; is_starred: boolean | null; reply_angle: string | null; sent_at: string | null; created_at: string; embedding: string };
  const pool: P[] = [];
  for (let i = 0; i < 20_000; i += 250) {
    const { data, error } = await sb.from("ai_reply_examples").select("id, conversation_id, customer_message, sent_reply, conversation_state, is_starred, reply_angle, sent_at, created_at, embedding").eq("entry_source", "line_reply").not("embedding", "is", null).order("id").range(i, i + 249);
    if (error) throw new Error(error.message); pool.push(...((data ?? []) as P[])); if ((data ?? []).length < 250) break;
  }
  // 前返信（その手本の顧客発言の前のこちらの送信）を messages から探す（直近の範囲だけ）
  const outPool = pool.filter((p) => !isTestConversation(p.conversation_id ?? "") && !applicationMaterialReason(p.customer_message) && !piiValueSignal(p.customer_message)).map((p) => {
    let prev: string | null = null;
    const list = p.conversation_id ? by.get(p.conversation_id) : undefined;
    const sentMs = Date.parse(p.sent_at ?? p.created_at);
    if (list) {
      const idx = list.findIndex((m) => m.sender !== "customer" && Math.abs(Date.parse(m.created_at) - sentMs) < 5 * 60_000);
      if (idx > 0) { let q = idx - 1; while (q >= 0 && list[q].sender === "customer") q--; if (q >= 0) prev = list[q].text ?? null; }
    }
    return {
      id: p.id, cid: p.conversation_id, customer: maskExamText(p.customer_message, convBy.get(p.conversation_id ?? "")?.customer_name ?? null, addressNamesOf([prev ?? "", p.sent_reply])).slice(0, 500), prevStaff: prev ? maskExamText(prev, convBy.get(p.conversation_id ?? "")?.customer_name ?? null, addressNamesOf([prev, p.sent_reply])).slice(0, 200) : null,
      sent: p.sent_reply, state: p.conversation_state, starred: !!p.is_starred, angle: p.reply_angle, at: p.sent_at ?? p.created_at,
      writer: writerFromText(p.sent_reply).writer, emb: p.embedding,
    };
  });
  fs.writeFileSync(POOL_FILE, JSON.stringify(outPool));
  console.log(`手本の置き場 ${outPool.length}（前返信が見つかった ${outPool.filter((p) => p.prevStaff).length}・竹内さんの文の癖 ${outPool.filter((p) => p.writer === "takeuchi").length}）→ ${POOL_FILE}`);
}

// ── label ─────────────────────────────────────────────
export const STATES = [
  "刺さっている", "興味が薄い", "急いでいる", "審査の不安", "先に取られる不安", "抑えたい・申込したい", "費用を抑えたい",
  "内覧したいが時間が無い", "内覧したい", "迷い・比較中", "条件を伝える・探してほしい", "物件の空き・中身を知りたい", "手続き・流れを知りたい",
  "不満・苛立ち", "離れかけ・断り", "お礼・了承だけ", "恐縮・謝罪", "日程・連絡の調整", "その他",
] as const;
const STATE_DEF = [
  "刺さっている: 送った物件・提案を気に入っている／良いと言っている／前のめり",
  "興味が薄い: この物件・提案には興味が無い・反応が薄い（断りまではいかない）",
  "急いでいる: 入居・決定を急いでいる（今月中・すぐ・早めに）",
  "審査の不安: 審査が通るか心配（＝申込したい前向きな不安。職業・収入・ブラック・保証会社）",
  "先に取られる不安: 先に他の人に申込が入ってしまわないか心配（＝抑えたい）",
  "抑えたい・申込したい: 決めに来ている・申込や仮押さえを望む",
  "費用を抑えたい: 初期費用・家賃を安くしたい／もっと抑えたい／総額を気にしている",
  "内覧したいが時間が無い: 見に行きたいが都合が付かない・遠方・先の日になる",
  "内覧したい: 見に行きたい・日程を出してきた（時間の問題なし）",
  "迷い・比較中: 決めきれない・検討する・他と比べている・相談する",
  "条件を伝える・探してほしい: 条件の提示・変更・もっと探して（気持ちは普通）",
  "物件の空き・中身を知りたい: 空いているか・設備・写真・条件を確かめたい（持ち込み物件を含む）",
  "手続き・流れを知りたい: 審査・契約・入居までの流れ・書類の質問（不安が主でない）",
  "不満・苛立ち: 返事が遅い・話が違う・高い等の不満",
  "離れかけ・断り: 他で決めた・見送り・もう大丈夫",
  "お礼・了承だけ: ありがとう・了解・よろしく だけ",
  "恐縮・謝罪: 遅れてすみません・お手数おかけします が主",
  "日程・連絡の調整: 内覧以外の日時・連絡のタイミング・電話の都合",
  "その他: 上に無い（free に短く書く）",
].join("\n");
const SYS = [
  "あなたは大阪の賃貸仲介の LINE 接客を読む係です。お客様の今の連投（と直前のこちらの送信）から、お客様の『状態』を読みます。",
  "状態は一般的な感情でなく、お部屋探しの中での本質で選ぶ。語だけで決めない（『不安』と書いてあっても、何が不安か・その不安が進みたいがゆえ（前向き）か引く理由（後ろ向き）かを見る）。",
  "状態の一覧（primary は1つ・secondary は0〜2つ）:", STATE_DEF,
  "anxiety: 不安・心配が読めれば {target: 審査|先に取られる|費用|物件の中身|立地・治安|手続き|日程|その他, direction: 前向き|後ろ向き}、無ければ null。",
  "temp: お客様の温度 高|中|低。",
  '出力は JSON だけ: {"items":[{"i":1,"primary":"…","secondary":["…"],"anxiety":null,"temp":"中","free":"10字（その他の時だけ）"}]}',
].join("\n");

let cost = { usd: 0, calls: 0, fail: 0 };
async function deepseekJson(user: string, sys: string = SYS): Promise<Record<string, unknown> | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../app/lib/llm-price");
  const model = process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, max_tokens: 2500, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const pr = altPriceOf(model);
      if (pr && j.usage) cost.usd += (((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6) * (pr.peakDouble && isDeepseekPeakAt(new Date()) ? 2 : 1);
      cost.calls++;
      return JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")) as Record<string, unknown>;
    } catch (e) { if (attempt === 1) { cost.fail++; console.warn(`  失敗: ${e instanceof Error ? e.message : e}`); } }
  }
  return null;
}
type Label = { primary: string; secondary: string[]; anxiety: { target: string; direction: string } | null; temp: string; free?: string };
async function labelSet(items: Array<{ id: string; text: string }>, file: string, batch: number, maxUsd: number) {
  const done: Record<string, Label> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const todo = items.filter((x) => !done[x.id]);
  console.log(`${path.basename(file)}: 済み ${Object.keys(done).length}・残り ${todo.length}`);
  const CONC = 6;
  const chunks: typeof todo[] = []; for (let i = 0; i < todo.length; i += batch) chunks.push(todo.slice(i, i + batch));
  for (let c = 0; c < chunks.length; c += CONC) {
    if (cost.usd > maxUsd) { console.log(`費用の上限 $${maxUsd} に達したので止める`); break; }
    await Promise.all(chunks.slice(c, c + CONC).map(async (ch) => {
      const user = ch.map((x, i) => `### ${i + 1}\n${x.text}`).join("\n\n");
      const o = await deepseekJson(user);
      const arr = Array.isArray(o?.items) ? (o!.items as Array<Record<string, unknown>>) : [];
      for (const it of arr) {
        const idx = Number(it.i) - 1; const x = ch[idx]; if (!x) continue;
        const prim = String(it.primary ?? "その他");
        done[x.id] = { primary: (STATES as readonly string[]).includes(prim) ? prim : "その他", secondary: Array.isArray(it.secondary) ? (it.secondary as string[]).filter((s) => (STATES as readonly string[]).includes(s)).slice(0, 2) : [], anxiety: (it.anxiety && typeof it.anxiety === "object") ? it.anxiety as Label["anxiety"] : null, temp: String(it.temp ?? ""), free: it.free ? String(it.free).slice(0, 20) : undefined };
      }
    }));
    fs.writeFileSync(file, JSON.stringify(done));
    process.stdout.write(`\r  ${Math.min(c + CONC, chunks.length)}/${chunks.length} 束・$${cost.usd.toFixed(3)}・${cost.calls} 回・失敗 ${cost.fail}`);
  }
  console.log("");
  return done;
}
async function label() {
  if (process.env.LLM_TEST_MODE !== "deepseek-all") throw new Error("LLM_TEST_MODE=deepseek-all を付けて流す（test_protocol_brain.md）");
  const maxUsd = Number(arg("max-usd", "2.5"));
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  await labelSet(turns.map((t) => ({ id: t.id, text: `【直前のこちらの送信】\n${t.prevStaff.join("\n―\n") || "（なし＝初回）"}\n【お客様の今の連投】\n${t.customer}` })), LABEL_FILE, 6, maxUsd);
  if (arg("pool", "1") !== "0") {
    const pool: Array<{ id: string; customer: string; prevStaff: string | null }> = JSON.parse(fs.readFileSync(POOL_FILE, "utf8"));
    await labelSet(pool.map((p) => ({ id: p.id, text: `【直前のこちらの送信】\n${p.prevStaff ?? "（不明）"}\n【お客様の今の連投】\n${p.customer.slice(0, 400)}` })), PLABEL_FILE, 12, maxUsd);
  }
  console.log(`DeepSeek ${cost.calls} 回・$${cost.usd.toFixed(3)}・失敗 ${cost.fail}`);
}

// ── analyze ───────────────────────────────────────────
function cos(a: Float32Array, b: Float32Array) { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); }
async function analyze() {
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const L: Record<string, Label> = JSON.parse(fs.readFileSync(LABEL_FILE, "utf8"));
  const lt = turns.filter((t) => L[t.id]);
  console.log(`\n=== ① 状態ごとの竹内さんの番（${lt.length} 番・ラベルあり）===`);
  const byState = new Map<string, Turn[]>(); for (const t of lt) (byState.get(L[t.id].primary) ?? byState.set(L[t.id].primary, []).get(L[t.id].primary)!).push(t);
  const allReplies = lt.filter((t) => !t.firstIsAix && t.reply).map((t) => replyShape(t.reply!));
  const base = {
    n: allReplies.length, chars: med(allReplies.map((r) => r.chars)), emoji: allReplies.filter((r) => r.emoji > 0).length / allReplies.length,
    nanitozo: allReplies.filter((r) => r.nanitozo).length / allReplies.length,
  };
  console.log(`全体の返信 ${base.n}: 中央 ${base.chars}字・絵文字あり ${Math.round(base.emoji * 100)}%・何卒 ${Math.round(base.nanitozo * 100)}%`);
  console.log("状態 | 番 | AIXが先 | 主な AIX | 返信の中央字 | 文 | 絵文字 | 何卒 | 共感 | 安心 | 扉 | 内覧誘 | 申込誘 | 約束 | 主な受け | 主な形 | ブレインemo | ブレイン一致");
  const rows = [...byState.entries()].sort((a, b) => b[1].length - a[1].length);
  const top = (xs: string[], k = 2) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([x, n]) => `${x} ${pct(n, xs.length)}`).join("・"); };
  for (const [st, ts] of rows) {
    const rs = ts.filter((t) => !t.firstIsAix && t.reply).map((t) => replyShape(t.reply!));
    const n = rs.length || 1;
    const matched = ts.filter((t) => t.brainMatched != null);
    console.log([st, ts.length, pct(ts.filter((t) => t.firstIsAix).length, ts.length), top(ts.filter((t) => t.firstIsAix).map((t) => `${t.aixType}${t.checkPattern ? `/${t.checkPattern}` : ""}`), 2),
      med(rs.map((r) => r.chars)), med(rs.map((r) => r.sentences)), pct(rs.filter((r) => r.emoji > 0).length, n), pct(rs.filter((r) => r.nanitozo).length, n), pct(rs.filter((r) => r.empathy).length, n), pct(rs.filter((r) => r.reassure).length, n),
      pct(rs.filter((r) => r.considerDoor).length, n), pct(rs.filter((r) => r.appealViewing).length, n), pct(rs.filter((r) => r.appealApply).length, n), pct(rs.filter((r) => r.promise).length, n),
      top(rs.map((r) => r.opener), 2), top(rs.map((r) => r.kind), 2), top(ts.map((t) => t.brainEmo ?? "なし"), 3), `${pct(matched.filter((t) => t.brainMatched).length, matched.length)}(${matched.length})`].join(" | "));
  }
  // 不安の本質
  console.log("\n--- 不安の中身と向き（anxiety があった番）---");
  const anx = lt.filter((t) => L[t.id].anxiety);
  const anxKey = (t: Turn) => `${L[t.id].anxiety!.target}/${L[t.id].anxiety!.direction}`;
  const ak = new Map<string, Turn[]>(); for (const t of anx) (ak.get(anxKey(t)) ?? ak.set(anxKey(t), []).get(anxKey(t))!).push(t);
  for (const [k, ts] of [...ak.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const rs = ts.filter((t) => !t.firstIsAix && t.reply).map((t) => replyShape(t.reply!));
    const m = ts.filter((t) => t.brainMatched != null);
    console.log(`${k}: ${ts.length} 番・ブレイン emo ${top(ts.map((t) => t.brainEmo ?? "なし"), 3)}・AIX が先 ${pct(ts.filter((t) => t.firstIsAix).length, ts.length)}（${top(ts.filter((t) => t.firstIsAix).map((t) => t.aixType ?? "?"), 2)}）・返信の形 ${top(rs.map((r) => r.kind), 3)}・安心 ${pct(rs.filter((r) => r.reassure).length, rs.length)}・申込誘 ${pct(rs.filter((r) => r.appealApply).length, rs.length)}・ブレイン一致 ${pct(m.filter((t) => t.brainMatched).length, m.length)}(${m.length})`);
  }
  // ② ブレイン emo との対応
  console.log("\n=== ② ブレインの emo（本番は 前向き/普通/不安/冷めかけ の4択）× 状態 ===");
  const emos = ["前向き", "普通", "不安", "冷めかけ", "なし"];
  console.log(`状態 | ${emos.join(" | ")} | ブレイン一致（emo 別: 不安 / それ以外）`);
  for (const [st, ts] of rows) {
    const cnt = emos.map((e) => pct(ts.filter((t) => (t.brainEmo ?? "なし") === e).length, ts.length));
    const fa = ts.filter((t) => t.brainEmo === "不安" && t.brainMatched != null), fo = ts.filter((t) => t.brainEmo !== "不安" && t.brainMatched != null);
    console.log(`${st}(${ts.length}) | ${cnt.join(" | ")} | ${pct(fa.filter((t) => t.brainMatched).length, fa.length)}(${fa.length}) / ${pct(fo.filter((t) => t.brainMatched).length, fo.length)}(${fo.length})`);
  }
  const bm = lt.filter((t) => t.brainMatched != null);
  for (const e of emos) { const x = bm.filter((t) => (t.brainEmo ?? "なし") === e); console.log(`  ブレイン emo=${e}: 一致 ${pct(x.filter((t) => t.brainMatched).length, x.length)}（${x.length}）`); }
  // 当たり率: 4択への写像
  const map4: Record<string, string> = { "刺さっている": "前向き", "抑えたい・申込したい": "前向き", "内覧したい": "前向き", "急いでいる": "前向き", "審査の不安": "不安(前向き)", "先に取られる不安": "不安(前向き)", "興味が薄い": "冷めかけ", "離れかけ・断り": "冷めかけ", "不満・苛立ち": "冷めかけ" };
  const evalSet = lt.filter((t) => t.brainEmo && map4[L[t.id].primary]);
  const hit = evalSet.filter((t) => map4[L[t.id].primary].startsWith(t.brainEmo!)).length;
  console.log(`  4択に写せる状態の番 ${evalSet.length}: ブレインの emo が写した先と同じ ${pct(hit, evalSet.length)}`);
  const pos = lt.filter((t) => L[t.id].anxiety?.direction === "前向き" && t.brainEmo);
  console.log(`  前向きな不安（${pos.length} 番）のブレイン emo: ${top(pos.map((t) => t.brainEmo!), 4)}`);

  // 場面 × 状態 の違いの大きさ（同じ場面の中で状態ごとに返しの形がどれだけ違うか）
  console.log("\n=== 場面 × 状態: 同じ場面の中で状態により返しの形がどれだけ割れるか ===");
  const scenes = new Map<string, Turn[]>(); for (const t of lt) (scenes.get(t.scene) ?? scenes.set(t.scene, []).get(t.scene)!).push(t);
  for (const [sc, ts] of [...scenes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const pathOf = (t: Turn) => (t.firstIsAix ? `AIX:${t.aixType}` : `返信:${t.reply ? replyShape(t.reply).kind : "?"}`);
    // 場面だけで一番多い形を当てる率 vs 場面×状態で一番多い形を当てる率（同じデータでの上限の見積もり・1件の状態は除く）
    const majority = (xs: Turn[]) => { const m = new Map<string, number>(); for (const t of xs) m.set(pathOf(t), (m.get(pathOf(t)) ?? 0) + 1); return Math.max(0, ...m.values()); };
    const sceneOnly = majority(ts);
    const st = new Map<string, Turn[]>(); for (const t of ts) (st.get(L[t.id].primary) ?? st.set(L[t.id].primary, []).get(L[t.id].primary)!).push(t);
    // 1つ抜き（自分を除いた多数派で当てる）で過大評価を避ける
    const loo = (groups: Turn[][]) => { let ok = 0; for (const g of groups) for (const t of g) { const m = new Map<string, number>(); for (const u of g) if (u !== t) m.set(pathOf(u), (m.get(pathOf(u)) ?? 0) + 1); const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; if (best === pathOf(t)) ok++; } return ok; };
    const a = loo([ts]), b = loo([...st.values()]);
    console.log(`${sc}(${ts.length}): 場面だけで次の一手＋返しの形を当てる ${pct(a, ts.length)} → 場面×状態 ${pct(b, ts.length)}（多数派 ${pct(sceneOnly, ts.length)}）・状態 ${top(ts.map((t) => L[t.id].primary), 4)}`);
  }

  // 場面の中で、状態により竹内さんの返しの要素が 25pt 以上違う所（状態が効く余地）
  console.log("\n=== 場面の中で状態により返しの要素が 25pt 以上違う所（返信の番・状態 5番以上）===");
  {
    const rs = lt.filter((t) => !t.firstIsAix && t.reply);
    const feats: Array<[string, (s: ReplyShape) => boolean]> = [["安心の一文", (s) => s.reassure], ["扉（ご検討・ごゆっくり・いつでも）", (s) => s.considerDoor], ["申込・抑える誘い", (s) => s.appealApply], ["内覧の誘い", (s) => s.appealViewing], ["約束", (s) => !!s.promise], ["何卒", (s) => s.nanitozo], ["60字以下", (s) => s.chars <= 60], ["絵文字", (s) => s.emoji > 0]];
    let off = 0;
    for (const sc of [...new Set(rs.map((t) => t.scene))]) {
      const xs = rs.filter((t) => t.scene === sc);
      const by = new Map<string, Turn[]>(); for (const t of xs) (by.get(L[t.id].primary) ?? by.set(L[t.id].primary, []).get(L[t.id].primary)!).push(t);
      off += xs.length - Math.max(...[...by.values()].map((v) => v.length));
      const out: string[] = [];
      for (const [fn, f] of feats) {
        const base = xs.filter((t) => f(replyShape(t.reply!))).length / xs.length;
        const d = [...by.entries()].filter(([, v]) => v.length >= 5).map(([k, v]) => ({ k, n: v.length, r: v.filter((t) => f(replyShape(t.reply!))).length / v.length })).filter((x) => Math.abs(x.r - base) >= 0.25);
        if (d.length) out.push(`${fn}（場面 ${Math.round(base * 100)}%）: ${d.map((x) => `${x.k}(${x.n}) ${Math.round(x.r * 100)}%`).join("・")}`);
      }
      console.log(`[${sc}] 返信 ${xs.length}\n  ${out.join("\n  ") || "（25pt 以上の差なし）"}`);
    }
    console.log(`場面の多数派と違う状態の返信の番: ${off}/${rs.length}（${pct(off, rs.length)}）`);
  }

  // ④ 状態 × こちらの一手 → お客様の次の反応（返事7日・次の番の状態・内覧14日・申込30日）
  console.log("\n=== ④ 状態 × こちらの一手 → 次の反応（観測できる番＝送ってから7日以上たった番だけ）===");
  const moveOf = (t: Turn): string => {
    if (t.firstIsAix) {
      const a = t.aixType ?? "?";
      return a === "estimate_sheet" ? "見積書" : a === "viewing_invite" ? "AIX内覧調整" : a === "meeting_place" ? "待ち合わせ（内覧確定）" : a === "application_push" ? "AIX申込へ"
        : a === "property_send" || a === "property_recommendation" ? "物件を送る" : a === "property_check_result" ? "物件確認の結果" : a === "zenryoku_support" ? "全力サポート" : `AIX:${a}`;
    }
    const r = t.reply ? replyShape(t.reply) : null;
    if (!r) return "返信:?";
    return r.appealApply ? "返信:申込・抑える誘い" : r.appealViewing ? "返信:内覧の誘い" : r.promise ? `返信:約束(${r.promise})` : r.considerDoor ? "返信:待つ（扉を開ける）" : r.chars <= 60 ? "返信:短い受け" : "返信:答え・説明";
  };
  const obs = lt.filter((t) => t.observable);
  const turnById = new Map(lt.map((t) => [t.id, t]));
  const POS = new Set(["刺さっている", "抑えたい・申込したい", "内覧したい", "急いでいる", "審査の不安", "先に取られる不安"]);
  const react = (ts: Turn[]) => {
    const nx = ts.map((t) => (t.nextTurnId ? turnById.get(t.nextTurnId) : undefined)).filter((x): x is Turn => !!x && !!L[x.id]);
    return `返事 ${pct(ts.filter((t) => t.nextReplyH != null).length, ts.length)}・次が前向き ${pct(nx.filter((x) => POS.has(L[x.id].primary)).length, nx.length)}(${nx.length})・内覧14日 ${pct(ts.filter((t) => t.viewing14).length, ts.length)}・申込30日 ${pct(ts.filter((t) => t.applied30).length, ts.length)}`;
  };
  console.log(`全体(${obs.length}): ${react(obs)}`);
  const mv = new Map<string, Turn[]>(); for (const t of obs) (mv.get(moveOf(t)) ?? mv.set(moveOf(t), []).get(moveOf(t))!).push(t);
  console.log("-- 一手だけ --");
  for (const [m, ts] of [...mv.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${m}(${ts.length}): ${react(ts)}`);
  console.log("-- 状態 × 一手（5番以上）--");
  for (const [st] of rows) {
    const ts = obs.filter((t) => L[t.id].primary === st); if (ts.length < 8) continue;
    console.log(`[${st}] ${ts.length}: ${react(ts)}`);
    const g = new Map<string, Turn[]>(); for (const t of ts) (g.get(moveOf(t)) ?? g.set(moveOf(t), []).get(moveOf(t))!).push(t);
    for (const [m, xs] of [...g.entries()].sort((a, b) => b[1].length - a[1].length)) if (xs.length >= 5) console.log(`    ${m}(${xs.length}${xs.length < 10 ? "・弱い参考" : ""}): ${react(xs)}`);
  }

  // ③ 手本の検索
  if (!fs.existsSync(PLABEL_FILE)) { console.log("\n手本のラベルが無いので③は飛ばす"); return; }
  const PL: Record<string, Label> = JSON.parse(fs.readFileSync(PLABEL_FILE, "utf8"));
  type PP = { id: string; cid: string | null; customer: string; sent: string; state: string; starred: boolean; angle: string | null; at: string; writer: string; emb: string };
  const pool0: PP[] = JSON.parse(fs.readFileSync(POOL_FILE, "utf8"));
  const { STATE_SEARCH_ALIASES } = await import("../app/lib/line-reply-prompts");
  const { isUsableExampleText, isCustomerFacingExample } = await import("../app/lib/example-hygiene");
  const { SCENE_EXAMPLE_BOOST } = await import("../app/lib/reply-scene");
  const pool = pool0.filter((p) => PL[p.id] && isUsableExampleText(p.sent) && isCustomerFacingExample(p.sent)).map((p) => ({ ...p, v: Float32Array.from(JSON.parse(p.emb) as number[]), scene: resolveReplyScene({ customerText: p.customer }).scene, shape: replyShape(p.sent) }));
  const since = Date.now() - DAYS * 86_400_000;
  const queries = pool.filter((p) => Date.parse(p.at) >= since && p.writer === "takeuchi");
  console.log(`\n=== ③ 手本の検索の再現（問い ${queries.length}＝直近 ${DAYS} 日の竹内さんの手本・置き場 ${pool.length}・同じ会話は外す）===`);
  const variants: Array<{ name: string; bonus: (q: typeof pool[0], c: typeof pool[0]) => number; filter?: boolean }> = [
    { name: "今（本番の並べ替え）", bonus: () => 0 },
    { name: "+状態一致 0.05", bonus: (q, c) => (PL[q.id].primary === PL[c.id].primary ? 0.05 : 0) },
    { name: "+状態一致 0.10", bonus: (q, c) => (PL[q.id].primary === PL[c.id].primary ? 0.1 : 0) },
    { name: "+状態一致 0.20", bonus: (q, c) => (PL[q.id].primary === PL[c.id].primary ? 0.2 : 0) },
    { name: "+状態 0.10＋不安の向き 0.05", bonus: (q, c) => (PL[q.id].primary === PL[c.id].primary ? 0.1 : 0) + (PL[q.id].anxiety && PL[c.id].anxiety && PL[q.id].anxiety!.target === PL[c.id].anxiety!.target && PL[q.id].anxiety!.direction === PL[c.id].anxiety!.direction ? 0.05 : 0) },
    { name: "状態で絞る（3件未満なら絞らない）", bonus: () => 0, filter: true },
  ];
  type Acc = { near: number[]; best: number[]; kind: number[]; emoji: number[]; nani: number[]; pure: number[]; byState: Map<string, number[]> };
  const acc = variants.map(() => ({ near: [], best: [], kind: [], emoji: [], nani: [], pure: [], byState: new Map() } as Acc));
  for (const q of queries) {
    const aliases = STATE_SEARCH_ALIASES[q.state] ?? [q.state];
    const truth = editCore(q.sent);
    const cands = pool.filter((c) => c.cid !== q.cid && c.id !== q.id && aliases.includes(c.state)).map((c) => ({ c, sim: cos(q.v, c.v) })).filter((x) => x.sim >= 0.5);
    cands.sort((a, b) => b.sim - a.sim);
    const top24 = cands.slice(0, 24);   // 本番は match_count 24 を取ってから並べ替え
    variants.forEach((vr, vi) => {
      let list = top24;
      if (vr.filter) { const f = cands.filter((x) => PL[x.c.id].primary === PL[q.id].primary).slice(0, 24); if (f.length >= 3) list = f; }
      const score = (x: typeof top24[0]) => x.sim + (x.c.starred ? 0.15 : 0) + (x.c.angle ? 0.1 : 0) + (x.c.scene === q.scene ? SCENE_EXAMPLE_BOOST : 0) + (x.c.writer === "takeuchi" ? 0.12 : x.c.writer === "employee" ? -0.12 : 0) + vr.bonus(q, x.c);
      const seen = new Set<string>();
      const top8 = [...list].sort((a, b) => score(b) - score(a)).filter((x) => { const k = editCore(x.c.sent).slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
      if (!top8.length) return;
      const sims = top8.map((x) => bigramSim(editCore(x.c.sent), truth));
      const a = acc[vi];
      a.near.push(sims.reduce((s, x) => s + x, 0) / sims.length); a.best.push(Math.max(...sims));
      a.kind.push(top8.filter((x) => x.c.shape.kind === q.shape.kind).length / top8.length);
      a.emoji.push(top8.filter((x) => (x.c.shape.emoji > 0) === (q.shape.emoji > 0)).length / top8.length);
      a.nani.push(top8.filter((x) => x.c.shape.nanitozo === q.shape.nanitozo).length / top8.length); a.pure.push(top8.filter((x) => PL[x.c.id].primary === PL[q.id].primary).length / top8.length);
      const st = PL[q.id].primary; (a.byState.get(st) ?? a.byState.set(st, []).get(st)!).push(top8.filter((x) => x.c.shape.kind === q.shape.kind).length / top8.length);
    });
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  console.log("並べ方 | 問い | 上位8件の平均の近さ（2字の重なり） | 最も近い1件 | 形（中身の種類）が同じ割合 | 絵文字の有無が同じ | 何卒の有無が同じ");
  variants.forEach((vr, vi) => { const a = acc[vi]; console.log(`${vr.name} | ${a.near.length} | ${avg(a.near).toFixed(4)} | ${avg(a.best).toFixed(4)} | ${(avg(a.kind) * 100).toFixed(1)}% | ${(avg(a.emoji) * 100).toFixed(1)}% | ${(avg(a.nani) * 100).toFixed(1)}% | 状態が同じ手本 ${(avg(a.pure) * 100).toFixed(1)}%`); });
  console.log("\n状態ごとの「形が同じ割合」（今 → +状態 0.10）:");
  for (const [st, xs] of [...acc[0].byState.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${st}(${xs.length}): ${(avg(xs) * 100).toFixed(0)}% → +0.10 ${(avg(acc[2].byState.get(st) ?? []) * 100).toFixed(0)}% ／ 絞る ${(avg(acc[5].byState.get(st) ?? []) * 100).toFixed(0)}%`);
  console.log(`\n置き場の状態の分布: ${(() => { const m = new Map<string, number>(); for (const p of pool) m.set(PL[p.id].primary, (m.get(PL[p.id].primary) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・"); })()}`);

  const SHOW = arg("show", "");
  if (SHOW) for (const t of lt.filter((t) => L[t.id].primary === SHOW).slice(0, Number(arg("n", "8")))) console.log(`\n[${t.id}] emo=${t.brainEmo} 一手=${t.firstIsAix ? `AIX:${t.aixType}` : "返信"}\n 客: ${t.customer.slice(0, 160).replace(/\n/g, " ")}\n 竹内: ${(t.reply ?? "").slice(0, 160).replace(/\n/g, " ")}`);
}

// ── hesitation: 「迷い・比較中」を中身で細かく分ける（2026-10-09 竹内さん④）──────────
//   対象: 状態の主か副が「迷い・比較中」／場面が considering（検討中・保留）の竹内さんの番
//   ラベル: DeepSeek（中身の細分・竹内さんの返し方の型・扉と内覧の誘いの有無）。費用は --max-usd（既定 1.5）
export const HES_KINDS = [
  "複数物件で迷う", "他社・他の物件と比べる", "家族・同居人に相談", "費用で迷う", "立地・周辺で迷う", "設備・広さ・間取りの1点で迷う",
  "時期・入居日で迷う", "内覧してから決めたい", "審査・手続きの見通し待ち", "決め手が無い・ピンと来ない", "急がない・しばらく保留", "その他",
] as const;
export const HES_RESPONSES = ["扉を開けて待つ", "内覧の誘い", "申込・抑える誘い", "比較の手伝い（違い・良し悪しを説明）", "1件を推す", "迷いの点に答える・解消", "別の物件を探す約束", "確認の約束", "AIX（物件・見積書 等）", "その他"] as const;
const HES_SYS = [
  "あなたは大阪の賃貸仲介の LINE 接客を読む係です。お客様が迷っている・検討中の番について、①迷いの中身 ②スタッフ（竹内さん）の返し方の型 を分けます。",
  "① kind（1つ）・kind2（0〜1つ）: " + HES_KINDS.join(" / "),
  "  - 複数物件で迷う: 送った/持ち込んだ物件のどれにするか。 他社・他の物件と比べる: 他の不動産会社・自分で見つけた物件と比較。",
  "  - 家族・同居人に相談: 親・パートナー・同居人と相談してから。 費用で迷う: 初期費用・家賃が決め手で迷う。",
  "  - 時期・入居日で迷う: 入居の時期・退去の都合で今決めきれない。 内覧してから決めたい: 実物を見てから。",
  "  - 審査・手続きの見通し待ち: 審査が通るか・勤務先・書類の目処が立ってから。 決め手が無い・ピンと来ない: どれもいまいち。 急がない・しばらく保留: 今は動かない。",
  "  object: 迷いの対象・理由をお客様の言葉で15字まで。",
  "② response（1〜2つ・スタッフの返信の文から）: " + HES_RESPONSES.join(" / "),
  "  - 扉を開けて待つ: 『ごゆっくりご検討ください』『いつでもご連絡ください』等で押さずに締める。 内覧の誘い: ご内覧・ご案内を勧める。 申込・抑える誘い: お申込みでお部屋を抑える提案。",
  "  - 比較の手伝い: 物件同士の違い・良し悪しを説明。 1件を推す: 特に〇〇がオススメと1件を推す。 迷いの点に答える: 迷っている点（費用・設備・時期）に答えて解消する。",
  "  - スタッフの文が無い（AIX だけ）なら AIX（物件・見積書 等）。",
  "  pressure: 押しの強さ 弱|中|強。",
  '出力は JSON だけ: {"items":[{"i":1,"kind":"…","kind2":null,"object":"…","response":["…"],"pressure":"弱"}]}',
].join("\n");
type HLabel = { kind: string; kind2: string | null; object: string; response: string[]; pressure: string };
async function hesitation() {
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const L: Record<string, Label> = JSON.parse(fs.readFileSync(LABEL_FILE, "utf8"));
  const tgt = turns.filter((t) => L[t.id] && (L[t.id].primary === "迷い・比較中" || L[t.id].secondary.includes("迷い・比較中") || t.scene === "considering"));
  const H: Record<string, HLabel> = fs.existsSync(HLABEL_FILE) ? JSON.parse(fs.readFileSync(HLABEL_FILE, "utf8")) : {};
  const todo = tgt.filter((t) => !H[t.id]);
  if (todo.length) {
    if (process.env.LLM_TEST_MODE !== "deepseek-all") throw new Error("ラベルが要るので LLM_TEST_MODE=deepseek-all を付けて流す");
    const maxUsd = Number(arg("max-usd", "1.5"));
    const chunks: Turn[][] = []; for (let i = 0; i < todo.length; i += 5) chunks.push(todo.slice(i, i + 5));
    for (let c = 0; c < chunks.length; c += 6) {
      if (cost.usd > maxUsd) { console.log("費用の上限で止める"); break; }
      await Promise.all(chunks.slice(c, c + 6).map(async (ch) => {
        const user = ch.map((t, i) => `### ${i + 1}\n【直前のこちらの送信】\n${t.prevStaff.join("\n―\n") || "（なし）"}\n【お客様の今の連投】\n${t.customer}\n【スタッフの返信】\n${t.firstIsAix && !t.reply ? `（AIX: ${t.aixType}）` : (t.reply ? maskExamText(t.reply, null, addressNamesOf([t.reply])).slice(0, 400) : "（なし）")}`).join("\n\n");
        const o = await deepseekJson(user, HES_SYS);
        const arr = Array.isArray(o?.items) ? (o!.items as Array<Record<string, unknown>>) : [];
        for (const it of arr) {
          const t = ch[Number(it.i) - 1]; if (!t) continue;
          const k = String(it.kind ?? "その他");
          H[t.id] = { kind: (HES_KINDS as readonly string[]).includes(k) ? k : "その他", kind2: it.kind2 && (HES_KINDS as readonly string[]).includes(String(it.kind2)) ? String(it.kind2) : null, object: String(it.object ?? "").slice(0, 20), response: Array.isArray(it.response) ? (it.response as string[]).filter((r) => (HES_RESPONSES as readonly string[]).includes(r)).slice(0, 2) : [], pressure: String(it.pressure ?? "") };
        }
      }));
      fs.writeFileSync(HLABEL_FILE, JSON.stringify(H));
    }
    console.log(`DeepSeek ${cost.calls} 回・$${cost.usd.toFixed(3)}・失敗 ${cost.fail}`);
  }
  const xs = tgt.filter((t) => H[t.id]);
  const obs = xs.filter((t) => t.observable);
  const out = (ts: Turn[]) => `内覧14日 ${pct(ts.filter((t) => t.viewing14).length, ts.length)}・申込30日 ${pct(ts.filter((t) => t.applied30).length, ts.length)}・返事 ${pct(ts.filter((t) => t.nextReplyH != null).length, ts.length)}`;
  const top = (a: string[], k = 3) => { const m = new Map<string, number>(); for (const x of a) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((p, q) => q[1] - p[1]).slice(0, k).map(([x, n]) => `${x} ${pct(n, a.length)}`).join("・"); };
  // 決まった計算の返し方（replyShape）とも並べる＝前回の「扉 60% 対 内覧の誘い 0%」と同じ物差し
  const detMove = (t: Turn) => { if (t.firstIsAix) return "AIX"; const r = t.reply ? replyShape(t.reply) : null; return !r ? "?" : r.appealApply ? "申込・抑える誘い" : r.appealViewing ? "内覧の誘い" : r.promise ? `約束(${r.promise})` : r.considerDoor ? "扉" : r.chars <= 60 ? "短い受け" : "答え・説明"; };
  console.log(`\n=== 迷い・検討中の番 ${xs.length}（${DAYS}日・竹内さんの番・観測できる番 ${obs.length}）・全体 ${out(obs)} ===`);
  console.log(`主の状態: ${top(xs.map((t) => L[t.id].primary), 5)}`);
  const by = new Map<string, Turn[]>(); for (const t of xs) (by.get(H[t.id].kind) ?? by.set(H[t.id].kind, []).get(H[t.id].kind)!).push(t);
  for (const [k, ts] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const o = ts.filter((t) => t.observable);
    console.log(`\n■ ${k}（${ts.length}${ts.length < 10 ? "・弱い参考" : ""}）: ${out(o)}`);
    console.log(`  返し方（DeepSeek）: ${top(ts.flatMap((t) => H[t.id].response.length ? H[t.id].response : ["なし"]), 5)}`);
    console.log(`  返し方（決まった計算）: ${top(ts.map(detMove), 4)}・押し ${top(ts.map((t) => H[t.id].pressure), 3)}`);
    const rg = new Map<string, Turn[]>(); for (const t of o) for (const r of (H[t.id].response.length ? H[t.id].response : ["なし"])) (rg.get(r) ?? rg.set(r, []).get(r)!).push(t);
    for (const [r, rs] of [...rg.entries()].sort((a, b) => b[1].length - a[1].length)) if (rs.length >= 3) console.log(`    → ${r}(${rs.length}${rs.length < 10 ? "・弱い" : ""}): ${out(rs)}`);
    console.log(`  例: ${ts.slice(0, 3).map((t) => `「${H[t.id].object}」`).join(" ")}`);
  }
  // 扉 vs 内覧の誘い が細分のどこで起きているか（前回の物差し＝主の状態が迷い・比較中・決まった計算）
  console.log("\n=== 扉 と 内覧の誘い（決まった計算・観測できる番）を細分ごとに ===");
  for (const mv of ["扉", "内覧の誘い", "申込・抑える誘い"]) {
    const ms = obs.filter((t) => detMove(t) === mv);
    console.log(`${mv}(${ms.length}): ${out(ms)}`);
    const g = new Map<string, Turn[]>(); for (const t of ms) (g.get(H[t.id].kind) ?? g.set(H[t.id].kind, []).get(H[t.id].kind)!).push(t);
    for (const [k, ks] of [...g.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`   ${k}(${ks.length}): ${out(ks)}`);
  }
  const SHOWK = arg("show", "");
  if (SHOWK) for (const t of xs.filter((t) => H[t.id].kind === SHOWK).slice(0, Number(arg("n", "8")))) console.log(`\n[${t.id}] ${detMove(t)} 内覧${t.viewing14 ? "○" : "×"} 申込${t.applied30 ? "○" : "×"}\n 客: ${t.customer.slice(0, 160).replace(/\n/g, " ")}\n 竹内: ${(t.reply ?? `AIX:${t.aixType}`).slice(0, 160).replace(/\n/g, " ")}`);
}

// ── blocker: 「あと1点で決まる」（決め手の残り）（2026-10-09 竹内さん）────────────────
//   竹内「建物の実際の中が良ければ決まる・設備面に問題無ければ決まる・駐車場の空きがあれば決まる・初期費用が希望以内なら決まる 等」
//   全番に DeepSeek で: その物件はあと何が解ければ決まりそうか（無ければ none）・どの物件か・引用／竹内さんがその1点をどう解いたか
export const BLOCKERS = ["室内・実物", "設備・広さ", "駐車場・駐輪場", "初期費用", "家賃", "審査", "入居日・時期", "立地・周辺・治安", "同居人・家族の同意", "空き・募集状況", "ペット・条件の可否", "その他"] as const;
export const RESOLVES = ["室内写真・動画を送る（撮影）", "内覧に誘う・内覧調整", "設備・条件を確認する（管理会社）", "空き・駐車場を確認する", "見積書を送る", "代表に割引を確認", "その場で答える（会話・資料・会社の事実）", "抑えて（申込して）から確認・内覧", "審査の見通しを説明・支える", "別の物件を探す", "待つ（扉を開ける）", "その他"] as const;
const BLK_SYS = [
  "あなたは大阪の賃貸仲介の LINE 接客を読む係です。お客様が特定の物件について『あと1点が解ければ決まる（申込する）』状態かを読みます。",
  "条件: お客様がその物件に前向き（気に入っている・候補にしている）で、残っている気がかりが1〜2点ある時だけ blocker を付ける。物件にまだ興味を示していない・ただの質問・条件の提示は none。",
  "blocker（1つ・無ければ null）: " + BLOCKERS.join(" / "),
  "  property: どの物件か（会話に出た名前・号室。分からなければ null）。 quote: お客様の言葉（25字まで）。 sure: 確か|推測。",
  "resolve（スタッフの返信・AIX から、その1点をどう解いたか・1〜2つ・blocker が null なら []）: " + RESOLVES.join(" / "),
  '出力は JSON だけ: {"items":[{"i":1,"blocker":null,"property":null,"quote":"","sure":"確か","resolve":[]}]}',
].join("\n");
type BLabel = { blocker: string | null; property: string | null; quote: string; sure: string; resolve: string[] };
async function blocker() {
  const BFILE = path.join(OUT, `cstate-labels-blocker${sfx}.json`);
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const L: Record<string, Label> = JSON.parse(fs.readFileSync(LABEL_FILE, "utf8"));
  const B: Record<string, BLabel> = fs.existsSync(BFILE) ? JSON.parse(fs.readFileSync(BFILE, "utf8")) : {};
  const todo = turns.filter((t) => !B[t.id]);
  if (todo.length) {
    if (process.env.LLM_TEST_MODE !== "deepseek-all") throw new Error("ラベルが要るので LLM_TEST_MODE=deepseek-all を付けて流す");
    const maxUsd = Number(arg("max-usd", "1.0"));
    const chunks: Turn[][] = []; for (let i = 0; i < todo.length; i += 6) chunks.push(todo.slice(i, i + 6));
    for (let c = 0; c < chunks.length; c += 6) {
      if (cost.usd > maxUsd) { console.log("費用の上限で止める"); break; }
      await Promise.all(chunks.slice(c, c + 6).map(async (ch) => {
        const user = ch.map((t, i) => `### ${i + 1}\n【直前のこちらの送信】\n${t.prevStaff.join("\n―\n") || "（なし）"}\n【お客様の今の連投】\n${t.customer}\n【スタッフの次の一手】\n${t.anyAix ? `AIX: ${t.aixType ?? "?"}${t.checkPattern ? `（${t.checkPattern}）` : ""}\n` : ""}${t.reply ? maskExamText(t.reply, null, addressNamesOf([t.reply])).slice(0, 350) : ""}`).join("\n\n");
        const o = await deepseekJson(user, BLK_SYS);
        const arr = Array.isArray(o?.items) ? (o!.items as Array<Record<string, unknown>>) : [];
        for (const it of arr) {
          const t = ch[Number(it.i) - 1]; if (!t) continue;
          const b = it.blocker ? String(it.blocker) : null;
          B[t.id] = { blocker: b && (BLOCKERS as readonly string[]).includes(b) ? b : b ? "その他" : null, property: it.property ? String(it.property).slice(0, 30) : null, quote: String(it.quote ?? "").slice(0, 30), sure: String(it.sure ?? ""), resolve: Array.isArray(it.resolve) ? (it.resolve as string[]).filter((r) => (RESOLVES as readonly string[]).includes(r)).slice(0, 2) : [] };
        }
      }));
      fs.writeFileSync(BFILE, JSON.stringify(B));
      process.stdout.write(`\r  ${Math.min(c + 6, chunks.length)}/${chunks.length}・$${cost.usd.toFixed(3)}`);
    }
    console.log(`\nDeepSeek ${cost.calls} 回・$${cost.usd.toFixed(3)}・失敗 ${cost.fail}`);
  }
  const xs = turns.filter((t) => B[t.id]);
  const bl = xs.filter((t) => B[t.id].blocker);
  const out = (ts: Turn[]) => { const o = ts.filter((t) => t.observable); return `申込30日 ${pct(o.filter((t) => t.applied30).length, o.length)}・内覧14日 ${pct(o.filter((t) => t.viewing14).length, o.length)}（${o.length}）`; };
  const convs = (ts: Turn[]) => new Set(ts.map((t) => t.cid)).size;
  const top = (a: string[], k = 4) => { const m = new Map<string, number>(); for (const x of a) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((p, q) => q[1] - p[1]).slice(0, k).map(([x, n]) => `${x} ${pct(n, a.length)}`).join("・"); };
  console.log(`\n=== あと1点で決まる（${DAYS}日・竹内さんの番 ${xs.length}）===`);
  console.log(`読める番 ${bl.length}（${pct(bl.length, xs.length)}・会話 ${convs(bl)}・確か ${bl.filter((t) => B[t.id].sure === "確か").length}・物件が分かる ${bl.filter((t) => B[t.id].property).length}）: ${out(bl)} ／ 読めない番: ${out(xs.filter((t) => !B[t.id].blocker))}`);
  const by = new Map<string, Turn[]>(); for (const t of bl) (by.get(B[t.id].blocker!) ?? by.set(B[t.id].blocker!, []).get(B[t.id].blocker!)!).push(t);
  for (const [k, ts] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n■ ${k}（${ts.length}・会話 ${convs(ts)}${ts.length < 10 ? "・弱い参考" : ""}）: ${out(ts)}・状態 ${top(ts.map((t) => L[t.id]?.primary ?? "?"), 3)}`);
    console.log(`  竹内さんの解き方: ${top(ts.flatMap((t) => B[t.id].resolve.length ? B[t.id].resolve : ["（なし）"]), 5)}`);
    console.log(`  実際の一手: ${top(ts.map((t) => t.anyAix ? `AIX:${t.aixType}${t.checkPattern ? `/${t.checkPattern}` : ""}` : "返信"), 4)}`);
    const rg = new Map<string, Turn[]>(); for (const t of ts) for (const r of (B[t.id].resolve.length ? B[t.id].resolve : ["（なし）"])) (rg.get(r) ?? rg.set(r, []).get(r)!).push(t);
    for (const [r, rs] of [...rg.entries()].sort((a, b) => b[1].length - a[1].length)) if (rs.length >= 3) console.log(`    → ${r}(${rs.length}・会話 ${convs(rs)}): ${out(rs)}`);
    console.log(`  例: ${ts.slice(0, 4).map((t) => `「${B[t.id].quote}」`).join(" ")}`);
  }
  // ブレインが同じ番に出した AIX（記録がある番だけ）
  const withBrain = bl.filter((t) => t.brainAction);
  console.log(`\nブレインの記録がある番 ${withBrain.length}: 竹内さんの AIX の種類と一致 ${pct(withBrain.filter((t) => t.brainMatched).length, withBrain.filter((t) => t.brainMatched != null).length)}・ブレインの一手 ${top(withBrain.map((t) => t.brainAction ?? "なし"), 5)}`);
}

// ── confirm: 「確認して問題無ければ決まる」（2026-10-09 竹内さん）──────────────────
//   ① お客様の「〇〇なら決める・申込する」（条件つきの決める）の言い方を全会話で数え、その後の申込30日
//   ② AIX【物件確認した】【確認した】の実送信（竹内さん）で、結果が問題無しの時に同じ文で申込・抑える提案につないだか・次の一手・申込30日
//   LLM なし（決まった計算）
export const CONDITIONAL_DECIDE_RE = /(?:なら|れば|たら|だったら|でしたら|であれば)[^。\n？?]{0,16}(?:決め|申し?込|契約|ここに(?:し|決)|即決|進め(?:たい|ます)|お願いしたい(?:です)?$)|(?:確認|確かめ)[^。\n]{0,10}(?:問題(?:な|無)|大丈夫)[^。\n]{0,10}(?:決め|申し?込|進め)|(?:決め(?:たい|ます)|申し?込(?:みたい|みます))[^。\n]{0,6}(?:けど|が)[^。\n]{0,20}(?:確認|気になる|だけ)/;
const NEG_RESULT_RE = /募集終了|申込(?:み)?が入|ご紹介出来|不可(?:となり|でし)|出来かね|難しい(?:状況|との事)|2番手|二番手|満車|空きがな/;
async function confirm() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const pre = new Date(Date.now() - (DAYS + 30) * 86_400_000).toISOString();
  const msgs = await all<M>((i) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer, line_message_id").gte("created_at", pre).order("created_at").order("id").range(i, i + 999));
  const convs = await all<{ id: string; line_source_type: string | null }>((i) => sb.from("conversations").select("id, line_source_type").range(i, i + 999));
  const grp = new Set(convs.filter((c) => c.line_source_type === "group").map((c) => c.id));
  const outs = await all<{ conversation_id: string; applied_at: string | null }>((i) => sb.from("deal_outcomes").select("conversation_id, applied_at").not("applied_at", "is", null).range(i, i + 999));
  const apBy = new Map<string, number[]>(); for (const o of outs) (apBy.get(o.conversation_id) ?? apBy.set(o.conversation_id, []).get(o.conversation_id)!).push(Date.parse(o.applied_at!));
  const aix = await all<{ conversation_id: string; aix_type: string | null; check_pattern: string | null; sent_at: string | null; generated_text: string | null }>((i) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at, generated_text").gte("sent_at", since).not("sent_at", "is", null).range(i, i + 999));
  const by = new Map<string, M[]>(); for (const m of msgs) { if (isTestConversation(m.conversation_id) || grp.has(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const applied30 = (cid: string, t: number) => (apBy.get(cid) ?? []).some((a) => a > t && a - t <= 30 * 86_400_000);
  const appliedBefore = (cid: string, t: number) => (apBy.get(cid) ?? []).some((a) => a <= t);
  const observable = (t: number) => Date.now() - t > 7 * 86_400_000;

  // ① 条件つきの決める
  const cd: Array<{ cid: string; at: number; text: string }> = [];
  for (const [cid, list] of by) for (const m of list) {
    const at = Date.parse(m.created_at);
    if (m.sender !== "customer" || at < Date.parse(since) || appliedBefore(cid, at) || applicationMaterialReason(m.text) || piiValueSignal(m.text)) continue;
    if (CONDITIONAL_DECIDE_RE.test(m.text ?? "")) cd.push({ cid, at, text: m.text ?? "" });
  }
  const cdo = cd.filter((x) => observable(x.at));
  const baseCust = [...by.entries()].flatMap(([cid, l]) => l.filter((m) => m.sender === "customer" && Date.parse(m.created_at) >= Date.parse(since) && observable(Date.parse(m.created_at)) && !appliedBefore(cid, Date.parse(m.created_at))).map((m) => ({ cid, at: Date.parse(m.created_at) })));
  console.log(`\n=== ① 「〇〇なら決める・確認して問題無ければ決める」の言い方（${DAYS}日・全スタッフの会話・申込より前）===`);
  console.log(`通 ${cd.length}（会話 ${new Set(cd.map((x) => x.cid)).size}）: 申込30日 ${pct(cdo.filter((x) => applied30(x.cid, x.at)).length, cdo.length)}（${cdo.length}）／ お客様の通全体: ${pct(baseCust.filter((x) => applied30(x.cid, x.at)).length, baseCust.length)}（${baseCust.length}）`);
  for (const x of cd.slice(0, 20)) console.log(`  ${applied30(x.cid, x.at) ? "申込○" : "申込×"} ${maskExamText(x.text, null, []).replace(/\n/g, " ").match(CONDITIONAL_DECIDE_RE)?.[0]} ｜ ${maskExamText(x.text, null, []).replace(/\n/g, " ").slice(0, 90)}`);

  // ② 確認の AIX の結果 → 次の一手 → 申込
  type Row = { cid: string; at: number; type: string; pat: string | null; text: string; result: "問題無し" | "問題あり"; appeal: "申込・抑える" | "内覧" | "なし"; nextCust: boolean; nextStaffApply: boolean; nextAix: string | null; applied: boolean; obs: boolean; conditional: boolean; writer: string | null };
  const rows: Row[] = [];
  for (const a of aix) {
    if (a.aix_type !== "property_check_result" && a.aix_type !== "acknowledge_check") continue;
    const list = by.get(a.conversation_id); if (!list) continue;
    const at = Date.parse(a.sent_at!);
    if (appliedBefore(a.conversation_id, at)) continue;
    const sent = list.filter((m) => m.is_aix_generated && Math.abs(Date.parse(m.created_at) - at) <= 3 * 60_000);
    const text = sent.map((m) => m.text ?? "").join("\n") || a.generated_text || "";
    const ap = detectAppeal(text);
    const after = list.filter((m) => Date.parse(m.created_at) > at + 3 * 60_000 && Date.parse(m.created_at) - at <= 7 * 86_400_000);
    const nc = after.find((m) => m.sender === "customer");
    const afterCust = nc ? after.filter((m) => m.sender !== "customer" && Date.parse(m.created_at) > Date.parse(nc.created_at)) : [];
    const nextAix = aix.filter((b) => b.conversation_id === a.conversation_id && Date.parse(b.sent_at!) > at + 3 * 60_000 && Date.parse(b.sent_at!) - at <= 7 * 86_400_000).sort((x, y) => Date.parse(x.sent_at!) - Date.parse(y.sent_at!))[0];
    const prevCust = list.filter((m) => m.sender === "customer" && Date.parse(m.created_at) < at && at - Date.parse(m.created_at) <= 14 * 86_400_000);
    rows.push({
      cid: a.conversation_id, at, type: a.aix_type, pat: a.check_pattern, text,
      result: NEG_RESULT_RE.test(text) || /unavailable|ended/.test(a.check_pattern ?? "") ? "問題あり" : "問題無し",
      appeal: ap.apply ? "申込・抑える" : ap.viewing ? "内覧" : "なし",
      nextCust: !!nc, nextStaffApply: afterCust.some((m) => detectAppeal(m.text).apply), nextAix: nextAix?.aix_type ?? null,
      applied: applied30(a.conversation_id, at), obs: observable(at), conditional: prevCust.some((m) => CONDITIONAL_DECIDE_RE.test(m.text ?? "")),
      writer: sent[0]?.staff_writer ?? null,
    });
  }
  const show = (rs: Row[]) => { const o = rs.filter((r) => r.obs); return `${rs.length}（会話 ${new Set(rs.map((r) => r.cid)).size}）申込30日 ${pct(o.filter((r) => r.applied).length, o.length)}（${o.length}）・返事 ${pct(rs.filter((r) => r.nextCust).length, rs.length)}`; };
  console.log(`\n=== ② 確認の AIX（物件確認した・確認した）の実送信 ${DAYS}日・申込より前 ===`);
  for (const w of ["takeuchi", "employee"]) {
    const ws = rows.filter((r) => r.writer === w);
    console.log(`\n[${w === "takeuchi" ? "竹内さん" : "従業員"}] ${show(ws)}`);
    for (const res of ["問題無し", "問題あり"] as const) {
      const rs = ws.filter((r) => r.result === res);
      console.log(`  結果 ${res}: ${show(rs)}・ピッカー ${(() => { const m = new Map<string, number>(); for (const r of rs) m.set(r.pat ?? r.type, (m.get(r.pat ?? r.type) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join("・"); })()}`);
      for (const ap of ["申込・抑える", "内覧", "なし"] as const) { const x = rs.filter((r) => r.appeal === ap); if (x.length) console.log(`    同じ文の締め=${ap}: ${show(x)}`); }
      const noAp = rs.filter((r) => r.appeal === "なし");
      console.log(`    締めなし→次の番でこちらが申込の誘い ${pct(noAp.filter((r) => r.nextStaffApply).length, noAp.length)}・次の AIX ${(() => { const m = new Map<string, number>(); for (const r of rs) m.set(r.nextAix ?? "なし", (m.get(r.nextAix ?? "なし") ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join("・"); })()}`);
    }
    const cond = ws.filter((r) => r.conditional);
    console.log(`  直前14日にお客様の「〇〇なら決める」があった確認: ${show(cond)}`);
  }
  const tk = rows.filter((r) => r.writer === "takeuchi" && r.result === "問題無し");
  console.log("\n竹内さん・問題無しの例（締めの1行）:");
  for (const r of tk.slice(0, 10)) console.log(`  [${r.appeal}|申込${r.applied ? "○" : "×"}] ${maskExamText(r.text, null, addressNamesOf([r.text])).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 110)}`);
}

// ── estimate: 見積書の後の締め（2026-10-09 竹内さん「見積書の文には内覧訴求や申込訴求を加え、次の方向を示しつつ待つ・未内覧で空室なら内覧訴求が主」）
//   AIX【見積書送る】の実送信（竹内さん・従業員）× お客様が見積を頼んだか × 内覧の前か → 同じ送信のまとまり（3分）の締め・申込30日（LLM なし）
async function estimate() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const pre = new Date(Date.now() - (DAYS + 30) * 86_400_000).toISOString();
  const msgs = await all<M>((i) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer, line_message_id").gte("created_at", pre).order("created_at").order("id").range(i, i + 999));
  const convs = await all<{ id: string; line_source_type: string | null }>((i) => sb.from("conversations").select("id, line_source_type").range(i, i + 999));
  const grp = new Set(convs.filter((c) => c.line_source_type === "group").map((c) => c.id));
  const outs = await all<{ conversation_id: string; applied_at: string | null }>((i) => sb.from("deal_outcomes").select("conversation_id, applied_at").not("applied_at", "is", null).range(i, i + 999));
  const apBy = new Map<string, number[]>(); for (const o of outs) (apBy.get(o.conversation_id) ?? apBy.set(o.conversation_id, []).get(o.conversation_id)!).push(Date.parse(o.applied_at!));
  const aix = await all<{ conversation_id: string; aix_type: string | null; sent_at: string | null }>((i) => sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at").gte("sent_at", pre).not("sent_at", "is", null).range(i, i + 999));
  const by = new Map<string, M[]>(); for (const m of msgs) { if (isTestConversation(m.conversation_id) || grp.has(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const meetBy = new Map<string, number[]>(); for (const a of aix) if (a.aix_type === "meeting_place") (meetBy.get(a.conversation_id) ?? meetBy.set(a.conversation_id, []).get(a.conversation_id)!).push(Date.parse(a.sent_at!));
  const ASK_RE = /見積|初期費用|いくら|費用(?:は|を|って|が)?(?:教え|知り|どれ|どのくらい|どの位)|安く(?:なり|でき|いけ)/;
  type R = { cid: string; at: number; writer: string | null; asked: boolean; viewed: boolean; notViewable: boolean; closing: "申込" | "内覧" | "ご査収のみ"; applied: boolean; obs: boolean; line: string };
  const rows: R[] = [];
  for (const a of aix) {
    if (a.aix_type !== "estimate_sheet") continue;
    const at = Date.parse(a.sent_at!); if (at < Date.parse(since)) continue;
    const list = by.get(a.conversation_id); if (!list) continue;
    if ((apBy.get(a.conversation_id) ?? []).some((x) => x <= at)) continue;
    const grpMsgs = list.filter((m) => m.sender !== "customer" && Date.parse(m.created_at) >= at - 60_000 && Date.parse(m.created_at) <= at + 5 * 60_000);
    const txt = grpMsgs.map((m) => m.text ?? "").join("\n");
    const ap = detectAppeal(txt);
    const prevCust = list.filter((m) => m.sender === "customer" && Date.parse(m.created_at) < at && at - Date.parse(m.created_at) <= 3 * 86_400_000);
    rows.push({
      cid: a.conversation_id, at, writer: grpMsgs.find((m) => m.staff_writer)?.staff_writer ?? null,
      asked: prevCust.some((m) => ASK_RE.test(m.text ?? "")), viewed: (meetBy.get(a.conversation_id) ?? []).some((x) => x < at),
      notViewable: /退去予定|居住中|ご内覧(?:は)?[^。\n]{0,8}以[後降]|内覧不可/.test(txt),
      closing: ap.apply ? "申込" : ap.viewing ? "内覧" : "ご査収のみ",
      applied: (apBy.get(a.conversation_id) ?? []).some((x) => x > at && x - at <= 30 * 86_400_000), obs: Date.now() - at > 7 * 86_400_000,
      line: maskExamText(txt, null, addressNamesOf([txt])).split("\n").map((s) => s.trim()).filter((s) => /お気に召され|ご案内|お申込|抑え|ご査収|ご内覧/.test(s)).slice(-2).join(" ／ ").slice(0, 120),
    });
  }
  const show = (rs: R[]) => { const o = rs.filter((r) => r.obs); return `${rs.length}（会話 ${new Set(rs.map((r) => r.cid)).size}）申込30日 ${pct(o.filter((r) => r.applied).length, o.length)}（${o.length}）`; };
  console.log(`\n=== AIX【見積書送る】の締め（${DAYS}日・申込より前）===`);
  for (const w of ["takeuchi", "employee"]) for (const asked of [true, false]) for (const viewed of [false, true]) {
    const rs = rows.filter((r) => r.writer === w && r.asked === asked && r.viewed === viewed); if (!rs.length) continue;
    console.log(`\n[${w === "takeuchi" ? "竹内さん" : "従業員"}・お客様が見積を${asked ? "頼んだ" : "頼んでいない"}・内覧の${viewed ? "後" : "前"}] ${show(rs)}`);
    for (const c of ["内覧", "申込", "ご査収のみ"] as const) { const x = rs.filter((r) => r.closing === c); if (x.length) console.log(`   締め=${c}: ${pct(x.length, rs.length)}・${show(x)}・まだ見られない ${x.filter((r) => r.notViewable).length}`); }
  }
  const tk = rows.filter((r) => r.writer === "takeuchi" && r.asked && !r.viewed && r.closing !== "ご査収のみ");
  console.log("\n竹内さん・頼まれた見積・内覧の前・締めあり の例:"); for (const r of tk.slice(0, 12)) console.log(`  [${r.closing}|申込${r.applied ? "○" : "×"}] ${r.line}`);
}

// ── det-check: 決まった計算の読み（app/lib/customer-mindset.ts）を DeepSeek のラベルに当てる（LLM なし）
async function detCheck() {
  const { readDecideGapsInTurn, hesitationKindOf, decideSignalOf } = await import("../app/lib/customer-mindset");
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const B: Record<string, BLabel> = JSON.parse(fs.readFileSync(path.join(OUT, `cstate-labels-blocker${sfx}.json`), "utf8"));
  const L: Record<string, Label> = JSON.parse(fs.readFileSync(LABEL_FILE, "utf8"));
  const xs = turns.filter((t) => B[t.id]);
  const POINT_MAP: Record<string, string> = { "室内・実物": "室内・実物", "設備": "設備・広さ", "駐車場・駐輪場": "駐車場・駐輪場", "空き・募集状況": "空き・募集状況", "入居日・時期": "入居日・時期", "ペット・条件の可否": "ペット・条件の可否", "審査": "審査", "初期費用": "初期費用" };
  let tp = 0, fp = 0, fn = 0; const fps: string[] = [], fns: string[] = [];
  const strongRows: Turn[] = [];
  for (const t of xs) {
    const det = readDecideGapsInTurn({ text: t.customer });
    const lab = B[t.id].blocker;
    const detPts = det.map((g) => POINT_MAP[g.point] ?? g.point);
    if (decideSignalOf(det).strong) strongRows.push(t);
    if (lab && (POINT_MAP[lab] || ["室内・実物", "設備・広さ", "駐車場・駐輪場", "空き・募集状況", "入居日・時期", "ペット・条件の可否", "審査", "初期費用"].includes(lab))) {
      if (detPts.includes(lab)) tp++; else { fn++; if (fns.length < 15) fns.push(`${lab}｜${t.customer.replace(/\n/g, " ").slice(0, 70)}`); }
    }
    for (const p of detPts) if (p !== lab) { fp++; if (fps.length < 25) fps.push(`${p}（DS: ${lab ?? "なし"}）｜${t.customer.replace(/\n/g, " ").slice(0, 70)}`); }
  }
  console.log(`決め手の残り（a/b の点）: 当たり ${tp}・DeepSeek にあって読めない ${fn}・DeepSeek と違う/無い所で読んだ ${fp}`);
  console.log("-- 読んだが DeepSeek と違う（目で読む）--"); for (const s of fps) console.log("  " + s);
  console.log("-- 読めなかった --"); for (const s of fns) console.log("  " + s);
  const so = strongRows.filter((t) => t.observable);
  console.log(`\n★決める寸前の印（決まった計算）: ${strongRows.length} 番（会話 ${new Set(strongRows.map((t) => t.cid)).size}）申込30日 ${pct(so.filter((t) => t.applied30).length, so.length)}（${so.length}）／全体 ${pct(xs.filter((t) => t.observable && t.applied30).length, xs.filter((t) => t.observable).length)}`);
  for (const t of strongRows.slice(0, 12)) console.log(`  ${t.applied30 ? "申込○" : "申込×"} ${t.customer.replace(/\n/g, " ").slice(0, 80)}`);
  // 迷いの中身
  const H: Record<string, HLabel> = fs.existsSync(path.join(OUT, "cstate-labels-hesitation-d180.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "cstate-labels-hesitation-d180.json"), "utf8")) : {};
  const t180: Turn[] = fs.existsSync(path.join(OUT, "cstate-turns-d180.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "cstate-turns-d180.json"), "utf8")) : [];
  let hOk = 0, hN = 0, hNone = 0; const hBad: string[] = [];
  for (const t of t180.filter((t) => H[t.id])) { hN++; const k = hesitationKindOf(t.customer)?.kind ?? null; if (!k) { hNone++; continue; } if (k === H[t.id].kind || (H[t.id].kind2 && k === H[t.id].kind2) || (k === "決め手が無い" && H[t.id].kind === "決め手が無い・ピンと来ない") || (k === "設備・広さの1点で迷う" && H[t.id].kind === "設備・広さ・間取りの1点で迷う")) hOk++; else if (hBad.length < 20) hBad.push(`${k}（DS: ${H[t.id].kind}）｜${t.customer.replace(/\n/g, " ").slice(0, 70)}`); }
  console.log(`\n迷いの中身: DeepSeek のラベル ${hN} 番 → 決まった計算で読めた ${hN - hNone}・同じ ${hOk}`);
  for (const s of hBad) console.log("  " + s);
  // 迷いでない番で迷いを読んだ（60日・状態が迷いでない）
  const notHes = turns.filter((t) => L[t.id] && L[t.id].primary !== "迷い・比較中" && !L[t.id].secondary.includes("迷い・比較中") && hesitationKindOf(t.customer));
  console.log(`迷いでない番（60日）で迷いを読んだ: ${notHes.length}/${turns.filter((t) => L[t.id] && L[t.id].primary !== "迷い・比較中").length}`);
  for (const t of notHes.slice(0, 12)) console.log(`  ${hesitationKindOf(t.customer)?.kind}（状態 ${L[t.id].primary}）｜${t.customer.replace(/\n/g, " ").slice(0, 70)}`);
}

// ── move-table: 状態（12種に写す）× 一手 → 反応の表を app/lib/mindset-move-table-data.ts に書く（--write）。LLM なし
export const STATE_TO_MINDSET: Record<string, string> = {
  "刺さっている": "刺さっている", "興味が薄い": "興味が薄い", "急いでいる": "急いでいる", "審査の不安": "審査の不安", "先に取られる不安": "先に取られる不安",
  "抑えたい・申込したい": "抑えたい", "費用を抑えたい": "安くしたい", "内覧したいが時間が無い": "時間が無い", "内覧したい": "内覧したい", "迷い・比較中": "迷い",
  "不満・苛立ち": "不満・離れかけ", "離れかけ・断り": "不満・離れかけ",
};
async function moveTable() {
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const L: Record<string, Label> = JSON.parse(fs.readFileSync(LABEL_FILE, "utf8"));
  const moveOf = (t: Turn): string => {
    if (t.firstIsAix) {
      const a = t.aixType ?? "?";
      return a === "estimate_sheet" ? "AIX【見積書送る】" : a === "viewing_invite" ? "AIX【内覧調整】" : a === "meeting_place" ? "AIX【待ち合わせ場所】" : a === "application_push" ? "AIX【申込へ】"
        : a === "property_send" ? "AIX【物件ピックアップした】" : a === "property_recommendation" ? "AIX【物件オススメ】" : a === "property_check_result" ? "AIX【物件確認した】" : a === "acknowledge_check" ? "AIX【確認した】" : `AIX:${a}`;
    }
    const r = t.reply ? replyShape(t.reply) : null;
    if (!r) return "返信";
    return r.appealApply ? "返信: 申込・抑える提案" : r.appealViewing ? "返信: 内覧の誘い" : r.promise ? `返信: ${r.promise}の約束` : r.considerDoor ? "返信: 押さずに扉を開けて待つ" : r.chars <= 60 ? "返信: 短い受け" : "返信: 答え・説明";
  };
  const obs = turns.filter((t) => L[t.id] && t.observable);
  const cells = new Map<string, Turn[]>();
  for (const t of obs) { const st = STATE_TO_MINDSET[L[t.id].primary] ?? "普通の依頼"; const k = `${st}\t${moveOf(t)}`; (cells.get(k) ?? cells.set(k, []).get(k)!).push(t); }
  const out = [...cells.entries()].map(([k, ts]) => { const [state, move] = k.split("\t"); const r = (f: (t: Turn) => boolean) => Math.round((ts.filter(f).length / ts.length) * 1000) / 1000; return { state, move, n: ts.length, convs: new Set(ts.map((t) => t.cid)).size, reply: r((t) => t.nextReplyH != null), view14: r((t) => t.viewing14), apply30: r((t) => t.applied30) }; })
    .filter((c) => c.n >= 5).sort((a, b) => a.state.localeCompare(b.state) || b.n - a.n);
  for (const c of out) console.log(`${c.state} | ${c.move} | ${c.n}（${c.convs}会話）| 返事 ${Math.round(c.reply * 100)}% | 内覧 ${Math.round(c.view14 * 100)}% | 申込 ${Math.round(c.apply30 * 100)}%`);
  if (process.argv.includes("--write")) {
    const file = path.join(__dirname, "..", "app", "lib", "mindset-move-table-data.ts");
    const body = `// app/lib/mindset-move-table-data.ts — scripts/audit-customer-mindset.ts --phase=move-table --write が書く（手で直さない）\n// 竹内さんの番・観測できる番 ${obs.length}・5番以上のマス（ブレインに渡すのは mindset-move-table.MOVE_TABLE_MIN_N 以上）\nimport type { MoveCell } from "./mindset-move-table";\nexport const MINDSET_MOVE_TABLE_META = { days: ${DAYS}, builtAt: "${new Date().toISOString().slice(0, 10)}", turns: ${obs.length} };\nexport const MINDSET_MOVE_TABLE_DATA: MoveCell[] = ${JSON.stringify(out, null, 0).replace(/\},\{/g, "},\n  {")};\n`;
    fs.writeFileSync(file, body);
    console.log(`→ ${file}`);
  }
}

// ── optional-lines: 竹内さんが入れたり入れなかったりする1行は、何で決まっているか（2026-10-09 竹内さん・LLM なし・$0）
//   対象: 180日の竹内さんの番（--tag=d180）のうち、最初の手打ちの返信がある番。状態は DeepSeek のラベル（既にある物）を 12種に写す
//   比べ方: 自分を除いた多数派で当てる（セルが5番未満なら粗い方へ下がる）。今の物差し＝sent-shape の「返信の中身の種類」（classifySentKind）・場面
async function optionalLines() {
  const { classifySentKind } = await import("../app/lib/sent-shape");
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const L: Record<string, Label> = JSON.parse(fs.readFileSync(LABEL_FILE, "utf8"));
  const H: Record<string, HLabel> = fs.existsSync(HLABEL_FILE) ? JSON.parse(fs.readFileSync(HLABEL_FILE, "utf8")) : {};
  const BF = path.join(OUT, "cstate-labels-blocker.json");
  const B: Record<string, BLabel> = fs.existsSync(BF) ? JSON.parse(fs.readFileSync(BF, "utf8")) : {};
  const xs = turns.filter((t) => L[t.id] && !t.firstIsAix && t.reply);
  // その日最初か: 会話ごとの送信の時刻を読む（読むだけ）
  const cids = [...new Set(xs.map((t) => t.cid))];
  const staffAt = new Map<string, number[]>();
  for (let i = 0; i < cids.length; i += 40) {
    const { data } = await sb.from("messages").select("conversation_id, created_at, sender").in("conversation_id", cids.slice(i, i + 40)).neq("sender", "customer").gte("created_at", new Date(Date.now() - (DAYS + 30) * 86_400_000).toISOString()).limit(20000);
    for (const m of (data ?? []) as Array<{ conversation_id: string; created_at: string }>) (staffAt.get(m.conversation_id) ?? staffAt.set(m.conversation_id, []).get(m.conversation_id)!).push(Date.parse(m.created_at));
  }
  const jday = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  const LINES: Array<[string, RegExp]> = [
    ["何卒", /何卒(?:よろしく|宜しく)/],
    ["扉（気になる点…ご連絡）", /気になる(?:点|事)[^\n。]{0,16}(?:ございましたら|出てきましたら|ありましたら|あれば)|ご不明(?:点|な点)[^\n。]{0,10}(?:ございましたら|ありましたら)/],
    ["内覧の誘い", /__VIEW__/],
    ["申込・抑える提案", /__APPLY__/],
    ["全力でサポート", /全力で(?:サポート|お部屋探し|探させ)|最善のサポート/],
    ["安心の一文", /ご安心|安心して|サポートさせて(?:頂|いただ)きます/],
    ["お気軽に", /お気軽に/],
    ["ご査収", /ご査収/],
  ];
  const has = (t: Turn, k: number) => { const r = t.reply!; if (LINES[k][0] === "内覧の誘い") return detectAppeal(r).viewing; if (LINES[k][0] === "申込・抑える提案") return detectAppeal(r).apply; return LINES[k][1].test(r); };
  const prevKind = (t: Turn) => { const p = t.prevStaff[t.prevStaff.length - 1] ?? ""; return /御見積書|お見積書|初期費用[：:]/.test(p) ? "見積書" : /🌟|ピックアップさせて|オススメ/.test(p) ? "物件" : /募集中|確認(?:しました|させて頂きました)ところ|管理会社に確認/.test(p) ? "確認の結果" : /待ち合わせ|ご案内|ご内覧/.test(p) ? "内覧" : p ? "その他" : "なし"; };
  type F = Record<string, string>;
  const feat = new Map<string, F>();
  for (const t of xs) {
    const sh = replyShape(t.reply!);
    const st = STATE_TO_MINDSET[L[t.id].primary] ?? "普通の依頼";
    const at = staffAt.get(t.cid) ?? [];
    const custMs = Date.parse(t.at);
    const firstOfDay = !at.some((x) => x < custMs && jday(x) === jday(custMs + 60_000));
    feat.set(t.id, {
      kind: classifySentKind(t.reply!), scene: t.scene, state: st,
      anx: L[t.id].anxiety ? `${L[t.id].anxiety!.target}:${L[t.id].anxiety!.direction}` : "-",
      hes: H[t.id]?.kind ?? "-", blk: B[t.id]?.blocker ?? "-", prev: prevKind(t), first: firstOfDay ? "その日最初" : "続き",
      sent: sh.sentences <= 2 ? "1-2文" : sh.sentences <= 4 ? "3-4文" : "5文以上", promise: sh.promise ?? "-", aixAfter: t.anyAix ? "AIXも" : "-",
      // 10/09 何卒の追加の物差し: 時間帯・距離感（こちらの送信の数・最初の送信からの日数）・直前のこちらの文の長さ・お客様の文の長さ
      hour: ((h) => h < 12 ? "朝" : h < 17 ? "昼" : h < 20 ? "夕" : "夜")(new Date(custMs + 9 * 3600_000).getUTCHours()),
      ex: ((n) => n <= 3 ? "送信0-3" : n <= 15 ? "送信4-15" : n <= 40 ? "送信16-40" : "送信41+")(at.filter((x) => x < custMs).length),
      days: ((d) => d < 1 ? "0日" : d < 7 ? "1-6日" : d < 30 ? "7-29日" : "30日+")(at.length ? (custMs - Math.min(...at)) / 86_400_000 : 0),
      prevLen: ((n) => n === 0 ? "なし" : n <= 60 ? "前60字以下" : n <= 150 ? "前61-150字" : "前151字+")((t.prevStaff[t.prevStaff.length - 1] ?? "").length),
      custLen: ((n) => n <= 20 ? "客20字以下" : n <= 80 ? "客21-80字" : "客81字+")(t.customer.length),
    });
  }
  const keyOf = (f: F, ks: string[]) => ks.map((k) => f[k]).join("|");
  const SETS: Array<[string, string[][]]> = [
    ["今の物差し: 返信の中身の種類（sent-shape）", [["kind"]]],
    ["場面", [["scene"]]],
    ["場面×状態", [["scene", "state"], ["scene"]]],
    ["中身の種類×状態×その日最初", [["kind", "state", "first"], ["kind", "state"], ["kind"]]],
    ["中身の種類×文の数×その日最初", [["kind", "sent", "first"], ["kind", "sent"], ["kind"]]],
    ["状態×直前の送信×その日最初×文の数", [["state", "prev", "first", "sent"], ["state", "prev", "first"], ["state", "prev"], ["state"]]],
    ["中身×状態×直前×最初×文の数", [["kind", "state", "prev", "first", "sent"], ["kind", "state", "first", "sent"], ["kind", "sent", "first"], ["kind"]]],
    ["中身×文の数×最初×距離感（送信の数）", [["kind", "sent", "first", "ex"], ["kind", "sent", "first"], ["kind"]]],
    ["中身×文の数×最初×時間帯", [["kind", "sent", "first", "hour"], ["kind", "sent", "first"], ["kind"]]],
    ["中身×文の数×最初×直前の長さ", [["kind", "sent", "first", "prevLen"], ["kind", "sent", "first"], ["kind"]]],
    ["文の数×最初×距離感×日数", [["sent", "first", "ex", "days"], ["sent", "first", "ex"], ["sent", "first"]]],
  ];
  const ids = xs.map((t) => t.id);
  console.log(`\n=== 任意の1行（竹内さんの手打ちの返信 ${ids.length} 番・${DAYS}日）: 自分を除いた多数派で当てる（セル5番未満は粗い方へ）===`);
  for (let k = 0; k < LINES.length; k++) {
    const y = new Map(xs.map((t) => [t.id, has(t, k)]));
    const pos = [...y.values()].filter(Boolean).length;
    console.log(`\n■ ${LINES[k][0]}: 入れた ${pos}/${ids.length}（${pct(pos, ids.length)}）・いつも入れない／入れるで当てる ${pct(Math.max(pos, ids.length - pos), ids.length)}`);
    for (const [name, levels] of SETS) {
      const counts = levels.map((ks) => { const m = new Map<string, [number, number]>(); for (const id of ids) { const c = keyOf(feat.get(id)!, ks); const v = m.get(c) ?? [0, 0]; v[y.get(id) ? 1 : 0]++; m.set(c, v); } return m; });
      let ok = 0, tp = 0, fp = 0, fn = 0;
      for (const id of ids) {
        const yi = y.get(id)!; let pred = pos * 2 > ids.length;
        for (let li = 0; li < levels.length; li++) { const v = counts[li].get(keyOf(feat.get(id)!, levels[li]))!; const n0 = v[0] - (yi ? 0 : 1), n1 = v[1] - (yi ? 1 : 0); if (n0 + n1 >= 5) { pred = n1 > n0; break; } }
        if (pred === yi) ok++; if (pred && yi) tp++; if (pred && !yi) fp++; if (!pred && yi) fn++;
      }
      console.log(`  ${name}: 当たり ${pct(ok, ids.length)}・入れる番の当たり（再現）${pct(tp, tp + fn)}・入れると当てた番の正しさ ${pct(tp, tp + fp)}`);
    }
    // 1つの物差しごとの率の幅（どの物差しで一番割れるか）
    const spread: string[] = [];
    for (const fk of ["kind", "scene", "state", "anx", "hes", "blk", "prev", "first", "sent", "promise", "aixAfter", "hour", "ex", "days", "prevLen", "custLen"]) {
      const m = new Map<string, [number, number]>(); for (const id of ids) { const c = feat.get(id)![fk]; const v = m.get(c) ?? [0, 0]; v[y.get(id) ? 1 : 0]++; m.set(c, v); }
      const cells = [...m.entries()].filter(([c, v]) => c !== "-" && v[0] + v[1] >= 10).map(([c, v]) => ({ c, n: v[0] + v[1], r: v[1] / (v[0] + v[1]) }));
      if (cells.length < 2) continue;
      cells.sort((a, b) => b.r - a.r);
      spread.push(`${fk}: ${cells.slice(0, 3).map((x) => `${x.c} ${Math.round(x.r * 100)}%(${x.n})`).join("・")} … ${cells.slice(-2).map((x) => `${x.c} ${Math.round(x.r * 100)}%(${x.n})`).join("・")}`);
    }
    for (const s of spread) console.log(`    ${s}`);
  }
}

const run = PHASE === "optional-lines" ? optionalLines : PHASE === "move-table" ? moveTable : PHASE === "det-check" ? detCheck : PHASE === "build" ? build : PHASE === "label" ? label : PHASE === "hesitation" ? hesitation : PHASE === "blocker" ? blocker : PHASE === "confirm" ? confirm : PHASE === "estimate" ? estimate : analyze;
if (require.main === module) run().catch((e) => { console.error(e); process.exitCode = 1; });

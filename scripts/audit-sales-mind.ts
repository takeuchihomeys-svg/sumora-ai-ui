// scripts/audit-sales-mind.ts — 営業マンの思考（空気感・状況の理解・次の一手とその理由）の差を型で数える（読むだけ・LLM なし）
//
// 2026-10-15 竹内さん（7番）「営業マン的思考の部分をブレイン強化していく。そうすれば空気感や状況理解力が改善されて100%により近くなる」
//   物差し＝竹内さんの実送信（messages.staff_writer=takeuchi）。条件の聞き取り・提案への反応・押し引き・迷い・急ぎ・比べている番だけ。
//   ① 竹内さんが下書きに足した／削った「営業の一手」を型に分ける（下書きのある番）
//   ② その一手がブレインの出力（reply_direction・closing_strategy・next_steps[0]・状態）に「あったのに文に届かない」か「ブレインに無い」かを分ける
//   ③ 自分で打った番（下書きなし）は、竹内さんが打った一手がブレインにあったかだけ数える
// 実行: npx tsx --env-file=.env.local scripts/audit-sales-mind.ts [--days=30] [--show=<型>] [--json=<file>]
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { hesitationKindOf } from "../app/lib/customer-mindset";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DAYS = Number(arg("days") ?? 30);
const SINCE_MS = arg("since") ? Date.parse(String(arg("since"))) : 0;

async function page<T>(fn: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await fn(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
type Msg = { id: string; sender: string; text: string; at: number; writer: string | null; aix: boolean };
type Digest = { at: number; dir: string; cs: string; step: string; ms: string; sig: string; la: string; hes: string };

const N = (s: string) => String(s ?? "").normalize("NFKC");
export function sentencesOf(s: string): string[] {
  const out: string[] = [];
  for (const line of N(s).split(/\n+/)) for (const p of line.split(/(?<=[!！]{2}|。|[!！](?=[^!！]))/u)) { const x = p.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").trim(); if (x.replace(/[!！。、\s]/g, "").length >= 3) out.push(x); }
  return out;
}

// ─── 営業の一手（文の型）───────────────────────────────────────────
export const MOVES: Record<string, RegExp> = {
  /** 申込・抑える（押す） */
  申込で抑える: /お申込|申込|お部屋(?:を)?(?:お?抑え|お?押さえ)|(?<!費用[^。！!]{0,8})(?:抑えさせ|押さえさせ)|先行/,
  /** 初期費用を抑える訴求（最大限割引） */
  初期費用の訴求: /最大限割引|初期費用[^。！!]{0,10}(?:抑え|割引)|費用面[^。！!]{0,10}(?:抑え|割引)/,
  /** 内覧の誘い */
  内覧の誘い: /内覧|ご案内(?:させ|出来|可能|致し)|見に行|お日にち|ご都合(?:の良い|宜しい|よろしい)/,
  /** 別の提案（他の物件・探す・新着） */
  別の提案: /他の(?:お部屋|物件)|ピックアップ|お探し(?:させ|致し|いたし)|新着|ご紹介(?:させ|出来|致し)|ご提案(?:させ|致し)|似た(?:お部屋|物件)/,
  /** 扉（押さずに待つ） */
  扉を開けて待つ: /お気軽に|いつでも|ご検討(?:頂|いただ|の程|下さ|くださ)|ごゆっくり|ご相談の上|お決まりになりましたら|ご連絡お待ち/,
  /** 安心の一文 */
  安心させる: /ご安心|審査[^。！!]{0,12}サポート|問題(?:ござい|御座い)ません|大丈夫(?:です|かと)/,
  /** 伴走の宣言（見つかるまで全力でサポート） */
  伴走の宣言: /見つかるまで|全力で|尽力/,
  /** 今すぐ探して送る（今の在庫からピックアップ） */
  今すぐ探して送る: /ピックアップ(?:して|し|させ)[^。！!]{0,10}お送り|ピックアップ(?:させて|致し|いたし)/,
  /** 新着を待って送る（出し切り・募集が出次第） */
  新着待ちで送る: /(?:募集|新着)[^。！!]{0,12}(?:出次第|出ましたら|出たら|出れば)|出次第お送り|随時(?:募集)?(?:確認|チェック)/,
  /** 急ぎ・人気の示唆（理由として） */
  急ぎ・埋まる: /人気|埋ま|お早め|早め|先に(?:お申込|申込)|お問い?合わせ(?:が)?(?:多|頂いて)|他の方/,
  /** 確認の約束 */
  確認の約束: /確認(?:させて|致し|いたし|して|し(?:ご連絡|次第|て)|出来次第)|お調べ|問い合わせ|問合せ/,
};
/** 次の一手に理由を添えた文（「〜ので／ため」＋押し・内覧・別の提案） */
const REASON_RE = /ので|ため|なので|から(?:、|です)|でしたら|であれば|なら/;
export function reasonedNext(s: string): boolean {
  return sentencesOf(s).some((x) => REASON_RE.test(x) && (MOVES.申込で抑える.test(x) || MOVES.内覧の誘い.test(x) || MOVES.別の提案.test(x)));
}
/** 一言目の受け止め（お客様の言葉・状態を受ける）の型 */
export function openerKind(s: string): string {
  const ss = sentencesOf(s).filter((x) => !/^[^。！!\s]{1,14}(?:さん|様)[、,]?$/.test(x) && !/お世話になっております/.test(x));
  const f = ss[0] ?? "";
  if (!f) return "なし";
  if (/そうなんですね|ですよね|なるほど|お気持ち|大変|不安|ご心配|嬉しい|良かった|よかった|楽しみ|素敵|お忙しい/.test(f)) return "共感・状態の受け";
  if (/かしこまりました|承知/.test(f)) return "了承";
  if (/^はい/.test(f)) return "はい";
  if (/ありがとうございます/.test(f)) return "お礼";
  if (/申し訳|すみません/.test(f)) return "お詫び";
  return "いきなり本題";
}

// ─── ブレインの出力に一手があるか ────────────────────────────────────
export const BRAIN_MOVES: Record<string, RegExp> = {
  申込で抑える: /申込|申し込|抑え|押さえ|仮押さえ|apply|application/,
  内覧の誘い: /内覧|内見|viewing/,
  初期費用の訴求: /割引|初期費用|見積|estimate/,
  別の提案: /他の(?:お部屋|物件)|ピックアップ|探す|探し|新着|別の物件|似た|代わり|代替|property_send|pickup|recommend/,
  扉を開けて待つ: /扉|待つ|押さず|押さない|急かさ|検討を待|ご検討|いつでも|お気軽/,
  安心させる: /安心|不安を(?:解|和ら|取)|支え|審査[^。]{0,10}サポート/,
  伴走の宣言: /全力|見つかるまで|尽力|zenryoku/,
  今すぐ探して送る: /ピックアップ|再検索|検索して|探して送|property_send|pickup/,
  新着待ちで送る: /新着|出次第|随時|出し切|募集に出|zenryoku/,
  急ぎ・埋まる: /人気|埋ま|早め|先に|急ぎ|急ぐ|他の方|今のうち/,
  確認の約束: /確認|問い合わせ|check/,
};
const brainText = (d: Digest | null) => (d ? [d.dir, d.cs, d.step, d.la].join(" ") : "");

// ─── 番を読む ──────────────────────────────────────────────────────
type Turn = { id: string; conv: string; at: number; draft: string; sent: string; customer: string; priorStaff: string[]; scene: string; kinds: string[]; brain: Digest | null; snapDir: string };

const PROPOSAL_RE = /🌟|号室|オススメ|おすすめ|ご紹介させて頂きました|お送りさせて頂きました|物件情報/;
function salesKinds(customer: string, priorStaff: string[], scene: string, ms: string): string[] {
  const k: string[] = [];
  const state = ms.split("|")[0] ?? "";
  const hes = hesitationKindOf(customer);
  if (scene === "conditions") k.push("条件の聞き取り");
  if (scene !== "ack" && priorStaff.slice(0, 2).some((p) => PROPOSAL_RE.test(p)) && scene !== "conditions") k.push("提案への反応");
  if (scene === "considering" || state === "迷い" || (hes && hes.kind !== "他社・他の物件と比べる")) k.push("迷い");
  if (state === "急いでいる" || /急ぎ|急いで|早め|すぐ(?:に)?(?:入|決|住)|今月中|今週中/.test(N(customer))) k.push("急ぎ");
  if (hes?.kind === "他社・他の物件と比べる" || hes?.kind === "複数物件で迷う" || /比較|比べ|どちら|どっち/.test(N(customer))) k.push("比べている");
  if (["抑えたい", "先に取られる不安", "刺さっている", "興味が薄い", "不満・離れかけ", "安くしたい", "審査の不安"].includes(state)) k.push(`押し引き(${state})`);
  return [...new Set(k)];
}

async function loadTurns(): Promise<Turn[]> {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const ex = await page<Record<string, unknown>>((a, b) => sb.from("ai_reply_examples")
    .select("id,conversation_id,ai_draft,sent_reply,sent_at,created_at,reply_context_snapshot")
    .eq("entry_source", "line_reply").gte("created_at", since).order("created_at").range(a, b));
  const convs = [...new Set(ex.map((r) => String(r.conversation_id ?? "")).filter((c) => c && !isTestConversation(c)))];
  const byConv = new Map<string, Msg[]>();
  const dig = new Map<string, Digest[]>();
  const msgSince = new Date(Date.now() - (DAYS + 15) * 86400e3).toISOString();
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
    const ds = await page<Record<string, unknown>>((a, b) => sb.from("brain_decision_logs")
      .select("conversation_id,created_at,suggested_next_steps,digest").in("conversation_id", ids).gte("created_at", msgSince).order("created_at").range(a, b));
    for (const d of ds) {
      const c = String(d.conversation_id); const g = (d.digest ?? {}) as Record<string, unknown>;
      if (!dig.has(c)) dig.set(c, []);
      const steps = Array.isArray(d.suggested_next_steps) ? (d.suggested_next_steps as unknown[]).map(String) : [];
      dig.get(c)!.push({ at: Date.parse(String(d.created_at)), dir: String(g.dir ?? ""), cs: String(g.cs ?? ""), step: steps[0] ?? "", ms: String(g.ms ?? ""), sig: String(g.sig ?? ""), la: String(g.la ?? g.aix ?? ""), hes: String(g.hes ?? "") });
    }
  }
  const out: Turn[] = [];
  for (const r of ex) {
    const conv = String(r.conversation_id ?? "");
    const arr = byConv.get(conv); if (!arr) continue;
    const sent = String(r.sent_reply ?? "").trim(); if (!sent) continue;
    if (Date.parse(String(r.sent_at ?? r.created_at)) < SINCE_MS) continue;
    const draft = String(r.ai_draft ?? "").trim();
    if (/^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました）|\[返信不要\])\s*$/.test(draft)) continue;
    const at = Date.parse(String(r.sent_at ?? r.created_at));
    const sentMsgs = arr.filter((m) => m.sender === "staff" && Math.abs(m.at - at) < 180_000 && m.text && sent.includes(m.text.slice(0, 20)));
    if (!sentMsgs.length || sentMsgs.some((m) => m.aix)) continue;
    if (sentMsgs.find((m) => m.writer)?.writer !== "takeuchi") continue;
    const firstSentAt = Math.min(...sentMsgs.map((m) => m.at));
    const before = arr.filter((m) => m.at < firstSentAt - 1000);
    let lastStaffIdx = -1;
    for (let i = before.length - 1; i >= 0; i--) if (before[i].sender === "staff") { lastStaffIdx = i; break; }
    const customer = before.slice(lastStaffIdx + 1).filter((m) => m.sender === "customer" && m.text).map((m) => m.text).join("\n");
    if (!customer.trim()) continue;
    const priorStaff = before.filter((m) => m.sender === "staff" && m.text && m.text !== "[画像]").slice(-4).reverse().map((m) => m.text);
    const brain = (dig.get(conv) ?? []).filter((d) => d.at <= firstSentAt).pop() ?? null;
    const usable = brain && firstSentAt - brain.at < 6 * 3600e3 ? brain : null;
    const scene = resolveReplyScene({ customerText: customer }).scene;
    if (scene === "apply" || scene === "ack") continue;
    const kinds = salesKinds(customer, priorStaff, scene, usable?.ms ?? "");
    if (!kinds.length) continue;
    const snap = (r.reply_context_snapshot ?? {}) as Record<string, unknown>;
    out.push({ id: String(r.id), conv, at, draft, sent, customer, priorStaff, scene, kinds, brain: usable, snapDir: String(snap.brainReplyDirection ?? snap.effectiveReplyDirection ?? "") });
  }
  return out;
}

(async () => {
  const turns = await loadTurns();
  const withDraft = turns.filter((t) => t.draft);
  const noDraft = turns.filter((t) => !t.draft);
  console.log(`=== 営業の番（竹内さんの手打ち・${DAYS}日）: ${turns.length} 番（下書きあり ${withDraft.length}・自分で打った ${noDraft.length}）・会話 ${new Set(turns.map((t) => t.conv)).size}`);
  const kc = new Map<string, number>(); for (const t of turns) for (const k of t.kinds) kc.set(k.replace(/\(.*\)/, ""), (kc.get(k.replace(/\(.*\)/, "")) ?? 0) + 1);
  console.log(`ブレインの出力が読める番: ${turns.filter((t) => t.brain || t.snapDir).length}`);
  console.log("番の種類:", [...kc].map(([k, v]) => `${k} ${v}`).join("・"));

  {
    const norm = (s: string) => N(s).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s！!。、]/gu, "");
    const dice = (a: string, b: string) => { const x = norm(a), y = norm(b); if (!x || !y) return 0; const A = new Map<string, number>(); for (let i = 0; i < x.length - 1; i++) A.set(x.slice(i, i + 2), (A.get(x.slice(i, i + 2)) ?? 0) + 1); let inter = 0; for (let i = 0; i < y.length - 1; i++) { const g = y.slice(i, i + 2); const v = A.get(g) ?? 0; if (v > 0) { inter++; A.set(g, v - 1); } } return 2 * inter / (x.length - 1 + y.length - 1); };
    const by = new Map<string, number[]>();
    for (const t of withDraft) for (const k of ["全部", ...t.kinds.map((x) => x.replace(/\(.*\)/, ""))]) { const a = by.get(k) ?? []; a.push(dice(t.draft, t.sent)); by.set(k, a); }
    console.log("下書きの近さ（種類ごと・直さず送った≒0.95以上の割合／平均）:", [...by].map(([k, a]) => `${k} ${a.length}番 ${Math.round(a.filter((x) => x >= 0.95).length / a.length * 100)}%／${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)}`).join("・"));
  }
  type Row = { type: string; n: number; brainHas: number; brainNo: number; ids: string[] };
  const rows = new Map<string, Row>();
  const add = (type: string, t: Turn, has: boolean | null) => {
    const r = rows.get(type) ?? { type, n: 0, brainHas: 0, brainNo: 0, ids: [] };
    r.n++; if (has === true) r.brainHas++; else if (has === false) r.brainNo++; r.ids.push(t.id); rows.set(type, r);
  };
  for (const t of withDraft) {
    const bt = `${brainText(t.brain)} ${t.snapDir}`;
    const bOk = !!t.brain || !!t.snapDir;
    for (const [mv, re] of Object.entries(MOVES)) {
      const d = sentencesOf(t.draft).some((x) => re.test(x)), s = sentencesOf(t.sent).some((x) => re.test(x));
      const has = bOk ? BRAIN_MOVES[mv].test(bt) : null;
      if (s && !d) add(`足した: ${mv}`, t, has);
      if (d && !s) add(`削った: ${mv}`, t, has);
    }
    if (reasonedNext(t.sent) && !reasonedNext(t.draft)) add("足した: 次の一手の理由", t, bOk ? /ので|ため|理由|から/.test(bt) : null);
    if (!reasonedNext(t.sent) && reasonedNext(t.draft)) add("削った: 次の一手の理由", t, null);
    const od = openerKind(t.draft), os = openerKind(t.sent);
    if (od !== os) add(`一言目: AI ${od} → 竹内さん ${os}`, t, null);
    const ls = sentencesOf(t.sent).length, ld = sentencesOf(t.draft).length;
    if (ld >= ls + 2) add("言わない判断（竹内さんが2文以上少ない）", t, null);
  }
  const fmt = (r: Row) => `${r.type.padEnd(34)} ${String(r.n).padStart(4)}  ブレインに有り ${r.brainHas}・無い ${r.brainNo}`;
  console.log(`\n--- 下書きあり ${withDraft.length} 番: 竹内さんが足した／削った一手（ブレインに有り＝あるのに文に届かない・無い＝ブレインの出力に無い）`);
  for (const r of [...rows.values()].sort((a, b) => b.n - a.n)) console.log(fmt(r));

  console.log(`\n--- 自分で打った ${noDraft.length} 番: 竹内さんが打った一手がブレインの出力にあったか`);
  const nd = new Map<string, Row>();
  for (const t of noDraft) {
    const bt = `${brainText(t.brain)}`; if (!t.brain) continue;
    for (const [mv, re] of Object.entries(MOVES)) if (sentencesOf(t.sent).some((x) => re.test(x))) {
      const r = nd.get(mv) ?? { type: mv, n: 0, brainHas: 0, brainNo: 0, ids: [] }; r.n++; if (BRAIN_MOVES[mv].test(bt)) r.brainHas++; else r.brainNo++; r.ids.push(t.id); nd.set(mv, r);
    }
    if (reasonedNext(t.sent)) { const r = nd.get("次の一手の理由") ?? { type: "次の一手の理由", n: 0, brainHas: 0, brainNo: 0, ids: [] }; r.n++; nd.set("次の一手の理由", r); }
  }
  for (const r of [...nd.values()].sort((a, b) => b.n - a.n)) console.log(fmt(r));

  const show = arg("show");
  if (show) {
    const r = rows.get(show) ?? nd.get(show);
    const byId = new Map(turns.map((t) => [t.id, t]));
    // --show=kind:迷い で番の種類ごとに（下書きのある番）
    const ids = show.startsWith("kind:") ? withDraft.filter((t) => t.kinds.some((k) => k.startsWith(show.slice(5)))).map((t) => t.id) : (r?.ids ?? []);
    for (const id of ids.slice(-Number(arg("n") ?? 10))) {
      const t = byId.get(id)!;
      const m = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様)/g, "〈名〉").replace(/\n+/g, " ／ ");
      console.log(`\n==== ${id.slice(0, 8)} ${new Date(t.at).toISOString().slice(0, 16)} [${t.kinds.join(",")}] ms=${t.brain?.ms ?? "-"} sig=${t.brain?.sig ?? "-"}`);
      console.log(`客: ${m(t.customer).slice(0, 200)}`);
      console.log(`脳: dir=${(t.snapDir || t.brain?.dir || "").slice(0, 120)} ｜cs=${t.brain?.cs ?? ""} ｜step=${(t.brain?.step ?? "").slice(0, 80)}`);
      if (t.draft) console.log(`AI: ${m(t.draft).slice(0, 260)}`);
      console.log(`竹: ${m(t.sent).slice(0, 260)}`);
    }
  }
  const js = arg("json");
  if (js) fs.writeFileSync(js, turns.map((t) => JSON.stringify({ src: t.id, conv: t.conv, at: new Date(t.at).toISOString(), kinds: t.kinds, scene: t.scene, staffText: t.sent, hasDraft: !!t.draft })).join("\n"));
})();

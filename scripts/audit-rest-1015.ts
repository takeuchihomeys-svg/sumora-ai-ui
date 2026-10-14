// scripts/audit-rest-1015.ts — 出口の監査の残り（#7 replyHint・#9 冒頭・#10 確定・最優先の注記・#11 ブレインの値の書き換え・#12 AIX の種類の決め打ち）
//   2026-10-15 作る人（audit-rest-1015）。読むだけ・LLM なし・費用0。
//   それぞれ「決まりがブレインとぶつかった番」を数え、竹内さん（staff_writer=takeuchi）の実送信・押した AIX と比べて、どちらが正しかったかを見る。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-rest-1015.ts [--days=30] [--part=hint,opener,notes,override,relax,check] [--show=20]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { openerLabelOf } from "../app/lib/opener-rates";
import { autoReplyHintOf } from "../app/lib/reply-hint-auto";
import { classifyFixedNoteTriggers } from "../app/lib/fixed-content-notes";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "30"));
const PARTS = new Set(arg("part", "hint,opener,notes,override,relax,check").split(","));
const SHOW = Number(arg("show", "12"));

type Row = Record<string, any>;
async function fetchAll(q: (from: number, to: number) => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const norm = (s: string | null | undefined) => String(s ?? "").replace(/[\s　]+/g, "");
const one = (s: string | null | undefined, n = 70) => String(s ?? "").replace(/\n/g, "／").slice(0, n);
const lines = (s: string | null | undefined) => String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
const QUESTION_RE = /[？?]|でしょうか|いかがですか|ますか(?:[！!。]|$)/;
const PICKUP_DECL_RE = /(?:ピックアップ|お探し|探し(?:て|させ))[^。！!\n]{0,24}(?:させて(?:頂|いただ)き|いたし|致し|します|お送り)/;
const ACTION_DECL_RE = /(?:ピックアップ|お探し|探し|確認|御見積書|お見積書|お送り)[^。！!\n]{0,24}(?:させて(?:頂|いただ)き|いたし|致し|します|次第)/;
const CONFIRM_PROMISE_RE = /確認(?:させて(?:頂|いただ)き|いたし|致し|し(?:て)?ご連絡|でき次第|出来次第)/;
const RELAX_RE = /代替|条件(?:を)?(?:少し|1つ|一つ)?(?:変え|緩め|広げ|見直)|エリアを広げ|難しい|厳しい|少ない(?:です|状況|かと)|妥協|優先順位/;
/** 冒頭の挨拶・名前だけの行を剥がした後の書き出しの種類 */
function openerAfterGreeting(text: string | null | undefined): string {
  const ls = lines(text).filter((l) => !/^[^\s。！!]{0,12}さん[！!、。]*$/.test(l));
  while (ls.length && /お世話になっております|夜分遅く|はじめまして|初めまして|鈴木と申します/.test(ls[0])) ls.shift();
  return openerLabelOf(ls.join("\n"));
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const ex = (await fetchAll((f, t) => sb.from("ai_reply_examples")
    .select("id, conversation_id, created_at, sent_at, customer_message, sent_reply, ai_draft, was_ai_used, entry_source, reply_context_snapshot")
    .gte("created_at", since).not("reply_context_snapshot", "is", null).order("created_at").range(f, t)))
    .filter((r) => !isTestConversation(r.conversation_id) && (r.ai_draft ?? "").trim() && !/^\[|^__/.test(r.ai_draft) && (r.sent_reply ?? "").trim());
  const cids = [...new Set(ex.map((r) => r.conversation_id))];
  const msgs = new Map<string, Row[]>(), aix = new Map<string, Row[]>(), brain = new Map<string, Row[]>();
  const push = (m: Map<string, Row[]>, k: string, v: Row) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (let i = 0; i < cids.length; i += 50) {
    const p = cids.slice(i, i + 50);
    const [m, a, b] = await Promise.all([
      fetchAll((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer, is_aix_generated").in("conversation_id", p).gte("created_at", since).order("created_at").range(f, t)),
      fetchAll((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").in("conversation_id", p).gte("created_at", since).range(f, t)),
      fetchAll((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, suggested_check_pattern, actual_check_pattern, actual_aix_type, decision_source, digest").in("conversation_id", p).gte("created_at", since).order("created_at").range(f, t)),
    ]);
    for (const x of m) push(msgs, x.conversation_id, x);
    for (const x of a) push(aix, x.conversation_id, x);
    for (const x of b) push(brain, x.conversation_id, x);
  }
  // 実送信の書き手（同じ会話のスタッフの手打ちで本文が一致）
  const writerOf = (r: Row): string => {
    const at = Date.parse(r.sent_at ?? r.created_at);
    const m = (msgs.get(r.conversation_id) ?? []).find((x) => x.sender === "staff" && !x.is_aix_generated && norm(x.text) === norm(r.sent_reply) && Math.abs(Date.parse(x.created_at) - at) < 3 * 3600e3);
    return m?.staff_writer ?? "?";
  };
  const brainBefore = (r: Row): Row | null => {
    const at = Date.parse(r.created_at);
    return [...(brain.get(r.conversation_id) ?? [])].filter((b) => Date.parse(b.created_at) <= at + 5000).at(-1) ?? null;
  };
  const pressedAfter = (cid: string, t0: number): string[] => {
    const nextCust = (msgs.get(cid) ?? []).filter((m) => m.sender === "customer" && Date.parse(m.created_at) > t0 + 60e3).map((m) => Date.parse(m.created_at)).sort()[0] ?? Infinity;
    const end = Math.min(t0 + 12 * 3600e3, nextCust);
    return (aix.get(cid) ?? []).filter((x) => { const t = Date.parse(x.created_at); return t >= t0 - 60e3 && t <= end; }).map((x) => String(x.aix_type).replace(/^property_recommendation$/, "property_send"));
  };
  console.log(`下書きと実送信のある番 ${ex.length}（${DAYS}日・テストの会話を除く）`);

  // ── #7 replyHint ──
  if (PARTS.has("hint")) {
    const agg: Record<string, { n: number; brain: number; tk: number; tkLong: number; tkQ: number; tkPick: number; brainAsk: number; brainAix: number; brainAixPressed: number; contentDiff: number; brainRight: number; hintRight: number }> = {};
    const samples: string[] = [];
    for (const r of ex) {
      const s = r.reply_context_snapshot ?? {};
      if (s.caller === "template_optimize") continue;
      const lastStaff = [...(msgs.get(r.conversation_id) ?? [])].filter((m) => m.sender === "staff" && !m.is_aix_generated && Date.parse(m.created_at) < Date.parse(r.created_at)).at(-1)?.text ?? "";
      const h = autoReplyHintOf(r.customer_message ?? "", { firstReply: s.rawState === "first_reply", lastStaffText: lastStaff });
      if (!h.kind) continue;
      const a = (agg[h.kind] ??= { n: 0, brain: 0, tk: 0, tkLong: 0, tkQ: 0, tkPick: 0, brainAsk: 0, brainAix: 0, brainAixPressed: 0, contentDiff: 0, brainRight: 0, hintRight: 0 });
      a.n++;
      const brainOn = s.turnContract?.source === "brain" || !!s.brainReplyDirection;
      if (!brainOn) continue;
      a.brain++;
      const dir = String(s.brainReplyDirection ?? "");
      if (/聞|確認する|質問|伺|答え/.test(dir)) a.brainAsk++;
      const b = brainBefore(r);
      if (b?.suggested_action) {
        a.brainAix++;
        if (pressedAfter(r.conversation_id, Date.parse(r.created_at)).includes(String(b.suggested_action).replace(/^property_recommendation$/, "property_send"))) a.brainAixPressed++;
      }
      if (writerOf(r) !== "takeuchi") continue;
      a.tk++;
      const sl = lines(r.sent_reply).length;
      if (sl > 4) a.tkLong++;
      if (QUESTION_RE.test(r.sent_reply)) a.tkQ++;
      if (PICKUP_DECL_RE.test(r.sent_reply)) a.tkPick++;
      // ぶつかる中身: ブレインの向きが行動の宣言（ピックアップ・確認・見積・お送り）でない番（答える・説明・締め・受け止め）
      const brainAct = /ピックアップ|探|確認|見積|お送り|送付|再開/.test(dir);
      const tkAct = ACTION_DECL_RE.test(r.sent_reply) && lines(r.sent_reply).length <= 4;
      if (!brainAct) { a.contentDiff++; if (tkAct) a.hintRight++; else a.brainRight++; }
      if (samples.length < SHOW) samples.push(`  [${h.kind}] ${r.conversation_id.slice(0, 8)} ${String(r.created_at).slice(5, 16)} 客「${one(r.customer_message, 40)}」 脳「${one(dir, 50)}」 竹内(${sl}行)「${one(r.sent_reply, 70)}」`);
    }
    console.log(`\n■ #7 自動の replyHint（指定生成モード＝全ルールの上書き・2〜3行・追加質問禁止・AIX の注記と本文の安全を外す）`);
    console.log(`  種類 | 当たった番 | うちブレインの判断あり（ぶつかる番） | その時ブレインが AIX も | その AIX をスタッフが押した | ブレインの向きが聞く/答える | 竹内さんの実送信 | 5行以上 | 質問あり | ピックアップ宣言 | ブレインの向きが行動の宣言でない（中身がぶつかる） | 竹内さん=ブレイン | 竹内さん=手がかり（4行以内の行動の宣言）`);
    for (const [k, a] of Object.entries(agg)) console.log(`  ${k} | ${a.n} | ${a.brain} | ${a.brainAix} | ${a.brainAixPressed} | ${a.brainAsk} | ${a.tk} | ${a.tkLong} | ${a.tkQ} | ${a.tkPick} | ${a.contentDiff} | ${a.brainRight} | ${a.hintRight}`);
    samples.forEach((x) => console.log(x));
  }

  // ── #9 冒頭（出口の enforceOpening が LLM の書き出しを置き換えた番）──
  if (PARTS.has("opener")) {
    let withRaw = 0, changed = 0, chTk = 0, rawRight = 0, ruleRight = 0, neither = 0, unusual = 0;
    const byPair = new Map<string, { n: number; raw: number; rule: number }>();
    const samples: string[] = [];
    for (const r of ex) {
      const s = r.reply_context_snapshot ?? {};
      const raw = s.postprocess?.rawGen?.[0];
      if (!raw) continue;
      withRaw++;
      if ((s.finalCheckCodes ?? []).some((c: string) => c.startsWith("OPENER_UNUSUAL"))) unusual++;
      const ro = openerAfterGreeting(raw), fo = openerAfterGreeting(r.ai_draft);
      const openerEdit = (s.postprocess?.exitEdits ?? []).some((e: Row) => e.exit === "enforceOpening" && (e.why ?? []).some((w: string) => /開口語/.test(w)));
      if (ro === fo || !openerEdit) continue;
      changed++;
      if (writerOf(r) !== "takeuchi") continue;
      chTk++;
      const so = openerAfterGreeting(r.sent_reply);
      const k = `${ro}→${fo}`;
      const p = byPair.get(k) ?? { n: 0, raw: 0, rule: 0 };
      p.n++;
      if (so === ro) { rawRight++; p.raw++; } else if (so === fo) { ruleRight++; p.rule++; } else neither++;
      byPair.set(k, p);
      if (samples.length < SHOW) samples.push(`  ${r.conversation_id.slice(0, 8)} ${String(r.created_at).slice(5, 16)} 生「${one(raw, 30)}」→下書き「${one(r.ai_draft, 30)}」 竹内「${one(r.sent_reply, 40)}」 greeting.opener=${s.greeting?.opener} allowed=${(s.greeting?.openerAllowed ?? []).join("/")}`);
    }
    console.log(`\n■ #9 冒頭: 生成の直後の文（rawGen・10/09〜）がある番 ${withRaw}・出口が開口語を置き換えた ${changed}・うち竹内さんの実送信 ${chTk}`);
    console.log(`  竹内さんが生成の書き出し（ブレインの reply_opener の注記に従った LLM）と同じ ${rawRight}・出口の決まりと同じ ${ruleRight}・どちらでもない ${neither}`);
    for (const [k, p] of byPair) console.log(`  ${k}: ${p.n}（生と同じ ${p.raw}・決まりと同じ ${p.rule}）`);
    console.log(`  最終チェックの OPENER_UNUSUAL（ブレインの書き出しと下書きが違う）: ${unusual}`);
    samples.forEach((x) => console.log(x));
    // 決定論の開口語（greeting.opener・openerAllowed）× 竹内さんの実送信の書き出し（挨拶の行の後）
    const JA: Record<string, string> = { hai: "はい", kashikomari: "かしこまりました", none: "開口語なし" };
    const det = new Map<string, { n: number; same: number; inAllowed: number; outside: Map<string, number> }>();
    let tkN = 0;
    for (const r of ex) {
      const g = r.reply_context_snapshot?.greeting;
      if (!g?.opener || r.reply_context_snapshot?.rawState === "first_reply" || writerOf(r) !== "takeuchi") continue;
      tkN++;
      const so = openerAfterGreeting(r.sent_reply);
      const k = `${JA[g.opener] ?? g.opener}（許可 ${(g.openerAllowed ?? []).map((x: string) => JA[x] ?? x).join("/")}${g.openerStrict ? "・名指し" : ""}）`;
      const a = det.get(k) ?? { n: 0, same: 0, inAllowed: 0, outside: new Map() };
      a.n++;
      if (so === JA[g.opener]) a.same++;
      if ((g.openerAllowed ?? []).some((x: string) => JA[x] === so)) a.inAllowed++;
      else a.outside.set(so, (a.outside.get(so) ?? 0) + 1);
      det.set(k, a);
    }
    console.log(`  決定論の開口語 × 竹内さんの実送信（${tkN}通・初回を除く）: 決定 | 通 | 同じ | 許可の内 | 許可の外の内訳`);
    for (const [k, a] of [...det].sort((x, y) => y[1].n - x[1].n)) console.log(`   ${k} | ${a.n} | ${a.same} | ${a.inAllowed} | ${[...a.outside].map(([o, v]) => `${o} ${v}`).join("・")}`);
  }

  // ── #10 確定・最優先の生成の注記 ──
  if (PARTS.has("notes")) {
    const agg: Record<string, { n: number; brain: number; tk: number; follow: number; against: number; brainDiff: number; brainRight: number; noteRight: number }> = {};
    const samples: string[] = [];
    for (const r of ex) {
      const s = r.reply_context_snapshot ?? {};
      if (s.caller === "template_optimize" || s.rawState === "first_reply") continue;
      const trig = classifyFixedNoteTriggers(r.customer_message ?? "", { customerAsked: !!s.hedge?.customerAsked });
      for (const t of trig) {
        const a = (agg[t] ??= { n: 0, brain: 0, tk: 0, follow: 0, against: 0, brainDiff: 0, brainRight: 0, noteRight: 0 });
        a.n++;
        const dir = String(s.brainReplyDirection ?? "");
        if (!(s.turnContract?.source === "brain" || dir)) continue;
        a.brain++;
        if (writerOf(r) !== "takeuchi") continue;
        a.tk++;
        const sent = String(r.sent_reply);
        // 注記の型に竹内さんが従ったか（注記ごとの物差し）
        const follows = t === "new_condition"
          ? PICKUP_DECL_RE.test(sent) && !QUESTION_RE.test(sent) && !RELAX_RE.test(sent)
          : t === "move_in_timing" || t === "move_in_month"
            ? !CONFIRM_PROMISE_RE.test(sent)
            : /ピックアップ|お送り|お探し/.test(sent) && !/^[^。]*確認(?:させて|して)[^。]*ご連絡[^。]*$/.test(sent);
        if (follows) a.follow++; else a.against++;
        // ブレインの向きが注記の型と食い違う番
        const brainDiffers = t === "new_condition" ? /聞|質問|確認|答え|難し|代替|伺/.test(dir) && !/ピックアップ|探|お送り/.test(dir)
          : t === "move_in_timing" || t === "move_in_month" ? /確認/.test(dir)
          : /確認/.test(dir) && !/ピックアップ|探|お送り/.test(dir);
        if (brainDiffers) { a.brainDiff++; if (follows) a.noteRight++; else a.brainRight++; }
        if (samples.length < SHOW && (brainDiffers || !follows)) samples.push(`  [${t}] ${r.conversation_id.slice(0, 8)} ${String(r.created_at).slice(5, 16)} 客「${one(r.customer_message, 40)}」 脳「${one(dir, 50)}」 竹内「${one(sent, 70)}」 型に${follows ? "従う" : "従わない"}`);
      }
    }
    console.log(`\n■ #10 確定・最優先の生成の注記（他のどのルールより上位・中身を決め打ち）`);
    console.log(`  注記 | 当たった番 | ブレインの判断あり | 竹内さんの実送信 | 型に従った | 従わない | ブレインの向きが型と違う | そのうち竹内さん=ブレイン | 竹内さん=注記`);
    for (const [k, a] of Object.entries(agg)) console.log(`  ${k} | ${a.n} | ${a.brain} | ${a.tk} | ${a.follow} | ${a.against} | ${a.brainDiff} | ${a.brainRight} | ${a.noteRight}`);
    samples.forEach((x) => console.log(x));
  }

  // ── #11 stripPreemptiveRelax（ブレインの勝ち筋・締め・潜在の意図から代替・緩和の節を落とす）──
  if (PARTS.has("relax")) {
    let n = 0, brainRelax = 0, tk = 0, tkRelax = 0, tkNo = 0;
    const samples: string[] = [];
    for (const r of ex) {
      const s = r.reply_context_snapshot ?? {};
      if (s.hedge?.allowance !== "forbid_preemptive") continue;
      n++;
      const cs = String(s.brainClosingStrategy ?? "");
      if (!RELAX_RE.test(cs)) continue;
      brainRelax++;
      if (writerOf(r) !== "takeuchi") continue;
      tk++;
      if (RELAX_RE.test(r.sent_reply)) tkRelax++; else tkNo++;
      if (samples.length < SHOW) samples.push(`  ${r.conversation_id.slice(0, 8)} ${String(r.created_at).slice(5, 16)} 締め「${one(cs, 60)}」 竹内「${one(r.sent_reply, 80)}」`);
    }
    console.log(`\n■ #11 stripPreemptiveRelax: 未探索（forbid_preemptive）の番 ${n}・ブレインの締めに代替・緩和の節 ${brainRelax}（落とされる＝ぶつかる番）・竹内さんの実送信 ${tk}: 代替・緩和を書いた ${tkRelax}／書かない ${tkNo}`);
    samples.forEach((x) => console.log(x));
  }

  // ── #11/#12 規則がブレインの一手（AIX の種類）を書き換えた番（decision_source の規則の印 × LLM の生の一手 digest.la × スタッフ）──
  if (PARTS.has("override")) {
    // --from=YYYY-MM-DD で直近の版だけ（規則の直しが入った後の番を見る）
    const since2 = arg("from", "") ? new Date(`${arg("from", "")}T00:00:00+09:00`).toISOString() : since;
    const rows = (await fetchAll((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, decision_source, suggested_action, digest").gte("created_at", since2).order("created_at").range(f, t))).filter((r) => !isTestConversation(r.conversation_id));
    const cs = [...new Set(rows.map((r) => r.conversation_id))];
    const mAll = new Map<string, Row[]>(), aAll = new Map<string, Row[]>();
    for (let i = 0; i < cs.length; i += 50) {
      const p = cs.slice(i, i + 50);
      const [a, m] = await Promise.all([
        fetchAll((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").in("conversation_id", p).gte("created_at", since2).range(f, t)),
        fetchAll((f, t) => sb.from("messages").select("conversation_id, created_at, is_aix_generated, sender, staff_writer").in("conversation_id", p).gte("created_at", since2).range(f, t)),
      ]);
      for (const x of a) push(aAll, x.conversation_id, x);
      for (const x of m) push(mAll, x.conversation_id, x);
    }
    const nm = (a: string | null | undefined) => (a ?? "reply").replace(/^property_recommendation$/, "property_send");
    const last = new Map<string, Row>();
    for (const r of rows) last.set(`${r.conversation_id}|${r.analyzed_msg_ts ?? r.created_at}`, r);
    const agg = new Map<string, { n: number; diff: number; ruleOk: number; llmOk: number; neither: number; nothing: number; tkDiff: number; tkRule: number; tkLlm: number }>();
    for (const r of last.values()) {
      if (!r.digest || !("la" in r.digest)) continue;
      const toks = String(r.decision_source ?? "").replace(/^no_aix:/, "").split("+").map((t) => t.replace(/\(.*$/, "")).filter((t) => t && t !== "llm");
      if (!toks.length) continue;
      const la = nm(r.digest.la), fin = nm(r.suggested_action);
      const t0 = Date.parse(r.created_at);
      const nextCust = (mAll.get(r.conversation_id) ?? []).filter((m) => m.sender === "customer" && Date.parse(m.created_at) > t0).map((m) => Date.parse(m.created_at)).sort()[0] ?? Infinity;
      const end = Math.min(t0 + 12 * 3600e3, nextCust);
      const pressed = (aAll.get(r.conversation_id) ?? []).filter((x) => { const t = Date.parse(x.created_at); return t >= t0 - 60e3 && t <= end; }).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).map((x) => nm(x.aix_type));
      const typedBy = (mAll.get(r.conversation_id) ?? []).filter((m) => m.sender === "staff" && !m.is_aix_generated && Date.parse(m.created_at) >= t0 - 60e3 && Date.parse(m.created_at) <= end);
      const staffAct = pressed[0] ?? (typedBy.length ? "reply" : "nothing");
      const tk = typedBy.some((m) => m.staff_writer === "takeuchi") || (pressed.length > 0 && false);
      for (const tok of new Set(toks)) {
        const a = agg.get(tok) ?? { n: 0, diff: 0, ruleOk: 0, llmOk: 0, neither: 0, nothing: 0, tkDiff: 0, tkRule: 0, tkLlm: 0 };
        a.n++;
        if (la !== fin) {
          a.diff++;
          if (staffAct === "nothing") a.nothing++;
          else if (staffAct === fin || pressed.includes(fin)) a.ruleOk++;
          else if (staffAct === la || pressed.includes(la)) a.llmOk++;
          else a.neither++;
          if (tk) { a.tkDiff++; if (staffAct === fin) a.tkRule++; else if (staffAct === la) a.tkLlm++; }
        }
        agg.set(tok, a);
      }
    }
    console.log(`\n■ #11/#12 規則の印ごと: ブレイン（LLM の生の一手 digest.la）と最終の一手が違った番（ぶつかる番）× スタッフの一手（押した AIX／手打ち＝reply）`);
    console.log(`  印 | 判断 | ぶつかる番 | 規則（最終）が正 | ブレイン（生）が正 | どちらでもない | スタッフ何もせず | 竹内さんの手打ちあり: 番・規則・ブレイン`);
    for (const [k, a] of [...agg].sort((x, y) => y[1].diff - x[1].diff)) if (a.diff) console.log(`  ${k} | ${a.n} | ${a.diff} | ${a.ruleOk} | ${a.llmOk} | ${a.neither} | ${a.nothing} | ${a.tkDiff}・${a.tkRule}・${a.tkLlm}`);
  }

  // ── #12 AIX の出口のゲート（enforceAixGates）が違反の文を決め打ちの宣言の文に置き換えた番 ──
  if (PARTS.has("gates")) {
    const SKIP = new Set(["見積作成宣言の繰り返し", "空室確認の再宣言", "ピックアップ再宣言"]); // #1・#2 は答える返信の担当
    const bigr = (t: string) => { const x = norm(t); const b = new Set<string>(); for (let i = 0; i < x.length - 1; i++) b.add(x.slice(i, i + 2)); return b; };
    const simv = (a: string, b: string) => { const A = bigr(a), B = bigr(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.min(A.size, B.size); };
    const agg = new Map<string, { n: number; rep: number; tk: number; tkRep: number; tkOrig: number; tkNone: number; brainRep: number; brainOther: number }>();
    const samples: string[] = [];
    for (const r of ex) {
      const s = r.reply_context_snapshot ?? {};
      for (const e of (s.postprocess?.gateEdits ?? []) as Row[]) {
        if (SKIP.has(e.rule)) continue;
        const a = agg.get(e.rule) ?? { n: 0, rep: 0, tk: 0, tkRep: 0, tkOrig: 0, tkNone: 0, brainRep: 0, brainOther: 0 };
        a.n++;
        if (e.after) a.rep++;
        const sentSents = String(r.sent_reply).split(/\n|(?<=[。！!？?])/).filter((x) => x.trim().length > 3);
        const hasRep = !!e.after && sentSents.some((x) => simv(x, e.after) >= 0.6);
        const hasOrig = sentSents.some((x) => simv(x, e.before) >= 0.6);
        const dir = String(s.brainReplyDirection ?? "");
        if (e.after && dir) { if (/見積|確認|ご連絡|内覧|日程/.test(dir) && simv(dir, e.after) >= 0.25) a.brainRep++; else a.brainOther++; }
        if (writerOf(r) === "takeuchi") {
          a.tk++;
          if (hasRep) a.tkRep++; else if (hasOrig) a.tkOrig++; else a.tkNone++;
          if (samples.length < SHOW && e.after && !hasRep) samples.push(`  [${e.rule}] ${r.conversation_id.slice(0, 8)} ${String(r.created_at).slice(5, 16)} 消した「${one(e.before, 40)}」→「${one(e.after, 40)}」 脳「${one(dir, 40)}」 竹内「${one(r.sent_reply, 70)}」`);
        }
        agg.set(e.rule, a);
      }
    }
    console.log(`\n■ #12 AIX の出口のゲート（enforceAixGates・#1/#2 の3つを除く）: 規則 | 当たり | 決め打ちの文に置き換え | 置き換えの文に近いブレインの向き | 違う向き | 竹内さんの実送信 | 置き換えの文を送った | 元の文（消された側）を送った | どちらも無い`);
    for (const [k, a] of [...agg].sort((x, y) => y[1].n - x[1].n)) console.log(`  ${k} | ${a.n} | ${a.rep} | ${a.brainRep} | ${a.brainOther} | ${a.tk} | ${a.tkRep} | ${a.tkOrig} | ${a.tkNone}`);
    samples.forEach((x) => console.log(x));
  }

  // ── #11 check_pattern（ブレインは出さない＝証拠と語で決める）の当たり ──
  if (PARTS.has("check")) {
    const rows = (await fetchAll((f, t) => sb.from("brain_decision_logs").select("conversation_id, suggested_action, suggested_check_pattern, actual_check_pattern, actual_aix_type").gte("created_at", since).eq("suggested_action", "property_check_result").not("actual_check_pattern", "is", null).range(f, t))).filter((r) => !isTestConversation(r.conversation_id));
    const tab = new Map<string, number>();
    let same = 0, diff = 0, none = 0;
    for (const r of rows) {
      if (r.actual_aix_type !== "property_check_result") continue;
      const k = `${r.suggested_check_pattern ?? "(空)"}→${r.actual_check_pattern}`;
      tab.set(k, (tab.get(k) ?? 0) + 1);
      if (!r.suggested_check_pattern) none++; else if (r.suggested_check_pattern === r.actual_check_pattern) same++; else diff++;
    }
    console.log(`\n■ #11 check_pattern（物件確認した のピッカー）: 押された番 ${same + diff + none}・決めた値と同じ ${same}・違う ${diff}・空（スタッフが選ぶ）${none}`);
    for (const [k, v] of [...tab].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k}: ${v}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

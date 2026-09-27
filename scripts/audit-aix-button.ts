// scripts/audit-aix-button.ts — トーク画面の AIX のボタンが「正しい時に・正しい種類で」出ていたかを本番のデータで測る（読むだけ）
// 2026-09-27 竹内さん「AIXのボタンが表示されるタイミングとかもズレや問題、違うのが出たりする場合そこのズレも修正する」
//
// やり方: 会話ごとに DB の suggested_aix_meta の移り変わりを再現し（お客様の発言・スタッフの送信で消える／ブレインの判断の記録で書かれる）、
//   その時点の値を画面と同じ関数（app/lib/aix-button-view.ts resolveAixButtonView）に当てて「画面が出していたはずの AIX」を出す。
//   旧の動き（legacy: true）と今の動きの両方を当てて、ズレの型ごとに件数と実例を並べる。
// 限り: brain_decision_logs には note・two_choice_mode・alt_actions が残らない → その型は会話の今の判断（last_brain_meta）で数える。
//   画面の手元の控え（下書きを出した時の判断）は DB に残らない → 記録の並びから「控えが残る場面」を数える（A・C）。
//   ブレイン以外の帯（申込・審査・契約の帯、送信直後のテンプレの帯、やることの帯）は数えない。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-button.ts [--days=30] [--examples=4]
import { createClient } from "@supabase/supabase-js";
import { resolveAixButtonView, summarizeAixButtonView, BRAIN_AIX_LABELS, sameAixAction, type AixViewMeta, type AixViewMessage } from "../app/lib/aix-button-view";
import { YUMA_CONVERSATION_ID, isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "30"));
const EX = Number(arg("examples", "4"));
const SINCE = new Date(Date.now() - DAYS * 864e5).toISOString();
const TOL = 5_000;

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Log = { id: string; conversation_id: string; created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; analyzed_msg_ts: string | null; decision_source: string | null; analysis_mode: string | null };
type Use = { id: string; conversation_id: string; aix_type: string; created_at: string; sent_at: string | null };
type Conv = { id: string; customer_name: string | null; status: string | null; last_sender: string | null; updated_at: string; suggested_aix_meta: Record<string, unknown> | null; last_brain_meta: Record<string, unknown> | null; ai_draft: string | null };

async function all<T>(table: string, cols: string, build: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const ms = (s: string | null | undefined) => (s ? new Date(s).getTime() : NaN);
const jst = (s: string) => new Date(ms(s) + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
const short = (s: string | null | undefined, n = 40) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const quant = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const sec = (x: number) => (Number.isFinite(x) ? `${Math.round(x / 1000)}秒` : "-");

function logToMeta(l: Log): AixViewMeta {
  const firstContact = l.decision_source === "guard:first_contact";
  return {
    action: firstContact ? "" : (l.suggested_action ?? ""),
    first_contact_pickup: firstContact ? l.suggested_action : null,
    reply_mode: l.suggested_reply_mode,
    analyzed_msg_ts: l.analyzed_msg_ts,
    source: l.analysis_mode === "cached" ? "cached" : "brain",
    decision_source: l.decision_source,
    note: "（記録に無い・有る物として数える）",
  };
}

type Ev = { t: number; kind: "cust" | "staff" | "log"; msg?: Msg; log?: Log };

async function main() {
  const [msgs, logs, uses, convs] = await Promise.all([
    all<Msg>("messages", "id, conversation_id, sender, text, created_at, is_aix_generated", (q) => q.gte("created_at", SINCE).order("created_at", { ascending: true })),
    all<Log>("brain_decision_logs", "id, conversation_id, created_at, suggested_action, suggested_reply_mode, analyzed_msg_ts, decision_source, analysis_mode", (q) => q.gte("created_at", SINCE).order("created_at", { ascending: true })),
    all<Use>("aix_usage_logs", "id, conversation_id, aix_type, created_at, sent_at", (q) => q.gte("created_at", SINCE).order("created_at", { ascending: true })),
    all<Conv>("conversations", "id, customer_name, status, last_sender, updated_at, suggested_aix_meta, last_brain_meta, ai_draft", (q) => q.gte("updated_at", SINCE)),
  ]);
  const nameOf = new Map(convs.map((c) => [c.id, c.customer_name ?? "?"]));
  // 判断の記録（brain_decision_logs）は 2026-09-05 から。番・押下の集計はそれ以降だけ（それより前は「判断が無い」と数えてしまう）
  const FROM = Math.max(ms(SINCE), ms(logs[0]?.created_at ?? SINCE));
  console.log(`=== AIX のボタンの監査（直近${DAYS}日）: メッセージ ${msgs.length}・ブレインの判断 ${logs.length}・押した AIX ${uses.length}・会話 ${convs.length} ===`);

  const byConv = new Map<string, { msgs: Msg[]; logs: Log[]; uses: Use[] }>();
  const g = (id: string) => { let v = byConv.get(id); if (!v) { v = { msgs: [], logs: [], uses: [] }; byConv.set(id, v); } return v; };
  for (const m of msgs) g(m.conversation_id).msgs.push(m);
  for (const l of logs) g(l.conversation_id).logs.push(l);
  for (const u of uses) g(u.conversation_id).uses.push(u);

  // ── 集計の器 ──
  const delays: number[] = []; let turns = 0, turnsNoBrainBeforeStaff = 0, turnsNeverAnalyzed = 0;
  const exDelay: string[] = [];
  const staleFixed: number[] = []; let staleNotFixed = 0;
  let staleWrites = 0, staleWritesAix = 0, staleBadgeMin = 0; const exStale: string[] = [];
  const pressCat: Record<string, number> = {}; const pressCatNew: Record<string, number> = {}; const exPress: Record<string, string[]> = {}; const pairs: Record<string, number> = {};
  let aFallback = 0; const exA: string[] = [];
  let cPersist = 0; const cDur: number[] = []; const exC: string[] = [];
  let gAtRisk = 0, gConvs = 0;
  let textThenSame = 0; const textThenGap: number[] = []; const exTextThen: string[] = [];
  let aixTurns = 0, aixTurnsPressedSame = 0, aixTurnsPressedOther = 0, aixTurnsText = 0, aixTurnsNothing = 0;
  const yumaLines: string[] = [];
  const todayJst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  for (const [cid, v] of byConv) {
    const test = isTestConversation(cid);
    const evs: Ev[] = [
      ...v.msgs.map((m) => ({ t: ms(m.created_at), kind: (m.sender === "customer" ? "cust" : "staff") as Ev["kind"], msg: m })),
      ...v.logs.map((l) => ({ t: ms(l.created_at), kind: "log" as const, log: l })),
    ].sort((a, b) => a.t - b.t);
    const name = nameOf.get(cid) ?? cid.slice(0, 8);

    // 時刻 t の直前の DB の判断と、画面のメッセージ
    const stateAt = (t: number, legacy: boolean) => {
      let meta: AixViewMeta | null = null; const shown: AixViewMessage[] = [];
      for (const e of evs) {
        if (e.t >= t) break;
        if (e.kind === "log") meta = logToMeta(e.log!);
        else { meta = null; shown.push({ sender: e.msg!.sender, rawCreatedAt: e.msg!.created_at, isAix: !!e.msg!.is_aix_generated }); }
      }
      const view = resolveAixButtonView({ meta, messages: shown, legacy });
      return { meta, view, sum: summarizeAixButtonView(view), msgs: shown };
    };

    // ① 表示の遅れ・② 古い判断の書き込み
    let lastCust: Msg | null = null; let pendingCust: Msg | null = null; let pendingFresh = false;
    let staleSince: number | null = null; let staleIsBadge = false;
    let aixDecisionCount = 0;
    for (const e of evs) {
      if (staleSince !== null) {
        if (staleIsBadge) staleBadgeMin += (e.t - staleSince) / 60000;
        staleSince = null; staleIsBadge = false;
      }
      if (e.kind === "cust") { lastCust = e.msg!; pendingCust = e.t >= FROM ? e.msg! : null; pendingFresh = false; continue; }
      if (e.kind === "staff") {
        if (pendingCust && !test) { turns++; if (!pendingFresh) turnsNoBrainBeforeStaff++; }
        pendingCust = null; continue;
      }
      const l = e.log!;
      if (lastCust && ms(l.analyzed_msg_ts) < ms(lastCust.created_at) - TOL) {
        if (!test) {
          staleWrites++;
          const isAix = !!l.suggested_action && !!BRAIN_AIX_LABELS[l.suggested_action] && l.suggested_reply_mode === "aix";
          if (isAix) staleWritesAix++;
          staleSince = e.t; staleIsBadge = isAix;
          const fix = evs.find((x) => x.t > e.t && x.kind === "log" && ms(x.log!.analyzed_msg_ts) >= ms(lastCust!.created_at) - TOL);
          const stop = evs.find((x) => x.t > e.t && x.kind !== "log");
          if (fix && (!stop || fix.t <= stop.t)) staleFixed.push(fix.t - e.t); else staleNotFixed++;
          if (exStale.length < EX && isAix) exStale.push(`${name} ${jst(l.created_at)} 判断=${l.suggested_action}（見た発言 ${jst(l.analyzed_msg_ts!)}）／最新の発言 ${jst(lastCust.created_at)}「${short(lastCust.text, 30)}」`);
        }
        continue;
      }
      if (pendingCust && !pendingFresh && ms(l.analyzed_msg_ts) >= ms(pendingCust.created_at) - TOL) {
        pendingFresh = true;
        if (!test) {
          const dly = e.t - ms(pendingCust.created_at);
          delays.push(dly);
          if (dly > 120_000 && exDelay.length < EX) exDelay.push(`${name} 発言 ${jst(pendingCust.created_at)}「${short(pendingCust.text, 24)}」→ 判断 ${jst(l.created_at)}（${sec(dly)}・${l.suggested_action || "AIXなし"}）`);
        }
      }
      if (l.suggested_reply_mode === "aix" && l.suggested_action && BRAIN_AIX_LABELS[l.suggested_action]) aixDecisionCount++;
    }
    if (!test && pendingCust) { turns++; if (!pendingFresh) turnsNoBrainBeforeStaff++; }
    if (!test) {
      // ブレインの判断が1つも無いお客様の発言の番
      const custs = v.msgs.filter((m) => m.sender === "customer");
      for (const c of custs) {
        const covered = v.logs.some((l) => ms(l.analyzed_msg_ts) >= ms(c.created_at) - TOL);
        if (!covered) { turnsNeverAnalyzed++; break; }
      }
      if (aixDecisionCount >= 2) { gConvs++; gAtRisk += aixDecisionCount - 1; }
    }

    // ③ 押した AIX と、その時画面が出していた AIX
    for (const u of v.uses) {
      if (test || ms(u.created_at) < FROM) continue;
      const t = ms(u.sent_at ?? u.created_at) - 1000;
      // 自分の送信で消える前の状態を見る: 押した AIX の送信メッセージ（±90秒の staff isAix）より前
      const sendMsg = v.msgs.find((m) => m.sender === "staff" && m.is_aix_generated && Math.abs(ms(m.created_at) - ms(u.sent_at ?? u.created_at)) < 90_000);
      const tt = sendMsg ? ms(sendMsg.created_at) - 1 : t;
      for (const legacy of [true, false]) {
        const s = stateAt(tt, legacy);
        const fresh = s.meta ? resolveAixButtonView({ meta: s.meta, messages: s.msgs }).metaFresh : false;
        let cat: string;
        const sameTurnStaff = s.msgs.length > 0 && s.msgs[s.msgs.length - 1].sender === "staff" && s.msgs.some((m) => m.sender === "customer");
        if (s.sum.shown) cat = sameAixAction(s.sum.shown.replace(/^two_choice:/, ""), u.aix_type) ? "①表示＝押した" : "②表示≠押した";
        else if (!s.meta && sameTurnStaff) cat = "④表示なし（同じ番にスタッフが先に送って判断が消えた後）";
        else if (!s.meta && s.msgs.some((m) => m.sender === "customer")) cat = "④'表示なし（お客様の発言の後・判断がまだ／来ない）";
        else if (!s.meta) cat = "④''表示なし（お客様の発言が無い・スタッフからの一手）";
        else if (!fresh) cat = "⑤表示なし（判断が古い）";
        else if (!s.meta.action) cat = "③表示なし（ブレイン AIX なし）";
        else if (s.meta.reply_mode !== "aix") cat = "⑥表示なし（返信モード＋AIX・帯の無い種類）";
        else cat = "⑦表示なし（その他）";
        const bucket = legacy ? pressCat : pressCatNew;
        bucket[cat] = (bucket[cat] ?? 0) + 1;
        if (legacy && cat.startsWith("②")) { const k = `${s.sum.shown}→${u.aix_type}${s.meta?.decision_source?.startsWith("rule:") ? "(" + s.meta.decision_source + ")" : ""}`; pairs[k] = (pairs[k] ?? 0) + 1; }
        if (legacy) { (exPress[cat] ??= []); if (exPress[cat].length < EX) exPress[cat].push(`${name} ${jst(u.sent_at ?? u.created_at)} 押した=${u.aix_type} 画面=${s.sum.shown ?? "なし"}（${s.sum.channel}）判断=${s.meta ? (s.meta.action || "なし") + "/" + (s.meta.reply_mode ?? "") : "無"}`); }
      }
    }

    // ④ ブレインが AIX（reply_mode=aix）を出した番に、スタッフが何をしたか
    if (!test) {
      for (let i = 0; i < v.logs.length; i++) {
        const l = v.logs[i];
        if (!(l.suggested_reply_mode === "aix" && l.suggested_action && BRAIN_AIX_LABELS[l.suggested_action])) continue;
        const nextCust = v.msgs.find((m) => m.sender === "customer" && ms(m.created_at) > ms(l.created_at));
        const nextLog = v.logs[i + 1];
        const endT = Math.min(nextCust ? ms(nextCust.created_at) : Infinity, nextLog ? ms(nextLog.created_at) : Infinity);
        const staff = v.msgs.find((m) => m.sender === "staff" && ms(m.created_at) > ms(l.created_at) && ms(m.created_at) < endT);
        if (nextLog && ms(nextLog.created_at) < (staff ? ms(staff.created_at) : Infinity) && ms(nextLog.analyzed_msg_ts) >= ms(l.analyzed_msg_ts) - TOL) continue; // 同じ番の判断が上書きされた
        aixTurns++;
        if (!staff) { aixTurnsNothing++; continue; }
        if (!staff.is_aix_generated) {
          aixTurnsText++;
          // 通常の返信を先に送った後、同じ番のうちにブレインの AIX を押したか（送信で判断が消えるので、押す時にはカードが無い）
          const endTurn = nextCust ? ms(nextCust.created_at) : Infinity;
          const laterUse = v.uses.find((u) => ms(u.sent_at ?? u.created_at) > ms(staff.created_at) && ms(u.sent_at ?? u.created_at) < endTurn && sameAixAction(u.aix_type, l.suggested_action));
          if (laterUse) { textThenSame++; textThenGap.push(ms(laterUse.sent_at ?? laterUse.created_at) - ms(staff.created_at)); if (exTextThen.length < EX) exTextThen.push(`${name} 判断 ${l.suggested_action} ${jst(l.created_at)} → 返信「${short(staff.text, 24)}」${jst(staff.created_at)} → AIX ${jst(laterUse.sent_at ?? laterUse.created_at)}`); }
          continue;
        }
        const use = v.uses.find((u) => Math.abs(ms(u.sent_at ?? u.created_at) - ms(staff.created_at)) < 90_000);
        if (use && sameAixAction(use.aix_type, l.suggested_action)) aixTurnsPressedSame++; else aixTurnsPressedOther++;
      }
    }

    // A: 同じ発言への判断が「AIX あり（返信モード＝下書きの控えになる）」→ スタッフの送信 →「AIX なし」の順（旧は控えで出続けた）
    // C: 返信モードの AIX（控え）が点滅の種類で、その後に AIX を送ってから次のお客様の発言までの長さ（旧は点滅・✓確認したが残った）
    if (!test) {
      for (let i = 0; i < v.logs.length; i++) {
        const l = v.logs[i];
        if (!(l.suggested_action && BRAIN_AIX_LABELS[l.suggested_action] && l.suggested_reply_mode !== "aix")) continue;
        const nextCust = v.msgs.find((m) => m.sender === "customer" && ms(m.created_at) > ms(l.created_at));
        const endT = nextCust ? ms(nextCust.created_at) : Date.now();
        const laterEmpty = v.logs.slice(i + 1).find((x) => ms(x.created_at) < endT && ms(x.analyzed_msg_ts) >= ms(l.analyzed_msg_ts) - TOL && !x.suggested_action);
        if (laterEmpty) { aFallback++; if (exA.length < EX) exA.push(`${name} ${jst(l.created_at)} ${l.suggested_action}（返信モード）→ ${jst(laterEmpty.created_at)} AIXなし（${laterEmpty.decision_source ?? ""}）`); }
        if (["property_check_result", "meeting_place", "estimate_sheet"].includes(l.suggested_action)) {
          const aixSent = v.msgs.find((m) => m.sender === "staff" && m.is_aix_generated && ms(m.created_at) > ms(l.created_at) && ms(m.created_at) < endT);
          if (aixSent) { cPersist++; const d = endT - ms(aixSent.created_at); cDur.push(d); if (exC.length < EX) exC.push(`${name} 判断 ${l.suggested_action} ${jst(l.created_at)} → AIX 送信 ${jst(aixSent.created_at)} → 次の発言 ${nextCust ? jst(nextCust.created_at) : "（まだ）"}（残り ${Math.round(d / 60000)}分）`); }
        }
      }
    }

    // YUMA の今日の往復（読むだけ）
    if (cid === YUMA_CONVERSATION_ID) {
      for (const e of evs) {
        const at = new Date(e.t + 9 * 3600e3).toISOString().slice(0, 10);
        if (at !== todayJst) continue;
        const before = stateAt(e.t + 1, true), after = stateAt(e.t + 1, false);
        const what = e.kind === "log" ? `ブレイン ${e.log!.suggested_action || "AIXなし"}/${e.log!.suggested_reply_mode ?? ""}（${e.log!.decision_source ?? ""}）`
          : `${e.kind === "cust" ? "お客様" : e.msg!.is_aix_generated ? "スタッフAIX" : "スタッフ"}「${short(e.msg!.text, 26)}」`;
        yumaLines.push(`  ${jst(new Date(e.t).toISOString())} ${what} → 画面 旧=${before.sum.shown ?? "なし"}(${before.sum.channel}) 新=${after.sum.shown ?? "なし"}(${after.sum.channel})${after.view.listBadge ? " 一覧AIX" : ""}`);
      }
    }
  }

  // ⑤ 今の判断（会話ごとの last_brain_meta）で、記録に残らない項目の型
  let snapN = 0, noteEmpty = 0, twoPre = 0, twoNoNote = 0, altPre = 0, twoTotal = 0, altTotal = 0, twoDraft = 0;
  const exSnap: string[] = [];
  const PRE = new Set(["viewing_invite", "meeting_place", "property_send", "estimate_sheet"]);
  for (const c of convs) {
    if (isTestConversation(c.id)) continue;
    for (const [col, raw] of [["suggested", c.suggested_aix_meta], ["last", c.last_brain_meta]] as const) {
      if (col === "suggested") continue; // last_brain_meta は本分析の控え（表示で消えない）
      const m = raw as AixViewMeta | null;
      if (!m || m.source === "cached" || m.source === "aix_patch" && !m.action) continue;
      snapN++;
      const valid = !!(m.action && BRAIN_AIX_LABELS[m.action]);
      if (valid && !(m.note ?? "").trim()) { noteEmpty++; if (exSnap.length < EX) exSnap.push(`${c.customer_name} note 空・${m.action}`); }
      if (m.two_choice_mode) { twoTotal++; if (PRE.has(m.action ?? "")) { twoPre++; if (exSnap.length < EX * 2) exSnap.push(`${c.customer_name} 2択×${m.action}（帯が先に出てカードが隠れる）`); } if (!(m.note ?? "").trim()) twoNoNote++; }
      const alts = (m.alt_actions ?? []).filter((a) => a !== m.action && BRAIN_AIX_LABELS[a]);
      if (alts.length) { altTotal++; if (PRE.has(m.action ?? "")) { altPre++; if (exSnap.length < EX * 3) exSnap.push(`${c.customer_name} ${m.action}＋2つ目 ${alts.join(",")}（帯が先に出て2つ目が出ない）`); } }
      if (m.two_choice_mode && m.reply_mode !== "aix") twoDraft++;
    }
  }

  // ── 出力 ──
  console.log(`\n■ 表示の遅れ（お客様の発言 → その発言を見たブレインの判断の保存）: 番 ${turns}`);
  console.log(`  中央 ${sec(quant(delays, 0.5))}・90% ${sec(quant(delays, 0.9))}・最大 ${sec(quant(delays, 0.999))}（件数 ${delays.length}）＋画面の再取得は最大30秒`);
  console.log(`  スタッフが返すまでに判断が来なかった番 ${turnsNoBrainBeforeStaff}（${pct(turnsNoBrainBeforeStaff, turns)}）／判断が一度も来なかった発言がある会話 ${turnsNeverAnalyzed}`);
  exDelay.forEach((x) => console.log(`   例 ${x}`));
  console.log(`\n■ 古い判断の書き込み（保存した時点で、判断が見た発言より新しいお客様の発言がある）: ${staleWrites}件（うち AIX 要対応の判断 ${staleWritesAix}件・一覧のバッジが古い判断で出ていた延べ ${Math.round(staleBadgeMin)}分）`);
  console.log(`  新しい発言の判断で置き換わった ${staleFixed.length}（中央 ${sec(quant(staleFixed, 0.5))}・90% ${sec(quant(staleFixed, 0.9))}）・置き換わる前に次の出来事（送信・発言） ${staleNotFixed}`);
  exStale.forEach((x) => console.log(`   例 ${x}`));
  console.log(`\n■ スタッフが押した AIX と、その時画面が出していた AIX（旧の動き → 今の動き）`);
  const cats = [...new Set([...Object.keys(pressCat), ...Object.keys(pressCatNew)])].sort();
  const totalP = Object.values(pressCat).reduce((a, b) => a + b, 0);
  for (const k of cats) console.log(`  ${k}: ${pressCat[k] ?? 0}（${pct(pressCat[k] ?? 0, totalP)}） → ${pressCatNew[k] ?? 0}`);
  console.log(`  ②の内訳（画面→押した）: ${Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} ${n}`).join("・")}`);
  for (const k of cats) (exPress[k] ?? []).forEach((x) => console.log(`   例[${k.slice(0, 2)}] ${x}`));
  console.log(`\n■ ブレインが AIX（reply_mode=aix）を出した番 ${aixTurns}: 同じ AIX を押した ${aixTurnsPressedSame}（${pct(aixTurnsPressedSame, aixTurns)}）・別の AIX ${aixTurnsPressedOther}・通常の返信 ${aixTurnsText}・何も送らず次へ ${aixTurnsNothing}`);
  console.log(`  通常の返信を先に送り、同じ番のうちにその AIX を押した ${textThenSame}（返信→AIX の間 中央 ${Math.round(quant(textThenGap, 0.5) / 60000)}分）＝押す時にはカード・帯が消えていた`);
  exTextThen.forEach((x) => console.log(`   例 ${x}`));
  console.log(`\n■ A 控えの AIX が「AIX なし」の後も出続ける（同じ発言への判断が 返信モード＋AIX → AIX なし）: ${aFallback}件`);
  exA.forEach((x) => console.log(`   例 ${x}`));
  console.log(`\n■ C 点滅の種類の控えが AIX を送った後も残る: ${cPersist}件（残った長さ 中央 ${Math.round(quant(cDur, 0.5) / 60000)}分・90% ${Math.round(quant(cDur, 0.9) / 60000)}分）`);
  exC.forEach((x) => console.log(`   例 ${x}`));
  console.log(`\n■ G 同じ会話に AIX の判断が2回以上（旧は1回 ✕・押下すると同じタブの間は次の判断でもカード・帯が出ない）: 会話 ${gConvs}・影響し得る判断 ${gAtRisk}`);
  console.log(`\n■ 今の判断（last_brain_meta ${snapN}会話）で見る型`);
  console.log(`  F AIX があるのに note が空（旧はカードが出ない）: ${noteEmpty}`);
  console.log(`  E 2択 ${twoTotal} のうち 帯の種類（内覧・待ち合わせ・物件ピックアップ・見積書）${twoPre}（旧は帯が先に出て2択が出ず AIX ボタンも隠れる）・2択で note 空 ${twoNoNote}・2択なのに返信モード ${twoDraft}`);
  console.log(`  E 2つ目の AIX ${altTotal} のうち 帯の種類 ${altPre}（旧は帯が先に出て2つ目のボタンが出ない）`);
  exSnap.forEach((x) => console.log(`   例 ${x}`));
  console.log(`\n■ YUMA の今日（${todayJst}・読むだけ）`);
  yumaLines.forEach((x) => console.log(x));
}
main().catch((e) => { console.error(e); process.exit(1); });

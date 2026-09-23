// S1「条件フォーム受信（初回の一手）」の生成と実送信のギャップを測る（読み取りのみ・LLM は呼ばない）
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして生成される文にギャップが生まれないか確認する」
//   S1 は YUMA に staffHasEngaged=true の履歴があるため再現できない → (c) 純関数の今月全件当て ＋ (b) 下書きと実送信の対 で測る。
//
// 【出す物】
//   A. 今月の「真の初回の条件フォーム」（スタッフの送信が1件も無い会話で、お客様が ①〜⑤ の条件フォームを送った通）
//      ・ブレイン側: guard:first_contact の行（scene_evidence・suggested_action）と、first-contact-pickup（純関数）を当てた値
//      ・要対応（aix_action_items・2時間以内）／押した AIX（aix_usage_logs・3時間以内と14日以内）／スタッフの最初の返信の種類
//   B. 下書きと実送信の対（ai_reply_examples）: 行の役割・約束・申込導線・禁止語・作業メモ・長さを、下書き側と実送信側で並べる
//   C. 本文の全文（伏せ字）を対で読む（件数の表だけで判断しない）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-s1-first-contact-gap.ts [SINCE=2026-09-01] [FULL=1]
import { createClient } from "@supabase/supabase-js";
import { isConditionFormMessage } from "../app/lib/reply-context";
import { resolveFirstContactPickup } from "../app/lib/first-contact-pickup";
import { isRentNegotiationPromise } from "../app/lib/rent-negotiation-guard";
import { detectRecommendApplyLine } from "../app/lib/apply-line-rates";
import { classifySentKind, checkSentShape } from "../app/lib/sent-shape";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SINCE_JST = process.env.SINCE ?? "2026-09-01";
const since = new Date(`${SINCE_JST}T00:00:00+09:00`).toISOString();
const FULL = process.env.FULL === "1";
const WON_STATUSES = ["closed_won", "applying", "screening", "application", "contract", "approved"];
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
/** 今日の改善のデプロイ（debdaabf 15:12 JST）。以後の対は「改善後」 */
const DEPLOY_AT = Date.parse("2026-09-23T15:15:00+09:00");
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました）|\[返信不要\])\s*$/;

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const jst = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ") : "—");
const hours = (a: string | null | undefined, b: string | null | undefined) =>
  a && b ? ((Date.parse(b) - Date.parse(a)) / 3600_000).toFixed(1) : "—";
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null };
type Log = { id: string; conversation_id: string; created_at: string; suggested_action: string | null; decision_source: string | null; analysis_mode: string | null; analyzed_msg_ts: string | null; digest: { aix?: string | null; dir?: string | null; intent?: string | null } | null; scene_evidence: string | null; conversation_status: string | null };
type Aix = { conversation_id: string; aix_type: string | null; created_at: string };
type Item = { conversation_id: string; action: string | null; status: string | null; created_at: string };
type Ex = { id: string; conversation_id: string; created_at: string; conversation_state: string | null; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; was_ai_used: boolean | null; ai_similarity: number | null; aix_action: string | null; reply_context_snapshot: Record<string, unknown> | null };
type Conv = { id: string; status: string | null; customer_name: string | null };

// ─── 伏せ字 ───
function makeMask(name: string | null | undefined) {
  const n = (name ?? "").trim();
  return (s: string | null | undefined) => {
    let t = (s ?? "").replace(/\r/g, "");
    if (n && n.length >= 2) t = t.split(n).join("〇〇");
    // 表示名の一部（絵文字・記号で割った断片）で呼ばれている事が多いので、断片ごとにも伏せる。1文字の断片は「Xさん」の形だけ
    for (const tok of n.split(/[^A-Za-z0-9一-龥ぁ-んァ-ヶー]+/).filter(Boolean)) {
      if (tok.length >= 2) t = t.split(tok).join("〇〇");
      else t = t.split(`${tok}さん`).join("〇〇さん");
    }
    // 本文中の「〇〇さん／様」の呼び名は本名かニックネームか区別できないので、区切りの後の呼び名も伏せる
    t = t.replace(/(^|[\s、。！!\n「『(（])([^\s、。！!\n「『(（]{1,8})(さん|様)(?=[、,。！!\s\n「』)）]|$)/g, "$1〇〇$3");
    t = t.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "***-****").replace(/https?:\/\/\S+/g, "[URL]");
    return t;
  };
}

// ─── 行の役割・材料の検出（下書きと実送信に同じ関数を当てる＝四者同名）───
const RE = {
  hajimemashite: /はじめまして|初めまして/,
  selfIntro: /と申します/,
  condThanks: /ご?条件[^\n。！!]{0,8}お送り(?:頂|いただ)き[^\n。！!]{0,4}ありがとう|ご(?:入力|記入)(?:頂|いただ)き[^\n。！!]{0,4}ありがとう/,
  kashikomari: /かしこまりました/,
  pickup: /ピックアップ/,
  sendDeclare: /お送り(?:させて頂きます|させていただきます|致します|いたします|します)/,
  estimate: /御見積書|見積書|お見積/,
  discount: /最大限割引|割引/,
  applyCta: /お申込|申込|申し込み/,
  nanitozo: /何卒(?:よろしく|宜しく)お願い/,
  forbidden: /お待たせ致しました|お待たせいたしました|全力サポート|いつでもお気軽に/,
  askCond: /お聞かせ|お教え(?:頂|いただ)け|教えて(?:頂|いただ)け/,
  confirmPromise: /確認(?:させて頂きます|させていただきます|致します|いたします|します)/,
  viewing: /内覧|内見/,
  screening: /審査/,
  emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
  meta: /への返信です|^\s*[-=━─]{3,}\s*$|^\s*#+\s|^\s*【(?:下書き|返信案|案|AI)[^】]*】\s*$/m,
  greetingOnly: /この度ご連絡頂きありがとうございます/,
  campaign: /キャンペーン|イエヤス割|還元/,
  today: /本日中|本日/,
};
type Feat = { flags: Record<string, boolean>; chars: number; lines: number; blanks: number; kind: string; longLines: number; applyKind: string | null };

function extractForm(text: string): { area: string[]; rent: string | null; layout: string | null; movein: string | null } {
  const t = text ?? "";
  const pick = (label: RegExp) => { const m = t.match(label); return m ? (m[1] ?? "").trim() : null; };
  // 項目の値は「】⇒値」か、次の行に書かれる（お客様がテンプレを貼って値を次行に書く形が多い）
  const val = (label: RegExp) => {
    const m = t.match(new RegExp(`(?:${label.source})[^】\\n]*】\\s*[⇒→➡:：]?\\s*([^\\n]*)\\n?([^\\n①②③④⑤⑥⑦⑧]*)`));
    if (!m) return null;
    const same = (m[1] ?? "").trim(), next = (m[2] ?? "").trim();
    const v = same || next;
    return v && !/^[①②③④⑤⑥⑦⑧]/.test(v) ? v : null;
  };
  const areaRaw = val(/希望エリア|希望の?エリア|エリア/) ?? "";
  const area = areaRaw.split(/[・、,，／/\s〜~]+/).map((s) => s.replace(/(?:駅|周辺|付近|エリア|辺り|あたり|全域|沿線|線)$/g, "").trim()).filter((s) => s.length >= 2);
  return {
    area,
    rent: val(/ご?希望の?家賃|家賃/),
    layout: val(/希望の?広さ|間取り/),
    movein: val(/入居の?時期/),
  };
}

function feats(text: string, form: ReturnType<typeof extractForm>): Feat {
  const t = (text ?? "").replace(/\r/g, "");
  const lines = t.split("\n");
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const sentences = t.split(/(?<=[。！!\n])/).map((s) => s.trim()).filter(Boolean);
  const sc = checkSentShape(t);
  const flags: Record<string, boolean> = {
    rentNeg: sentences.some((s) => isRentNegotiationPromise(s)),
    areaMention: form.area.some((a) => t.includes(a)),
    rentMention: !!form.rent && /万円?|万/.test(form.rent) && (() => { const nums = form.rent!.match(/[0-9０-９.]+/g) ?? []; return nums.some((n) => t.includes(n)); })(),
    layoutMention: !!form.layout && (form.layout.match(/[0-9０-９]?(?:LDK|DK|K|R|ワンルーム)/g) ?? []).some((l) => t.includes(l)),
  };
  for (const [k, re] of Object.entries(RE)) flags[k] = re.test(t);
  return {
    flags, chars: t.replace(/\s/g, "").length, lines: nonEmpty.length, blanks: lines.length - nonEmpty.length,
    kind: classifySentKind(t), longLines: sc.longLines.length, applyKind: detectRecommendApplyLine(t).kind,
  };
}

async function main() {
  console.log(`=== S1 条件フォーム受信（真の初回）: 生成と実送信のギャップ（${SINCE_JST}〜・読み取りのみ）===\n`);
  // ① 今月のお客様の発言（テキスト）
  const custMsgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url")
    .gte("created_at", since).eq("sender", "customer").order("created_at").range(a, b));
  const formMsgs = custMsgs.filter((m) => m.conversation_id !== YUMA && isConditionFormMessage(m.text ?? ""));
  const convIds = [...new Set(formMsgs.map((m) => m.conversation_id))];
  console.log(`今月のお客様発言 ${custMsgs.length}通 ／ 条件フォーム ${formMsgs.length}通（${convIds.length}会話）`);

  // ② それらの会話の全メッセージ・ログ・AIX・要対応・対・会話
  const [allMsgs, logs, aix, items, exs, convs] = await Promise.all([
    all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url").in("conversation_id", convIds).order("created_at").range(a, b)),
    all<Log>((a, b) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, suggested_action, decision_source, analysis_mode, analyzed_msg_ts, digest, scene_evidence, conversation_status").in("conversation_id", convIds).gte("created_at", since).order("created_at").range(a, b)),
    all<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").in("conversation_id", convIds).gte("created_at", since).order("created_at").range(a, b)),
    all<Item>((a, b) => sb.from("aix_action_items").select("conversation_id, action, status, created_at").in("conversation_id", convIds).gte("created_at", since).order("created_at").range(a, b)),
    all<Ex>((a, b) => sb.from("ai_reply_examples").select("id, conversation_id, created_at, conversation_state, customer_message, ai_draft, sent_reply, was_ai_used, ai_similarity, aix_action, reply_context_snapshot").in("conversation_id", convIds).gte("created_at", since).order("created_at").range(a, b)),
    all<Conv>((a, b) => sb.from("conversations").select("id, status, customer_name").in("id", convIds).range(a, b)),
  ]);
  const convOf = new Map(convs.map((c) => [c.id, c]));
  const msgsByConv = new Map<string, Msg[]>();
  for (const m of allMsgs) { const a = msgsByConv.get(m.conversation_id) ?? []; a.push(m); msgsByConv.set(m.conversation_id, a); }
  const isStaffText = (m: Msg) => m.sender === "staff" && !!(m.text ?? "").trim() && !/^\[(?:画像|動画|スタンプ|ファイル)\]\s*$/.test((m.text ?? "").trim());

  // ③ 真の初回（フォームより前にスタッフのテキスト送信が無い）
  type Row = {
    m: Msg; conv: Conv; won: boolean; form: ReturnType<typeof extractForm>;
    guard: Log | null; anyLog: Log | null; pick: string; item: Item | null; aix3h: Aix | null; aix14d: Aix | null;
    staffFirst: Msg | null; sfKind: string; ex: Ex | null;
  };
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const m of formMsgs) {
    const ms = msgsByConv.get(m.conversation_id) ?? [];
    const before = ms.filter((x) => x.created_at < m.created_at);
    if (before.some(isStaffText)) continue;
    if (seen.has(m.conversation_id)) continue; // 同じ会話でフォームを2回送った時は最初の1通
    seen.add(m.conversation_id);
    const conv = convOf.get(m.conversation_id) ?? { id: m.conversation_id, status: null, customer_name: null };
    const t0 = Date.parse(m.created_at);
    const convLogs = logs.filter((l) => l.conversation_id === m.conversation_id && Date.parse(l.created_at) >= t0 - 60_000 && Date.parse(l.created_at) <= t0 + 6 * 3600_000);
    const guard = convLogs.find((l) => l.decision_source === "guard:first_contact") ?? null;
    const anyLog = convLogs[0] ?? null;
    let sceneJson: { scene?: string; reason?: string; property_by?: string | null } | null = null;
    try { sceneJson = guard?.scene_evidence ? JSON.parse(guard.scene_evidence) : null; } catch { sceneJson = null; }
    const pick = resolveFirstContactPickup({ finalAix: null, custSentConditionForm: true, sceneEvidence: sceneJson }) ?? "null";
    const item = items.find((it) => it.conversation_id === m.conversation_id && Date.parse(it.created_at) >= t0 - 60_000 && Date.parse(it.created_at) <= t0 + 2 * 3600_000) ?? null;
    const later = aix.filter((x) => x.conversation_id === m.conversation_id && Date.parse(x.created_at) >= t0);
    const aix3h = later.find((x) => Date.parse(x.created_at) <= t0 + 3 * 3600_000) ?? null;
    const aix14d = later.find((x) => Date.parse(x.created_at) <= t0 + 14 * 86400_000) ?? null;
    const staffFirst = ms.find((x) => x.created_at > m.created_at && isStaffText(x)) ?? null;
    const sf = staffFirst?.text ?? "";
    const sfKind = !staffFirst ? "(未返信)" : RE.pickup.test(sf) && !/募集状況/.test(sf) ? "ピックアップ宣言" : /募集状況|確認させて/.test(sf) ? "募集状況確認の宣言" : RE.askCond.test(sf) ? "条件のお願い" : /^\[画像\]/.test(sf) ? "画像" : "その他";
    // 対: フォーム以後 48 時間以内で、customer_message にフォームの一部が含まれる物を優先
    const head = (m.text ?? "").replace(/\s+/g, "").slice(0, 30);
    const cand = exs.filter((e) => e.conversation_id === m.conversation_id && Date.parse(e.created_at) >= t0 - 60_000 && Date.parse(e.created_at) <= t0 + 48 * 3600_000);
    const ex = cand.find((e) => (e.customer_message ?? "").replace(/\s+/g, "").includes(head)) ?? cand[0] ?? null;
    rows.push({ m, conv, won: WON_STATUSES.includes(conv.status ?? ""), form: extractForm(m.text ?? ""), guard, anyLog, pick, item, aix3h, aix14d, staffFirst, sfKind, ex });
  }
  const won = rows.filter((r) => r.won);
  console.log(`真の初回の条件フォーム ${rows.length}通（会話）／ 成約側（申込以降まで進んだ）${won.length}\n`);

  // ─── A. ブレイン側 ───
  console.log(`=== A. ブレイン側（初回ガードの記録 と first-contact-pickup 純関数）===`);
  const cnt = <T,>(xs: T[], key: (x: T) => string) => { const mm = new Map<string, number>(); for (const x of xs) mm.set(key(x), (mm.get(key(x)) ?? 0) + 1); return [...mm].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" ／ "); };
  console.log(`   ガード行あり: ${rows.filter((r) => r.guard).length}／${rows.length}（ログ自体あり ${rows.filter((r) => r.anyLog).length}）`);
  console.log(`   ガード行の suggested_action: ${cnt(rows.filter((r) => r.guard), (r) => (r.guard!.suggested_action ?? "").trim() || "(空)")}`);
  console.log(`   ガード行の digest.aix: ${cnt(rows.filter((r) => r.guard), (r) => r.guard!.digest?.aix ?? "(null)")}`);
  console.log(`   純関数 resolveFirstContactPickup: ${cnt(rows, (r) => r.pick)}`);
  console.log(`   要対応（2時間以内）: ${cnt(rows, (r) => r.item ? `${r.item.action}` : "(なし)")}`);
  console.log(`   押した AIX（3時間以内）: ${cnt(rows, (r) => r.aix3h?.aix_type ?? "(押さず)")}`);
  console.log(`   押した AIX（14日以内・最初）: ${cnt(rows, (r) => r.aix14d?.aix_type ?? "(押さず)")}`);
  console.log(`   スタッフの最初の返信: ${cnt(rows, (r) => r.sfKind)}`);
  console.log(`   純関数 property_send と押した AIX（3h）の一致: ${rows.filter((r) => r.aix3h?.aix_type === "property_send").length}／${rows.length}（14日: ${rows.filter((r) => r.aix14d?.aix_type === "property_send").length}）`);
  const lagsPS = rows.filter((r) => r.aix14d?.aix_type === "property_send").map((r) => (Date.parse(r.aix14d!.created_at) - Date.parse(r.m.created_at)) / 3600_000);
  const lagsSF = rows.filter((r) => r.staffFirst).map((r) => (Date.parse(r.staffFirst!.created_at) - Date.parse(r.m.created_at)) / 3600_000);
  console.log(`   物件送付（property_send）を押すまでの時間: 中央値 ${median(lagsPS).toFixed(1)}h ／ 3h以内 ${lagsPS.filter((h) => h <= 3).length} ／ 24h以内 ${lagsPS.filter((h) => h <= 24).length} ／ 72h以内 ${lagsPS.filter((h) => h <= 72).length}（n=${lagsPS.length}）`);
  console.log(`   スタッフの最初の返信までの時間: 中央値 ${median(lagsSF).toFixed(1)}h ／ 1h以内 ${lagsSF.filter((h) => h <= 1).length}／${lagsSF.length}`);
  const sinceGuard = rows.filter((r) => Date.parse(r.m.created_at) >= Date.parse("2026-09-13T00:00:00+09:00"));
  console.log(`   09-13 以降（初回ガードに記録が付いてから）${sinceGuard.length}件: 要対応=${cnt(sinceGuard, (r) => r.item ? `${r.item.action}(${r.item.status})` : "(なし)")}`);
  console.log(`   成約側 ${won.length}: 押した3h=${cnt(won, (r) => r.aix3h?.aix_type ?? "(押さず)")} ／ 最初の返信=${cnt(won, (r) => r.sfKind)}`);
  console.log(`\n   会話ごと:`);
  for (const r of rows) {
    console.log(`   ${jst(r.m.created_at)} ${r.conv.id.slice(0, 8)} status=${String(r.conv.status).padEnd(14)}${r.won ? "【成約側】" : "        "} ガード=${r.guard ? `${(r.guard.suggested_action ?? "").trim() || "(空)"}(${r.guard.analysis_mode})` : "なし"}`.padEnd(120)
      + ` 要対応=${r.item ? `${r.item.action}(${r.item.status})` : "なし"} 押した3h=${r.aix3h?.aix_type ?? "—"} 14d=${r.aix14d?.aix_type ?? "—"} 最初の返信=${r.sfKind}${r.staffFirst ? `(${hours(r.m.created_at, r.staffFirst.created_at)}h${r.staffFirst.is_aix_generated ? "・AIX" : ""})` : ""} 対=${r.ex ? (MARK.test((r.ex.ai_draft ?? "").trim()) ? `[${(r.ex.ai_draft ?? "").trim()}]` : "下書きあり") : "なし"}`);
  }

  // ─── B. 対（下書き vs 実送信）───
  const pairs = rows.filter((r) => r.ex && (r.ex.ai_draft ?? "").trim() && (r.ex.sent_reply ?? "").trim() && !MARK.test((r.ex.ai_draft ?? "").trim()) && !MARK.test((r.ex.sent_reply ?? "").trim()));
  const sentOnly = rows.filter((r) => r.staffFirst && !pairs.includes(r));
  console.log(`\n=== B. 対（下書きと実送信が両方ある）${pairs.length}件 ／ 実送信だけ ${sentOnly.length}件 ／ 改善後（${jst(new Date(DEPLOY_AT).toISOString())}〜）の対 ${pairs.filter((r) => Date.parse(r.ex!.created_at) >= DEPLOY_AT).length}件 ===`);
  const D = pairs.map((r) => feats(r.ex!.ai_draft ?? "", r.form));
  const S = pairs.map((r) => feats(r.ex!.sent_reply ?? "", r.form));
  // 実送信の物差しは「対」の実送信＋対が無い実送信（スタッフの最初の返信）の両方で出す
  const SALL = rows.filter((r) => r.staffFirst).map((r) => feats(r.ex?.sent_reply?.trim() && !MARK.test(r.ex.sent_reply.trim()) && pairs.includes(r) ? r.ex.sent_reply! : r.staffFirst!.text ?? "", r.form));
  const keys = ["hajimemashite", "selfIntro", "greetingOnly", "condThanks", "kashikomari", "pickup", "sendDeclare", "areaMention", "rentMention", "layoutMention", "estimate", "discount", "applyCta", "nanitozo", "emoji", "askCond", "confirmPromise", "viewing", "screening", "campaign", "today", "forbidden", "meta", "rentNeg"];
  const ja: Record<string, string> = {
    hajimemashite: "はじめまして", selfIntro: "〜と申します（名乗り）", greetingOnly: "この度ご連絡頂き…（挨拶の定型）", condThanks: "ご条件お送り頂きありがとう", kashikomari: "かしこまりました", pickup: "ピックアップ宣言", sendDeclare: "お送りさせて頂きます", areaMention: "エリア名（⑤）に触れる", rentMention: "家賃（②）の数字に触れる", layoutMention: "間取り（③）に触れる", estimate: "見積書に触れる", discount: "割引に触れる", applyCta: "申込の語", nanitozo: "何卒", emoji: "絵文字", askCond: "条件をお聞かせ（聞き直し）", confirmPromise: "確認します（約束）", viewing: "内覧に触れる", screening: "審査に触れる", campaign: "キャンペーン・還元", today: "本日", forbidden: "禁止語（お待たせ／全力サポート／いつでもお気軽に）", meta: "作業メモ混入", rentNeg: "家賃交渉の約束（guard）",
  };
  console.log(`   役割・材料                                      下書き(${D.length})   実送信・対(${S.length})   実送信・全(${SALL.length})   差(下書き−対)`);
  const gaps: string[] = [];
  for (const k of keys) {
    const d = D.filter((f) => f.flags[k]).length, s = S.filter((f) => f.flags[k]).length, sa = SALL.filter((f) => f.flags[k]).length;
    const dp = D.length ? (d / D.length) * 100 : 0, sp = S.length ? (s / S.length) * 100 : 0;
    const diff = dp - sp;
    const flag = Math.abs(diff) >= 10 ? "  ★ずれ" : "";
    console.log(`   ${ja[k].padEnd(28)} ${pct(d, D.length).padStart(7)} (${d})   ${pct(s, S.length).padStart(7)} (${s})   ${pct(sa, SALL.length).padStart(7)} (${sa})   ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pt${flag}`);
    if (Math.abs(diff) >= 10) gaps.push(`${ja[k]}: 下書き ${dp.toFixed(1)}% ／ 実送信 ${sp.toFixed(1)}%`);
  }
  const num = (xs: Feat[], k: "chars" | "lines" | "blanks" | "longLines") => median(xs.map((f) => f[k]));
  console.log(`   文字数 中央値: 下書き ${num(D, "chars")} ／ 実送信・対 ${num(S, "chars")} ／ 実送信・全 ${num(SALL, "chars")}`);
  console.log(`   行数 中央値:   下書き ${num(D, "lines")} ／ 実送信・対 ${num(S, "lines")} ／ 実送信・全 ${num(SALL, "lines")}`);
  console.log(`   空行 中央値:   下書き ${num(D, "blanks")} ／ 実送信・対 ${num(S, "blanks")} ／ 実送信・全 ${num(SALL, "blanks")}`);
  console.log(`   55字超の行がある: 下書き ${D.filter((f) => f.longLines > 0).length} ／ 実送信・対 ${S.filter((f) => f.longLines > 0).length}`);
  console.log(`   返信の種類(classifySentKind): 下書き ${cnt(D, (f) => f.kind)} ／ 実送信・対 ${cnt(S, (f) => f.kind)}`);
  console.log(`   申込導線の種類(detectRecommendApplyLine): 下書き ${cnt(D, (f) => f.applyKind ?? "なし")} ／ 実送信・対 ${cnt(S, (f) => f.applyKind ?? "なし")}`);
  console.log(`   そのまま送信(was_ai_used): ${pairs.filter((r) => r.ex!.was_ai_used).length}／${pairs.length}（${pct(pairs.filter((r) => r.ex!.was_ai_used).length, pairs.length)}）`);
  const band = (sim: number | null) => sim === null ? "不明" : sim >= 0.95 ? "ほぼ同じ" : sim >= 0.8 ? "少し直した" : sim >= 0.6 ? "半分書き直し" : sim >= 0.35 ? "大きく書き直し" : "別の文";
  console.log(`   直しの大きさ: ${cnt(pairs, (r) => band(r.ex!.ai_similarity))}`);
  console.log(`   場面（snapshot）: ${cnt(pairs, (r) => { const s = r.ex!.reply_context_snapshot ?? {}; const tp = s.turnPair as { ruleId?: string } | undefined; return `state=${r.ex!.conversation_state ?? "?"}/tier=${String((s as { tier?: unknown }).tier ?? "?")}/rule=${tp?.ruleId ?? "?"}`; })}`);
  console.log(`\n   ★ずれ（10pt 以上）: ${gaps.length ? gaps.join(" ／ ") : "なし"}`);

  // ─── C. 全文を対で読む ───
  console.log(`\n=== C. 本文を対で読む（伏せ字・古い→新しい）===`);
  for (const [i, r] of pairs.entries()) {
    const mask = makeMask(r.conv.customer_name);
    const e = r.ex!;
    console.log(`\n#${i + 1} ${jst(r.m.created_at)} ${r.conv.id.slice(0, 8)} ${r.won ? "【成約側】" : ""} そのまま=${e.was_ai_used ? "はい" : "いいえ"} 似ている度=${e.ai_similarity ?? "—"}（${band(e.ai_similarity)}） 押した3h=${r.aix3h?.aix_type ?? "—"} 最初の返信=${r.sfKind}`);
    console.log(`   フォーム: 入居=${mask(r.form.movein ?? "—")} 家賃=${mask(r.form.rent ?? "—")} 間取り=${mask(r.form.layout ?? "—")} エリア=${r.form.area.join("・") || "—"}  state=${e.conversation_state ?? "?"}`);
    const custBody = mask((r.m.text ?? "")).replace(/_{5,}[\s\S]*$/, "").replace(/\s+/g, " ");
    console.log(`   お客様（フォーム以外の文も含む・先頭260字）: ${custBody.slice(0, 260)}`);
    const otherCust = (msgsByConv.get(r.conv.id) ?? []).filter((x) => x.sender === "customer" && x.id !== r.m.id && Date.parse(x.created_at) <= Date.parse(r.m.created_at) + 30 * 60_000);
    if (otherCust.length) console.log(`   お客様の前後30分の他の発言: ${otherCust.map((x) => mask(x.text ?? (x.image_url ? "[画像]" : "")).replace(/\s+/g, " ").slice(0, 80)).join(" ／ ")}`);
    console.log(`   ── 下書き ──`);
    console.log(mask(e.ai_draft).split("\n").map((l) => `   │ ${l}`).join("\n"));
    console.log(`   ── 実送信 ──`);
    console.log(mask(e.sent_reply).split("\n").map((l) => `   │ ${l}`).join("\n"));
  }
  if (FULL) {
    console.log(`\n=== C'. 対が無い実送信（スタッフの最初の返信）${sentOnly.length}件 ===`);
    for (const r of sentOnly) {
      const mask = makeMask(r.conv.customer_name);
      console.log(`\n・${jst(r.m.created_at)} ${r.conv.id.slice(0, 8)} ${r.won ? "【成約側】" : ""} 押した3h=${r.aix3h?.aix_type ?? "—"} 対=${r.ex ? `[${(r.ex.ai_draft ?? "").trim().slice(0, 20)}]` : "なし"}`);
      console.log(mask(r.staffFirst!.text).split("\n").map((l) => `   │ ${l}`).join("\n"));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

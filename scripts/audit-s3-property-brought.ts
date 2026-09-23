// 場面 S3「お客様が物件を持ってきた（URL・画像・物件情報のコピペ → 物件確認）」の実物を今月の実送信から集める（読み取りのみ）
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして 生成される文にギャップが生まれないか確認する」
//
// 【場面の決め方】こちらの返信（ai_reply_examples）の直前の「お客様の番」（前のスタッフ送信より後の messages）に
//   URL／画像／物件情報のコピペ（築・階・円・LDK・号室・住所 のうち 2 つ以上）があるもの。条件フォームは除く。
//   ⚠ 実送信 12,000 通の分類器（sent-shape customerSceneOf）は「物件の画像・URLだけ」しか持たないので、
//     コピペ型はここで追加して数える（四者同名ではない。率は本スクリプトの中でだけ比べる）。
//
// 【数える物】件数の取り違え（お客様が持ってきた数 ↔ 本文の「N件」）／物件名を本文に挙げる／その場で結果を断定する
//   ／構成（受け・お礼・確認宣言・結果報告・締め）／申込 CTA／長さ／そのまま送信率。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-s3-property-brought.ts [SHOW=12] [SINCE=2026-09-01T00:00:00+09:00]
import { createClient } from "@supabase/supabase-js";
import { isConditionFormMessage } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました[^）]*）|\[返信不要\])\s*$/;
const WON_STATUSES = ["closed_won", "applying", "screening", "application", "contract", "approved"];

type Ex = { id: string; conversation_id: string | null; customer_message: string | null; sent_reply: string | null; ai_draft: string | null; was_ai_used: boolean | null; aix_action: string | null; sent_at: string | null; created_at: string; conversation_state: string | null; reply_context_snapshot: Record<string, unknown> | null };
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null };

const URL_RE = /https?:\/\/\S+/g;
const PASTE_MARKS: RegExp[] = [/築\s*[0-9０-９]+\s*年/, /[0-9０-９]+\s*階/, /[0-9０-９]{1,3},?[0-9０-９]{3}\s*円|[0-9０-９.]+\s*万円?/, /[1-4１-４]\s*(?:S?L?DK|K|R|LK)\b/i, /[0-9０-９]{2,4}\s*号室/, /(?:大阪府|兵庫県|京都府|奈良県)[^\n]{2,}/, /[0-9０-９.]+\s*(?:㎡|m2|平米|帖|畳)/];
function pasteScore(t: string): number { return PASTE_MARKS.filter((re) => re.test(t)).length; }

/** 本文の「N件」（件数の言及） */
function countMention(t: string): number | null {
  const m = /([0-9０-９]+|[一二三四五六七八九十]+)\s*(?:件|部屋|物件|つ)(?![0-9])/.exec(t.replace(/[0-9０-９]+\s*号室/g, ""));
  if (!m) return null;
  const s = m[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const kan: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return /^[0-9]+$/.test(s) ? Number(s) : kan[s] ?? null;
}
/** 本文に出る建物名らしい語（カタカナ 4 字以上・お客様の文か URL 以外から） */
function buildingNames(t: string): string[] {
  const names = new Set<string>();
  for (const m of t.replace(URL_RE, " ").matchAll(/[ァ-ヶー]{4,}(?:[A-Za-zＡ-Ｚ0-9０-９Ⅰ-Ⅹ]+)?/g)) names.add(m[0]);
  return [...names].filter((n) => !/^(?:ピックアップ|オススメ|エントランス|クリーニング|キャンペーン|フリーレント|マンション|アパート|エリア|オンライン|サポート|メッセージ|フォーマット|スクリーンショット|スクショ|タイミング|エアコン|インターネット|オートロック|バルコニー|クローゼット|ファミリー|カップル|シェア|システム)$/.test(n));
}
const ROLES: Array<[string, RegExp]> = [
  ["受け（かしこまりました等）", /かしこまりました|承知(?:いた|致)しました|了解/],
  ["受領（お送り頂き〜）", /(?:お送り|ご送付|ご共有|お伝え)(?:頂|いただ)き/],
  ["お礼", /ありがとうござ/],
  ["確認宣言（確認させて頂きます）", /確認(?:させて|いたし|致し|して)(?:頂き|いただき)?ま/],
  ["確認後の連絡", /(?:確認|分かり|わかり)(?:出来|でき)次第|(?:改めて|追って)ご連絡/],
  ["結果の断定（募集中／終了）", /現在?募集中|募集(?:が)?(?:終了|終わ)|空室|申込が入|ご案内(?:可能|出来)|埋ま(?:って|り)/],
  ["見積書の言及", /御見積書|お見積|見積書|初期費用/],
  ["内覧の誘い", /ご内覧|ご案内させて/],
  ["申込 CTA", /お申込|申込/],
  ["ピックアップ宣言", /ピックアップ/],
  ["何卒", /何卒/],
  ["お気軽に", /お気軽に/],
  ["絵文字", /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u],
];
const FORBID: Array<[string, RegExp]> = [["お待たせ致しました", /お待たせ(?:致|いた)しました/], ["全力サポート", /全力(?:で)?サポート/], ["いつでもお気軽に", /いつでもお気軽に/]];

/** 本名・電話・住所・URL を伏せる（出力に個人情報を書かない） */
function mask(t: string, names: string[]): string {
  let s = t;
  for (const n of names) if (n && n.length >= 2) s = s.split(n).join("〈お客様〉");
  return s.replace(URL_RE, "〈URL〉")
    .replace(/0[0-9]{1,4}-?[0-9]{2,4}-?[0-9]{3,4}/g, "〈電話〉")
    .replace(/〒?\s*[0-9０-９]{3}-?[0-9０-９]{4}[^\n]*/g, "〈住所〉")
    .replace(/(?:氏名|フリガナ|生年月日|現住所|勤務先名)[^\n]*/g, "〈個人情報〉")
    .replace(/担当させて頂きます[^\n！!]{1,6}と申します/g, "担当させて頂きます〈担当〉と申します");
}
async function pageAll<T>(table: string, select: string, gteCreatedAt: string, orderCol = "created_at"): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from(table).select(select).gte("created_at", gteCreatedAt).order(orderCol).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(table, error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const SHOW = Number(process.env.SHOW ?? 12);
  const since = new Date(process.env.SINCE ?? "2026-09-01T00:00:00+09:00").toISOString();
  const exs = await pageAll<Ex>("ai_reply_examples", "id, conversation_id, customer_message, sent_reply, ai_draft, was_ai_used, aix_action, sent_at, created_at, conversation_state, reply_context_snapshot", since);
  const convIds = [...new Set(exs.map((e) => e.conversation_id).filter((x): x is string => !!x))];
  const convs = new Map<string, { status: string | null; customer_name: string | null }>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, status, customer_name").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; status: string | null; customer_name: string | null }>) convs.set(c.id, c);
  }
  const msgs = await pageAll<Msg>("messages", "id, conversation_id, sender, text, image_url, created_at, is_aix_generated", new Date(Date.parse(since) - 7 * 86400_000).toISOString());
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  console.log(`[debug] 例 ${exs.length}・messages ${msgs.length}（${msgs[0]?.created_at} 〜 ${msgs[msgs.length - 1]?.created_at}）・会話 ${byConv.size}・URL入り客発言 ${msgs.filter((m) => m.sender === "customer" && URL_RE.test(m.text ?? "")).length}・画像 ${msgs.filter((m) => m.sender === "customer" && (m.image_url || /^\[画像\]/.test(m.text ?? ""))).length}`);
  let dbgNoTurn = 0, dbgForm = 0, dbgNoConv = 0;
  const aixLogs = await pageAll<{ conversation_id: string; aix_type: string; check_pattern: string | null; created_at: string; sent_at: string | null }>("aix_usage_logs", "conversation_id, aix_type, check_pattern, created_at, sent_at", since);

  type Case = { ex: Ex; turn: Msg[]; urls: number; images: number; pasted: number; kind: string; won: boolean; aixAfter: string[]; sentAt: number; lastCustAt: string };
  const cases: Case[] = [];
  for (const ex of exs) {
    if (!ex.conversation_id) continue;
    const s = (ex.sent_reply ?? "").trim();
    if (!s || MARK.test(s)) continue;
    const sentAt = Date.parse(ex.sent_at ?? ex.created_at);
    // 実送信そのものの行（messages に先に保存される）を境にする。本文一致・±10分。見つからなければ送信時刻の 500ms 前
    const all = byConv.get(ex.conversation_id) ?? [];
    const norm = (t: string) => t.replace(/\s+/g, "");
    const selfIdx = all.findIndex((m) => m.sender === "staff" && Math.abs(Date.parse(m.created_at) - sentAt) < 10 * 60_000 && norm(m.text ?? "") === norm(s));
    const list = selfIdx >= 0 ? all.slice(0, selfIdx) : all.filter((m) => Date.parse(m.created_at) < sentAt - 500);
    // 直前のスタッフ送信より後のお客様の番
    let lastStaffIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].sender === "staff") { lastStaffIdx = i; break; }
    const turn = list.slice(lastStaffIdx + 1).filter((m) => m.sender === "customer");
    if (!byConv.has(ex.conversation_id)) dbgNoConv++;
    if (!turn.length) { dbgNoTurn++; continue; }
    const texts = turn.map((m) => m.text ?? "");
    const joined = texts.join("\n");
    if (isConditionFormMessage(joined)) { dbgForm++; continue; }
    // 申込の書類・記入欄は「物件を持ってきた」ではない（本人確認書類の画像・申込者記入欄）
    if (/お申込者様記入欄|本人確認書類|申込フォーム/.test(joined)) { dbgForm++; continue; }
    const urls = (joined.match(URL_RE) ?? []).length;
    const images = turn.filter((m) => !!m.image_url || /^\[画像\]/.test(m.text ?? "")).length;
    // コピペは印 3 つ以上、または物件名・号室が明示（「1dk以上で8.9万」のような条件の文は 2 つ止まりなので除く）
    const pasted = texts.filter((t) => !URL_RE.test(t) && (pasteScore(t) >= 3 || (/物件名|号室/.test(t) && pasteScore(t) >= 2))).length;
    if (urls + images + pasted === 0) continue;
    const kind = urls ? "URL" : pasted ? "コピペ" : "画像";
    const conv = convs.get(ex.conversation_id);
    const lastCustAt = turn[turn.length - 1].created_at;
    const t0 = Date.parse(lastCustAt);
    const aixAfter = aixLogs.filter((l) => l.conversation_id === ex.conversation_id && Date.parse(l.created_at) >= t0 && Date.parse(l.created_at) <= t0 + 3 * 3600_000).map((l) => `${l.aix_type}${l.check_pattern ? `/${l.check_pattern}` : ""}`);
    cases.push({ ex, turn, urls, images, pasted, kind, won: WON_STATUSES.includes(conv?.status ?? ""), aixAfter, sentAt, lastCustAt });
  }
  const won = cases.filter((c) => c.won);
  console.log(`[debug] 会話なし ${dbgNoConv}・客の番なし ${dbgNoTurn}・条件フォーム ${dbgForm}`);
  console.log(`=== 場面 S3（お客様が物件を持ってきた）今月の実送信 ${cases.length}件（成約側 ${won.length}）／ 例の総数 ${exs.length} ===`);
  const kinds = new Map<string, number>(); for (const c of cases) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
  console.log(`   持ってきた形: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(" ／ ")}`);
  const withDraft = cases.filter((c) => c.ex.ai_draft && !MARK.test(c.ex.ai_draft));
  console.log(`   下書きあり ${withDraft.length}／ AIX 印あり ${cases.filter((c) => c.ex.aix_action).length}（${[...new Set(cases.map((c) => c.ex.aix_action).filter(Boolean))].join(", ")}）／ そのまま送信 ${pct(cases.filter((c) => c.ex.was_ai_used).length, cases.length)}（下書きあり分母 ${pct(withDraft.filter((c) => c.ex.was_ai_used).length, withDraft.length)}）`);
  const markKinds = new Map<string, number>();
  for (const c of cases) { const d = (c.ex.ai_draft ?? "").trim(); const k = !d ? "（下書きなし）" : MARK.test(d) ? d : "本文あり"; markKinds.set(k, (markKinds.get(k) ?? 0) + 1); }
  console.log(`   その時の ai_draft: ${[...markKinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" ／ ")}`);
  const aixKinds = new Map<string, number>();
  for (const c of cases) { const k = c.aixAfter[0] ?? "（3時間以内に AIX なし＝通常返信）"; aixKinds.set(k, (aixKinds.get(k) ?? 0) + 1); }
  console.log(`\n① 実物でスタッフが 3 時間以内に押した AIX（最初の 1 つ）`);
  for (const [k, n] of [...aixKinds].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${k}`);

  console.log(`\n② 構成（行の役割の出現率）実送信 ／ AI 下書き（下書きあり ${withDraft.length}件）`);
  for (const [name, re] of ROLES) {
    const s = cases.filter((c) => re.test(c.ex.sent_reply ?? "")).length;
    const sw = won.filter((c) => re.test(c.ex.sent_reply ?? "")).length;
    const a = withDraft.filter((c) => re.test(c.ex.ai_draft ?? "")).length;
    const d = (a / Math.max(withDraft.length, 1) - s / Math.max(cases.length, 1)) * 100;
    console.log(`   ${name.padEnd(22)} 実送信 ${pct(s, cases.length).padStart(6)}（成約側 ${pct(sw, won.length).padStart(6)}）／ AI ${pct(a, withDraft.length).padStart(6)} ／ 差 ${(d >= 0 ? "+" : "") + d.toFixed(1)}pt${Math.abs(d) >= 10 ? "  ← ずれ" : ""}`);
  }
  console.log(`   禁止語: ${FORBID.map(([n, re]) => `${n} 実送信 ${cases.filter((c) => re.test(c.ex.sent_reply ?? "")).length}／AI ${withDraft.filter((c) => re.test(c.ex.ai_draft ?? "")).length}`).join(" ／ ")}`);

  console.log(`\n③ 件数・物件名・断定`);
  const cnt = (list: Case[], pick: (c: Case) => string) => {
    let mention = 0, match = 0, mismatch = 0, name = 0, assert = 0;
    for (const c of list) {
      const t = pick(c); const n = countMention(t); const brought = c.urls + c.images + c.pasted;
      if (n != null) { mention++; if (n === brought) match++; else mismatch++; }
      const custNames = new Set(buildingNames(c.turn.map((m) => m.text ?? "").join("\n")));
      if (buildingNames(t).some((b) => custNames.has(b)) ) name++;
      if (ROLES[5][1].test(t)) assert++;
    }
    return { mention, match, mismatch, name, assert, n: list.length };
  };
  const rs = cnt(cases, (c) => c.ex.sent_reply ?? ""), ra = cnt(withDraft, (c) => c.ex.ai_draft ?? "");
  console.log(`   件数を書く       実送信 ${pct(rs.mention, rs.n)}（一致 ${rs.match}・不一致 ${rs.mismatch}）／ AI ${pct(ra.mention, ra.n)}（一致 ${ra.match}・不一致 ${ra.mismatch}）`);
  console.log(`   物件名を本文に   実送信 ${pct(rs.name, rs.n)} ／ AI ${pct(ra.name, ra.n)}（お客様の文にあるカタカナ名を本文にも書いた）`);
  console.log(`   結果を断定       実送信 ${pct(rs.assert, rs.n)} ／ AI ${pct(ra.assert, ra.n)}`);
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  const lines = (t: string) => t.split("\n").filter((l) => l.trim()).length;
  console.log(`\n④ 長さ（中央値） 実送信 ${med(cases.map((c) => (c.ex.sent_reply ?? "").length))}字・${med(cases.map((c) => lines(c.ex.sent_reply ?? "")))}行 ／ AI ${med(withDraft.map((c) => (c.ex.ai_draft ?? "").length))}字・${med(withDraft.map((c) => lines(c.ex.ai_draft ?? "")))}行`);
  console.log(`   snapshot turnPair: ${[...new Map(cases.map((c) => { const tp = (c.ex.reply_context_snapshot?.turnPair as Record<string, unknown> | undefined); const k = tp ? `${tp.staff}/${tp.customer}/${tp.ruleId}` : "（なし）"; return [k, 1] as const; })).keys()].slice(0, 12).join(" ｜ ")}`);

  console.log(`\n⑤ 実物（成約側→下書きあり→新しい順・${SHOW}件）`);
  const ordered = [...cases].sort((a, b) => Number(b.won) - Number(a.won) || Number(!!b.ex.ai_draft && !MARK.test(b.ex.ai_draft)) - Number(!!a.ex.ai_draft && !MARK.test(a.ex.ai_draft)) || b.sentAt - a.sentAt);
  for (const c of ordered.slice(0, SHOW)) {
    const conv = convs.get(c.ex.conversation_id ?? "");
    const names = [conv?.customer_name ?? ""].filter(Boolean);
    const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
    console.log(`\n── [${c.won ? "成約側" : "全体"}] conv=${c.ex.conversation_id?.slice(0, 8)} 客の最後の発言=${jst(c.lastCustAt)} 送信=${jst(new Date(c.sentAt).toISOString())} 形=${c.kind}（URL${c.urls}・画像${c.images}・コピペ${c.pasted}） status=${conv?.status} AIX印=${c.ex.aix_action ?? "なし"} 3h内AIX=${c.aixAfter.join(",") || "なし"} そのまま=${c.ex.was_ai_used ? "はい" : "いいえ"}`);
    for (const m of c.turn.slice(-6)) console.log(`   客 ${jst(m.created_at)} ${mask((m.text ?? (m.image_url ? "[画像]" : "")), names).replace(/\n/g, " ⏎ ").slice(0, 140)}`);
    console.log(`   実送信: ${mask(c.ex.sent_reply ?? "", names).replace(/\n/g, " ⏎ ")}`);
    console.log(`   AI    : ${c.ex.ai_draft && !MARK.test(c.ex.ai_draft) ? mask(c.ex.ai_draft, names).replace(/\n/g, " ⏎ ") : `（${c.ex.ai_draft ?? "下書きなし"}）`}`);
  }
  // ⑦ ブレインの判断（その発言を分析した行）と、スタッフが実際にした事（3時間以内の AIX or 通常返信）の一致
  console.log(`\n⑦ ブレインの判断 vs スタッフが実際にした事（brain_decision_logs.analyzed_msg_ts = 客の最後の発言 ±2秒）`);
  const logs = await pageAll<{ conversation_id: string; suggested_action: string | null; suggested_reply_mode: string | null; suggested_check_pattern: string | null; analyzed_msg_ts: string | null; decision_source: string | null; scene_evidence: Record<string, unknown> | null }>("brain_decision_logs", "conversation_id, suggested_action, suggested_reply_mode, suggested_check_pattern, analyzed_msg_ts, decision_source, scene_evidence", since);
  const pair = new Map<string, number>();
  let withLog = 0;
  const NORM = (a: string | null | undefined) => (a ?? "").replace(/^property_check_result.*$/, "property_check_result") || "（AIXなし）";
  for (const c of cases) {
    const t = Date.parse(c.lastCustAt);
    const lg = logs.find((l) => l.conversation_id === c.ex.conversation_id && l.analyzed_msg_ts && Math.abs(Date.parse(l.analyzed_msg_ts) - t) < 2000);
    if (!lg) continue;
    withLog++;
    const did = c.aixAfter.length ? NORM(c.aixAfter[0].split("/")[0]) : "（通常返信）";
    const d = (c.ex.ai_draft ?? "").trim();
    const k = `ブレイン ${String(lg.suggested_action || "（AIXなし）")}/${lg.suggested_reply_mode ?? "-"}${lg.scene_evidence?.scene ? `/${String(lg.scene_evidence.scene)}` : ""} [${lg.decision_source ?? "-"}]  →  実際 ${did}（その時の下書き: ${!d ? "なし" : MARK.test(d) ? d : "本文あり"}）`;
    pair.set(k, (pair.get(k) ?? 0) + 1);
  }
  console.log(`   判断の記録があるもの ${withLog}/${cases.length}`);
  for (const [k, n] of [...pair].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${k}`);

  console.log(`\n⑥ YUMA 再現の候補（成約側・下書きが出た・通常返信または acknowledge）`);
  for (const c of ordered.filter((x) => x.ex.ai_draft && !MARK.test(x.ex.ai_draft)).slice(0, 8)) {
    console.log(`   ${c.won ? "成約側" : "全体　"} conv=${c.ex.conversation_id} lastCust=${c.lastCustAt} kind=${c.kind} aix=${c.ex.aix_action ?? "-"} 3h=${c.aixAfter.join(",") || "-"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

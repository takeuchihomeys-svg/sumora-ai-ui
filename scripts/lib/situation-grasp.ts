// scripts/lib/situation-grasp.ts — 現状把握の物差し（純関数・LLM なし・DB なし・費用0）
//
// 2026-11-15 作業員L（竹内さん 11/15「文の中身9割に・現状把握能力弱いのでは」「時系列」「約束の把握と完了」・KB P0 3041baaa・d16cfe1b）。
//   番ごとに、ブレインがその番で持っていた「今」（送った材料の塊＝試験の録音の入力）と、その番の時点の DB の事実
//   （試験の問題の台帳の写し: sent_properties・estimate_records・aix_usage_logs・sent_facts（行動台帳）・条件の行・会話）を突き合わせる。
//   欄ごとに: held＝持っていた／link＝DB にあったのに持っていなかった（連携の切れ）／base＝DB にも無かった（土台の穴・見張る欄だけ）／
//             conflict＝食い違っていた（数・種類が違う）／none＝どちらにも無い（その番に関係なし）。
//   限界: 録音の入力は日付と時刻が伏せてある（<md> <hm>）＝日付の取り違えは測れない。日付が「付いていたか」だけ数える（取り違えは本番の記録の段で）。
export type Grasp = "held" | "link" | "base" | "conflict" | "none";
export const GRASP_LABEL: Record<Grasp, string> = { held: "持っていた", link: "DB にあったのに持っていなかった（連携）", base: "DB にも無かった（土台）", conflict: "食い違っていた", none: "関係なし" };
export const GRASP_FIELDS = [
  "sent_props", "sent_outside", "sent_props_dated", "estimate", "check_result", "open_promise", "promise_in_ledger", "promise_kind", "promise_due", "double_promise",
  "cond_rent", "cond_area", "cond_layout", "last_our", "customer_sent", "route_map", "time_words",
] as const;
export type GraspField = typeof GRASP_FIELDS[number];
export const FIELD_LABEL: Record<GraspField, string> = {
  sent_props: "送った物件（件数・この会話）", sent_outside: "グループに共有のみの物件（line_group・お客様には未送付）",
  promise_in_ledger: "こちらの約束の文が行動台帳（sent_facts）に入っていたか", sent_props_dated: "送った物件に日付が付いていたか", estimate: "送った見積", check_result: "確かめた結果（物件確認した）",
  open_promise: "開いている約束", promise_kind: "約束の種類（確認・見積・ピックアップ）", promise_due: "約束の期日・経った時間", double_promise: "同じ約束を2日以内に重ねた",
  cond_rent: "最新の条件: 家賃の上限", cond_area: "最新の条件: エリア", cond_layout: "最新の条件: 間取り", last_our: "直前のこちらの通", customer_sent: "お客様が送ってきた物件・画像",
  route_map: "申込までの地図の駅", time_words: "お客様の時の言葉を絶対の日付に直した値",
};

type Ctx = { s: string; t: string; aix?: boolean; ago?: number };
type Row = Record<string, unknown>;
/** 行動台帳（sent_facts）の最初の行の created_at（これより前の番の問題の写しには行が無い） */
export const SENT_FACTS_START = "2026-09-14T05:42:20Z";
export type ProblemLike = {
  id: string; at?: string; source?: string; context?: Ctx[];
  pc?: Record<string, unknown> | null;
  ledger?: { sent_properties?: Array<{ ago?: number; row: Row }>; estimate_records?: Array<{ ago?: number; row: Row }>; aix_usage_logs?: Array<{ ago?: number; row: Row }>; sent_facts?: Array<{ ago?: number; row: Row }> };
};

export type Blocks = Map<string, string>;
/** 送った文の user の部分 → 見出しの塊（名前の頭 → 中身） */
export function blocksOf(user: string): Blocks {
  const out: Blocks = new Map();
  let cur = "", buf: string[] = [];
  const flush = () => { if (cur) out.set(cur, (out.get(cur) ?? "") + buf.join("\n")); };
  for (const line of user.split(/\r?\n/)) {
    const m = line.match(/^【([^】]{1,60})】?/);
    if (m) { flush(); cur = m[1].replace(/<[^>]+>/g, "").replace(/[（(].*$/, "").trim(); buf = [line]; } else buf.push(line);
  }
  flush();
  return out;
}
const block = (b: Blocks, head: string) => { for (const [k, v] of b) if (k.startsWith(head)) return v; return null; };

const PROMISE_DONE: Record<string, string> = { confirmation_promised: "confirmation_reported", pickup_declared: "properties_sent", estimate_declared: "estimate_sent" };
const KIND_WORD: Record<string, RegExp> = { confirmation_promised: /確認/, pickup_declared: /ピックアップ|物件の?(?:送付|お送り)|探/, estimate_declared: /見積/ };
/** 行動台帳（sent_facts の写し）→ この番の時点で開いている約束（同じ種類の「済み」が後に無い物）・2日以内に重ねた約束 */
export function openPromisesOf(facts: ReadonlyArray<{ ago?: number; row: Row }>): { open: Array<{ kind: string; ago: number }>; doubled: number } {
  const rows = facts.map((f) => ({ kind: String(f.row.kind ?? ""), status: String(f.row.status ?? ""), at: Date.parse(String(f.row.sent_at ?? "")) })).filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
  const last = rows.length ? rows[rows.length - 1].at : 0;
  const open: Array<{ kind: string; ago: number }> = [];
  let doubled = 0;
  rows.forEach((r, i) => {
    if (r.status !== "promised" || !PROMISE_DONE[r.kind]) return;
    const done = rows.slice(i + 1).some((d) => d.status === "done" && d.kind === PROMISE_DONE[r.kind]);
    if (!done) open.push({ kind: r.kind, ago: Math.round((last - r.at) / 60000) });
    if (rows.slice(i + 1).some((q) => q.kind === r.kind && q.status === "promised" && q.at - r.at < 2 * 86_400_000)) doubled++;
  });
  return { open, doubled };
}
const TIME_WORD = /来週|再来週|今週|月末|月初|中旬|上旬|下旬|給料日|明日|明後日|あさって|週末|土日|\d{1,2}月|\d{1,2}日(?!本)|年内|年明け|ボーナス/;
const squash = (s: string) => s.normalize("NFKC").replace(/[\s、。・！!？?😊😌🌟✨「」（）()]/g, "");

export type GraspRow = { id: string; takeuchi: boolean; f: Record<GraspField, Grasp>; detail: Partial<Record<GraspField, string>> };
/** 1つの番: 問題（その番の時点の DB の写し）× 送った文の user の部分 */
export function graspOfTurn(p: ProblemLike, user: string): GraspRow {
  const b = blocksOf(user);
  const f = {} as Record<GraspField, Grasp>;
  const detail: Partial<Record<GraspField, string>> = {};
  const L = p.ledger ?? {};
  // 送った物件
  // 送付の台帳は会話の外（売上番長グループ経由 source=line_group・conversation_id なし）の行も持つ。この会話の行だけを「送った物件」とし、会話の外の行は別の欄で数える
  const convId = (p as { conv?: string }).conv ?? null;
  const sentRows = L.sent_properties ?? [];
  const dbSent = sentRows.filter((r) => !convId || r.row.conversation_id === convId).length;
  // 2026-11-21 作業員L（台帳 #17 ⑤）: 材料（sent-props-text.buildSentProps）は共有の行を 物件名|号室 で1つにまとめ、号室の無い共有の行は
  //   同じ建物をお客様に送っていれば出さない（決まりどおり）。行の数で比べると食い違い36番のうち多くが「同じ物件の重複」だったので、材料と同じ数え方で数える
  const nm = (r: { row: Row }) => String(r.row.property_name ?? "").trim();
  const ownNames = new Set(sentRows.filter((r) => convId && r.row.conversation_id === convId).map(nm));
  // 2026-11-21 作業員L（#17 の残り28を読んだ）: brain-core は共有のみ（source=line_group）を「新しい順に20行」取ってから1つにまとめる。
  //   全部の行で数えると、20行の外の古い共有まで「材料に無い」に数えていた（q060: 27物件 → 新しい20行では11物件＝材料の11行と一致）。取り方も同じにする
  const outsideRows = sentRows.filter((r) => convId && !r.row.conversation_id && r.row.source === "line_group")
    .sort((a, b) => String(b.row.sent_at ?? "").localeCompare(String(a.row.sent_at ?? ""))).slice(0, 20);
  //   お客様に送った物の名前は、材料と同じく property_customer_id で結んだ行（line_group 以外）も入れる。同じ 物件名|号室 を送っていれば共有は出ない
  const ownRows = sentRows.filter((r) => r.row.source !== "line_group" && (r.row.conversation_id === convId || !!r.row.property_customer_id));
  for (const r of ownRows) ownNames.add(nm(r));
  const ownKeys = new Set(ownRows.map((r) => `${nm(r)}|${String(r.row.room_no ?? "").trim()}`));
  const dbOutside = new Set(outsideRows.filter((r) => nm(r) && !(!String(r.row.room_no ?? "").trim() && ownNames.has(nm(r))))
    .map((r) => `${nm(r)}|${String(r.row.room_no ?? "").trim()}`).filter((k) => !ownKeys.has(k))).size;
  const sentHead = [...b.keys()].find((k) => k.startsWith("すでに送付済みの物件"));
  const sentBlockFull = user.match(/【すでに送付済みの物件（(\d+)件）】/);
  const pSent = sentBlockFull ? Number(sentBlockFull[1]) : null;
  // グループに共有のみ（line_group）の行は【すでに送付済みの物件】の下の「▼グループに共有のみ」に出る（取得の上限 20件）。行の数で比べる
  const pShared = (user.match(/グループに共有のみ・お客様には未送付/g) ?? []).length;
  f.sent_outside = dbOutside ? (pShared >= Math.min(dbOutside, 20) * 0.8 ? "held" : pShared > 0 ? "conflict" : "link") : "none";
  if (dbOutside) detail.sent_outside = `グループに共有のみ ${dbOutside}行・材料に出た ${pShared}行`;
  f.sent_props = dbSent === 0 ? (pSent ? "conflict" : "none") : pSent == null ? "link" : pSent === 0 ? "link" : Math.abs(pSent - dbSent) <= Math.max(1, dbSent * 0.2) ? "held" : "conflict";
  if (f.sent_props === "conflict" || f.sent_props === "link") detail.sent_props = `DB ${dbSent}件・持っていた ${pSent ?? "塊なし"}`;
  // 日付が付いていたか（送付の塊の行に <md> があるか）
  const sb = sentHead ? block(b, sentHead) ?? "" : "";
  const sentLines = sb.split(/\r?\n/).slice(1).filter((l) => l.trim().startsWith("・") || l.trim().startsWith("-") || /号室/.test(l));
  f.sent_props_dated = dbSent === 0 ? "none" : !sentLines.length ? "link" : sentLines.filter((l) => /<md>|\d+日前|\d+月\d+日/.test(l)).length >= sentLines.length * 0.8 ? "held" : "base";
  // 見積
  // 2026-11-21 作業員L（#17 の残り「食い違い13」を読んだ）: 【御見積書 送付済み】は aix_usage_logs.estimate_sent=true の行から出る（材料の決まり）。
  //   estimate_records（09/23 に始まった）だけを DB の証拠にすると、見積を同封した AIX（物件確認した＋見積など）の番を「食い違い」に数えていた
  const dbEst = (L.estimate_records ?? []).length + (L.aix_usage_logs ?? []).filter((a) => a.row.estimate_sent === true).length;
  // 2026-11-21 作業員L: BRAIN_ESTIMATE_RECORDS（11/21 から既定 on）の塊【送った御見積書（記録・新しい順）】も「持っていた」に数える（前は古い2つの見出しだけで、連携の漏れに数えていた）
  const pEst = !!(block(b, "御見積書 送付済み") ?? block(b, "送付済み御見積書の費用情報") ?? block(b, "送った御見積書"));
  f.estimate = dbEst ? (pEst ? "held" : "link") : pEst ? "conflict" : "none";
  // 確かめた結果
  const dbChk = (L.aix_usage_logs ?? []).filter((a) => a.row.aix_type === "property_check_result").length;
  const pChk = !!(block(b, "物件別空き状況") ?? block(b, "🏠 物件ごとの状況")) || /募集状況[^\n]{0,20}(?:確認済み|募集中|募集終了)/.test(user);
  f.check_result = dbChk ? (pChk ? "held" : "link") : "none";
  // 約束
  const fromFacts = openPromisesOf(L.sent_facts ?? []);
  // 行動台帳の写しに直前の約束が入っていない番がある（書き込みが後・写しの線の外）＝会話の文からも拾う（最後の AIX の後のこちらの約束の文）
  const ctx0 = p.context ?? [];
  let lastAix = -1; ctx0.forEach((c, i) => { if (c.aix) lastAix = i; });
  const textPromises = ctx0.slice(lastAix + 1).filter((c) => c.s === "staff").flatMap((c) => {
    const k: string[] = [];
    if (/確認[^。\n]{0,24}(?:出来次第|させて頂きます)/.test(c.t)) k.push("confirmation_promised");
    if (/ピックアップ[^。\n]{0,24}(?:出来次第|させて頂きます)|お部屋[^。\n]{0,10}出次第/.test(c.t)) k.push("pickup_declared");
    if (/見積[^。\n]{0,24}(?:作成|お送りさせて頂きます|出来次第)/.test(c.t)) k.push("estimate_declared");
    return k.map((kind) => ({ kind, ago: c.ago ?? 0 }));
  });
  const open = [...fromFacts.open, ...textPromises.filter((t) => !fromFacts.open.some((o) => o.kind === t.kind))];
  const doubled = fromFacts.doubled;
  f.promise_in_ledger = textPromises.length ? (textPromises.every((t) => fromFacts.open.some((o) => o.kind === t.kind)) ? "held" : "link") : "none";
  // 2026-11-21 作業員L（台帳 #17）: 行動台帳（sent_facts）は 2026-09-14 05:42Z に始まり、それより前の番の問題の写しは行が0。
  //   「連携の漏れ 21」のうち読んだ8問は全部この前の番だった＝測れない番。行が0で台帳の始まりより前の番は「関係なし」にする
  if (f.promise_in_ledger === "link" && !(L.sent_facts ?? []).length && p.at && p.at < SENT_FACTS_START) { f.promise_in_ledger = "none"; detail.promise_in_ledger = "行動台帳の始まり（09/14）より前の番＝測れない"; }
  const pOpen = block(b, "まだ果たしていないこちらの約束");
  f.open_promise = open.length ? (pOpen ? "held" : "link") : pOpen ? "conflict" : "none";
  if (f.open_promise !== "none") detail.open_promise = `DB ${open.map((o) => o.kind).join("・") || "無し"}・持っていた ${pOpen ? "あり" : "なし"}`;
  f.promise_kind = open.length && pOpen ? (open.some((o) => KIND_WORD[o.kind]?.test(pOpen)) ? "held" : "conflict") : "none";
  const pDue = /（[^）]{0,12}(?:時間前|日前)）|期限|期日|中央値/.test(block(b, "🤝 お客様との約束") ?? "") || /時間前|日前/.test(pOpen ?? "");
  f.promise_due = open.length ? (pDue ? "held" : "base") : "none";
  // 2026-11-21 作業員L（台帳 #288）: 重ねた約束は竹内さん本人も 30日で15回している形（「引き続きピックアップさせて頂きます」）＝外れではない。
  //   把握漏れ（土台）に数えず「関係なし」にする（数は detail に残す）
  f.double_promise = "none";
  if (doubled) detail.double_promise = `重ねた約束 ${doubled}（竹内さんもする形・漏れに数えない）`;
  // 最新の条件
  const pc = p.pc ?? {};
  const rent = Number(pc.rent_max ?? 0);
  const rentHas = rent > 0 && (user.includes(String(rent)) || user.includes(`${rent / 10000}万`) || user.includes(`${(rent / 10000).toFixed(1)}万`));
  f.cond_rent = rent > 0 ? (rentHas ? "held" : "link") : "none";
  const area = String(pc.desired_area ?? "").split(/[、,・\s]/)[0]?.trim();
  f.cond_area = area ? (user.includes(area) ? "held" : "link") : "none";
  const layout = String(pc.floor_plan ?? "").trim();
  f.cond_layout = layout ? (user.includes(layout) || user.includes(layout.replace(/以上$/, "")) ? "held" : "link") : "none";
  // 直前のこちらの通
  const ctx = p.context ?? [];
  const lastOur = [...ctx].reverse().find((c) => c.s === "staff" && c.t && !/^\[画像\]$/.test(c.t.trim()));
  // 名前は伏せ字（お客様）に替わるので、〇〇さん・お客様を外して比べる
  const unname = (x: string) => squash(x.replace(/[^\s、。！!？?]{1,12}?さん|お客様/g, ""));
  const head = lastOur ? unname(lastOur.t).slice(0, 12) : "";
  f.last_our = head ? (unname(user).includes(head) ? "held" : "link") : "none";
  // お客様が送ってきた物件・画像（返していないお客様の通）
  let lastOurIdx = -1; ctx.forEach((c, i) => { if (c.s === "staff") lastOurIdx = i; });
  const unreplied = ctx.slice(lastOurIdx + 1).filter((c) => c.s === "customer");
  const urls = unreplied.flatMap((c) => c.t.match(/https?:\/\/\S+/g) ?? []);
  const imgs = unreplied.filter((c) => /\[画像\]/.test(c.t)).length;
  f.customer_sent = urls.length || imgs ? (urls.every((u) => user.includes(u.slice(0, 30))) && (!imgs || /\[画像\]|お客様の画像|画像の結び付け/.test(user)) ? "held" : "link") : "none";
  // 申込までの地図
  f.route_map = block(b, "申込までの地図") ? "held" : "base";
  // 時の言葉（お客様の通の中の相対の言葉）→ 絶対の日付に直した値が材料にあるか
  const said = ctx.filter((c) => c.s === "customer" && TIME_WORD.test(c.t)).map((c) => c.t.match(TIME_WORD)![0]);
  const conv = /（＝[^）]*(?:<md>|\d+月\d+日)|絶対の日付|→\s*<md>/.test(user);
  f.time_words = said.length ? (conv ? "held" : "base") : "none";
  if (said.length) detail.time_words = said.slice(-3).join("・");
  return { id: p.id, takeuchi: /竹内さん/.test(String(p.source ?? "")), f, detail };
}

export type GraspTally = Record<GraspField, Record<Grasp, number>>;
export function tallyGrasp(rows: ReadonlyArray<GraspRow>): GraspTally {
  const t = {} as GraspTally;
  for (const k of GRASP_FIELDS) t[k] = { held: 0, link: 0, base: 0, conflict: 0, none: 0 };
  for (const r of rows) for (const k of GRASP_FIELDS) t[k][r.f[k]]++;
  return t;
}
/** 把握漏れの多い欄の1行（関係のある番のうち 持っていた でない割合の高い順・上位3） */
export function graspLine(t: GraspTally, n: number): string {
  const rows = GRASP_FIELDS.map((k) => { const c = t[k]; const rel = c.held + c.link + c.base + c.conflict; return { k, rel, miss: rel - c.held }; }).filter((x) => x.rel >= 3).sort((a, b) => b.miss / b.rel - a.miss / a.rel).slice(0, 3);
  return `現状把握（${n}番）: 把握漏れの多い欄 ${rows.map((x) => `${FIELD_LABEL[x.k]} ${x.miss}/${x.rel}`).join("・")}`;
}

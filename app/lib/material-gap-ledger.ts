// app/lib/material-gap-ledger.ts — 番ごとの「材料の抜けの台帳」（純関数・DB/LLM なし）
//
// 2026-11-12 作業員1（竹内さん 11/12「材料足りていない部分や連携できていない部分は土台作るのと細分化も強化する。具体的に、何が何で何なのか、その点も把握できるようにする」・統括役）
//   抜け1つにつき、次の5つを具体の名前で持つ:
//     ① 何が（what）: 材料の名前（情報の項目 INFO_KEYS・会社の事実・資料の欄・物件の記録・照らし合わせの残り・確認の結果・AIX の記録・ブレインの自己申告の鍵）
//     ② 何のために（forRole・forWhat）: どの役（ブレイン／統括／文の統括／書き手／AIX 1通目／AIX 2通目）の、どの判断・どの文の要素に要るか
//     ③ どこから来るはずか（from）: 会話・資料・DB の表・確認の結果・AIX の記録
//     ④ なぜ無いか（why）: a そもそも無い＝土台が無い／b あるが取りに行っていない／c 取ったが役に渡していない＝連携の切れ目／
//                          d 渡したが古い・粗い＝細分化が足りない／e スタッフしか知らない＝AIX の番
//     ⑤ 無いと何が起きるか（effect）: 作業員22 の疑いの印の9種（conductor-doubt の DOUBT_TABLE の kind）に揃える
//   新しく作るのは台帳の型と集める関数だけ。既存の読み（情報の土台 INFO_FILL_MAP の表・材料を切ったログ・ブレインの自己申告の鍵・
//   今の番の物件の取りこぼし）を入力に受け取る（型は形だけ受ける＝まだ main に無い部品にも依存しない）。
//   既定 off（MATERIAL_GAP_LEDGER=shadow で meta と digest に記録だけ・on も同じ＝道は変えない）。
import { materialMissingKey, materialMissingSide, MATERIAL_KEY_JA, type MaterialKey } from "./material-missing-key";

type Env = Record<string, string | undefined>;
export function materialGapLedgerMode(env?: Env): "off" | "shadow" {
  const v = ((env ?? (typeof process !== "undefined" ? process.env : {})).MATERIAL_GAP_LEDGER ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? "shadow" : "off";
}

/** ① 何が（語彙の出所ごと） */
export type GapWhatKind = "info_key" | "company_fact" | "doc_field" | "property_record" | "exchange_left" | "check_result" | "aix_record" | "self_report" | "cut_text";
export type GapWhat = { kind: GapWhatKind; name: string; label?: string };
/** ② 何のために（役）。conductor-field-links の受け取る所と揃えた名前＋AIX の1通目・2通目 */
export const GAP_ROLES = ["brain", "conductor", "compose", "writer", "aix_first", "aix_second"] as const;
export type GapRole = typeof GAP_ROLES[number];
export const GAP_ROLE_LABEL: Record<GapRole, string> = { brain: "ブレイン", conductor: "統括", compose: "文の統括", writer: "書き手", aix_first: "AIX 1通目", aix_second: "AIX 2通目" };
/** ③ どこから来るはずか */
export type GapFrom = "conversation" | "document" | "db_table" | "check_result" | "aix_record" | "company_facts";
/** ④ なぜ無いか */
export const GAP_WHY = ["a", "b", "c", "d", "e"] as const;
export type GapWhy = typeof GAP_WHY[number];
export const GAP_WHY_LABEL: Record<GapWhy, string> = {
  a: "そもそも無い（土台が無い）", b: "あるが取りに行っていない", c: "取ったが役に渡していない（連携の切れ目）", d: "渡したが古い・粗い（細分化が足りない）", e: "スタッフしか知らない（AIX の番）",
};
/** ⑤ 無いと何が起きるか（作業員22 の疑いの印の9種と同じ名前・conductor-doubt.ts の DOUBT_TABLE） */
export const GAP_EFFECTS = ["fact_missed", "path_mismatch", "misread", "push_over_ceiling", "held_answerable", "time_line", "promise_overlap", "answered_staff_only", "fact_but_staff"] as const;
export type GapEffect = typeof GAP_EFFECTS[number];
export const GAP_EFFECT_LABEL: Record<GapEffect, string> = {
  fact_missed: "事実の取りこぼし", path_mismatch: "型と道の食い違い", misread: "読み違い", push_over_ceiling: "押す強さの上限越え", held_answerable: "答えられるのに保留",
  time_line: "時間の線の食い違い", promise_overlap: "約束の重ね", answered_staff_only: "スタッフしか知らない事に答えた", fact_but_staff: "答えられるのにスタッフの番",
};

export type MaterialGap = { what: GapWhat; forRole: GapRole; forWhat: string; from: GapFrom; why: GapWhy; effect: GapEffect; detail?: string | null };

// ─── 集める関数（既存の読みを受け取る） ──────────────────────────────────────────

/** 情報の土台（INFO_FILL_MAP の表の1行の形）。state: known / unknown / stale / unwired */
export type InfoCellLike = { key: string; state: "known" | "unknown" | "stale" | "unwired"; why?: string | null };
/** 情報の項目 → どこから来るはずか・何のためか（申込までの地図の次の駅へ進む判断） */
const INFO_FROM: Record<string, GapFrom> = {
  area: "db_table", rent: "db_table", layout: "db_table", move_in: "db_table", size: "db_table",
  property_chosen: "conversation", vacancy_checked: "aix_record", estimate_sent: "aix_record", viewing_date: "db_table", viewing_done: "db_table",
  apply_intent: "conversation", apply_form: "conversation", screening_info: "conversation",
};
export function gapsFromInfoCells(cells: ReadonlyArray<InfoCellLike>, node: string | null): MaterialGap[] {
  const out: MaterialGap[] = [];
  for (const c of cells) {
    if (c.state === "known") continue;
    // unknown＝お客様からまだ聞けていない（土台＝会話にまだ無い）／unwired＝表に材料を渡していない（連携の切れ目）／stale＝古い
    const why: GapWhy = c.state === "unwired" ? "c" : c.state === "stale" ? "d" : "a";
    out.push({ what: { kind: "info_key", name: c.key }, forRole: "brain", forWhat: `次の駅へ進む判断（今の駅 ${node ?? "不明"}）`, from: INFO_FROM[c.key] ?? "conversation", why, effect: why === "d" ? "fact_missed" : "path_mismatch", detail: c.why ?? null });
  }
  return out;
}

/** 材料を字数で切ったログ（material-cut-log の記録の形）→ 取ったが切って渡した＝c（渡していない） */
export function gapsFromCutRecords(recs: ReadonlyArray<{ label: string; cut: number }>): MaterialGap[] {
  return recs.filter((r) => r.cut > 0).map((r) => ({
    what: { kind: "cut_text", name: r.label }, forRole: r.label.startsWith("final_check") ? "writer" : "brain",
    forWhat: r.label.startsWith("final_check") ? "最終チェックの決まりの照らし" : "判断の材料（セーブデータ）", from: "db_table", why: "c", effect: "fact_missed", detail: `${r.cut}字を切った`,
  }));
}

/** ブレインの自己申告（material_missing の言葉）→ 鍵に寄せる。スタッフの側は e・システムの側は b（取りに行っていない）・会社の知識は a */
export function gapsFromSelfReport(labels: ReadonlyArray<string>): MaterialGap[] {
  return labels.map((label) => {
    const key: MaterialKey = materialMissingKey(label);
    const side = materialMissingSide(label);
    const why: GapWhy = side === "staff" ? "e" : side === "knowledge" ? "a" : side === "system" ? "b" : "a";
    const from: GapFrom = side === "staff" ? "check_result" : side === "knowledge" ? "company_facts" : side === "system" ? "db_table" : "conversation";
    return { what: { kind: "self_report", name: key, label: MATERIAL_KEY_JA[key] }, forRole: "brain", forWhat: "判断（ブレインが自分で足りないと書いた）", from, why, effect: why === "e" ? "answered_staff_only" : "fact_missed", detail: label.slice(0, 40) };
  });
}

/** 今の番に名前の出た物件が、読んだ記録（件数の上限の内）に無かった＝取りに行っていない（b） */
export function gapsFromTurnMust(missing: ReadonlyArray<{ table: string; name: string }>): MaterialGap[] {
  return missing.map((m) => ({ what: { kind: "property_record", name: `${m.table}:${m.name}`.slice(0, 60) }, forRole: "brain", forWhat: "今の番の物件の記録（送付・確認・見積・内覧）", from: "db_table", why: "b", effect: "fact_missed" }));
}

/** ブレインの材料の読みが失敗した表（brain-core の materialMisses＝表の名前）→ 取りに行ったが読めなかった（b） */
export function gapsFromReadMisses(tables: ReadonlyArray<string>): MaterialGap[] {
  return tables.map((t) => ({ what: { kind: "aix_record" as const, name: `read_fail:${t}`.slice(0, 60) }, forRole: "brain" as const, forWhat: "判断の材料（DB の読み）", from: "db_table" as const, why: "b" as const, effect: "fact_missed" as const }));
}

/** brain-core の meta に入れる形（無ければ undefined） */
export function materialGapsDigest(selfReportLabels: ReadonlyArray<string>, readMissTables: ReadonlyArray<string>): string[] | undefined {
  const d = gapLedgerDigest(buildGapLedger(gapsFromSelfReport(selfReportLabels), gapsFromReadMisses(readMissTables)));
  return d.length ? d : undefined;
}

/** 台帳（重なりを1つに） */
export function buildGapLedger(...groups: ReadonlyArray<ReadonlyArray<MaterialGap>>): MaterialGap[] {
  const seen = new Set<string>(); const out: MaterialGap[] = [];
  for (const g of groups) for (const x of g) { const k = `${x.what.kind}:${x.what.name}:${x.forRole}:${x.why}`; if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

/** meta / digest に入れる短い形（1行＝1つの抜け） */
export function gapLedgerDigest(gaps: ReadonlyArray<MaterialGap>, max = 12): string[] {
  return gaps.slice(0, max).map((g) => `${g.what.kind}:${g.what.name}|${g.forRole}|${g.from}|${g.why}|${g.effect}`);
}

/** 数え（a〜e・役・効き目） */
export function tallyGaps(gaps: ReadonlyArray<MaterialGap>): { why: Record<GapWhy, number>; role: Record<string, number>; effect: Record<string, number> } {
  const why = Object.fromEntries(GAP_WHY.map((k) => [k, 0])) as Record<GapWhy, number>;
  const role: Record<string, number> = {}; const effect: Record<string, number> = {};
  for (const g of gaps) { why[g.why]++; role[g.forRole] = (role[g.forRole] ?? 0) + 1; effect[g.effect] = (effect[g.effect] ?? 0) + 1; }
  return { why, role, effect };
}

// ─── 材料の帳面の6つ（2026-11-13 作業員1・弱い所 G1 親 680・竹内さん「足りていない土台の強化と具体的な細分化」・KB P0 d16cfe1b）──────
//   分からない事（ブレインの自己申告）を、どの帳面が空かで6つに分け、番ごとに「入口で取りに行く物（fetch）」と
//   「スタッフしか知らない＝AIX の物（staff）」の印を付ける（CLAUDE.md の絶対的な考え方: スタッフだけが知る情報は AIX）。
//   既定 off（MATERIAL_GAP_BOOKS=shadow で meta に記録だけ・道は変えない）
export const MATERIAL_BOOKS = ["phone", "viewing_place", "mgmt_result", "company_fact", "property_doc", "our_side"] as const;
export type MaterialBook = typeof MATERIAL_BOOKS[number];
export const MATERIAL_BOOK_LABEL: Record<MaterialBook, string> = {
  phone: "電話", viewing_place: "内覧の場", mgmt_result: "管理会社の結果", company_fact: "会社の事実", property_doc: "物件の資料", our_side: "こちら側",
};
export type BookMark = "fetch" | "staff";
export function materialGapBooksMode(env?: Env): "off" | "shadow" {
  const v = ((env ?? (typeof process !== "undefined" ? process.env : {})).MATERIAL_GAP_BOOKS ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? "shadow" : "off";
}
/** 鍵 → 帳面と印（言葉で先に決まる物は下の BOOK_WORDS が先） */
const KEY_BOOK: Record<MaterialKey, { book: MaterialBook; mark: BookMark }> = {
  screening_status: { book: "mgmt_result", mark: "staff" }, mgmt_answer: { book: "mgmt_result", mark: "staff" }, vacancy_status: { book: "mgmt_result", mark: "staff" },
  estimate_amount: { book: "our_side", mark: "staff" }, viewing_slot: { book: "our_side", mark: "staff" }, room_photos: { book: "viewing_place", mark: "staff" },
  customer_feedback: { book: "viewing_place", mark: "staff" },
  sendable_candidates: { book: "our_side", mark: "fetch" }, conversation_context: { book: "our_side", mark: "fetch" }, customer_conditions: { book: "our_side", mark: "fetch" },
  sent_property_status: { book: "property_doc", mark: "fetch" }, guarantor_company: { book: "property_doc", mark: "fetch" }, brought_property_detail: { book: "property_doc", mark: "fetch" },
  move_in_date: { book: "property_doc", mark: "fetch" }, property_doc: { book: "property_doc", mark: "fetch" }, viewing_record: { book: "viewing_place", mark: "fetch" },
  company_knowledge: { book: "company_fact", mark: "fetch" }, other: { book: "our_side", mark: "fetch" },
};
/** 言葉で決まる帳面（電話・内覧の場で話した事・交渉・代表の確認はスタッフしか知らない） */
const BOOK_WORDS: Array<{ re: RegExp; book: MaterialBook; mark: BookMark }> = [
  { re: /電話/, book: "phone", mark: "staff" },
  { re: /内覧(?:の場|で話|中|当日|時)|見た(?:部屋|お部屋)|内覧の感想/, book: "viewing_place", mark: "staff" },
  { re: /交渉|代表(?:の)?(?:確認|割引|判断)|割引(?:の)?可否|スライド/, book: "mgmt_result", mark: "staff" },
  { re: /会社の(?:方針|決まり|事実)|探し始め|手順/, book: "company_fact", mark: "fetch" },
  { re: /提携先/, book: "our_side", mark: "staff" },
];
export function materialBookOf(label: string): { book: MaterialBook; mark: BookMark; key: MaterialKey } {
  const key = materialMissingKey(label);
  for (const w of BOOK_WORDS) if (w.re.test(label)) return { book: w.book, mark: w.mark, key };
  return { ...KEY_BOOK[key], key };
}
/** meta に入れる形: 「帳面|印|鍵」（同じ組は1つ）。無ければ undefined */
export function materialBooksDigest(labels: ReadonlyArray<string>, max = 12): string[] | undefined {
  const seen = new Set<string>(); const out: string[] = [];
  for (const l of labels) { const b = materialBookOf(l); const s = `${b.book}|${b.mark}|${b.key}`; if (!seen.has(s)) { seen.add(s); out.push(s); } }
  return out.length ? out.slice(0, max) : undefined;
}

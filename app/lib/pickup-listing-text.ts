// app/lib/pickup-listing-text.ts（純関数・import は純関数の pickup-image-bonus だけ・画面とサーバーで共用）
// 売上サポのピックアップの物件カードに、物件資料（PDF の文字層 pdf_text）の文字をそのまま出すための読み取り。
//
// 2026-09-27 竹内（YUMA テストの AIXツールのスクショを見て）:
//   「物件名に号室もいれる」「AD の項目は重要なので物件名の横にもスタンプでいれる」
//   ＋ 9/27「物件の資料の中の文字変えなくても…文字抜かなくてそのまま使う」（feedback_pickup_material_verbatim）
// 決まり:
//   - 号室: 資料の「号室名 703（7階部分）」の 703 を先に使い、無い行（itandi 等）は保存済みの room_no（2.5.31 から資料の文字のまま）。
//     先頭の 0・英字（005B）を落とさない。どちらも無ければ出さない（推測しない）
//   - AD の札: 資料の「A D 2ヶ月（税込）（-1万）」「広告料 2ヶ月（税込）」「A D 100％」を 1文字も変えずに（A と D の間の空白・括弧の付け足しも）。
//     AD は元付業者のページ（偶数ページ）の末尾にある → 文字層の中で最後に出る物を採る（弊社帯の奇数ページには書かれない）。
//     「広告掲載 可」「webサービス広告掲載 [許可]」は AD ではない（「広告料」「広告費」だけ・値は数字か なし）。無ければ出さない
//   - 説明文の「AD 2ヶ月」（拡張の一覧の列・資料から足した行）は資料の文字ではないので札には使わない（カードの AD のマスは今まで通り）

import { imageBonusOf, signedPoints, totalPointsLabel, type ImageAnalysisForBonus } from "./pickup-image-bonus";
import { assumedAdAgentOf, assumedAdStamp } from "./agent-ad-assume";

/** AD の見出し（リアプロの元付は「A D」と空白が入る・全角も） */
const AD_HEAD = String.raw`(?<![A-Za-zＡ-Ｚａ-ｚ])(?:A\s?D|Ａ\s?Ｄ)(?![A-Za-zＡ-Ｚａ-ｚ])|広告料|広告費`;
/**
 * リアプロの資料は元付業者のページの最後の行が AD の欄で、見出しは元付の書き方のまま（9/20〜 145行の実物）:
 *   「A D 2ヶ月（税込）（-1万）」「広告料 2ヶ月（税込）」「BK 2ヶ月（税込）」「業務委託料 2ヶ月（税込）」「委託業務報酬 250％（税込）」
 *   「対応補助業務手数料 3ヶ月（ー11,000円(税込)）」。前の欄の続きに付く時もある（「…迄 広告料 2ヶ月（税込）」）
 *   → 最後の行の中ではこの広い見出しも AD とみなす（「契約事務手数料」「仲介手数料」は当たらない）
 */
const AD_HEAD_LAST_LINE = String.raw`${AD_HEAD}|(?<![A-Za-zＡ-Ｚａ-ｚ])(?:BK|ＢＫ)(?![A-Za-zＡ-Ｚａ-ｚ])|[一-龥]{0,6}(?:委託料|業務報酬|委託報酬|業務手数料)`;
/** 値の始まり（数字・なし／無し）。値から後ろは行の終わりまで資料の文字のまま（括弧の付け足し・空白も） */
const AD_VALUE_START = String.raw`(?=[\d０-９]|なし|無し)`;
const LAST_LINE_RE = new RegExp(String.raw`(?:${AD_HEAD_LAST_LINE})[ \t　]*[:：]?[ \t　]*${AD_VALUE_START}`, "gu");
/** 行の途中（itandi 等）: 見出し → 値（単位まで）→ 括弧の付け足しは空白まで */
const AD_VALUE = String.raw`(?:[\d０-９][\d０-９.,，．]*[ \t　]?(?:ヶ月|ヵ月|カ月|か月|ケ月|ヶ|%|％|円|万円)?|なし|無し)`;
const AD_PHRASE_RE = new RegExp(String.raw`(?:${AD_HEAD})[ \t　]*[:：]?[ \t　]*${AD_VALUE}[^\s]*`, "gu");

/**
 * 資料の文字層から AD の書き方を資料の文字のまま（無ければ null）。
 *   ①最後の行（リアプロの元付業者のページの AD の欄）に見出し＋値があれば、見出しから行の終わりまで
 *   ②無ければ文字全体で「AD／広告料／広告費 ＋ 値」の最後に出る物（元付業者のページ・itandi の「広告費 100 ％」）
 *   値の無い欄（「A D」だけ）・「広告掲載 [許可]」は AD ではない → null
 */
export function listingAdText(pdfText: string | null | undefined): string | null {
  const t = String(pdfText ?? "").replace(/\r/g, "");
  if (!t.trim()) return null;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  // 2026-09-30 最後の行の「最初の」見出しから（旧は最後の見出し）。TIO岸和田 103（#1952）の最後の行
  //   「A D 1ヶ月（税込）（礼金1ヵ月の場合は広告料2.0ヶ月）」で、括弧の中の条件付きの「広告料2.0ヶ月）」を札にしていた
  //   （採点は AD 1ヶ月・画面の札は 2.0ヶ月＝竹内さんの見た食い違い）。欄の見出しは行の中で先に出る（付け足しの括弧は後ろ）
  const hits = [...last.matchAll(LAST_LINE_RE)];
  if (hits.length) return last.slice(hits[0].index).trim();
  const all = [...t.matchAll(AD_PHRASE_RE)].map((m) => m[0].trim()).filter(Boolean);
  return all.length ? all[all.length - 1] : null;
}

/**
 * 物件名の横の AD の札（2026-09-27）: 資料の文字のまま（listingAdText）。資料に AD の値が無く、元付業者の決まりでみなした時
 *   （竹内「株式会社アズ・スタットは AD 記載なくても基本的に 200% あるから 200% とみなす」）は「AD 200%（アズ・スタット）」
 *   ＝資料の文字ではなく、みなした値だと分かる形。どちらも無ければ null
 */
export function listingAdStamp(pdfText: string | null | undefined): string | null {
  const verbatim = listingAdText(pdfText);
  if (verbatim) return verbatim;
  const ag = assumedAdAgentOf(pdfText);
  return ag ? assumedAdStamp(ag) : null;
}

/**
 * AD の札を「芯」（見出し＋値＋（税込）（税抜））と「付け足し」（残りの括弧書き）に分ける。つなげると元の文字と同じ（1文字も落とさない）。
 *   「A D 2ヶ月（税込）（-1万）」→ 芯「A D 2ヶ月（税込）」＋付け足し「（-1万）」
 */
export function splitAdStamp(text: string): { core: string; rest: string } {
  const m = text.match(/^(.*?(?:[\d０-９][\d０-９.,，．]*[ \t　]?(?:ヶ月|ヵ月|カ月|か月|ケ月|ヶ[⽉月]?|%|％|円|万円)?|なし|無し)(?:[（(]税[込抜][）)])?)([\s\S]*)$/u);
  if (!m) return { core: text, rest: "" };
  return { core: m[1], rest: m[2] };
}

/**
 * 2026-09-30 札の芯（splitAdStamp の core）から AD の月数（採点と同じ物差し）。読めなければ null。
 *   「A D 2ヶ月（税込）」→ 2／「A D 250％」→ 2.5／「広告費 なし」→ 0／「A D 98000円」→ 円÷家賃（家賃が無ければ null）／
 *   「AD 200%（アズ・スタット）」（みなしの札）→ 2。付け足しの括弧（「（礼金1ヵ月の場合は広告料2.0ヶ月）」）は読まない
 */
export function adMonthsOfStamp(stamp: string | null | undefined, rentYen?: number | null): number | null {
  if (!stamp) return null;
  const core = splitAdStamp(stamp).core
    .replace(/[０-９．，％]/g, (c) => (c === "．" ? "." : c === "，" ? "," : c === "％" ? "%" : String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
    .replace(/⽉/g, "月").replace(/,/g, "");
  if (/(?:なし|無し)\s*$/.test(core)) return 0;
  const m = core.match(/(\d+(?:\.\d+)?)\s*(ヶ月|ヵ月|カ月|か月|ケ月|ヶ|%|万円|円)?\s*(?:[（(]税[込抜][）)])?\s*$/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = m[2] ?? "";
  if (unit === "%") return v / 100;
  if (unit === "円" || unit === "万円") {
    const yen = unit === "万円" ? v * 10_000 : v;
    return rentYen && rentYen > 0 ? Math.round((yen / rentYen) * 100) / 100 : null;
  }
  // 単位の無い「AD2.5(WEB申込)」「AD3」（リアプロの元付の書き方・#1199）は月数。大きな数（円の書き漏れ）は読まない
  if (!unit) return v > 0 && v <= 5 ? v : null;
  return v <= 12 ? v : null;
}

/** 資料の「号室名 703（7階部分）」の号室（資料の文字のまま・無ければ null） */
export function listingRoomText(pdfText: string | null | undefined): string | null {
  const m = String(pdfText ?? "").match(/号室名[ \t　]*[:：]?[ \t　]*([0-9A-Za-z０-９Ａ-Ｚａ-ｚ\-－]+)/u);
  return m ? m[1] : null;
}

/**
 * 物件名に号室を付ける（「ラ・フォーレ東天満 703」）。号室が無ければ名前だけ。
 *   名前の末尾に同じ号室（「… 703」「… 703号室」）が既にあれば付けない（二重にしない）
 */
export function nameWithRoom(name: string | null | undefined, room: string | null | undefined): string {
  const n = String(name ?? "").trim();
  const r = String(room ?? "").trim();
  if (!r) return n;
  if (!n) return r;
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|[\\s　])${esc}(?:号室)?$`, "u").test(n)) return n;
  return `${n} ${r}`;
}

/**
 * カードに出す号室（資料の号室名 → 保存済みの room_no）。無ければ null。
 *   資料の文字を先にする: 2.5.31 より前の行は room_no の先頭の 0 が落ちている（9/20〜 145行中 13行: 資料「0403」↔ room_no「403」）
 */
export function cardRoom(roomNo: string | null | undefined, roomText: string | null | undefined): string | null {
  return String(roomText ?? "").trim() || String(roomNo ?? "").trim() || null;
}

// ── 画像で分析をカードにまとめる（2026-09-27 竹内「画像で分析の部分も上の部分にまとめる。点数のと画像で分析がわかれていたらみにくい」）──
// 2026-09-27 竹内「ここは合わせる」: 画像は判定の点に足す分（画像の加点・pickup-image-bonus）で見せる。0〜100 の割合は詳細の中だけ

export type ImageAnalysisLike = {
  match?: unknown; match_raw?: unknown; ok_count?: unknown;
  checks?: Array<{ id?: string; result?: string; why?: string }> | unknown;
  review?: { status?: string; reasons?: string[] } | null;
  [k: string]: unknown;
} | null | undefined;

/** カードの「🔍 画像」の札の状態 */
export type ImageChip =
  | { kind: "scored"; match: number; ok: number; ng: number; text: string; bonus: number | null; covered: number }
  | { kind: "needs_check"; text: string }
  | { kind: "unscored"; text: string }
  | { kind: "waiting"; text: string };

/**
 * 1件の画像で分析の札（純関数）。
 *   分析済み・点あり →「🔍 画像 86点（◎5・×1）」／物件と資料が合わない →「🔍 画像 要確認」／分析したが点なし →「🔍 画像 点なし」／
 *   まだ分析していない → showWaiting の時だけ「🔍 画像の分析待ち」（画像で確かめる希望が無いお客様では出さない＝null）
 */
export function imageChipOf(a: ImageAnalysisLike, showWaiting: boolean, reasonCodes?: ReadonlyArray<string> | null): ImageChip | null {
  if (!a) return showWaiting ? { kind: "waiting", text: "🔍 画像の分析待ち" } : null;
  if (a.review?.status === "要確認") return { kind: "needs_check", text: "🔍 画像 要確認" };
  const checks = Array.isArray(a.checks) ? (a.checks as Array<{ result?: string }>) : [];
  const ok = checks.filter((c) => c?.result === "ok").length;
  const ng = checks.filter((c) => c?.result === "ng").length;
  if (typeof a.match === "number" && Number.isFinite(a.match)) {
    // 2026-09-27 版 b: 判定に足した点（判定と同じ希望は数えない）。◎× も足した希望だけ数える。希望と答えが読めない古い形は前の見せ方（足していない）
    const b = imageBonusOf({ reason_codes: reasonCodes ?? null, image_analysis: a as ImageAnalysisForBonus });
    if (b) return { kind: "scored", match: a.match, ok: b.ok, ng: b.ng, bonus: b.points, covered: b.covered, text: `🔍 画像 ${signedPoints(b.points)}点${b.ok + b.ng ? `（◎${b.ok}・×${b.ng}）` : ""}` };
    return { kind: "scored", match: a.match, ok, ng, bonus: null, covered: 0, text: `🔍 画像 ${a.match}点${checks.length ? `（◎${ok}・×${ng}）` : ""}` };
  }
  return { kind: "unscored", text: "🔍 画像 点なし" };
}

/**
 * 回（まとめた回）の画像で分析の1行: 「🔍 画像で分析 9/10件（分析待ち 1件・要確認 0件）」。1件も分析していなければ null
 */
export function roundImageLine(items: ReadonlyArray<{ image_analysis?: ImageAnalysisLike; status?: string | null }>): string | null {
  const done = items.filter((x) => !!x.image_analysis);
  if (!done.length) return null;
  const needsCheck = done.filter((x) => x.image_analysis?.review?.status === "要確認").length;
  // 分析待ちは未送信（pending）の物だけ（送信済み・見送りはもう分析しない＝👑 の行の「分析待ち」と同じ数え方）。status が無い時は未送信とみる
  const waiting = items.filter((x) => !x.image_analysis && (x.status == null || x.status === "pending")).length;
  const extra = [waiting ? `分析待ち ${waiting}件` : "", needsCheck ? `要確認 ${needsCheck}件` : ""].filter(Boolean).join("・");
  return `🔍 画像で分析 ${done.length}/${items.length}件${extra ? `（${extra}）` : ""}`;
}

/**
 * 👑 の行の点。2026-09-27 版 b:「合計 169点（判定 163・画像 +6）」／分析待ち・要確認・古い形は「判定 163点」
 */
export function pointsLabel(score: number | null | undefined, a: ImageAnalysisLike, reasonCodes?: ReadonlyArray<string> | null): string {
  return totalPointsLabel({ score: typeof score === "number" ? score : null, reason_codes: reasonCodes ?? null, image_analysis: a as ImageAnalysisForBonus });
}

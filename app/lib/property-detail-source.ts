// app/lib/property-detail-source.ts
// 資料の中身（駐車場・ペット・保証会社・設備… 有無・可否の行）を **どこから読むか** を決め、文字層から読む口。
//
// 2026-09-29 竹内「昨日かなり DeepSeek で API 費用を使った。この点も踏まえて更に節約できないか調査する」
//   9/28 の DeepSeek $7.2（公式料金）のうち property_image_detail（資料の画像を読む）が $6.0（83%）。費用の 96% は**出力＝推論**
//   （1回 中央 6,200 トークン・30秒）。入力（画像 1,331 トークン）は $0.26 で、キャッシュは指示文の 128 トークンしか当たらない（画像は毎回違う）。
//   一方、売上サポの行は 973/973 が PDF の文字層あり・画像から読んだ行の 90% は文字層にそのまま載っていた。
//   影の比較（12件・元付の資料・同じ指示文・温度0・推論なし）:
//     文字層だけ … 基準（画像・推論 low）と同じ行 89%・1.6秒・$0.001/回・保証会社名と帖数はむしろ正確・反転なし
//     画像のまま推論なし … 82%・5秒・$0.0007 だが「2人入居不可 → 可」の反転が 1件（有無・可否の行に危ない）
//   → **文字層がある資料は画像を送らず文字層を読む（推論なし・温度0）。文字層が無い／薄い資料だけ今までどおり画像（推論 low）**
//
// 【決め方は純関数】detailSourceFor: 文字層の長さと「項目の見出し」が何個あるかで "text" / "image" を決める。
//   pdf_has_text=true でも「白い表（文字抜け）」の資料は中身が薄いので、見出しの数で見分ける（長さだけでは見分けられない）。
// 【同じ物件を二度読まない】reusableLinesByPdfUrl: 同じ印刷用 URL（pdf_url）の行が 7日以内に image_lines を持っていれば写す
//   （募集状況・退去予定は日で変わるので 7日で切る。9/28 は当日中の読み直しが 10%・2人以上のお客様に出た物件 84/863）。
//   2026-09-29 検証の反証で**写すのは文字層が無い行だけ**（planDetailSource）: 文字層読みは 1回 $0.001 なので写しの節約は週 $0.1 しか無く、
//   同じ部屋を2回読んだ 92組のうち 89組で image_lines が違っていた（画像読み・推論 low の揺れ）＝写しは揺れと古さ（現況・入居可能日）を持ち込むだけ。
//   文字層の無い行（画像 1回 $0.006）だけは写す価値がある。
// 【文字層の読み取りが失敗したら画像に倒す】旧は画像で読めていたので、DeepSeek の一時障害で材料が減らないように（費用は失敗した回だけ）
// ⚠ 読んだ行の使い先（image_lines／image_details・売上サポのカード・AIX の材料・引用返信）は変えない。
//   金額・住所・駅徒歩・面積を書かない線（PROPERTY_IMAGE_DETAIL_PROMPT と同じ）もそのまま。

import { parseDetailResult, type DetailResult } from "./property-image-read";
import { resolveReadProperty } from "./property-name-match";
import { alignVacancyLines } from "./sheet-vacancy";

export type DetailSource = "text" | "image" | "none";

/** 文字層をこれ未満しか持たない資料は「薄い」（画像に落とす）。売上サポの行は 8,000 字上限で保存・典型は 1,500〜4,000 字 */
export const DETAIL_TEXT_MIN_CHARS = 200;
/** 文字層に最低これだけの「項目の見出し」が無ければ白い表（文字抜け）とみなして画像に落とす */
export const DETAIL_TEXT_MIN_LABELS = 3;
/** 資料の表に出る見出し（PROPERTY_IMAGE_DETAIL_PROMPT の項目と同じ並び） */
export const DETAIL_TEXT_LABELS = [
  "間取", "所在階", "階", "向き", "方位", "築年", "構造", "現況", "入居可能", "入居時期", "退去予定", "解約予定",
  "駐車場", "駐輪場", "バイク", "ペット", "楽器", "保証会社", "保証人", "洗濯機", "設備", "フリーレント", "入居条件", "備考",
] as const;

/**
 * 文字層で足りるか（純関数）。hasImage=false で文字層も薄ければ "none"（読む物が無い）。
 * @param pdfText  PDF の文字層（property_pickups.pdf_text と同じ物・null 可）
 * @param hasImage 画像（agent_image_url / page_image_url）があるか
 */
export function detailSourceFor(pdfText: string | null | undefined, hasImage: boolean): DetailSource {
  const s = String(pdfText ?? "").trim();
  if (s.length >= DETAIL_TEXT_MIN_CHARS && countDetailLabels(s) >= DETAIL_TEXT_MIN_LABELS) return "text";
  return hasImage ? "image" : "none";
}

/** 文字層に出ている見出しの種類数（同じ見出しは1つに数える） */
export function countDetailLabels(pdfText: string): number {
  let n = 0;
  for (const l of DETAIL_TEXT_LABELS) if (pdfText.includes(l)) n++;
  return n;
}

/** 文字層のうち DeepSeek に渡す長さ（資料 2ページで十分・8,000 字保存の物も先頭で足りる） */
export const DETAIL_TEXT_MAX_CHARS = 6000;

/**
 * 文字層の読み取りの指示（固定・system に置く＝DeepSeek の前置きキャッシュが毎回当たる）。
 * 項目・線（金額・住所・駅徒歩・面積は書かない／「不明」「記載なし」は作らない）は画像版 PROPERTY_IMAGE_DETAIL_PROMPT と同じ。
 * ⚠ 文面を変えると前置きキャッシュが1回外れる（変える時は1か所だけ・llm_usage_logs の cache_read で戻るのを見る）
 */
export const PROPERTY_TEXT_DETAIL_SYSTEM = `次に渡す文字は、賃貸物件の資料（PDF）から取り出した文字です。物件の資料なら**書いてある条件だけ**を書き出してください。JSONのみ返答（説明文・コードブロック一切不要）：
{"kind":"property","lines":["駐車場: 敷地内 空有","ペット: 不可"]}
- kind: "property"（物件の資料・マイソク・間取り図）／"estimate"（見積書・初期費用の明細）／"document"（本人確認書類・申込書）／"other"
- kind が "property" 以外なら lines は必ず空配列（中身は書き出さない）
- lines に入れてよいのは次の項目だけ。**文字に書いてある物だけ**（書いていない項目は行ごと作らない）:
  間取り／所在階／向き／築年／構造／現況／入居可能日／退去予定／駐車場／駐輪場／バイク置場／
  ペット／楽器／保証会社／連帯保証人／洗濯機置場／設備／フリーレント／入居条件
- **金額・住所・駅徒歩・専有面積は書かない**（別の所で扱う）
- 値は資料の文字をそのまま短く写す。推測しない。「不明」「記載なし」という行も作らない
- 文字の並びが崩れていても（表の行と列が入れ替わって見えても）見出しと値の組を読む`;

/**
 * 2026-09-29（B・その2）送った画像を**書き写した文字**（readPropertyImageDetailByTranscript）から読む時の指示。
 * 文字層の指示（上）に2つ足しただけ（上の文面は売上サポの文字層の読み取りの前置きキャッシュのため変えない）:
 *   ① 2部屋以上の一覧（号室ごとの状況）を現況の1行にまとめる … 監査で Goパレス福島（3室とも「状況 10/末」）の退去予定が行から落ちた
 *      （「部屋の一覧があれば」だけだと1部屋の資料でも入居可能日「即入」を現況に畳んだ＝30枚中14件 → 2部屋以上に限った）
 *   ② 「6階建」を所在階にしない … 同じ資料で「所在階: 6階建」を作った（建物の階数）
 */
export const PROPERTY_TRANSCRIPT_DETAIL_SYSTEM = PROPERTY_TEXT_DETAIL_SYSTEM
  .replace("賃貸物件の資料（PDF）から取り出した文字です。", "賃貸物件の資料の画像を書き写した文字です。")
  + `
- 2部屋以上の一覧（「号室: 203 / 状況: 10/末」の行が2つ以上）がある時だけ、その状況を「現況: 203号室 10/末・205号室 10/末」の形で1行にまとめる。
  1部屋の資料の「現況」「入居可能日（入居時期）」の欄はいつも通りそれぞれの行にする
- 所在階は部屋の階だけ（「6階建」「地上10階」は建物の階数なので所在階にしない）${sheetReadR2Enabled() ? sheetReadR2Rules() : ""}`;

/**
 * 2026-10-13 竹内「退去予定日がどこに書いていて空室がどこに書いているか。退去予定と入居予定（入居可能日）の部分を正確に読み取る場所が分かるように」
 *   読み直した 1,213枚の見本 14枚を画像と突き合わせた取り違え（scripts/backfill-sent-image-details-90d.ts の後の目読み）:
 *   ① 備考の【現況】「空き予定（9/30退去予定）」の日付を落とした（リアプロ・サザンパークス）
 *   ② 特記事項の「内覧可能日：2026年8月1日〜」を落とした（項目に無かった・サンプラザ山坂）
 *   ③ 「案内方法: 8月末空き予定」を落とし、「期日指定(2026年09月上旬)」を「即日指定(2026年09月16日)」と書き換えた（元付・ジェントリー3）
 *   ④ 「現況/入居時期: 空室 / 即入」を「現況: 入居可能」「入居可能日: 空室 即入」に分けた（リアプロ・S-FORT桜川南）
 *   ⑤ 「解約予定日: 2026年6月30日」を退去予定にしなかった（エステムプラザ本町クロス）
 *   書き写しの文字の読み取り（送った画像）だけに足す（文字層の指示は売上サポの前置きキャッシュのため変えない）。戻す: SHEET_READ_R2=off
 */
export function sheetReadR2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SHEET_READ_R2 ?? "").trim().toLowerCase() !== "off";
}
export function sheetReadR2Rules(): string {
  // 関数の中に文を置く（上の PROPERTY_TRANSCRIPT_DETAIL_SYSTEM が読み込みの時に呼ぶ＝const だと初期化前で落ちる）
  return `
- 「現況/入居時期: A / B」（リアプロの資料）は「/」の前が現況・後ろが入居可能日（例「退去予定 / 2026年10月20日」→ 現況: 退去予定 ／ 入居可能日: 2026年10月20日。「空室 / 即入」→ 現況: 空室 ／ 入居可能日: 即入）。「入居可能」という現況は作らない
- 退去予定の日付は表の欄だけでなく 備考・特記事項・案内方法・【現況】 の文にもある（「空き予定（9/30退去予定）」「8月末空き予定」「解約予定日 2026年6月30日」）。あれば「退去予定: 9/30」の行にする（解約予定日＝退去予定）。退去予定の行にするのは「退去」「解約」「空き予定」の字が付いた日付だけ（入居時期・入居可能日の日付を退去予定にしない）
- 内覧（内見）の開始日（「内覧可能日：2026年8月1日〜」）があれば「内覧可能日: 2026年8月1日〜」の行にする（項目に内覧可能日を足す）
- 日付・「上旬/中旬/下旬」・「期日指定」「即入」「相談」は書いてある字のまま（日付に直したり言い換えたりしない）`;
}

/**
 * 読んだ行の現況・入居可能日・退去予定を決定論で整える（純関数・読み取りの後の出口）。取り違えの形（上の①〜⑤）のうち文字で直せる物:
 *   ・「現況: 退去予定 / 2026年10月20日」→ 現況: 退去予定 ＋ 入居可能日: 2026年10月20日（入居可能日の行が無い時）
 *   ・「現況: 入居可能」＋「入居可能日: 空室 即入」→ 現況: 空室 ＋ 入居可能日: 即入
 *   ・「現況: 解約予定日 2026年6月30日」「現況: 2026/9/中旬退去予定」「入居可能日: 2026/9/中旬退去予定」→ 現況: 退去予定 ＋ 退去予定: 日付
 * 書いていない値は作らない（日付は行の中の字だけ）。戻す: SHEET_READ_R2=off
 */
export function normalizeVacancyLines(lines: string[], env: Record<string, string | undefined> = process.env): string[] {
  if (!sheetReadR2Enabled(env)) return lines;
  const out = lines.map((l) => String(l ?? ""));
  const idxOf = (label: RegExp) => out.findIndex((l) => label.test(l));
  const valOf = (i: number) => (i >= 0 ? out[i].replace(/^[^:：]+[:：]\s*/, "").trim() : "");
  const has = (label: RegExp) => idxOf(label) >= 0;
  // 2026-10-13: リアプロの「(10/下)」の「下」だけの旬も日付に数える（数えないと ⑤ が「退去予定: 10/下」を落とした）
  const DATE = /(\d{4}[年/.-]\s*\d{1,2}(?:[月/.-]\s*(?:\d{1,2}日?|上旬|中旬|下旬|末|上|中|下))?|\d{1,2}\s*[月/]\s*(?:\d{1,2}日?|上旬|中旬|下旬|末|上|中|下))/;
  const S = /^現況\s*[:：]/, M = /^入居可能日\s*[:：]/, V = /^退去予定\s*[:：]/;
  // ① 現況に「A / B」
  let si = idxOf(S);
  if (si >= 0) {
    const m = valOf(si).match(/^(空室|退去予定|居住中|入居中|空き予定|賃貸中)\s*[\/／]\s*(.+)$/);
    // 「/」の後ろが入居時期の値（即入・相談・日付・上中下旬）の時だけ分ける。内装中・商談中・申込あり 等の状態は現況に残す（消さない）
    const MOVEIN_VAL = /^(?:即入(?:居)?(?:可)?|即日|相談|期日指定.*|\d{4}[年/.-].*|\d{1,2}\s*[月/].*)$/;
    if (m && MOVEIN_VAL.test(m[2].trim())) {
      const mv = idxOf(M);
      if (mv < 0) { out[si] = `現況: ${m[1]}`; out.push(`入居可能日: ${m[2].trim()}`); }
      else if (valOf(mv).replace(/\s+/g, "") === m[2].replace(/\s+/g, "") || /^相談$/.test(m[2].trim())) out[si] = `現況: ${m[1]}`;
    }
  }
  // ② 現況「入居可能」＋ 入居可能日「空室 …」
  si = idxOf(S); let mi = idxOf(M);
  if (si >= 0 && mi >= 0 && /^入居可能$/.test(valOf(si)) && /^空室/.test(valOf(mi))) {
    const rest = valOf(mi).replace(/^空室\s*[\/／、・]?\s*/, "").trim();
    out[si] = "現況: 空室"; if (rest) out[mi] = `入居可能日: ${rest}`; else out.splice(mi, 1);
  }
  // ③ 解約予定日・〇〇退去予定（日付つき）が現況・入居可能日に入っている
  for (const lab of [S, M]) {
    const i = idxOf(lab);
    if (i < 0) continue;
    const v = valOf(i);
    if (!/解約予定|退去予定|空き?予定/.test(v)) continue;
    // 退去の日付と言えるのは「解約予定日 日付」「退去予定日 日付」「退去予定(日付)」「日付＋退去予定／空き予定」の形だけ。
    //   「退去予定 2026年12月上旬」（日付が後ろ・区切りなし）はリアプロの「現況/入居時期」の入居時期かもしれない＝退去予定の行にしない
    const explicit = v.match(new RegExp(`(?:解約予定日?|退去予定日)\\s*[:：]?\\s*${DATE.source}|退去予定\\s*[（(]\\s*${DATE.source}\\s*[）)]|${DATE.source}\\s*(?:に)?(?:退去予定|退去|空き?予定)`));
    const d = explicit ? explicit[0].match(DATE) : null;
    if (lab === M) { out.splice(i, 1); if (!has(S)) out.push("現況: 退去予定"); }
    else if (d && /解約予定/.test(v)) out[i] = "現況: 退去予定";
    if (d && !has(V)) out.push(`退去予定: ${d[0].replace(/\s+/g, "")}`);
  }
  // ④ 退去予定が入居可能日と同じ値（入居時期の日付を写した・サンプラザ山坂「退去予定 / 2026年8月下旬」の読み直し）は退去予定の行を落とす
  const vi = idxOf(V), mi2 = idxOf(M);
  if (vi >= 0 && mi2 >= 0 && valOf(vi).replace(/\s+/g, "") === valOf(mi2).replace(/\s+/g, "")) out.splice(vi, 1);
  // ⑤ 日付の無い退去予定の行（「退去予定: 退去予定」）は落とす（現況の行が持つ）
  const vi2 = idxOf(V);
  if (vi2 >= 0 && !DATE.test(valOf(vi2))) out.splice(vi2, 1);
  return out;
}

/** 読み直しでも同じ形（前置きの先頭一致を保つ） */
export function buildTextDetailUser(pdfText: string): string {
  return `【資料の文字】\n${String(pdfText ?? "").replace(/\r/g, "").trim().slice(0, DETAIL_TEXT_MAX_CHARS)}`;
}

/** 推論なし・答えは 20行以内なので小さくてよい（画像版は推論込みで 12,000）。JSON が長くても 1,500 で切れない */
export const PROPERTY_TEXT_DETAIL_MAX_TOKENS = 1500;
export const PROPERTY_TEXT_DETAIL_TIMEOUT_MS = 30_000;

/**
 * 同じ印刷用 URL（pdf_url）の行に 7日以内の image_lines があれば写す（純関数）。
 * 複数あれば新しい方。空の配列・古い行は写さない
 */
export function reusableLinesByPdfUrl(
  rows: Array<{ pdf_url: string | null; image_lines: unknown; created_at: string | null }>,
  nowMs: number,
  maxAgeDays = 7,
): Map<string, string[]> {
  const out = new Map<string, { lines: string[]; at: number }>();
  const minAt = nowMs - maxAgeDays * 86_400_000;
  for (const r of rows) {
    if (!r.pdf_url || !Array.isArray(r.image_lines) || r.image_lines.length === 0) continue;
    const at = r.created_at ? Date.parse(r.created_at) : NaN;
    if (!Number.isFinite(at) || at < minAt || at > nowMs + 60_000) continue;
    const lines = (r.image_lines as unknown[]).map((x) => String(x ?? "").trim()).filter((s) => s.length >= 2 && s.length <= 120);
    if (lines.length === 0) continue;
    const prev = out.get(r.pdf_url);
    if (!prev || at > prev.at) out.set(r.pdf_url, { lines, at });
  }
  return new Map([...out.entries()].map(([k, v]) => [k, v.lines]));
}

/** どこから読むか（写し・文字層・画像・無し）。image_details.model の先頭にもこの語を付けて出所を残す */
export type DetailPlan =
  | { source: "reuse"; lines: string[] }
  | { source: "text" | "image" | "none" };

/**
 * 写し → 文字層 → 画像 の順を決める純関数。
 * **写しは文字層が無い行だけ**（文字層がある行は毎回 $0.001 で読む方が正確で新しい）
 * @param reusedLines 同じ pdf_url の 7日以内の行の image_lines（reusableLinesByPdfUrl の値・無ければ null）
 */
export function planDetailSource(pdfText: string | null | undefined, hasImage: boolean, reusedLines: string[] | null | undefined): DetailPlan {
  const src = detailSourceFor(pdfText, hasImage);
  if (src === "text") return { source: "text" };
  if (reusedLines && reusedLines.length > 0) return { source: "reuse", lines: reusedLines };
  return { source: src };
}

/**
 * image_details.model に残す出所付きのモデル名（列は text なので列追加なし・migrate-schema の変更不要）。
 *   "text:deepseek-flash"（文字層）／"reuse"（同じ物件の写し）／"image:deepseek-flash"（画像・推論 low）／
 *   "pickup_lines"（送った画像を売上サポの行の image_lines から写した）／"pickup_text:deepseek-flash"（売上サポの行の文字層）
 *   ／"transcribe:deepseek-flash"（送った画像を書き写して文字で読んだ・2026-09-29 readPropertyImageDetailByTranscript）
 * 後から「この行は画像で読んだのか写しか」を表だけで追える（scripts/audit-detail-source.ts が model 別に数える）
 */
export function detailModelLabel(source: string, model: string | null | undefined): string {
  const m = (model ?? "").trim();
  if (source === "reuse" || source === "pickup_lines") return source;
  return m ? `${source}:${m}` : source;
}

/** 送った画像が売上サポの行に当たった時、行のどれで済ませるか（純関数）。image_lines があれば写す・無ければ文字層で読む・どちらも無ければ null */
export function pickupRowDetailPlan(
  rows: Array<{ image_lines: unknown; pdf_text: string | null }>,
): { kind: "lines"; lines: string[] } | { kind: "text"; text: string } | null {
  for (const r of rows) {
    if (!Array.isArray(r.image_lines) || r.image_lines.length === 0) continue;
    const lines = (r.image_lines as unknown[]).map((x) => String(x ?? "").trim()).filter((s) => s.length >= 2 && s.length <= 120);
    // 2026-10-13: 写す行も同じ行の文字層の欄に合わせる（9/26〜29 の画像読みは「退去予定 / 2026年10月20日」の入居時期を退去予定にした行が 127行ある）
    if (lines.length > 0) return { kind: "lines", lines: normalizeVacancyLines(alignVacancyLines(lines, r.pdf_text).lines) };
  }
  for (const r of rows) {
    if (detailSourceFor(r.pdf_text, false) === "text") return { kind: "text", text: r.pdf_text as string };
  }
  return null;
}

/** 売上サポの行を物件名・号室で結ぶ時に見る日数（prime と同じく資料の行は7日で古くなる＝募集状況・退去予定が変わる） */
export const PICKUP_LINK_MAX_AGE_DAYS = 7;

/**
 * 送った画像の物件（物件名・号室）に当たる、その会話の売上サポの行を1つ選ぶ（純関数）。
 * 2026-09-29 API 費用: AIX が送る画像は再アップロードで URL が変わり（URL では結べない）、行 ID が来るのは売上サポから開いた時だけ。
 *   本番 7日: 送った画像 283枚のうち 78枚（28%）は物件名・号室がその会話の売上サポの行と一致した（URL・行 ID では 0枚）。
 *   物件名は照合（resolveReadProperty＝会話の物件名に寄せる・建物の番号 Ⅱ/III が違えば寄せない）、号室は先頭の0を外して一致。
 *   号室が読めない（空）・行に号室が無い時は結ばない（同じ建物の別の部屋の資料を使わない）。一致が複数なら新しい行。
 * @param rows その会話の直近 PICKUP_LINK_MAX_AGE_DAYS 日の行（新しい順でなくてよい）
 */
export function pickupRowForProperty<R extends { property_name: string | null; room_no: string | null; created_at: string | null }>(
  item: { propertyName: string | null | undefined; roomNumber: string | null | undefined } | null,
  rows: R[],
  nowMs: number,
): R | null {
  if (!item?.propertyName) return null;
  const room = (s: string | null | undefined) => String(s ?? "").trim().replace(/号室\s*$/, "").replace(/^0+(?=\d)/, "");
  const r0 = room(item.roomNumber);
  if (!r0) return null;
  const minAt = nowMs - PICKUP_LINK_MAX_AGE_DAYS * 86_400_000;
  const fresh = rows.filter((r) => r.property_name && room(r.room_no) === r0 && Number.isFinite(Date.parse(r.created_at ?? "")) && Date.parse(r.created_at!) >= minAt);
  if (fresh.length === 0) return null;
  const hit = resolveReadProperty({ propertyName: item.propertyName, roomNumber: item.roomNumber ?? "" }, [...new Set(fresh.map((r) => r.property_name as string))]);
  if (!hit) return null;
  const same = fresh.filter((r) => (r.property_name as string).trim() === hit.propertyName);
  same.sort((a, b) => Date.parse(b.created_at!) - Date.parse(a.created_at!));
  return same[0] ?? null;
}

/**
 * 可否・有無の項目 → 文字層にその項目が「書いてある」と言える言葉（どれか1つ）。
 * 2026-09-29 監査 scripts/audit-image-read-grounding.ts: 文字層の読み取り（推論なし）は 24件中 4〜6行、
 *   文字層に言葉の無い可否を作った（「ペット: 不可」＝指示の例を写す・「連帯保証人: 保証人不要」）。
 */
export const GROUNDED_LABEL_WORDS: Record<string, RegExp> = {
  ペット: /ペット|犬|猫|動物/,
  楽器: /楽器|ピアノ/,
  連帯保証人: /保証人/,
  駐車場: /駐車|パーキング/,
  駐輪場: /駐輪|自転車/,
  バイク置場: /バイク|原付|二輪|オートバイ/,
  洗濯機置場: /洗濯/,
  フリーレント: /フリーレント/,
};

/**
 * 文字層から読んだ行のうち、可否・有無の項目で**文字層にその言葉が1つも無い行**を落とす（純関数・出口の決定論）。
 * 文字層の読み取りは文字しか見ていないので、言葉が無い行は必ず作った行＝誤削除は起きない（画像の読み取りには使わない: アイコンは文字層に無い）。
 * 文字層は康煕部首（⼈・⾞）や行の途中の空白で入る事があるので NFKC・空白を外して見る。上の表に無い項目（設備・入居条件・構造…）は触らない
 */
export function dropUngroundedLines(lines: string[], sourceText: string): { kept: string[]; dropped: string[] } {
  const text = String(sourceText ?? "").normalize("NFKC").replace(/\s+/g, "");
  const kept: string[] = []; const dropped: string[] = [];
  for (const l of lines) {
    const label = l.normalize("NFKC").replace(/\s+/g, "").split(/[:：]/)[0] ?? "";
    const re = GROUNDED_LABEL_WORDS[label];
    if (re && !re.test(text)) dropped.push(l); else kept.push(l);
  }
  return { kept, dropped };
}

export type TextDetailResult = DetailResult & { ms: number; model: string; failed: boolean };

/**
 * 文字層から資料の中身を読む（DeepSeek flash・推論なし・温度0）。失敗しても投げない（lines が空・failed=true）。
 * 同じ前置きのまま1回だけ読み直し、Claude には倒さない（設計知見「物件の判断・読み取りは DeepSeek だけ」）。
 * 費用は llm_usage_logs に action="property_text_detail" で残す（画像版 property_image_detail と並べて数えられる）。
 */
export async function readPropertyDetailFromText(
  pdfText: string,
  opts?: { apiKey?: string; model?: string; timeoutMs?: number; conversationId?: string | null; system?: string },
): Promise<TextDetailResult> {
  const system = opts?.system ?? PROPERTY_TEXT_DETAIL_SYSTEM;
  const startedAt = Date.now();
  const { callDeepSeekRead, VISION_ALT_MODEL_DEFAULT } = await import("./vision-alt-provider");
  const model = (opts?.model ?? process.env.PROPERTY_IMAGE_MODEL ?? VISION_ALT_MODEL_DEFAULT).trim();
  const text = String(pdfText ?? "").trim();
  if (!text) return { kind: "other", lines: [], raw: "", ms: 0, model, failed: true };
  // 鍵が無い環境（ローカル）では呼ばず・記録もしない（画像版 readPropertyImageDetail と同じ。旧は行ごとに status 0 の行が llm_usage_logs に残った）
  if (!(opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim()) return { kind: "other", lines: [], raw: "", ms: 0, model, failed: true };
  const budget = opts?.timeoutMs ?? PROPERTY_TEXT_DETAIL_TIMEOUT_MS;
  const read = await callDeepSeekRead(system, buildTextDetailUser(text),
    { maxTokens: PROPERTY_TEXT_DETAIL_MAX_TOKENS, timeoutMs: budget, apiKey: opts?.apiKey, model },
    (t) => { const r = parseDetailResult(t); return r.kind === "other" && r.lines.length === 0 && !/"kind"\s*:\s*"other"/.test(t) ? null : r; },
    { retryIf: (elapsed) => budget - elapsed >= 3_000, retryTimeoutMs: (elapsed) => budget - elapsed });
  const ms = Date.now() - startedAt;
  void import("./llm-usage-recorder").then(({ recordAltUsage }) => {
    for (const a of read.attempts) {
      recordAltUsage({
        model: a.res?.model ?? model, action: "property_text_detail", conversationId: opts?.conversationId ?? null,
        usage: { input_tokens: a.res?.usage.cacheMiss ?? 0, output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
        status: a.res ? 200 : 0, errorType: a.ok ? null : a.res ? "empty_or_unparsable" : "no_response",
        durationMs: a.ms, sysHead: a.retry ? "【読み直し】" + system.slice(0, 180) : system.slice(0, 200),
        sysKeyFull: null, maxTokens: PROPERTY_TEXT_DETAIL_MAX_TOKENS,
      });
    }
  }).catch(() => {});
  const v0 = read.value;
  if (!v0) return { kind: "other", lines: [], raw: read.res?.text ?? "", ms, model: read.res?.model ?? model, failed: true };
  // 2026-09-29: 文字層に言葉の無い可否の行（作った行）を落とす（dropUngroundedLines・誤削除0）
  const g = dropUngroundedLines(v0.lines, text.slice(0, DETAIL_TEXT_MAX_CHARS));
  if (g.dropped.length) console.log(JSON.stringify({ tag: "text-detail:ungrounded-dropped", conversationId: opts?.conversationId ?? null, dropped: g.dropped }));
  // 2026-10-13: 現況・入居可能日・退去予定の取り違えの形を決定論で整える（normalizeVacancyLines・SHEET_READ_R2=off で止まる）
  //   さらに、元の文字（文字層・書き写し）の欄で読んだ現況・退去予定・入居可能日・内覧可能日に合わせる（alignVacancyLines・SHEET_VACANCY_FIELDS=off で止まる）
  //   ＝リアプロ「現況/入居時期 退去予定 / 2026年10月20日」の入居時期を退去予定にした行・備考の退去日を落とした行を、欄の値に直す
  const al = alignVacancyLines(g.kept, text.slice(0, DETAIL_TEXT_MAX_CHARS));
  if (al.changed) console.log(JSON.stringify({ tag: "text-detail:vacancy-aligned", conversationId: opts?.conversationId ?? null, before: g.kept.filter((l) => /^(現況|退去予定|入居可能日|内覧可能日)/.test(l)), after: al.lines.filter((l) => /^(現況|退去予定|入居可能日|内覧可能日)/.test(l)), from: al.read ? { current: al.read.currentFrom, vacate: al.read.vacateFrom, moveIn: al.read.moveInFrom } : null }));
  const v = { ...v0, lines: normalizeVacancyLines(al.lines) };
  return { ...v, usage: read.res ? { input: read.res.usage.input, output: read.res.usage.output, cacheHit: read.res.usage.cacheHit } : undefined, ms, model: read.res?.model ?? model, failed: false };
}

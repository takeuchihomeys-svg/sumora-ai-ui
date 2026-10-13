// app/lib/extract-vacancy-date-prompt.ts
// AIX【物件確認した】で貼った物件資料の画像から「物件名・退去予定日」を読む（/api/extract-vacancy-date・Claude Haiku）。
//
// 2026-10-13 竹内「退去予定日がどこに書いていて…退去予定と入居予定の部分を、資料の読み取る箇所を間違えていた部分等も」:
//   旧は Haiku に退去予定日そのものを判断させていた。取り違えやすい資料4枚（scripts/verify-extract-vacancy-date.ts）で
//   ・リアプロ「現況/入居時期 退去予定 / 2026年10月20日」の / の後ろ（入居時期）を退去予定日として返す（maison de Villa 北畠）
//   ・備考【現況】「空き予定(9/30退去予定)」・案内方法「8月末空き予定」を落とす／「8月」に丸める
//   ＝前 1/4。指示に欄の場所を書き足しても Haiku は守らず 0/4（判断を任せる形が根本の原因）。
//   ここで返した日付はお客様への文「10月20日退去予定のため…」にそのまま入る。
//   → 送った画像の読み方（書き写し → 欄で読む）と同じ形にする: Haiku には**欄の見出しと値を書き写させるだけ**にし、
//     どれが退去予定日かは sheet-vacancy（決定論・欄で読む）が決める。分からない時は null（作らない）。
//   戻す: SHEET_VACANCY_FIELDS=off（旧の指示・旧の返し方）
import { readSheetVacancy, sheetDateKey, sheetVacancyFieldsEnabled } from "./sheet-vacancy";
import { JA_KANJI_INSTRUCTION, jaKanji } from "./ja-kanji";

const LEGACY_SYSTEM = `あなたは日本の物件資料（不動産マイソク・物件概要書）から情報を抽出するAIです。
以下の2つをJSONで返してください。

【propertyName】
物件名を「マンション名 号室番号号室」の形式で返す。
探し方：
- 資料の最上部・タイトル行に大きく書かれたマンション名（例「エスリード新大阪グランファースト 208 号室」）
- 「物件名」「マンション名」と書かれた欄の値
- 「号室名」欄がある場合はマンション名と組み合わせる（例「KTIレジデンス西中島II 202号室」）
- 号室番号は資料の表記のまま（先頭の0・英字も落とさない: 0202 は 0202）
- 不明な場合のみ null

【vacancyDate】
★最重要ルール：「現況」欄が「空室」の場合は必ず null を返す。
退去予定日は「現況が入居中（または空室でない）」かつ「退去予定日が記載されている場合」のみ返す。
- 「現況: 空室」「現況: 空室 / 7月下旬」→ null（空室物件は退去予定ではない）
- 「現況: 入居中」「退去予定: 8月下旬」→ "8月下旬"
- 「現況/入居時期」欄が「空室 / ○月○旬」形式→ 現況が空室なので null
- 「退去予定日」欄に日付がある場合のみ月日を返す（例: "8月31日"）
- 年号（2026年等）は不要・月日のみ返す

出力はJSONのみ・説明文なし：
{"propertyName":"KTIレジデンス西中島II 202号室","vacancyDate":null}`;

const FIELDS_SYSTEM = `あなたは日本の物件資料（不動産マイソク・物件概要書）の文字を書き写すAIです。判断はしない（書いてある字をそのまま写すだけ）。
JSONで返してください。

【propertyName】
物件名を「マンション名 号室番号号室」の形式で返す。
- 資料の最上部・タイトル行に大きく書かれたマンション名、または「物件名」「マンション名」の欄の値
- 「号室名」欄がある場合はマンション名と組み合わせる（例「KTIレジデンス西中島II 202号室」）
- 号室番号は資料の表記のまま（先頭の0・英字も落とさない: 0202 は 0202）
- 不明な場合のみ null

【fields】次の欄・文が資料にあれば、1つずつ「見出し: 値」の形で、**資料の字のまま**書き写す（無い物は書かない）:
- 「現況/入居時期」「現況」「入居可能時期」「入居可能日」「入居時期」「入居予定日」「退去予定日」「解約予定日」「退去日」の欄（例「現況/入居時期: 退去予定 / 2026年10月20日 / 商談中」）
- 備考・特記事項・案内方法・カギ所在・【現況】などの文のうち「退去」「解約」「空き予定」「空予定」の字を含む文（例「備考: 空き予定(9/30退去予定)」「案内方法: 8月末空き予定」）
- 日付・「上旬/中旬/下旬」「末」「期日指定」「即入」「相談」は字のまま（日付に直さない・言い換えない）
${JA_KANJI_INSTRUCTION}

出力はJSONのみ・説明文なし：
{"propertyName":"KTIレジデンス西中島II 202号室","fields":["現況/入居時期: 退去予定 / 2026年10月20日"]}`;

export function extractVacancyDateSystem(env: Record<string, string | undefined> = process.env): string {
  return sheetVacancyFieldsEnabled(env) ? FIELDS_SYSTEM : LEGACY_SYSTEM;
}

/** 日付の鍵（「9/30」「8/末」「9/下旬」）→ 画面・文に入れる形（「9月30日」「8月末」「9月下旬」）。月だけは返さない */
export function vacancyDateLabel(raw: string | null | undefined): string | null {
  const k = sheetDateKey(raw);
  if (!k) return null;
  const [mo, d] = k.split("/");
  if (/^\d+$/.test(d)) return `${Number(mo)}月${Number(d)}日`;
  if (d === "末" || /旬$/.test(d)) return `${Number(mo)}月${d}`;
  return null;
}

/**
 * Haiku の返事から物件名と退去予定日を作る（純関数）。
 *   新: fields（書き写した欄）を sheet-vacancy で欄ごとに読む＝入居時期の日付は退去予定日にしない・現況が空室なら null
 *   旧（SHEET_VACANCY_FIELDS=off）: vacancyDate をそのまま
 */
export function parseExtractVacancyResponse(raw: string, env: Record<string, string | undefined> = process.env): { propertyName: string | null; vacancyDate: string | null; fields?: string[]; vacancyFrom?: string | null } {
  const m = String(raw ?? "").match(/\{[\s\S]*\}/);
  if (!m) return { propertyName: null, vacancyDate: null };
  let o: { propertyName?: string | null; vacancyDate?: string | null; fields?: unknown };
  try { o = JSON.parse(m[0]); } catch { return { propertyName: null, vacancyDate: null }; }
  const propertyName = typeof o.propertyName === "string" && o.propertyName.trim() ? jaKanji(o.propertyName).trim() : null;
  if (!sheetVacancyFieldsEnabled(env)) return { propertyName, vacancyDate: typeof o.vacancyDate === "string" && o.vacancyDate.trim() ? o.vacancyDate.trim() : null };
  const fields = Array.isArray(o.fields) ? (o.fields as unknown[]).map((x) => jaKanji(String(x ?? "")).trim()).filter(Boolean).slice(0, 20) : [];
  const v = readSheetVacancy(fields.join("\n"));
  return { propertyName, vacancyDate: vacancyDateLabel(v.vacate), fields, vacancyFrom: v.vacateFrom };
}

/** 新の時の画像に添える文（書き写しだけ） */
export const EXTRACT_VACANCY_USER_TEXT = "この物件資料の物件名と、現況・入居時期・退去予定の欄と文を書き写してください。";

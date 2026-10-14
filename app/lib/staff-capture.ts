// app/lib/staff-capture.ts — スタッフしか知らない事（物件確認の別の部屋・内覧の結果・電話の結果）を AIX の入力からブレインの材料へ（純関数・DB/LLM なし・画面とサーバーの両方から使う）
//
// 2026-10-14 竹内さん（設計知見 37af1885「取りこぼしの無い設計」）:
//   「AIX 物件確認したでも同じマンションで別の部屋を送る場合に入れるピッカーがある… その別の部屋が空いていてお客さんが食いついていたら、その別の部屋が中心になるように」
//   「内覧終了の挨拶を送る際、内覧の結果をスタッフが共有する画面をつくる… 電話完了後も同じ」「取りこぼしがないよう設計すれば完全に理解できるようになる」
//
// 実データ（scripts/audit-staff-info-capture.ts・120日・LLM なし）:
//   ① 上の「別の部屋が募集してた」9番: 記録に別の部屋の名前 0（property_names を記録していなかった）
//   ② 物件カードの「別の部屋」7番: 名前はあるが、台帳（property-thread）・お客様の状況（customer-state）が状態 "alternative" を読まず
//      「ただの送付」扱い＝今の番の物件の候補・主のお部屋に入らない → 次のブレインの今の物件がその部屋 0/6
//   ③ 内覧後の挨拶 9番: 内覧の内容 0（自由入力の欄だけで書く人がいない）・保存と生成が同時に走るので1通目の文には届かない作り
//   ④ 電話終了後 0番（電話をかけるボタンは 19回）: 電話で分かった事はどこにも残っていない
// 決め方: 入れた事実は材料として渡すだけ・判断（今の物件・次の一手・文）はブレインが決める（P0 9eb6aa9c・0593a0aa）。
// 戻す: STAFF_CAPTURE_ALTERNATIVE=off（台帳・状況が別の部屋を募集中として読む所）／NEXT_PUBLIC_STAFF_CAPTURE_UI=off（画面のタップ入力）／
//       STAFF_CAPTURE_CALL=off（電話の結果のメモをブレインに渡す所）

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {}) as Env;
const off = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "off";

/** 物件確認の「別の部屋」（prop_statuses = alternative）を、台帳・お客様の状況で「確認の結果 別の部屋が募集中」として読むか */
export function alternativeCaptureEnabled(env: Env = envOf()): boolean {
  return !off(env.STAFF_CAPTURE_ALTERNATIVE);
}
/** 画面のタップ入力（内覧の結果・電話の結果・別の部屋の号室）。画面では NEXT_PUBLIC_ の値しか入らない */
export function staffCaptureUiEnabled(): boolean {
  return !off(process.env.NEXT_PUBLIC_STAFF_CAPTURE_UI);
}
/** 電話の結果のメモ（お客様のメモの kind=call）をブレインの材料に渡すか */
export function callCaptureEnabled(env: Env = envOf()): boolean {
  return !off(env.STAFF_CAPTURE_CALL);
}

// ─── ① 物件確認した → 上の「別の部屋が募集してた」の記録 ───

/** 号室の形（先頭の0は外す＝設計知見 f7c8b201） */
function roomOf(s: string | null | undefined): string | null {
  const t = String(s ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/\s+/g, "").trim();
  if (!/^[A-Za-z]?-?\d{1,4}[A-Za-z]?$/.test(t)) return null;
  return t.replace(/^([A-Za-z]?-?)0+(?=\d)/, "$1");
}

/**
 * 固定テンプレの本文「お送り頂きました〇〇（302号室）ですが確認しましたところ募集終了しておりました」から建物名を読む。
 * 読めない時は null（推測しない）
 */
export function alternativeBuildingFromText(text: string | null | undefined): string | null {
  const m = String(text ?? "").match(/お送り(?:頂|いただ)きました\s*(.+?)\s*(?:[A-Za-z]?-?\d{1,4}[A-Za-z]?\s*号室)?\s*ですが[、,]?\s*確認/);
  // fix(review): 本番の固定文は「[物件名]${N}階${号室}号室」「${N}階部分」「のお部屋」（action/route.ts endedRoomStr）→ 階・部分・のお部屋を外す
  const b = m?.[1]?.replace(/[「」『』【】]/g, "")
    .replace(/\s*[（(]?\s*[0-9０-９]{1,3}\s*階(?:部分)?\s*[）)]?$/, "").replace(/\s*の?お部屋$/, "").trim();
  if (!b || b.length < 2 || b.length > 40 || /\[物件名\]|物件名/.test(b)) return null;
  return b;
}

/**
 * 上の「別の部屋が募集してた」の記録（aix_usage_logs.property_names / prop_statuses）。
 *   代わりのお部屋＝ alternative（号室が分かる時だけ。建物だけだと募集終了の部屋に寄ってしまう＝設計知見 abce93ff の寄せない線）
 *   募集終了だったお部屋＝ unavailable（号室が分かる時だけ）
 */
export function alternativeCheckRecord(o: { text: string | null | undefined; building?: string | null; endedFloor?: number | null; endedUnit?: string | null; altUnit?: string | null }): { names: string[]; statuses: string[] } {
  const building = (o.building ?? "").trim() || alternativeBuildingFromText(o.text);
  const names: string[] = [];
  const statuses: string[] = [];
  if (!building) return { names, statuses };
  const alt = roomOf(o.altUnit);
  const ended = roomOf(o.endedUnit);
  if (alt) { names.push(`${building} ${alt}号室`); statuses.push("alternative"); }
  if (ended && ended !== alt) { names.push(`${building} ${ended}号室`); statuses.push("unavailable"); }
  return { names, statuses };
}

// ─── ② 内覧の結果（内覧後の挨拶の画面・タップで入れる） ───

export const VIEWING_MOOD_OPTIONS = ["気に入った", "前向きに検討", "迷っている", "見送り"] as const;
export const VIEWING_LIKE_OPTIONS = ["家賃・初期費用", "広さ・間取り", "日当たり", "きれいさ", "駅・立地", "設備", "収納", "周りの環境"] as const;
export const VIEWING_CONCERN_OPTIONS = ["家賃・初期費用", "広さ・間取り", "日当たり", "騒音・周り", "駅・立地", "設備", "収納", "古さ・汚れ", "駐車場"] as const;
export const VIEWING_NEXT_OPTIONS = ["申込する", "家族と相談", "他の物件も見たい", "見積がほしい", "もう一度見たい", "連絡待ち"] as const;
export type ViewingTaps = { mood?: string | null; likes?: string[]; concerns?: string[]; next?: string[]; who?: string | null };

/**
 * タップの結果を内覧の内容の行に（viewing_history.viewing_report に保存・ブレイン・返信・AIX は既存の viewing-report が渡す）。
 * 自由入力の文は後ろにそのまま残す。同じ行がもう入っていれば足さない（作り直しで重ならない）
 */
export function composeViewingReport(taps: ViewingTaps, free: string | null | undefined): string {
  const lines: string[] = [];
  if (taps.mood) lines.push(`内覧の結果: ${taps.mood}`);
  if (taps.likes?.length) lines.push(`気に入った点: ${taps.likes.join("、")}`);
  if (taps.concerns?.length) lines.push(`気になった点: ${taps.concerns.join("、")}`);
  if (taps.next?.length) lines.push(`次の動き: ${taps.next.join("、")}`);
  if (taps.who?.trim()) lines.push(`決める人・相談相手: ${taps.who.trim()}`);
  const freeText = String(free ?? "").trim();
  const freeLines = freeText ? freeText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  // 前に保存した内容（タップの行を含む）を初期値に戻した時に重ならないよう、タップの見出しの行は自由入力から外す
  const TAP_HEAD = /^(?:内覧の結果|気に入った点|気になった点|次の動き|決める人・相談相手):/;
  const rest = lines.length ? freeLines.filter((l) => !TAP_HEAD.test(l)) : freeLines;
  return [...lines, ...rest].join("\n");
}

/** 保存した内覧の内容 → タップの初期値と自由入力（画面で開き直した時） */
export function parseViewingReport(report: string | null | undefined): { taps: ViewingTaps; free: string } {
  const taps: ViewingTaps = { mood: null, likes: [], concerns: [], next: [], who: null };
  const free: string[] = [];
  for (const l of String(report ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const m = l.match(/^(内覧の結果|気に入った点|気になった点|次の動き|決める人・相談相手):\s*(.*)$/);
    if (!m) { free.push(l); continue; }
    const vals = m[2].split("、").map((x) => x.trim()).filter(Boolean);
    if (m[1] === "内覧の結果") taps.mood = m[2].trim() || null;
    else if (m[1] === "気に入った点") taps.likes = vals;
    else if (m[1] === "気になった点") taps.concerns = vals;
    else if (m[1] === "次の動き") taps.next = vals;
    else taps.who = m[2].trim() || null;
  }
  return { taps, free: free.join("\n") };
}

// ─── ③ 電話の結果（電話終了後の画面・お客様のメモ kind=call に保存） ───

export const CALL_RESULT_OPTIONS = ["条件を聞いた", "物件を探す約束", "内覧の日程が決まった", "申込の意思あり", "家族と相談", "他社で検討中", "見送り"] as const;
export const CALL_MEMO_MAX_CHARS = 200;

/** 電話の結果の1件（お客様のメモの1行・200字まで）。タップの結果を頭に、メモの本文を後ろに */
export function composeCallReport(taps: string[], notes: string | null | undefined): string {
  const head = taps.length ? `【${taps.join("・")}】` : "";
  const body = String(notes ?? "").replace(/\r?\n+/g, " ／ ").replace(/\s+/g, " ").trim();
  return `${head}${head && body ? " " : ""}${body}`.slice(0, CALL_MEMO_MAX_CHARS);
}

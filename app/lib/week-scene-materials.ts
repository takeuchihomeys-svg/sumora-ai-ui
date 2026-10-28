// app/lib/week-scene-materials.ts — 竹内さんの今週の LINE の指摘（10/28 受け取り）から、ブレインに渡す場面の材料（純関数・決めるのはブレイン＝P0）
//
//   #33 じゅな: 退去予定の部屋で内覧を組んだ後・内覧が7日以内 → 先にお申込でお部屋を抑えてから内覧（内覧後にご判断頂ける）を勧める番。
//       「管理会社に確認しましたところ」は入れない（KB P1 記録済み）。VACATE_VIEWING_HOLD_FIRST
//   #3 #7 KID: 退去予定の部屋で「申込→内覧→気に入らなければキャンセル」を聞かれた → 返信で言い切らず管理会社に確認（AIX【確認した】→お部屋止めについて）。
//       返信には入居まで期間がある事と、そのためお部屋を抑える意味の説明。VACATE_HOLD_CANCEL_CHECK
//   #37 れい: 前向きな発言（洗濯機置き場があって気になる）に否定的な事（記載が見当たらない 等）を返信で書かない・否定は AIX【確認した】から。POSITIVE_NO_NEGATIVE
// テスト: app/lib/__tests__/week-scene-materials.test.ts
type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";
export const vacateViewingHoldFirstEnabled = (env: Env = envOf()) => on(env.VACATE_VIEWING_HOLD_FIRST);
export const vacateHoldCancelCheckEnabled = (env: Env = envOf()) => on(env.VACATE_HOLD_CANCEL_CHECK);
export const positiveNoNegativeEnabled = (env: Env = envOf()) => on(env.POSITIVE_NO_NEGATIVE);

const DAY = 86_400_000;
const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\s・･\-ー]/g, "");

/** 送った物件のうち退去予定（募集状況・送った資料の現況）の物 */
export type VacateProp = { name: string; vacating: boolean };
export function vacatingNameIn(text: string, props: ReadonlyArray<VacateProp>): string | null {
  const t = norm(text);
  for (const p of props) {
    if (!p.vacating) continue;
    const b = norm(p.name.replace(/\s*[A-Za-z]?[0-9]{1,5}\s*(?:号室|号)?\s*$/, ""));
    if (b.length >= 3 && (t.includes(b) || t.includes(b.slice(0, Math.max(5, Math.min(8, b.length)))))) return p.name;
  }
  return null;
}

/** M/D の日（今日から見て未来の一番近い年）までの日数 */
export function daysUntilMD(md: string | null | undefined, nowMs: number): number | null {
  const m = String(md ?? "").match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const now = new Date(nowMs + 9 * 3600_000);
  const y = now.getUTCFullYear();
  let t = Date.UTC(y, Number(m[1]) - 1, Number(m[2])) - 9 * 3600_000;
  if (t < nowMs - 2 * DAY) t = Date.UTC(y + 1, Number(m[1]) - 1, Number(m[2])) - 9 * 3600_000;
  return Math.ceil((t - nowMs) / DAY);
}

/** #33: 退去予定の部屋の内覧が7日以内 */
export function vacateViewingHoldFirstLine(i: { appointment: { dateMD: string | null; place: string | null } | null; props: ReadonlyArray<VacateProp>; nowMs: number; propertyHint?: string | null }): string {
  if (!i.appointment?.dateMD) return "";
  const d = daysUntilMD(i.appointment.dateMD, i.nowMs);
  if (d == null || d < 0 || d > 7) return "";
  const name = vacatingNameIn(`${i.appointment.place ?? ""}\n${i.propertyHint ?? ""}`, i.props);
  if (!name) return "";
  return `【退去予定のお部屋の内覧が近い（材料）】${i.appointment.dateMD} の内覧（あと${d}日）は退去予定のお部屋（${name}）。竹内さんの決め（10/28）: 内覧が1週間以内なら、先にお申込でお部屋を抑えてから内覧し、内覧後にご判断頂ける事をお勧めする番（申込が入ると内覧できなくなるため）。「管理会社に確認しましたところ」は入れない。状況に合わせて返信で伝える。`;
}

/** #3 #7: 退去予定の部屋で「申込→内覧→キャンセルできるか」 */
const APPLY_CANCEL_RE = /(?:申し?込(?:み|ん)?(?:して|してから|後に?)[^\n]{0,24}(?:内覧|内見)[^\n]{0,30}キャンセル)|(?:キャンセル[^\n]{0,10}(?:可能|できます|出来ます))/;
export function vacateHoldCancelLine(i: { customerText: string; props: ReadonlyArray<VacateProp>; propertyHint?: string | null }): string {
  if (!APPLY_CANCEL_RE.test(String(i.customerText ?? "").normalize("NFKC"))) return "";
  const name = vacatingNameIn(`${i.customerText}\n${i.propertyHint ?? ""}`, i.props) ?? (i.props.filter((p) => p.vacating).length === 1 ? i.props.find((p) => p.vacating)!.name : null);
  if (!name) return "";
  return `【退去予定のお部屋の申込→内覧→キャンセルの相談（材料）】${name} は退去予定で、申込するとオーナー審査も進むためキャンセル料がかかる可能性が高い。竹内さんの決め（10/28）: 返信で可否を言い切らず管理会社に確認する（AIX【確認した】→お部屋止めについて）。返信には入居まで期間がある事と、そのためお部屋を抑える意味の説明。`;
}

/** #37: 前向きな発言（設備がある・良い）への否定的な事 */
const POSITIVE_RE = /(?:気になります|嬉しい|うれしい|良い|いい|最高|助かり)/;
const EQUIP_WORD_RE = /洗濯機置|洗濯パン|独立洗面|バス・?トイレ|浴室乾燥|宅配ボックス|オートロック|エアコン|コンロ|収納|ベランダ|バルコニー|追い焚き|追焚/;
export function positiveNoNegativeLine(customerText: string): string {
  const t = String(customerText ?? "").normalize("NFKC");
  if (!POSITIVE_RE.test(t) || !EQUIP_WORD_RE.test(t) || /[?？]/.test(t)) return "";
  const w = t.match(EQUIP_WORD_RE)?.[0] ?? "設備";
  return `【お客様の前向きな発言（材料）】お客様は「${w}」があって前向き。竹内さんの決め（10/28）: 申込の妨げになる否定的な事（記載が見当たらない・無い 等）は返信で書かない。送った資料の読みには設備・間取り図の欄が無い（文字の読みだけ）＝資料で読めていない設備を「無い」「記載が見当たらない」と言い切る根拠は無い。確かめが要る否定はスタッフが確認して AIX【確認した】から送る。返信は前向きな気持ちを受ける。`;
}

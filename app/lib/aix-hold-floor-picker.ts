// app/lib/aix-hold-floor-picker.ts（純関数・DB/ネットに触れない）
// 2026-10-28 竹内さんの指摘 #7・#27: AIX【確認した（条件・交渉）→管理会社に確認した】に新しいピッカー2つ。
//   ① お部屋止めについて（mgmt_room_hold）: 申込でお部屋を押さえられるか（申込可能／申込不可）＋理由（管理会社の回答のまま）
//      竹内さんの型（KID 10/25 手打ち）: 「こちらお申込みしてお部屋押さえることができるか管理会社確認しましたところ11月末退去予定の為期間が長く
//                                          お部屋止めをできないとのことでした。」
//   ② 床の色について（mgmt_floor_color）: 色を入れる（例「こちら床の色グレーとなります！！」・10/26 手打ち「偶数階のお部屋が白色／奇数階のお部屋がグレー」）
//   どちらもスタッフだけが知る事（P0: AIX で送る）なのにボタンが無く手で打っていた。
// 切替: 画面のピッカーは NEXT_PUBLIC_AIX_HOLD_FLOOR_PICKER=on の時だけ出す（既定 off）。ブレインが選ぶ側（カタログ）は AIX_HOLD_FLOOR_PICKER=on の時だけ。
//   生成は押した時だけ動く足すだけの物。事実はスタッフの入力のまま（理由・色は言い換えない）・出口で入力の字が本文に無ければ決まった型に差し替える

type Env = Record<string, string | undefined>;

export const HOLD_CHECK_PATTERN = "mgmt_room_hold" as const;
export const FLOOR_CHECK_PATTERN = "mgmt_floor_color" as const;
export const HOLD_PICKER_LABEL = "お部屋止めについて";
export const FLOOR_PICKER_LABEL = "床の色について";

export function holdFloorPickerUiOn(v: string | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "on";
}
export function holdFloorPickerForBrain(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_HOLD_FLOOR_PICKER ?? "").trim().toLowerCase() === "on";
}

export const HOLD_RESULTS = ["申込可能", "申込不可"] as const;
export type HoldResult = typeof HOLD_RESULTS[number];
export function isHoldResult(v: unknown): v is HoldResult {
  return typeof v === "string" && (HOLD_RESULTS as readonly string[]).includes(v);
}

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "");

/** aix/action の【スタッフ入力情報】（入れるのは 結果・理由・物件名・補足だけ） */
export function buildHoldMgmtInfo(i: { result: unknown; reason?: unknown; propertyName?: unknown; extra?: string | null }): string {
  if (!isHoldResult(i.result)) throw new Error("お部屋止めが 申込可能／申込不可 のどちらかが必要です");
  const reason = clean(i.reason), pn = clean(i.propertyName);
  return [
    `お部屋止め：${i.result === "申込可能" ? "お申込みでお部屋を押さえられる" : "お部屋止めできない"}`,
    reason ? `理由（管理会社の回答のまま）：${reason}` : "",
    pn ? `物件名：${pn}` : "物件名：入力なし（「こちら」と書く）",
    i.extra && i.extra.trim() ? `補足：${i.extra.trim()}` : "",
  ].filter(Boolean).join("\n");
}

/** 理由の字のつなぎ（「11月末退去予定の為期間が長く」はそのまま・句点で終わる字は句点を外す） */
function reasonJoint(reason: string): string {
  const r = reason.replace(/[。．.！!]+$/, "").trim();
  if (!r) return "";
  return /(?:く|て|で|め|為|ため|ので|から)$/.test(r) ? `${r}\n` : `${r}の為\n`;
}

/** 生成の型（竹内さんの KID 10/25 の手打ちの形） */
export function holdFormat(result: HoldResult, reason?: string | null, propertyName?: string | null): string {
  const pn = clean(propertyName);
  const head = `${pn ? `${pn}` : "こちら"}お申込みしてお部屋押さえることができるか管理会社確認しましたところ`;
  const r = reasonJoint(clean(reason));
  if (result === "申込不可") return `${head}${r || "\n"}お部屋止めをできないとのことでした。`;
  return `${head}${r || "\n"}お申込みでお部屋止めできるとのことでした😊！！`;
}

export const HOLD_RULES = `・竹内さんの型（KID 10/25）どおり「〈物件名／こちら〉お申込みしてお部屋押さえることができるか管理会社確認しましたところ〈理由〉お部屋止めをできないとのことでした。」の形で書く
・スタッフが入れたのは「お部屋止め（できる／できない）」「理由」「物件名」「補足」だけ。これ以外の事実は書かない（退去日・入居日・審査・他の物件）
・理由はスタッフ入力の字のまま（言い換え・推測で足さない）。理由が無ければ理由に触れない
・できない時に代わりの提案（他の物件・申込の時期）は書かない（スタッフが別の AIX で送る）。謝罪表現は使わない
・できる時に「お申込み頂ければ確実に押さえられます」等の確認していない断定はしない`;

/** 床の色 */
export function buildFloorMgmtInfo(i: { color: unknown; note?: unknown; propertyName?: unknown; extra?: string | null }): string {
  const color = clean(i.color);
  if (!color) throw new Error("床の色（例：グレー）を入力してください");
  const note = clean(i.note), pn = clean(i.propertyName);
  return [
    `床の色：${color}`,
    note ? `補足（階・お部屋ごとの違い等・管理会社の回答のまま）：${note}` : "",
    pn ? `物件名：${pn}` : "物件名：入力なし（「こちら」と書く）",
    i.extra && i.extra.trim() ? `補足：${i.extra.trim()}` : "",
  ].filter(Boolean).join("\n");
}

export function floorFormat(color: string, note?: string | null, propertyName?: string | null): string {
  const pn = clean(propertyName);
  const n = clean(note);
  return `${pn ? `${pn}の` : "こちら"}床の色${clean(color)}となります！！${n ? `\n${n}` : ""}`;
}

export const FLOOR_RULES = `・竹内さんの型（10/26）どおり「こちら床の色〈色〉となります！！」の1文で書く（補足があれば次の行にスタッフの字のまま）
・色・補足はスタッフ入力の字のまま（言い換えない・他の色を足さない）。これ以外の事実（広さ・設備・築年）は書かない
・次の一手を足してよいのは、この会話で内覧のご案内も申込のご案内も一度もしていない時だけ（「よろしければ一度ご都合よろしいお日にちにお部屋ご案内させて頂きます！！」）`;

const NEG_RE = /できな|出来な|不可|難し|お断り/;
/** 出口の安全の線: 結果の取り違え・理由の字の抜けがあれば決まった型に差し替える（事実はスタッフの入力のまま） */
export function ensureHoldResult(text: string, result: HoldResult, reason: string | null | undefined, propertyName?: string | null): string {
  const t = String(text ?? "");
  const r = clean(reason).replace(/[。．.！!]+$/, "");
  const hasNeg = NEG_RE.test(t.replace(/確認[^\n]{0,20}できるか/g, ""));
  const ok = result === "申込不可" ? hasNeg : !hasNeg;
  if (ok && (!r || t.includes(r))) return t;
  return holdFormat(result, reason, propertyName);
}
export function ensureFloorColor(text: string, color: string, note?: string | null, propertyName?: string | null): string {
  const t = String(text ?? "");
  const c = clean(color);
  if (c && t.includes(c)) return t;
  return floorFormat(color, note, propertyName);
}

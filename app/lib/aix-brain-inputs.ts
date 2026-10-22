// app/lib/aix-brain-inputs.ts — AIX のブレインに渡す「スタッフが入力した事」を押した AIX の本文（body）から作る（純関数）。
//   ピッカーの定義（aix-pickers.ts AIX_PICKERS）の見出し・選択肢の文言で並べる＝画面でスタッフが選んだ物と同じ言葉。
//   ここに無い物（会話・資料）はスタッフだけが知る事の根拠にしない（aix-brain.checkAixText の staffBasis）。
import { AIX_PICKERS, type PickerDef } from "./aix-pickers";

type Body = Record<string, unknown>;
const str = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean).join("・");
  if (typeof v === "boolean") return v ? "はい" : "";
  if (typeof v === "object") return "";
  return String(v).trim();
};
const optLabel = (p: PickerDef, v: string): string => p.options?.find((o) => o.value === v)?.label ?? v;

/** 本文の自由な欄（ピッカーの外）で、スタッフが入れた事実 */
const EXTRA_FIELDS: Array<[string, string]> = [
  ["calendar_info", "内覧の候補日時（カレンダー）"],
  ["property_name", "物件名"],
  ["property_names", "物件名（複数）"],
  ["prop_statuses", "物件ごとの確認の結果"],
  ["property_count", "物件の数"],
  ["other_room_status", "別の部屋の結果"],
  ["vacating_note", "退去予定の注記"],
  ["move_out_date", "退去日"],
  ["vacancy_status", "募集状況"],
  ["keyword", "伝えたい事（スタッフのキーワード）"],
  ["appeal_points", "訴求の点（スタッフ）"],
  ["extra_input", "スタッフの追記"],
  ["meeting_date", "待ち合わせの日付"],
  ["meeting_time", "待ち合わせの時刻"],
  ["meeting_property_address", "待ち合わせの住所"],
  ["expanded_conditions", "広げた条件"],
  ["customer_conditions", "お客様の希望条件（登録）"],
];
const STATUS_JA: Record<string, string> = { available: "募集中", unavailable: "募集終了", ended: "募集終了", alternative: "別の部屋が募集中", exclusive: "専任", applied: "申込あり" };

export function staffInputsFromBody(aixType: string, body: Body): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const spec = AIX_PICKERS[aixType];
  const seen = new Set<string>();
  for (const p of spec?.pickers ?? []) {
    const raw = body[p.column ?? p.key] ?? body[p.key];
    const v = str(raw);
    if (!v) continue;
    if (p.onlyWhen) {
      const parent = str(body[p.onlyWhen.key]);
      if (parent && !p.onlyWhen.values.includes(parent)) continue;
    }
    const shown = Array.isArray(raw) ? (raw as unknown[]).map((x) => optLabel(p, String(x))).join("・") : p.kind === "choice" ? optLabel(p, v) : v;
    out.push([p.label, shown]);
    seen.add(p.column ?? p.key);
  }
  // ピッカーの値が示すスタッフだけが知る事（文字に出ない物）を言葉にする＝確かめ（aix-brain.claimsOf）の根拠
  const cp = str(body.check_pattern);
  if (aixType === "property_check_result" && cp) {
    const res = cp === "available" ? "募集中" : cp === "unavailable" ? "募集終了（募集に出ていない）" : cp === "alternative" ? "別の部屋が募集中" : cp === "exclusive" ? "専任" : "";
    if (res) out.push(["確認の結果", `${res}（スタッフが確認致しました）`]);
    else if (/^(?:mgmt_|vacate_date|other_room|nearby_parking|owner_|room_vacancies|move_in)/.test(cp)) out.push(["確認", "スタッフが管理会社に確認致しました"]);
    const or = str(body.other_room ?? body.other_room_status);
    if (cp === "other_room_check" && or) out.push(["別の部屋の確認の結果", or === "no_room" ? "他のお部屋は募集されていない（確認致しました）" : "別の部屋が募集中（確認致しました）"]);
  }
  if (aixType === "property_send" && str(body.send_mode) === "new_arrival") out.push(["新着", "新しく募集に出た（募集中の）物件"]);
  for (const [k, label] of EXTRA_FIELDS) {
    if (seen.has(k)) continue;
    let v = k === "prop_statuses" && Array.isArray(body[k]) ? (body[k] as unknown[]).map((s, i) => `${i + 1}件目 ${STATUS_JA[String(s)] ?? String(s)}`).join("・") : str(body[k]);
    if (!v) continue;
    if (k === "customer_conditions" && v.length > 600) v = `${v.slice(0, 600)}…`;
    out.push([label, v]);
  }
  return out;
}

/** ピッカーの値（指揮官に見せる「どのピッカーか」） */
export function pickerValueOf(aixType: string, body: Body): string | null {
  const v = str(body.check_pattern) || str(body.send_mode) || str(body.pickupType ?? body.pickup_type) || str(body.viewing_mode) || str(body.app_sub_mode) || str(body.estimate_count);
  return v || null;
}

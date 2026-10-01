// app/lib/aix-autofill-readiness.ts
// ブレインが選んだ AIX を「スタッフが何も入れずに」作れるか（自動反映の度合い）を決める（純関数・DB も fetch も持たない）。
//
// 2026-10-01 竹内「AIXでの返信も自動でおこなって、実際自動反映できていない部分もみつける…自動返信をするにおいてのボトルネックをみつけて改善していく」
//   ＋ memory project_aix_prefill_direction（開いたら確認した要件以外は全部セット済み・スタッフは確認した事だけ入れる）。
//   YUMA の再生（scripts/yuma-replay-scenarios.ts）と見張り（line-watch）で「AIX の種類ごとに何が自動で埋まらないか」を同じ物差しで数えるために1か所に置く。
//
// 段（level）:
//   auto          … 会話だけで作れる（入力なし）。生成の引数（request）を返す
//   auto_calendar … カレンダーの空き（画面が開いた時に読む）と会話から作れる。テストでは固定の候補を入れて作る
//   staff_confirm … 管理会社・オーナーへの確認の結果が要る（募集中か等）。物件名などは先に入れ、確認の結果だけスタッフが入れる
//   needs_material … 別の道具の材料が要る（見積書の画像・物件のピックアップ・待ち合わせの住所・費用の入力値）
// blockers は「自動で埋まらない欄」（画面の欄の名前の日本語）。prefilled は自動で入れた欄と出所。
//
// 線（どの AIX が何を要るか）は AixModal.tsx の作成の分岐（2026-10-01 時点）から写した:
//   viewing_invite … calendar_info（カレンダーの空き・画面で既定 ON）／property_name（任意）／viewing_requested_dates（お客様の希望日がある時）
//   meeting_place  … meeting_date（お客様が選んだ日時）／meeting_property_name／meeting_property_address（番地まで・meeting-address.ts の関所）
//   property_check_result … check_pattern（募集中/終了/退去予定＝確認の結果）／property_names／prop_statuses／御見積書の画像（同封する時）
//   estimate_sheet … 見積書の画像（見積書ツール）／property_send・property_recommendation … ピックアップ（売上サポ）
//   cost_explain・cost_breakdown・guarantor_info … 入力値（金額・還元額・保証会社）
import { extractDateMentions, fixedViewingSlots } from "./customer-sim-material";
import { extractRequestedViewingDates } from "./viewing-date-request";

export type AutofillLevel = "auto" | "auto_calendar" | "staff_confirm" | "needs_material" | "unknown";
export type AixAutofill = {
  level: AutofillLevel;
  blockers: string[];
  prefilled: Record<string, string>;
  /** 生成の引数（/api/aix/action の body に足す）。作れない時は null */
  request: Record<string, unknown> | null;
};

/** 会話だけで作れる AIX（customer-sim の SIM_TEXT_ONLY_AIX と同じ＋電話・確認の宣言） */
export const TEXT_ONLY_AIX: ReadonlySet<string> = new Set([
  "condition_hearing", "application_push", "followup_revive", "greeting_viewing", "zenryoku_support", "phone_call", "acknowledge_check",
]);

export type AutofillInput = {
  action: string;
  checkPattern?: string | null;
  /** 今回のお客様の連投（改行でつないだ物） */
  customerText: string;
  /** 前の会話の文（古→新） */
  contextTexts?: ReadonlyArray<string>;
  /** こちらの前の発言（古→新）。待ち合わせ場所の物件名を、直前の内覧調整の文（「〇〇 203号室ご案内させていただきます」）から読む */
  staffTexts?: ReadonlyArray<string>;
  /** aix-prefill.propertyNamePrefill の値（無ければ null） */
  propertyName?: string | null;
  nowMs?: number;
};

export function classifyAixAutofill(i: AutofillInput): AixAutofill {
  const action = (i.action ?? "").trim();
  const nowMs = i.nowMs ?? Date.now();
  const prefilled: Record<string, string> = {};
  if (i.propertyName) prefilled["物件名"] = `${i.propertyName}（会話）`;
  // 電話をかける は文を作らない（LINE コールのボタンと定型の案内＝画面の固定の物）
  if (action === "phone_call") return { level: "auto", blockers: [], prefilled, request: null };
  if (TEXT_ONLY_AIX.has(action)) return { level: "auto", blockers: [], prefilled, request: {} };

  switch (action) {
    case "viewing_invite": {
      const asked = extractDateMentions(i.customerText, nowMs);
      const slots = asked.length
        ? asked.slice(0, 3).map((d) => `${d.label} ${d.time ?? (d.ampm === "am" ? "11:00〜13:00" : "14:00〜16:00")}`)
        : fixedViewingSlots(nowMs).map((s) => `${s.label} ${s.start}〜${s.end ?? ""}`);
      if (asked.length) prefilled["希望日"] = asked.map((d) => d.label).join("・") + "（会話）";
      return {
        level: "auto_calendar", blockers: [], prefilled,
        request: { calendar_info: slots.join("\n"), ...(asked.length ? { viewing_requested_dates: asked.map((d) => d.label).join("・") } : {}), ...(i.propertyName ? { property_name: i.propertyName } : {}) },
      };
    }
    case "property_check_result": {
      // 確認の結果（check_pattern）は管理会社に確かめた事実。ブレインの check_pattern は「どの確認か」の見立てで結果ではない
      const blockers = ["確認の結果（募集中／終了／退去予定）"];
      if (!i.propertyName) blockers.push("物件名（会話から1件に決まらない）");
      const cp = (i.checkPattern ?? "").trim();
      const resultLike = /^(?:available|unavailable|vacating)$/.test(cp) ? cp : "available";
      return {
        level: "staff_confirm", blockers, prefilled,
        // テストでは「募集中だった」と仮に置いて文の形を見る（本番では確認の結果が入るまで作らない）
        request: { check_pattern: resultLike, property_count: 1, ...(i.propertyName ? { property_names: [i.propertyName], prop_statuses: ["available"] } : {}) },
      };
    }
    case "meeting_place": {
      // 日時: 月日つき（extractDateMentions）→ 無ければ「5日の15時〜」の形（日だけ＋時刻・viewing-date-request の読み方）
      const asked = extractDateMentions(i.customerText, nowMs).filter((d) => d.time);
      const blockers = ["待ち合わせの住所（番地まで・資料から）"];
      const dayOnly = asked.length ? [] : extractRequestedViewingDates(i.customerText, nowMs);
      const timeOnly = String(i.customerText ?? "").normalize("NFKC").match(/(\d{1,2})\s*(?::(\d{2})|時(半)?)/);
      if (asked.length) prefilled["日時"] = `${asked[0].label} ${asked[0].time}（会話）`;
      else if (dayOnly.length && timeOnly) prefilled["日時"] = `${dayOnly[0].label} ${timeOnly[1]}:${timeOnly[2] ?? (timeOnly[3] ? "30" : "00")}（会話）`;
      else blockers.push("日時（お客様の発言から読めない）");
      // 物件: 直前の内覧調整の文の「〇〇 203号室」
      const lastInvite = [...(i.staffTexts ?? [])].reverse().find((t) => /号室/.test(t) && /ご案内|ご内覧/.test(t));
      const room = lastInvite?.match(/([^\s／/、。！!「」]{2,30}?)\s*([0-9０-９]{2,4})\s*号室/);
      const propertyName = i.propertyName ?? (room ? `${room[1]} ${room[2]}号室` : null);
      if (propertyName && !i.propertyName) prefilled["物件名"] = `${propertyName}（内覧調整の文）`;
      if (!propertyName) blockers.push("物件名");
      return { level: "needs_material", blockers, prefilled, request: null };
    }
    case "estimate_sheet":
      return { level: "needs_material", blockers: ["見積書の画像（見積書ツール）", ...(i.propertyName ? [] : ["物件名"])], prefilled, request: null };
    case "property_send":
    case "property_recommendation":
      return { level: "needs_material", blockers: ["送る物件（売上サポのピックアップ）"], prefilled, request: null };
    case "cost_explain":
    case "cost_breakdown":
    case "guarantor_info":
      return { level: "needs_material", blockers: ["入力値（金額・還元額・保証会社）"], prefilled, request: null };
    default:
      return { level: "unknown", blockers: [`未知の AIX: ${action || "(空)"}`], prefilled, request: null };
  }
}

export const AUTOFILL_LEVEL_JA: Record<AutofillLevel, string> = {
  auto: "自動で作れる", auto_calendar: "カレンダーと会話で作れる", staff_confirm: "確認の結果だけ要る", needs_material: "材料が要る", unknown: "不明",
};

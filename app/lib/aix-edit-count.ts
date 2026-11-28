// app/lib/aix-edit-count.ts — 物件オススメの AIX の直しの組（直す前の AI の文と送った文）を「数えるためだけ」に残す（台帳 #839・2026-11-28 作業員A・統括役の決め）
//   今は画面（AixModal）が物件オススメの直しの組を保存しない（物件固有の文のため）＝直した中身が数えられず、#827 の札で直しが減ったかも測れない。
//   統括役の条件: ①既定 off ②保存する文は伏せた形（maskPII＋物件の名前・号室・金額・URL・申込の書類の伏せ残しの網）③数えるためだけ＝手本・RAG・学びの入口から読まれない
//   置き場は今ある ai_template_candidates（新しい列は足さない＝migrate-schema の変更なし）に、どの読み手にも拾われない形で置く:
//     source="aix_edit_count"（読み手は source="aix_edit"／"improvement"／"opus_weekly"／"auto" を名指しで読む）・is_dismissed=true（候補の一覧・重複の確かめは is_dismissed=false だけ）・
//     dismissed_reason=null（corpus2skill の「却下の理由」の読みは理由が null でない行だけ）。読むのは scripts/audit-aix-edit-baseline.ts だけ
//   スイッチ AIX_EDIT_COUNT_RECOMMENDATION（既定 off・サーバーの /api/ai-template-candidates が読む）
import { maskPII } from "./pii-mask";
import { applicationMaterialReason, MOBILE_RE, EMAIL_RE, BIRTH_VALUE_RE } from "./test-pii-guard";

export const AIX_EDIT_COUNT_SOURCE = "aix_edit_count" as const;
export const aixEditCountOn = (env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}) =>
  (env.AIX_EDIT_COUNT_RECOMMENDATION ?? "").trim().toLowerCase() === "on";

/** 物件の名前・号室・金額・URL を伏せる（数えるのは行の形と種類だけ＝中身の値は要らない） */
export function maskPropertyFacts(text: string, propertyNames: ReadonlyArray<string | null | undefined> = []): string {
  let t = String(text ?? "");
  for (const n of propertyNames) { const s = String(n ?? "").trim(); if (s.length >= 2) t = t.split(s).join("〈物件〉"); }
  return t
    .replace(/https?:\/\/\S+/g, "〈URL〉")
    .replace(/[0-9０-９]{1,5}\s*号室/g, "〈号室〉")
    .replace(/[0-9０-９][0-9０-９,，.．]*\s*(?:万円|万|円)/g, "〈金額〉")
    .replace(/【[^】\n]{1,40}】/g, (m) => (/物件名|号室名|所在地|【交通】/.test(m) ? m : "【〈物件〉】"));
}

export type CountOnlyRow = {
  action_type: string; category: string; suggested_title: string; template_text: string; original_text: string;
  conversation_id: string | null; source: typeof AIX_EDIT_COUNT_SOURCE; reason: string; evidence_count: 1; is_dismissed: true; dismissed_reason: null;
};

/** 保存する行（伏せた後）。申込の書類・個人の値が残る文は保存しない（null） */
export function buildCountOnlyRow(i: { actionType: string; category: string; sent: string; original: string; conversationId?: string | null; propertyNames?: ReadonlyArray<string | null | undefined>; knownNames?: ReadonlyArray<string | null | undefined> }): CountOnlyRow | null {
  if (!i.sent?.trim() || !i.original?.trim()) return null;
  if (applicationMaterialReason(i.sent) || applicationMaterialReason(i.original)) return null;
  const mask = (s: string) => maskPropertyFacts(maskPII(s, [...(i.knownNames ?? [])]), i.propertyNames ?? []);
  const sent = mask(i.sent), original = mask(i.original);
  if (applicationMaterialReason(sent) || applicationMaterialReason(original)) return null; // 伏せ残しの網
  return {
    action_type: i.actionType, category: i.category, suggested_title: "[数えるだけ] AIX の直しの組", template_text: sent, original_text: original,
    conversation_id: i.conversationId ?? null, source: AIX_EDIT_COUNT_SOURCE, reason: "数えるためだけ（手本・学び・RAG に使わない・#839）",
    evidence_count: 1, is_dismissed: true, dismissed_reason: null,
  };
}

/** 2026-11-28 #839: on にした後の伏せ方の確かめ（scripts/audit-aix-edit-count-mask.ts）。伏せ残しの形（純関数・テストあり）。値ではなく、どの形が何回当たったかだけ返す */
export const RESIDUE_CHECKS: Array<[string, RegExp]> = [
  ["携帯番号", MOBILE_RE],
  ["メール", EMAIL_RE],
  ["生年月日", BIRTH_VALUE_RE],
  ["号室", /[0-9０-９]{1,5}\s*号室/],
  ["金額", /[0-9０-９][0-9０-９,，.．]*\s*(?:万円|万|円)/],
  ["URL", /https?:\/\//],
  ["長い数字", /[0-9０-９]{5,}/],
  ["名前らしい語（漢字・カナ＋さん／様）", /[一-龠ァ-ヶ]{2,}(?:さん|様)/],
];
export function residueOf(text: string): string[] {
  const out = RESIDUE_CHECKS.filter(([, re]) => re.test(text)).map(([k]) => k);
  const app = applicationMaterialReason(text); if (app) out.push(`申込の書類（${app}）`);
  return out;
}


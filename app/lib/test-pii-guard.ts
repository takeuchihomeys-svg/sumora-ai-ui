// app/lib/test-pii-guard.ts
// テスト（YUMA・場面の再生）で LLM に渡す材料に、申込の書類・本人確認書類・収入の書類・個人を特定する値が入っていないかを見る（純関数）。
//
// 2026-10-01 竹内「1～4すべて改善する。設計知見と協力して改善する」＋ 同じ日の事故（自動返信の再生・⑦）:
//   本番の会話から作った再生の場面を「申込へ を押す前」だけで切っていた。会話 ae321772 は 申込へ を押さないまま
//   記入済みの申込フォーム（氏名・生年月日・住所・勤務先・年収）が届いていて、その通が2場面の前の通に入り DeepSeek に渡った。
//   ⑦は「場面の作り方で書類より後を落とす」「流す時に書類の印があれば止める」の二重にした（scripts/replay-scenarios-mine.ts・yuma-replay-scenarios.ts）。
//   → ここに一般の形を置く:
//     ① 場面の材料（1通ずつ）: applicationMaterialReason … 本人確認書類・収入／身元の書類（id-document-guard / personal-document-guard の指紋）・
//        保存済みの書類の見出し（[画像] 本人確認書類／収入証明書（…）／申込書）・申込フォームの欄（記入済みでも空でも）・個人を特定する値
//        → cutBeforeApplicationMaterial で「最初に当たった通より前」だけを使う（書類より後の流れは申込以降と同じ扱い＝テストの対象外）
//     ② 出口（テストの間に DeepSeek へ送る本文全体）: piiValueSignal … 値だけを見る（携帯番号・生年月日の値・メール・記入済みのフォーム）。
//        本文全体には指示文（「本人確認書類（運転免許証・パスポート）と住所…」）が入るので、書類の指紋（語の組）は出口では使わない
//        （使うと全部のテストが止まる）。1通ずつの判定は①で行う。
// 実データの線（2026-10-01・YUMA 504通）: ②に当たる通 0（空の申込フォーマット 1通は値が無いので当たらない）。
// 本番の動きは変えない: ここを呼ぶのはテストの間（llm-test-mode.readTestRun が null でない時）とスクリプトだけ。

import { isIdDocument, ID_DOCUMENT_LABEL } from "./id-document-guard";
import { classifyPersonalDocument, savedPersonalDocumentLabel } from "./personal-document-guard";
import { readTestRun } from "./llm-test-mode";

/** 携帯電話の番号（070/080/090）。会社の番号（06-）は当てない */
export const MOBILE_RE = /0[789]0[-‐－ー\s]?\d{4}[-‐－ー\s]?\d{4}/;
/** 生年月日の値（2010年以前の年月日・昭和／平成の年月）。「2026年10月」のような今の日付は当てない */
export const BIRTH_VALUE_RE = /(?:19\d{2}|200\d|201\d)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|(?:昭和|平成)\s*(?:\d{1,2}|元)\s*年\s*\d{1,2}\s*月/;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}/;
/** 申込フォームの欄の見出し（スタッフが送る空のフォーマットにもある＝出口では値と組で見る） */
export const APPLICATION_FORM_RE = /申込者様記入欄|同居人記入欄|緊急連絡先欄|勤務先電話|連帯保証人様記入欄/;
/** 年収の値（「年収 350万」「年収：4,200,000円」） */
export const INCOME_VALUE_RE = /年収\s*[:：は]?\s*(?:約)?\s*[\d,，０-９]{2,}\s*(?:万|円)/;

/** 出口用: 本文全体に個人を特定する「値」があるか（理由・無ければ null） */
export function piiValueSignal(text: string | null | undefined): string | null {
  const t = String(text ?? "");
  if (!t) return null;
  if (APPLICATION_FORM_RE.test(t) && (MOBILE_RE.test(t) || BIRTH_VALUE_RE.test(t) || INCOME_VALUE_RE.test(t))) return "記入済みの申込フォーム";
  if (MOBILE_RE.test(t)) return "携帯電話の番号";
  if (BIRTH_VALUE_RE.test(t)) return "生年月日の値";
  if (EMAIL_RE.test(t)) return "メールアドレス";
  return null;
}

/** 場面の材料（1通）が申込の書類・本人確認書類・収入の書類・個人の値か（理由・無ければ null）。1通ずつに使う（本文全体には使わない） */
export function applicationMaterialReason(messageText: string | null | undefined): string | null {
  const t = String(messageText ?? "");
  if (!t.trim()) return null;
  if (t.includes(ID_DOCUMENT_LABEL) || isIdDocument(null, t)) return "本人確認書類";
  const saved = savedPersonalDocumentLabel(t);
  if (saved) return `個人の書類（${saved}）`;
  const doc = classifyPersonalDocument(t);
  if (doc) return `個人の書類（${doc}）`;
  if (APPLICATION_FORM_RE.test(t)) return "申込フォームの欄";
  if (INCOME_VALUE_RE.test(t)) return "年収の値";
  return piiValueSignal(t);
}

/** テストの間（deepseek-all／final-claude）に LLM へ送る本文に個人の値があれば、止める理由（日本語）。テストでない時・無い時は null */
export function testPiiRefusal(env: Record<string, string | undefined>, bodyText: string | null | undefined, where: string): string | null {
  const run = readTestRun(env);
  if (!run) return null;
  const sig = piiValueSignal(bodyText);
  if (!sig) return null;
  return `[llm-test-mode] ⛔ テスト（${run}）で ${where} に送る本文に個人の値（${sig}）が入っているので送りません。` +
    `\n  場面・再生の材料は申込の書類・本人確認書類・収入の書類より前で切り、名前・番号を伏せる（test-pii-guard.cutBeforeApplicationMaterial）。手順書: memory/test_protocol_brain.md`;
}

/** 会話の通（古い→新しい）を、最初に書類・個人の値が出た通の手前で切る。cutAt は切った位置（無ければ null） */
export function cutBeforeApplicationMaterial<T extends { text?: string | null }>(messages: ReadonlyArray<T>): { kept: T[]; cutAt: number | null; reason: string | null } {
  for (let i = 0; i < messages.length; i++) {
    const r = applicationMaterialReason(messages[i]?.text ?? "");
    if (r) return { kept: messages.slice(0, i), cutAt: i, reason: r };
  }
  return { kept: [...messages], cutAt: null, reason: null };
}

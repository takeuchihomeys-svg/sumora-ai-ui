// app/lib/viewing-reask.ts
// 2026-10-02 ⑫ 21巡（待ち合わせまで行く流れ flow2_fbffca_t12）: 内覧の日時が決まった後（スタッフ「9/24日13:00からはよろしくお願いいたします」）の
//   お客様の了承に、下書きが「お気に召されましたらご都合よろしいお日にち御座いますでしょうか！！ご案内させて頂きます！！」と日にちを聞き直した。
//   ブレインの方向は「内覧待ちの状態・当日の準備」だったのに生成が外した（G4）。内覧は段階どおり（feedback_viewing_flow_stages）＝決まった日を聞き直さない。
//   出口は止めるだけ（自動では送らない・本文は変えない）。線は scripts/audit-viewing-reask.ts（人の送信で、決まった後の聞き直しが何通あるか）
/** 内覧の日時が決まった印（スタッフの「◯/◯（日）◯:◯◯からはよろしくお願い」「◯日◯時からのご案内で承りました」） */
export const VIEWING_FIXED_STAFF_RE = /(?:[0-9０-９]{1,2}\s*[\/月]\s*[0-9０-９]{1,2}|[0-9０-９]{1,2}日)[^。\n]{0,10}[0-9０-９]{1,2}(?::|：|時)[0-9０-９]{0,2}[^。\n]{0,6}(?:から(?:は)?(?:よろしく|宜しく)|(?:で|にて)(?:承り|確定|ご予約))/;
/** 下書きが内覧の日にちを聞き直している */
export const VIEWING_DATE_ASK_RE = /ご都合(?:の)?(?:よろし|良ろし|いい|良い)(?:い)?(?:お)?日(?:にち|時|程)|ご都合(?:如何|いかが)|内覧(?:の)?(?:ご)?希望(?:の)?(?:日|お日にち)|候補(?:日|のお日にち)(?:を)?(?:お)?(?:教え|お知らせ)/;

/** 決まった内覧の日にちを聞き直している下書きか（staffRecent は直近のこちらの送信・新しい順でも古い順でもよい） */
export function findViewingDateReask(draft: string | null | undefined, staffRecent: ReadonlyArray<string | null | undefined>): string | null {
  const d = String(draft ?? "");
  const m = d.match(VIEWING_DATE_ASK_RE);
  if (!m) return null;
  return staffRecent.some((t) => VIEWING_FIXED_STAFF_RE.test(String(t ?? ""))) ? m[0] : null;
}

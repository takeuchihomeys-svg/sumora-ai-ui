// app/lib/final-check-staff-name.ts
// 最終チェックの「名前の誤り」（FABRICATED_NAME）が、こちらの担当者の名乗り（鈴木と申します）を指していないか（純関数）。
//
// 2026-10-06 竹内「最終チェックの部分ちゃんとできているのか…抜けている部分…徹底的に調査」の点検で見つけた穴:
//   line_watch_turns（10/01〜）の FABRICATED_NAME 11件のうち3件（949・1003・1239）の引用が
//   「お部屋探しを担当させて頂きます鈴木と申します」＝こちらの担当者の正しい名乗り。
//   原因（入口）: anomaly_scan の出力例6が「顧客名『田中様』なのに返信に『鈴木様』」＝担当者と同じ名前を
//   「間違った名前」の例にしていた＋担当者の名前を検査に渡していなかった。
//   画面に「△確認推奨」が出るだけの誤発火だが、書き直し（Sonnet＋再検査）の入口にもなる。
// 直し: 入口＝出力例の名前を担当者と被らない名前にし、担当者の名前を渡す（final-check.ts）。
//   出口＝この関数で、引用が担当者の名乗りだけ（お客様の呼びかけ「〇〇さん／様」を含まない）の FABRICATED_NAME を外す。
//   呼びかけを含む引用（「鈴木様」「森本様」等）は外さない＝お客様の名前の誤りは残る。

/** こちらの担当者の名前（greeting.ts の初回の名乗りと同じ） */
export const STAFF_SELF_NAME = "鈴木";

const SELF_INTRO_RE = new RegExp(`${STAFF_SELF_NAME}と申します|担当(?:の|させて(?:頂|いただ)きます)${STAFF_SELF_NAME}|担当者名[：:]\\s*${STAFF_SELF_NAME}`);

/** FABRICATED_NAME の引用が、担当者の名乗りだけを指しているか（外してよいか） */
export function isStaffSelfIntroNameFlag(code: string, evidence: string | null | undefined): boolean {
  if (code !== "FABRICATED_NAME") return false;
  const ev = String(evidence ?? "").normalize("NFKC");
  if (!SELF_INTRO_RE.test(ev)) return false;
  // お客様への呼びかけ（〇〇さん／様）が引用にあれば外さない（名前の誤りの本物かもしれない）
  if (/さん|様|ちゃん|くん/.test(ev)) return false;
  return true;
}

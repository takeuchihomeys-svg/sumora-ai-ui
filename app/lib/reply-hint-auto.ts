// app/lib/reply-hint-auto.ts — 返信の手がかり（replyHint）の自動の分（純関数・DB なし）
//
// bg-async・画面の再生成・generate-draft-bg が、お客様の文から決定論で「返信の手がかり」を作って generate-reply に渡していた
// （箇条書きの条件・条件変更/ピックアップ依頼・申込フォーム説明への確認質問）。generate-reply は replyHint を
// 【🔴✨ 指定生成モード（通常の生成ルールをすべて上書き）】で扱う＝2〜3行・追加質問禁止・即行動宣言にし、AIX の注記・本文の安全・返信側の AIX の判断も外す。
// スタッフが自分で書いた指定（✨ のキーワード等）なら上書きで正しいが、自動の分は「お客様の文に語がある」だけで、ブレインの判断（【🧭 この番の本質】）を上書きしていた。
// 2026-10-15 監査の残り #7（scripts/audit-rest-1015.ts --part=hint）: 自動の分は呼ぶ側が replyHintAuto を付け、ブレインの判断がある番は材料の注記に下げる（generate-reply）。
// 戻す: REPLY_HINT_BRAIN=off（旧＝全部 replyHint の上書き）

export type AutoReplyHintKind = "form_question" | "bullet" | "cond_pickup";

const COND_RE = /[0-9０-９]+万|[0-9０-９]+LDK|[0-9０-９]+[KDk]|エリア|区|駅|間取り|家賃|広さ|㎡|ペット|駐車場|築/;
const ACT_RE = /含めて|を外|に変え|以上|以下|でも可|気にしな|上げて|下げて|緩め|広げ|に絞|でお願い|から探|も探/;
const PICKUP_RE = /ありませんか|ありますか|送って|ピックアップ|おすすめ|オススメ|出てます|教えて/;
const APPLY_FORM_RE = /住居年数|携帯番号|続柄|勤務先名|勤務先所在地|現住所|本人確認書類|運転免許証|マイナンバー|お申込|申込フォーム|入居審査|緊急連絡先|保証人/;

/**
 * bg-async と同じ線（2026-10-15 まで route に直書きだった物をここに移した・中身は同じ）。
 * text は連投をつないだお客様の文（MSG_SEP は呼ぶ側で改行に直す）。
 */
export function autoReplyHintOf(text: string, o: { firstReply?: boolean; lastStaffText?: string } = {}): { kind: AutoReplyHintKind | null; hint: string } {
  if (o.firstReply) return { kind: null, hint: "" };
  const msgLines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const shortLines = msgLines.filter((l) => l.length <= 25);
  const t = String(text ?? "").trim();
  if (o.lastStaffText !== undefined && APPLY_FORM_RE.test(o.lastStaffText) && t.length < 40 && /[？?]|ですか|でしょうか|でいい|でもいい/.test(t)) {
    return { kind: "form_question", hint: "【⚠️ 申込フォーム説明への確認質問】スタッフが直前に申込必要書類を案内済み。お客様はフォームをまだ記入していない段階での確認質問。「記入完了したら送ってください」「お送りください」等の送付催促は絶対に書かない。質問に端的に答えるだけでよい。" };
  }
  if (shortLines.length >= 3) return { kind: "bullet", hint: `【お客様が列挙した条件・要望（返信で具体的に言及すること）】${shortLines.slice(0, 8).join("・")}` };
  if (msgLines.some((l) => COND_RE.test(l) && ACT_RE.test(l)) || msgLines.some((l) => PICKUP_RE.test(l))) {
    return { kind: "cond_pickup", hint: `【条件変更/ピックアップ依頼（追加質問禁止・変更内容を具体的に言葉にして即行動宣言）】${msgLines.join("・")}` };
  }
  return { kind: null, hint: "" };
}

/** 自動の手がかりをブレインの判断がある番で材料に下げるか（既定 on） */
export function replyHintBrainEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.REPLY_HINT_BRAIN ?? "").toLowerCase() !== "off";
}

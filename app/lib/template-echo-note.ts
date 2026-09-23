// app/lib/template-echo-note.ts
// お客様が貼り返してきた「こちらのフォームの末尾」（スタッフの定型文）をお客様の言葉と取り違えない（純関数・DB 依存なし）。
//
// 2026-09-23 S1 の実測（真の初回×条件フォーム・下書きと実送信の対 31件）:
//   お客様が審査に触れていないのに「審査面も柔軟にサポートさせて頂きます」を足した下書きが 2/31（審査に触れる全体 16.1%・180日 17.4%）。
//   実送信は 0/31（実送信の審査 2件はお客様が夜職/ホストと書いた時だけ・180日 8/86 は全部お客様発）。
//
// 出所: お客様が条件フォームをスタッフのテンプレートごと返してくる（90件中41件）。末尾の
//   「※審査に不安な事がある方…審査面柔軟にサポートさせて頂きます」が reply-context.TEMPLATE_ECHO_RE で剥がされるのは
//   懸念判定・復唱の body だけで、生成プロンプトに入る customerMessage はそのまま＝材料に残っていた。
//
// 線: 「お客様の文に審査の語が無い時は 0/31」＝禁止にできる。ただし本文の書き換え（出口）は入れない
//   （お客様が本当に審査を書いた 8/86 と区別する判定が本文だけからは立たない）。入口で「これは貼り返し・お客様の言葉ではない」と渡す。

/** スタッフのフォーム末尾（お客様が貼り返す部分）。reply-context.TEMPLATE_ECHO_RE と同じ形（循環 import を避けてここで持つ） */
const TEMPLATE_TAIL_RE = /※\s*審査に不安な事がある方[^\n]*|審査面(?:も)?柔軟にサポートさせて頂きます[！!]?|【お部屋お探し中！?】/g;
/** お客様自身が審査に触れた語（テンプレート部分を剥がした後で見る） */
const CUSTOMER_SCREENING_RE = /審査|保証会社|夜職|水商売|ホスト|キャバ|風俗|無職|ブラック|滞納|債務|自己破産|任意整理|離婚|生活保護|外国籍|在留/;

export type TemplateEchoVerdict = {
  /** 貼り返しの部分がある */
  echoed: boolean;
  /** 貼り返しを剥がした後にお客様自身が審査に触れているか */
  customerMentionsScreening: boolean;
};

export function detectTemplateEcho(customerText: string | null | undefined): TemplateEchoVerdict {
  const raw = customerText ?? "";
  const echoed = TEMPLATE_TAIL_RE.test(raw);
  TEMPLATE_TAIL_RE.lastIndex = 0;
  const body = raw.replace(TEMPLATE_TAIL_RE, "");
  TEMPLATE_TAIL_RE.lastIndex = 0;
  return { echoed, customerMentionsScreening: CUSTOMER_SCREENING_RE.test(body) };
}

/**
 * 生成に渡す1行。貼り返しがあり、お客様自身は審査に触れていない時だけ出す（それ以外は空）。
 * 「書くな」ではなく「これはお客様の言葉ではない」と材料の出所を正す（率も添える）。
 */
export function buildTemplateEchoNote(customerText: string | null | undefined): string {
  const v = detectTemplateEcho(customerText);
  if (!v.echoed || v.customerMentionsScreening) return "";
  return "- ⚠ お客様の文の末尾「※審査に不安な事がある方…審査面柔軟にサポートさせて頂きます」はこちらのフォームの貼り返し（お客様の言葉ではない）。お客様自身は審査に触れていないので、審査の話（「審査面も柔軟にサポート」等）は足さない（この場面の実送信 0/31。審査に触れる実送信はお客様が夜職等と書いた時だけ）";
}

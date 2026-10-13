// app/lib/__tests__/final-check-brain-align.test.ts — 最終チェックの「直す・直さない」をブレインの判断にそろえる（2026-10-13）
//   実行: npx tsx app/lib/__tests__/final-check-brain-align.test.ts
//   例は本番の画面に残った指摘（conversations.ai_draft_check・9/18〜10/13）の実物（名前は伏せた）
import { evidenceAnchoredInDraft, brainBacksIssue, selectRevisionIssues, annotateUnfixed, normForAnchor, type AlignIssue } from "../final-check-brain-align";
import { contractConfirmMiss, findConfirmPromiseSentence } from "../final-check-brain-align";
import { isConfirmPromiseAsk, issueContradictsContract, type TurnContract } from "../turn-contract";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

const base: TurnContract = { asks: [], leadWith: null, closeOnly: false, mustNot: [], proposals: [], alreadySaid: [], settled: [], feeling: { kind: null, acknowledge: false }, humanChecks: [], source: "brain" };

console.log("① 引用が本文にあるか（省略・括弧の二重・並び）");
{
  const draft = "〇〇さんお世話になっております！！\nお待たせしており申し訳ございません、堺筋本町・本町周辺全域から家賃10〜12万円・1LDKのお部屋ピックアップしてお送りさせて頂きます！！";
  // ccdea0b5: 「…」で省略した引用（旧は本文に無い扱い＝書き直しに渡らなかった）
  t("「…」の省略", evidenceAnchoredInDraft("お待たせしており申し訳ございません、堺筋本町・本町周辺全域から…ピックアップしてお送りさせて頂きます", draft));
  // f895b126: 括弧が二重
  t("括弧の二重", evidenceAnchoredInDraft("「「堺筋本町・本町周辺全域から」」", draft));
  // 10/10 1095eb88: 複数の引用の並び
  t("複数の引用の並び（片方が本文）", evidenceAnchoredInDraft("「〇〇さんにオススメできるお部屋」「お待たせしており申し訳ございません」", draft));
  // ad97cd40: 「顧客メッセージ: X / 返信: Y」の形（返信の側が本文の引用）
  t("「返信:」の見出し付きの引用", evidenceAnchoredInDraft("顧客メッセージ: この3つ全部初期費用知りたいです！ / 返信: お待たせしており申し訳ございません、堺筋本町", draft));
  t("お客様の側だけの見出し付きは本文の引用でない", !evidenceAnchoredInDraft("顧客メッセージ: この3つ全部初期費用知りたいです！", draft));
  t("絵文字・空白の違い",evidenceAnchoredInDraft("お部屋ピックアップしてお送りさせて頂きます😊！！", draft));
  t("本文に無い説明は本文の引用でない", !evidenceAnchoredInDraft("返信文に「今年中」「入居時期」への言及がない", draft));
  t("お客様の質問は本文の引用でない", !evidenceAnchoredInDraft("敷礼なしの子供可能物件ってありますでしょうか？", draft));
  t("短い断片（8字未満）だけでは当てない", !evidenceAnchoredInDraft("「お部屋」「本町」", "本町のお部屋"));
  t("引用なしは通す（旧と同じ）", evidenceAnchoredInDraft("", draft));
  t("正規化: 括弧・句読点・絵文字を外す", normForAnchor("「お部屋」、😊！！") === "お部屋");
}

console.log("② ブレインの裏付け（引用が本文に無い取りこぼし）");
{
  const mq: AlignIssue = { code: "MISSED_QUESTION", severity: "warning", message: "顧客の「敷礼なしの子供可能物件はありますか」という質問に対して、返信が具体的な回答や対応方針を示していない", evidence: "敷礼なしの子供可能物件ってありますでしょうか？" };
  const cPromise: TurnContract = { ...base, asks: [{ quote: "敷礼なしの子供可能物件ってありますでしょうか", topic: "pickup" as never, kind: "question", route: "promise", answer: "敷礼なし・子供可で探してお送り", basis: null, aixKey: null }] };
  t("本質で promise の項目を指す → 裏付け", brainBacksIssue(mq, cPromise, null));
  const cAix: TurnContract = { ...cPromise, asks: [{ ...cPromise.asks[0], route: "aix", aixKey: "property_send" }] };
  t("本質で AIX の項目 → 裏付けなし", !brainBacksIssue(mq, cAix, null));
  t("閉じる番 → 裏付けなし", !brainBacksIssue(mq, { ...cPromise, closeOnly: true }, null));
  t("本質が無くても customer_questions にあれば裏付け", brainBacksIssue(mq, null, ["敷礼なしで子供可能の物件はあるか"]));
  t("customer_questions に無い質問 → 裏付けなし", !brainBacksIssue({ ...mq, evidence: "本当に初期費用2980円なんでしょうか？", message: "顧客が「本当に初期費用2980円なんでしょうか？」と明確に質問しているが" }, null, ["1LDKか2LDKの物件はあるか"]));
  t("(未対応) の印の質問は裏付けにしない", !brainBacksIssue({ ...mq, evidence: "入居は最短で何日になりますか？", message: "" }, null, ["(未対応)入居は最短で何日になりますか？"]));
  // 615499ba: 検査がブレインの判断を根拠に「本文に無い」と言う（竹内さんの言う「アナウンスはブレインが正しい」の型）
  t("ブレインを根拠にした抜けの指摘 → 裏付け", brainBacksIssue({ code: "RULE_VIOLATION", severity: "warning", evidence: "Brain指示には「11月末入居のご条件に合うお部屋を」と明記されているが、実返信に入居時期の言及がない", message: "" }, null, null));
  t("ブレインを挙げても『対象外・問題視しない』は裏付けにしない（1095eb88）", !brainBacksIssue({ code: "MISSED_QUESTION", severity: "warning", evidence: "返信文に「今年中」への言及がない", message: "ただしBrain判断の復唱対象外のため、問題視しない選択も可。" }, null, null));
  t("ブレインを挙げた作り話の指摘は裏付けにしない（引用が本文に無いと根拠が無い）", !brainBacksIssue({ code: "FABRICATED_AVAILABILITY", severity: "warning", evidence: "Brain 指示：『STANDY…の募集状況を管理会社に確認し』", message: "" }, null, null));
  t("閉じる番ではブレインを挙げた抜けも足さない", !brainBacksIssue({ code: "RULE_VIOLATION", severity: "warning", evidence: "Brain判定の内容が本文に無い", message: "" }, { ...base, closeOnly: true }, null));
  t("取りこぼし以外の型は裏付けの対象でない",!brainBacksIssue({ ...mq, code: "FABRICATED_NAME" }, cPromise, ["敷礼なしで子供可能の物件はあるか"]));
}

console.log("③ 選び方（warning・block の道が同じ関数）");
{
  const draft = "かしこまりました！！";
  const issues: AlignIssue[] = [
    { code: "MISSED_QUESTION", severity: "warning", message: "敷礼なしの子供可能物件の質問に答えていない", evidence: "敷礼なしの子供可能物件ってありますでしょうか？" },
    { code: "FABRICATED_NAME", severity: "warning", message: "顧客名が情報源と異なる可能性", evidence: "返信文に顧客名の明示的な呼びかけがない" },
    { code: "CELL_AVOID_CONFLICT", severity: "warning", message: "セル衝突", evidence: "PS_THINKING" },
    { code: "WE_DO_MISSING", severity: "warning", message: "閉じる番に行動宣言が無い", evidence: "かしこまりました！！" },
  ];
  const contract: TurnContract = { ...base, asks: [{ quote: "敷礼なしの子供可能物件ってありますでしょうか", topic: "pickup" as never, kind: "question", route: "promise", answer: null, basis: null, aixKey: null }] };
  const opts = {
    contract, customerQuestions: null,
    isRevisable: (i: AlignIssue) => i.code !== "CELL_AVOID_CONFLICT",
    contradicts: (i: AlignIssue) => i.code === "WE_DO_MISSING",
    legacyAnchored: (i: AlignIssue) => !i.evidence || draft.includes(i.evidence),
  };
  const r = selectRevisionIssues(issues, draft, { ...opts, env: {} });
  t("取りこぼし（ブレインの約束の項目）は渡す", r.pass.some((i) => i.code === "MISSED_QUESTION"));
  t("引用が本文に無く裏付けも無い指摘は渡さない", r.held.some((h) => h.issue.code === "FABRICATED_NAME" && h.reason === "unanchored"));
  t("表示だけの指摘は渡さない", r.held.some((h) => h.issue.code === "CELL_AVOID_CONFLICT" && h.reason === "not_revisable"));
  t("ブレインとぶつかる指摘は渡さない", r.held.some((h) => h.issue.code === "WE_DO_MISSING" && h.reason === "contradicts_brain"));
  const off = selectRevisionIssues(issues, draft, { ...opts, env: { FINAL_CHECK_BRAIN_ALIGN: "off" } });
  t("off: 旧の判定（引用が本文にそのまま）＝取りこぼしは渡らない", !off.pass.some((i) => i.code === "MISSED_QUESTION"));

  console.log("④ 残った指摘の理由・ブレインとぶつかる warning は画面から外す");
  const a = annotateUnfixed(issues as Array<AlignIssue & { unfixed_reason?: string }>, r.held, "no_passable", false, {});
  t("ぶつかる warning は画面から外し overruled へ", !a.shown.some((i) => i.code === "WE_DO_MISSING") && a.overruled.some((i) => i.code === "WE_DO_MISSING"));
  t("引用が無い指摘に理由", /裏付けも無い/.test(a.shown.find((i) => i.code === "FABRICATED_NAME")?.unfixed_reason ?? ""));
  t("表示だけの指摘には理由を付けない", !a.shown.find((i) => i.code === "CELL_AVOID_CONFLICT")?.unfixed_reason);
  t("渡したのに残った指摘には書き直しの理由", /渡せる指摘/.test(a.shown.find((i) => i.code === "MISSED_QUESTION")?.unfixed_reason ?? ""));
  const blk = annotateUnfixed([{ code: "WE_DO_MISSING", severity: "block", message: "", evidence: "かしこまりました！！" }], r.held, null, false, {});
  t("block は安全の線なのでぶつかっても画面に残す", blk.shown.length === 1 && blk.overruled.length === 0);
  const offA = annotateUnfixed(issues as Array<AlignIssue & { unfixed_reason?: string }>, r.held, "no_passable", false, { FINAL_CHECK_BRAIN_ALIGN: "off" });
  t("off: 旧のまま（理由なし・全部画面）", offA.shown.length === issues.length && !offA.shown.some((i) => i.unfixed_reason));
  const rev = annotateUnfixed<AlignIssue & { unfixed_reason?: string }>([{ code: "RULE_VIOLATION", severity: "warning", message: "", evidence: "周辺全域から" }], [], null, true, {});
  t("書き直した後に残った指摘", /書き直した後も残りました/.test(rev.shown[0].unfixed_reason ?? ""));
}

console.log("⑤ 本質に無い確認の約束（ブレインの物差しの検査）");
{
  // fecda03f（10/10）: 本質は小型犬2匹可の物件のピックアップの約束・下書きは「確認出来次第ご連絡」
  const c: TurnContract = { ...base, asks: [{ quote: "わかりました ありがとうございます", topic: "pickup" as never, kind: "request", route: "promise", answer: "小型犬2匹可の物件をピックアップしてお送り", basis: null, aixKey: null }] };
  const r = contractConfirmMiss("かしこまりました！！\n\n確認出来次第ご連絡させて頂きます😊！！", c, isConfirmPromiseAsk, {});
  t("本質に確認の約束が無い → 指摘・案は本質の約束", !!r && /確認出来次第/.test(r.sentence) && /小型犬2匹可/.test(r.suggestion));
  const cc: TurnContract = { ...base, asks: [{ quote: "空いてますか", topic: "vacancy" as never, kind: "question", route: "aix", answer: null, basis: null, aixKey: "property_check_result" }] };
  t("本質に確認の AIX がある → 指摘しない", !contractConfirmMiss("お送り頂きました物件の募集状況確認させて頂きます！！", cc, isConfirmPromiseAsk, {}));
  t("お客様の『ご確認の上』は数えない", !contractConfirmMiss("お手隙の際にご確認の上ご連絡ください！！", c, isConfirmPromiseAsk, {}));
  t("本質が依頼の一覧（ledger）だけ → 指摘しない", !contractConfirmMiss("確認させて頂きます！！", { ...c, source: "ledger" }, isConfirmPromiseAsk, {}));
  t("閉じる番 → 受けの一言＋締めの案", /受けの一言/.test(contractConfirmMiss("確認させて頂きます！！", { ...base, closeOnly: true }, isConfirmPromiseAsk, {})?.suggestion ?? ""));
  t("off で何もしない", !contractConfirmMiss("確認させて頂きます！！", c, isConfirmPromiseAsk, { FINAL_CHECK_BRAIN_ALIGN: "off" }));
  t("この指摘は本質とぶつかる指摘に数えない", !issueContradictsContract({ code: "CONTRACT_UNASKED_CONFIRM", message: "ブレインの判断（この番の本質）に確認・作成の約束が無いのに、確認の約束を書いています", evidence: r?.sentence ?? "", suggestion: r?.suggestion ?? "" }, c, {}));
}

console.log("⑥ 10/13 レビューの直し");
{
  // 重要1: 書き直しに渡した本物の指摘が、同じ code の「ブレインと逆」の指摘に引きずられて画面から消えない
  const contract: TurnContract = { ...base, asks: [
    { quote: "空いてますか", topic: "vacancy" as never, kind: "question", route: "aix", answer: null, basis: null, aixKey: "property_check_result" },
    { quote: "駐車場はありますか", topic: "equipment" as never, kind: "question", route: "reply", answer: "資料どおり敷地内に1台", basis: "material", aixKey: null },
  ] };
  const a: AlignIssue & { unfixed_reason?: string } = { code: "MISSED_QUESTION", severity: "warning", message: "「空いてますか」に答えていない", evidence: "空いてますか" };
  const b: AlignIssue & { unfixed_reason?: string } = { code: "MISSED_QUESTION", severity: "warning", message: "「駐車場はありますか」に答えていない", evidence: "駐車場はありますか" };
  const draft = "かしこまりました！！";
  const sel = selectRevisionIssues([a, b], draft, { contract, customerQuestions: null, isRevisable: () => true, contradicts: (i) => i === a, legacyAnchored: () => false, env: {} });
  t("再現: a はぶつかる・b は書き直しに渡す", sel.held.some((h) => h.issue === a && h.reason === "contradicts_brain") && sel.pass.includes(b));
  const ann = annotateUnfixed([a, b], sel.held, "new_warn_type", false, {});
  t("再現: 書き直しを採らなくても b は画面に残る（旧は shown=[]）", ann.shown.some((i) => i.evidence === "駐車場はありますか") && ann.overruled.length === 1 && ann.overruled[0].evidence === "空いてますか");
  t("b の理由は書き直しを採らなかった理由", /別の種類の指摘/.test(ann.shown.find((i) => i.evidence === "駐車場はありますか")?.unfixed_reason ?? ""));

  // 軽微1: ブレインの裏付けだけの指摘は block の道に渡さない
  const blk = selectRevisionIssues([b], draft, { contract, customerQuestions: null, isRevisable: () => true, contradicts: () => false, legacyAnchored: () => false, allowBrainBacked: false, env: {} });
  t("block の道: 裏付けだけの指摘は渡さない（理由つき）", blk.pass.length === 0 && blk.held[0]?.reason === "brain_backed_block_path");
  t("warning の道: 渡して viaBrain に数える", sel.viaBrain.includes(b));

  // 軽微2: ブレインを根拠に挙げた指摘でも、指す項目が AIX／触れないなら通さない
  t("Brain を挙げても AIX の項目を指す → 裏付けなし", !brainBacksIssue({ code: "RULE_VIOLATION", severity: "warning", evidence: "Brain指示では「空いてますか」への回答が必要だが返信に募集状況の言及がない", message: "" }, contract, null));
  t("Brain を挙げて返信の項目を指す → 裏付け", brainBacksIssue({ code: "RULE_VIOLATION", severity: "warning", evidence: "Brain指示では「駐車場はありますか」への回答が必要だが返信に言及がない", message: "" }, contract, null));

  // 重要2: 確認の約束の取り違え（聞き取り・受け取り・案内は約束でない）・取りこぼし
  const NOT = ["ご希望のエリアを確認させて頂きたいのですが、いかがでしょうか！！", "念のため確認させてください！！ご入居時期はいつ頃でしょうか😊", "お送り頂いた内容確認させて頂きました！！", "確認の上、改めてご案内させて頂きます！！", "お手隙の際にご確認の上ご連絡ください！！", "お部屋確認でき次第お送りさせて頂きます！！", "こちらで確認させて頂いてもよろしいでしょうか？"];
  for (const s of NOT) t(`約束でない: ${s.slice(0, 20)}`, findConfirmPromiseSentence(s) === null);
  const YES = ["確認次第ご連絡させて頂きます！！", "管理会社に確認してご連絡させて頂きます😊！！", "確認出来次第ご連絡させて頂きます😊！！", "初期費用につきまして管理会社に確認させて頂きます！！"];
  for (const s of YES) t(`約束: ${s.slice(0, 20)}`, findConfirmPromiseSentence(s) !== null);
  const c2: TurnContract = { ...base, asks: [{ quote: "わかりました", topic: "pickup" as never, kind: "request", route: "promise", answer: "小型犬2匹可の物件をピックアップしてお送り", basis: null, aixKey: null }] };
  t("聞き取りの文だけの下書きは指摘しない", !contractConfirmMiss("かしこまりました！！\nご希望のエリアを確認させて頂きたいのですが、いかがでしょうか！！", c2, isConfirmPromiseAsk, {}));
}

console.log("⑧ 確認の約束の取りこぼしの直し（2026-10-13・CONFIRM_PROMISE_TIGHT）");
{
  t("物件の空き確認でき次第ご連絡 → 約束", findConfirmPromiseSentence("お送り頂きました物件の空き確認でき次第ご連絡させて頂きます！！") !== null);
  t("文の途中の「ました」で外さない", findConfirmPromiseSentence("お送り頂きました物件の募集状況を確認させて頂きます！！") !== null);
  t("文の途中の「たい」で外さない", findConfirmPromiseSentence("ご希望されたいお日にちで内覧可能か管理会社に確認させて頂きます！！") !== null);
  t("ご来店時に身分証を確認 → 手続きの説明で約束でない", findConfirmPromiseSentence("ご来店時に身分証を確認させて頂きます！！") === null);
  t("ご契約の際に〜確認 → 約束でない", findConfirmPromiseSentence("ご契約の際に本人確認書類を確認させて頂きます！！") === null);
  t("お部屋確認でき次第お送り（探す約束）は今まで通り外す", findConfirmPromiseSentence("ご条件に合うお部屋確認でき次第お送りさせて頂きます！！") === null);
  t("文の終わりの「たい」はお願い（外す）", findConfirmPromiseSentence("ご都合よろしいお日にちを確認させて頂きたいです！！") === null);
  const OFF = { CONFIRM_PROMISE_TIGHT: "off" };
  t("戻す: 文の途中の「ました」で外れる（旧）", findConfirmPromiseSentence("お送り頂きました物件の募集状況を確認させて頂きます！！", OFF) === null);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);

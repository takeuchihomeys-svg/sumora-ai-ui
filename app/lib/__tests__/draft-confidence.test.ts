// app/lib/__tests__/draft-confidence.test.ts — 下書きの自信（draft-confidence.ts）
// 実行: npx tsx app/lib/__tests__/draft-confidence.test.ts
import { scoreDraftConfidence, draftConfidenceEnabled, confidenceFromCheck, confidenceLine, countCustomerAsks, type ConfidenceInput } from "../draft-confidence";
import { canAutoReply, type AutoReplyInput } from "../auto-reply-policy";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

// 型どおりの番（条件の長い文 → ピックアップの約束）
const BASE: ConfidenceInput = {
  draft: "お客様\nご条件ありがとうございます！！\n天王寺エリアから駅近のお部屋をピックアップしてお送りさせて頂きます😊！！",
  customerText: "希望エリア：天王寺周辺\n家賃：7万円まで\n間取り：1K以上\n入居時期：12月頃\nこだわり：駅から徒歩10分以内・バストイレ別・2階以上・独立洗面台があると嬉しいです。よろしくお願いいたします。",
  groundText: "",
  finalCheck: { ok: true, issues: [] },
  brain: { replyMode: "auto_reply", action: "", llmAction: "" },
  sceneKey: "返信:条件提示",
};

console.log("── 切替（既定 off）");
t("未設定は off", !draftConfidenceEnabled({}));
t("on の時だけ on", draftConfidenceEnabled({ DRAFT_CONFIDENCE: "on" }));
t("ON（大文字）も on", draftConfidenceEnabled({ DRAFT_CONFIDENCE: " ON " }));

console.log("── 型どおりの番は高い");
{
  const c = scoreDraftConfidence(BASE);
  t("段は high", c.band === "high", JSON.stringify(c));
  t("点は 100 を超えない", c.score <= 100);
  t("版がある", !!c.v);
}

console.log("── 下がる印");
{
  const block = scoreDraftConfidence({ ...BASE, finalCheck: { ok: false, issues: [{ code: "X", severity: "block" }], revisionExhausted: true } });
  t("直せなかった block は high にならない", block.band !== "high", JSON.stringify(block));
  t("理由に fc_block", block.reasons.some((r) => r.code === "fc_block"));
  const sched = scoreDraftConfidence({ ...BASE, customerText: "ありがとうございます！", draft: "かしこまりました！！\n10/5(土)12:00〜でお待ち合わせ如何でしょうか！！" });
  t("内覧の段取り＋聞き返し＋お礼だけの番は low", sched.band === "low", JSON.stringify(sched));
  t("理由に draft_schedule", sched.reasons.some((r) => r.code === "draft_schedule"));
  const sens = scoreDraftConfidence({ ...BASE, customerText: "審査落ちてしまいました。どうしたらいいですか？", sceneKey: "返信:意図:negative" });
  t("否決の番は理由に sensitive", sens.reasons.some((r) => r.code === "sensitive"));
  t("否決の番は high より下", sens.score < scoreDraftConfidence(BASE).score);
  const staff = scoreDraftConfidence({ ...BASE, draft: "お部屋はまだ空いております！！内覧可能です😊！！" });
  t("スタッフしか知らない事（空き）を言い切る → 理由に staff_only_fact", staff.reasons.some((r) => r.code === "staff_only_fact"), JSON.stringify(staff.reasons));
}

console.log("── 0点の印は理由に出さない（ブレインが AIX を指しているだけ）");
{
  const c = scoreDraftConfidence({ ...BASE, brain: { replyMode: "aix", action: "property_send", llmAction: "property_send" } });
  t("brain_wants_aix は理由に出ない", !c.reasons.some((r) => r.code === "brain_wants_aix"));
}

console.log("── 将来の印（入力がある時だけ）");
{
  t("読み手の割れが無ければ数えない", !scoreDraftConfidence(BASE).reasons.some((r) => r.code === "reader_split"));
  t("読み手の割れがあれば下がる", scoreDraftConfidence({ ...BASE, readerSplit: true }).score < scoreDraftConfidence(BASE).score);
}

console.log("── 質問の数・読み戻し・1行");
{
  t("質問2つ", countCustomerAsks("ペットは大丈夫ですか？\n駐車場はありますか？") === 2);
  t("お礼だけは0", countCustomerAsks("ありがとうございます！") === 0);
  const c = scoreDraftConfidence({ ...BASE, finalCheck: { ok: false, issues: [{ code: "X", severity: "block" }] } });
  t("ai_draft_check から読める", confidenceFromCheck({ ok: false, confidence: c })?.score === c.score);
  t("形が違えば null", confidenceFromCheck({ confidence: { score: "x" } }) === null && confidenceFromCheck(null) === null);
  t("1行に段と理由", /自信 (高|中|低)（\d+/.test(confidenceLine(c)));
}

console.log("── 自動返信の関所: 低い番は送らない（送る側には倒さない）");
{
  const OK: AutoReplyInput = {
    autoSendEnabled: true, lastSender: "customer", replyMode: "auto_reply", suggestedAixAction: null,
    draft: "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！",
    draftHasBlock: false, status: "proposing", hasPendingScheduled: false,
  };
  t("低い → low_confidence で止まる", canAutoReply({ ...OK, draftConfidenceLow: true }).reason === "low_confidence");
  t("立っていない時は今まで通り", canAutoReply(OK).ok && canAutoReply({ ...OK, draftConfidenceLow: false }).ok);
  t("切り替えていない会話は低くなくても送らない", canAutoReply({ ...OK, autoSendEnabled: null, draftConfidenceLow: false }).reason === "auto_off");
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);

// 実行: npx tsx app/lib/__tests__/id-doc-passport.test.ts
// 2026-10-01 竹内（みこと）「マイナンバーカードがあれば大丈夫。パスポートの場合はパスポートと現在の住所記載の住民票がいる。
//   今回はマイナンバー持っているので、マイナンバーカードの部分でお客さんに伝えたら大丈夫。パスポートに関して触れなくて大丈夫」
//   お客様の文・AI の下書き・スタッフの実送信をそのまま使う。
import { detectProcedureQuestion, idDocsIn, idDocFactFor, buildProcedureAnswerNote, procedureReplyDirection, resolveProcedurePlan } from "../procedure-question";
import { findCompanyFactContradiction, findCompanyFactContradictionsUngated } from "../company-fact-guard";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

const MIKOTO_Q = "よろしくお願いします。\n本人確認書類がマイナンバー、パスポート両方あるのですが審査通るまでどのくらいの期間見といたらいいですか？";
const AI_DRAFT = "かしこまりました！！\n\n本人確認書類がマイナンバーカード・パスポートどちらでもお申込みを進めることができます😊\n\n審査の期間は保証会社の審査が3日〜10日程度、その後の契約手続きに1週間程かかりますので、お申込みから入居までは最短で2週間程が目安となります！！";
const STAFF_SENT = "かしこまりました！！\n\n本人確認書類としてマイナンバーカードお申込みを進めることができます😊！！\n\n審査の期間は保証会社の審査が3日〜10日程度、その後の契約手続きに1週間程かかりますので、お申込みから入居までは最短で2週間程が目安となります！！";

// ── 入口: お客様の持っている書類で事実を変える ──
{
  const q = detectProcedureQuestion(MIKOTO_Q);
  t("みこと: 手続きの質問（審査の期間＋本人確認書類）", !!q && q.kinds.includes("screening_period") && q.kinds.includes("id_doc"), JSON.stringify(q));
  t("みこと: 持っている書類 = マイナンバー・パスポート", JSON.stringify(q?.ids) === JSON.stringify(["my_number", "passport"]), JSON.stringify(q?.ids));
  const note = buildProcedureAnswerNote(resolveProcedurePlan({ question: q!, target: null, materialLines: [] }));
  t("みこと: 事実はマイナンバーカードで進められる・パスポートには触れない", /マイナンバーカード（裏表の写真）でお申込み/.test(note) && /パスポートには触れない/.test(note), note);
  t("みこと: 旧の「一度パスポートでお申込みを進められる」は渡さない", !/一度パスポートで/.test(note));
  const dir = procedureReplyDirection(resolveProcedurePlan({ question: q!, target: null, materialLines: [] }));
  t("みこと: ブレインの方向もマイナンバーカード", /マイナンバーカードでお申込み/.test(dir) && /パスポートには触れない/.test(dir), dir);
}
{
  t("パスポートだけ → 住民票の2点", /現住所記載の住民票の2点/.test(idDocFactFor(idDocsIn("顔付き身分証がパスポートしかなくて"))));
  t("免許証 → 免許証で進められる", /運転免許証（裏表の写真）でお申込み/.test(idDocFactFor(idDocsIn("免許証で大丈夫ですか？"))));
  t("書類の名前なし → 一般の事実（パスポートは住民票も）", /住民票/.test(idDocFactFor(idDocsIn("本人確認書類は何がいりますか？"))));
  t("「マイナス」はマイナンバーではない", idDocsIn("家賃マイナス5千円").length === 0);
}

// ── 出口: カードとパスポートを並べて「どちらでも」 ──
{
  const hit = findCompanyFactContradiction(AI_DRAFT, [MIKOTO_Q]);
  t("みこと: AI の下書きは止める", !!hit && /パスポート/.test(hit.sentence), JSON.stringify(hit));
  t("みこと: スタッフが送った文は止めない", findCompanyFactContradiction(STAFF_SENT, [MIKOTO_Q]) === null);
}
// スタッフの実送信（365日・パスポートの語がある全7通）は1通も当たらない（ゲート無し）
const REAL_STAFF = [
  "かしこまりました、Ryuさん！ 鍵取りの際のご持ち物についてですが、身分証明書（運転免許証やパスポートなど）をご持参いただければ大丈夫です😊 ご同居人さんがいらっしゃる場合も、本人確認の手続きの都合上、身分証明書が必要となってきますので、お忘れなくお願いいたします！",
  "かしこまりました！！ パスポートの写真をお送り頂き、こちらでお申込させて頂きます！！ 保証会社の審査の際に運転免許証またはマイナンバーカード（どちらか一点）の提出をお願いされますので、ご準備頂き次第お送り頂きますと幸いです😌！！",
  "かりんさんパスポート写真お送り頂きありがとうございます！！一度こちらでお申込を進めさせて頂きます😊！！ お手数ですが、運転免許証またはマイナンバーカードのお写真お母様から送られましたら、こちらのLINEにお送り頂きますと幸いです！！",
  "かしこまりました！！ 一度パスポートでお申し込みさせていただきますので、お送りの程よろしくお願いいたします😊！！",
  "かしこまりました！！ パスポートで審査していただけるよう交渉させていただきます！！",
  "上記フォーマットご入力いただき、ご本人確認書類としてパスポートの顔写真ページのお写真をお送りください！！ お送り頂き次第、お部屋お申込し抑えさせて頂きます！！",
  "かしこまりました！！ フォーマットのご入力とパスポートのお写真お待ちしております！！",
];
for (const s of REAL_STAFF) {
  const hits = findCompanyFactContradictionsUngated(s).filter((h) => h.factId === "screening_flow" || h.factId === "apply_docs");
  t(`実送信は当たらない: ${s.slice(0, 30)}…`, hits.length === 0, JSON.stringify(hits));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

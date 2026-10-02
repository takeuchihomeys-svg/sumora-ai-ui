// app/lib/__tests__/apply-docs-guard.test.ts — 2026-10-02 竹内さん「申込み時に必要なのはフォーマットと本人確認書類の裏表写真」
//   実行: npx tsx app/lib/__tests__/apply-docs-guard.test.ts
import { findExtraApplyDocs } from "../apply-docs-guard";
import { isUsableExampleText } from "../example-hygiene";
import { canAutoReply } from "../auto-reply-policy";
import { matchCompanyFacts } from "../company-facts";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// YUMA の LINE（10/02 11:42）に届いた実物
const YUMA_DRAFT = "全然大丈夫です！！\n\n申込に必要な書類をまとめてお伝えさせて頂きます😊！！\n\n・お申込みフォームのご入力\n・YUMAさん達3名様の単体または集合写真\n・YUMA様の資格確認書またはマイナポータルの医療保険資格情報の添付\n・YUMA様の写真\n・YUMA様の携帯番号\n・YUMAさんとお兄様のご兄弟関係を証明できる戸籍謄本\n\n紙の保険書がない場合は、マイナポータルの医療保険資格情報のスクリーンショットで代用可能です😌！！";
t("YUMA の実物（申込の書類として資格確認書・集合写真・戸籍）→ 当たる", findExtraApplyDocs(YUMA_DRAFT) !== null, JSON.stringify(findExtraApplyDocs(YUMA_DRAFT)));
const v = canAutoReply({ autoSendEnabled: true, lastSender: "customer", replyMode: "auto_reply", suggestedAixAction: null, draft: YUMA_DRAFT, draftHasBlock: false, status: "proposing", hasPendingScheduled: false });
t("自動では送らない（本文は変えない）", !v.ok && v.reason === "staff_only_fact:extra_apply_docs", JSON.stringify(v));
t("手本にしない（他のお客様の個別の指示）", !isUsableExampleText("審査に伴いカイナさんの保険証のお写真も必要となりますので、マイナポータルより資格情報のスクショお送りの程よろしくお願いいたします😊！！"));

// 当てない物（正しい形・スタッフの実送信）
const OK_TEXTS = [
  "上記フォーマットご入力いただき、ご本人確認書類として運転免許証またはマイナンバーカードの裏表の写真をお送りください！！\n※マイナンバーカードの場合は番号部分をマスキングしてお写真お送りください！！",
  "現状管理会社より提出指示が来ているものとして\n・健康資格確認書\n・入居者皆様分の顔写真\nが必要となります！！",
  "パスポートの場合はパスポートと現住所記載の住民票の2点が必要となります！！",
  "契約時には連帯保証人様直筆での契約書へのご署名と実印での押印、実印の印鑑登録書原本の提出が必要となります！！",
  "免許証の顔写真部分が光で見えづらくなっておりますので、お手隙の際に表面のみ再度お送りの程よろしくお願いいたします！！",
];
for (const s of OK_TEXTS) t(`当てない: ${s.slice(0, 30)}`, findExtraApplyDocs(s) === null, JSON.stringify(findExtraApplyDocs(s)));

// 会社の事実: 申込の書類を聞かれた時に渡る事実にマスキングと「他の書類は挙げない」が入る
const f = matchCompanyFacts(["すみません、必要書類を今まとめて全て教えて貰っても良いでしょうか。"]).find((x) => x.id === "apply_docs");
t("必要書類の質問 → apply_docs が渡る", !!f);
t("事実にマイナンバーのマスキング", /マスキング/.test(f?.fact ?? ""));
t("事実に「他の書類は挙げない」", /こちらから挙げない/.test(f?.fact ?? ""));

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);

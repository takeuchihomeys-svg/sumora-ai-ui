// app/lib/__tests__/line-watch-staff-only-v9.test.ts — 見張り v9（スタッフだけが知る事の網・返信の文の物差しの外）
//   実行: npx tsx app/lib/__tests__/line-watch-staff-only-v9.test.ts
import { staffFactsOf } from "../line-watch-judge";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const kinds = (s: string) => staffFactsOf(s, "").map((x) => x.kind);
process.env.LINE_WATCH_STAFF_ONLY_V9 = "off";
t("off は今まで通り（v9 の網を使わない）", !kinds("Tio Parterre管理会社に確認させていただき、お部屋ご両親での代理契約でのお申込みも可能とのことです！！").includes("check_reported_v9"));
process.env.LINE_WATCH_STAFF_ONLY_V9 = "on";
t("確認させていただき、〜可能とのことです（#5204）", kinds("Tio Parterre管理会社に確認させていただき、お部屋ご両親での代理契約でのお申込みも可能とのことです！！").includes("check_reported_v9"));
t("床の色（#8173）", kinds("こちら床の色グレーとなります！！ 偶数階のお部屋が白色 奇数階のお部屋がグレーとなります😊！！").includes("room_attr_checked"));
t("スタッフの予定（#7369）", kinds("本日15:00より神戸市の方で次のご予定がございますので国分本町7丁目 貸家のご案内は別日で設定いただけますと幸いです！！").includes("staff_schedule"));
t("現地の位置（#7630）", kinds("咲さんお世話になっております！！ 御堂筋線側のエントランスにおります！！").includes("staff_onsite"));
t("画像だけ（#6038）", kinds("[画像]").includes("staff_image"));
t("申込書のフォーマット", kinds("こちらお申込に必要なご情報となります😊！！ 上記フォーマットご入力いただき").includes("apply_format"));
t("これからの約束は当てない", kinds("お部屋の募集状況確認させて頂きます！！ 確認出来次第ご連絡させて頂きます！！").length === 0);
t("前の話の引用（とのことでしたので）は当てない", !kinds("はい！！ 1匹のみとのことでしたので、引き続き新着で小型犬2匹まで飼育可能なお部屋をピックアップしてお送りさせて頂きます😊！！").includes("check_reported_v9"));
t("随時確認させて頂き、〜お送り は当てない", !kinds("新着状況を随時確認させて頂き、オススメ出来るお部屋が募集に出次第お送りさせて頂きます！！").includes("check_reported_v9"));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);

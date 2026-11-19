// 2026-11-15 竹内さんの決定（KB 1d2400c6・確認事項 H-14）: お客様の画像の3つの型の返し方（customer-image-link・CUSTOMER_IMAGE_ROUTE_1115）と、
//   好みの手本の特徴を要望の欄に足す形（image-taste-wants・CUSTOMER_IMAGE_TASTE_WANTS）。元の番の形（書き起こしの形・名前は架空）で。LLM も DB も使わない。
// 実行: npx tsx app/lib/__tests__/image-route-1115.test.ts
import { readFileSync } from "node:fs";
import { linkCustomerImage, linkTurnImages, buildImageLinkBlock, tasteFeaturesFromTranscript, type SentForLink } from "../customer-image-link";
import { tasteWantUpdates, imageTasteWantsOn, TASTE_TAG } from "../image-taste-wants";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

process.env.CUSTOMER_IMAGE_ROUTE_1115 = "on";
const SENT: SentForLink[] = [
  { name: "サンプルレジデンス本町", room: "502", sentAt: "2026-11-10T03:00:00Z", rent: 72000, bundleNo: 3, bundlePos: 2 },
  { name: "サンプルハイツ天満", room: "301", sentAt: "2026-11-10T03:00:20Z", rent: 65000, bundleNo: 3, bundlePos: 3, vacating: true },
];
// ① こちらが送った物件と同じマンションの他社の画面（ポータル・SUUMO の形）
const OTHER_SITE = "[画像] 【物件の画面（ポータル）】\nSUUMO\n物件名：サンプルレジデンス本町 502号室\n賃料 7.2万円 管理費 6,000円\n1LDK 35.2㎡\nお問い合わせ";
{
  const now = linkCustomerImage({ text: OTHER_SITE, at: "2026-11-12T05:00:00Z", customerWords: "", sent: SENT });
  ok("① 送った物件の他社の画面: 関連は「他社の画面」（決め打ちしない）", now.relation === "ours_on_other_site" && now.ours?.bundleNo === 3 && now.ours.bundlePos === 2, JSON.stringify({ r: now.relation, o: now.ours }));
  ok("① 後の一言がまだ無い＝待つ", /待つ/.test(now.route.text) && /1d2400c6/.test(now.route.kb ?? ""));
  const cmp = linkCustomerImage({ text: OTHER_SITE, at: "2026-11-12T05:00:00Z", customerWords: "他社だとこの値段なんですけどそちらの方が安くなりますか？", sent: SENT });
  ok("① 比べ・安さの確かめ＝最大限割引の御見積書で応える", /最大限割引した御見積書/.test(cmp.route.text));
  const vw = linkCustomerImage({ text: OTHER_SITE, at: "2026-11-12T05:00:00Z", customerWords: "ここ内見できますか", sent: SENT });
  ok("① 内覧＝ AIX【内覧調整】", /内覧調整/.test(vw.route.text));
  const vc = linkCustomerImage({ text: OTHER_SITE, at: "2026-11-12T05:00:00Z", customerWords: "これまだ空いてますか", sent: SENT });
  ok("① 空き＝送った時に確認済み（確認の約束にしない）", /確認済み/.test(vc.route.text) && /書かない/.test(vc.route.text));
}
// ② 好みの手本（2cb0feb7 11/07 の形「自分で色々探しているのですが…部屋が白基調で広ければ」）
const TASTE = "[画像] 【物件の画面（ポータル）】\nHOME'S\n賃料 11万円\n2LDK 55.1㎡\nLDK 14帖・白基調の内装・独立洗面台・バス・トイレ別\n徒歩4分 新築\nお問い合わせ";
{
  const l = linkCustomerImage({ text: TASTE, at: "2026-11-07T05:23:00Z", customerWords: "こういうお部屋がいいです 白基調で広ければ有難いです", sent: SENT });
  ok("② 好みの手本＝好みを条件に足してピックアップの約束（2段:pickup）→ 物件の AIX", l.relation === "similar_other" && /2段:pickup/.test(l.route.text) && /1d2400c6/.test(l.route.kb ?? ""));
  const keys = (l.taste ?? []).map((t) => t.key).join(",");
  ok("② 画像の特徴（白基調・広いリビング・築浅・駅近・独立洗面台・バストイレ別）", ["white", "wide_living", "new_build", "near_station", "wash", "bath_toilet"].every((k) => keys.includes(k)), keys);
  ok("② 材料の行に画像の好みが出る", /画像の好み: 白基調の内装/.test(buildImageLinkBlock([l])));
  // 要望の欄に足す形
  const u = tasteWantUpdates({ preferences: "オートロック・独立洗面台", other_requests: "初期費用15万円以内", ng_points: "1階NG" }, l.taste ?? []);
  ok("② 設備はこだわり（preferences）・それ以外はその他（other_requests）に1つずつ", /バストイレ別\[画像の好み\]/.test(u.updates.preferences ?? "") && /白基調の内装\[画像の好み\]・広いリビング（10帖以上）\[画像の好み\]・築浅\[画像の好み\]/.test(u.updates.other_requests ?? ""), JSON.stringify(u.updates));
  ok("② 既にある要望（独立洗面台）は重ねない・今ある節は消さない", u.skipped.some((s) => s.label === "独立洗面台" && s.why === "already") && /^オートロック・独立洗面台・/.test(u.updates.preferences ?? "") && /^初期費用15万円以内・/.test(u.updates.other_requests ?? ""));
  ok("② 好み（できれば）として足す＝[必須] を付けない", !/必須/.test(JSON.stringify(u.updates)) && JSON.stringify(u.updates).includes(TASTE_TAG));
  const ng = tasteWantUpdates({ ng_points: "新築NG" }, tasteFeaturesFromTranscript("新築 白基調"));
  ok("② NG の欄に当たる物は足さない", ng.skipped.some((s) => s.label === "築浅" && s.why === "ng") && ng.added.join() === "白基調の内装");
  ok("② 2回目は何も足さない（同じ画像を二重に書かない）", tasteWantUpdates({ preferences: u.updates.preferences, other_requests: u.updates.other_requests }, l.taste ?? []).added.length === 0);
  ok("② 書く所は既定 off", imageTasteWantsOn({}) === false);
}
// ③ こちらの見積書の送り返し（13f37ce2 11/09 の形・弊社＝蓮産業）
const OWN_EST = (name: string) => `[画像] 【見積書・初期費用の明細】\n御見積書\nこの度は、蓮産業株式会社をご利用頂き誠に有り難うございました。\n御請求金額 ¥125,820\n物件名：${name}\n敷金：0\n礼金：63,000\n火災保険：15,000\n鍵交換：27,500`;
{
  const q = linkCustomerImage({ text: OWN_EST("サンプルレジデンス本町"), at: "2026-11-12T06:00:00Z", customerWords: "以前これで貰ったんですけど差額の方どうなりますか？", sent: SENT });
  ok("③ 質問あり＝答える返信", q.kind === "estimate_own" && /答える返信/.test(q.route.text));
  const n = linkCustomerImage({ text: OWN_EST("サンプルレジデンス本町"), at: "2026-11-12T06:00:00Z", customerWords: "ありがとうございます、いいですね", sent: SENT });
  ok("③ 質問なし＝内覧の誘い", /内覧に誘う/.test(n.route.text));
  const v = linkCustomerImage({ text: OWN_EST("サンプルハイツ天満"), at: "2026-11-12T06:00:00Z", customerWords: "ありがとうございます", sent: SENT });
  ok("③ 退去予定の物件＝申込に誘導（AIX【申込へ】）", /申込へ/.test(v.route.text));
  const w = linkCustomerImage({ text: OWN_EST("サンプルレジデンス本町"), at: "2026-11-12T06:00:00Z", customerWords: "", sent: SENT });
  ok("③ 文がまだ無い＝連投の続きを待つ", /待つ/.test(w.route.text));
}
{
  delete process.env.CUSTOMER_IMAGE_ROUTE_1115;
  const off = linkCustomerImage({ text: OTHER_SITE, at: "2026-11-12T05:00:00Z", customerWords: "", sent: SENT });
  ok("off なら前の行き先（送った物件への反応）", off.relation === "reaction_to_ours");
  const turns = linkTurnImages([{ text: TASTE, created_at: "2026-11-07T05:23:00Z" }, { text: "こんな感じのお部屋が希望です", created_at: "2026-11-07T05:24:00Z" }], SENT);
  ok("off でも好みの手本の関連と特徴は出す（行き先の文だけ前の形）", turns[0].relation === "similar_other" && (turns[0].taste ?? []).length > 0 && /決まっていない/.test(turns[0].route.text));
}
{
  const wh = readFileSync("app/lib/line-webhook-text.ts", "utf8"), bc = readFileSync("app/lib/brain-core.ts", "utf8");
  ok("配線: お客様の文を受けた後に要望の欄へ（スイッチの時だけ）", /CUSTOMER_IMAGE_TASTE_WANTS === "on"/.test(wh) && /applyImageTasteWants\(/.test(wh));
  ok("配線: brain-core が送った物件の退去予定を結び付けに渡す", /vacating: \/退去予定\//.test(bc));
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

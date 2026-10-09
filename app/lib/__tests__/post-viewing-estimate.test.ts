// 実行: npx tsx app/lib/__tests__/post-viewing-estimate.test.ts
// 2026-10-08 竹内さん「内覧の後の見積書は、お客様から希望があった時だけ」・竹内さん「ピックアップに添える条件の数は実際の LINE を参考に」
import {
  postViewingEstimateOnRequest, VIEWING_PATTERN_C, NEW_VIEWING_PATTERN_C, OLD_VIEWING_PATTERN_C,
  VIEWING_BANS_ESTIMATE, VIEWING_PATTERN_F_STEPS, VIEWING_PATTERN_F_EXAMPLE, VIEWING_SCENE_SUMMARY,
} from "../post-viewing-estimate";
import { PHASE_GUIDE } from "../line-reply-prompts";
import { countEchoedConditions, countFormConditions, deliveredPickupConditionRule, pickupCondCountOn } from "../pickup-condition-count";
import { takeuchiPickupConditionsRule } from "../aix-takeuchi-form";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

console.log("■ 内覧後の見積書");
t("既定は on", postViewingEstimateOnRequest({}) && !postViewingEstimateOnRequest({ POST_VIEWING_ESTIMATE_ON_REQUEST: "off" }));
t("既定の型は新しい物", VIEWING_PATTERN_C === NEW_VIEWING_PATTERN_C);
t("新しい型に「即・見積書の作成宣言へ橋渡し」が無い", !/即・見積書の作成宣言へ橋渡し/.test(VIEWING_PATTERN_C) && /即・見積書の作成宣言へ橋渡し/.test(OLD_VIEWING_PATTERN_C));
t("新しい型は頼んだ時だけ", /お客様が見積・初期費用を頼んだ時だけ/.test(VIEWING_PATTERN_C));
t("例文に見積の宣言が無い", !/御見積書/.test((VIEWING_PATTERN_C.match(/→ 例: 「[^」]*」/) ?? [""])[0]));
t("F の例文にも見積の宣言が無い", !/御見積書/.test(VIEWING_PATTERN_F_EXAMPLE) && /頼んだ時だけ/.test(VIEWING_PATTERN_F_STEPS));
t("禁止の段: 作成宣言は頼んだ時だけ", /頼んだ時だけ許可/.test(VIEWING_BANS_ESTIMATE) && !/見積橋渡し/.test(VIEWING_BANS_ESTIMATE));
t("場面の要約から見積橋渡しが消えた", !/見積橋渡し/.test(VIEWING_SCENE_SUMMARY));
const viewing = String((PHASE_GUIDE as Record<string, string>).viewing ?? "");
t("line-reply-prompts の viewing に差し込まれている", viewing.includes(NEW_VIEWING_PATTERN_C) && !/見積橋渡し ★このフェーズ最重要/.test(viewing), viewing.slice(0, 80));

console.log("■ ピックアップに添える条件の数");
const FORM = "（あやさんご希望のお部屋探しご条件）\n①ご入居時期  10月29日〜11月1日\n②ご希望家賃（管理費込み）  6万〜7万\n③ご希望間取り   1K、1LDK\n④ご希望築年数     20年以内\n⑤ご希望エリア・最寄り駅   大国町\n⑥駅からの徒歩分数    20分以内\n⑦初期費用 20万\n⑧その他 バストイレ別、2階以上";
t("フォームの条件の数（②③④⑥＋⑧の2つ＝6・①⑤⑦は数えない）", countFormConditions(FORM) === 6, String(countFormConditions(FORM)));
t("「特になし」は数えない", countFormConditions("②【家賃】⇒8万\n③【間取り】⇒1K\n⑥【ご希望の駅徒歩分数】⇒特になし") === 2);
t("宣言 10/05 Yuki（5つ）", countEchoedConditions("大阪市内全域から家賃8〜14万円・1LDK〜2LDK・40〜60平米・築10年以内・駅徒歩5分以内でYukiさんにオススメできるお部屋をピックアップしてお送りさせて頂きます！！") === 5);
t("届けた行 10/05 Yuki（2つ）", countEchoedConditions("大阪市内全域から1LDK〜2LDK・駅徒歩5分以内でYukiさんにオススメできるお部屋ピックアップさせて頂きました！！") === 2);
t("エリアだけの行（0）", countEchoedConditions("南堀江・九条周辺全域から大野さんにオススメ出来るお部屋ピックアップさせて頂きました😊！！") === 0);
t("間取りの並び（1R・1K）は1つ", countEchoedConditions("九条周辺全域から大野様にオススメできる家賃6万円以下の1R・1Kのお部屋をピックアップしお送りさせて頂きます！！") === 2);
t("既定は on・固定の「2つまで」を出さない", pickupCondCountOn({}) && !/2つまで/.test(takeuchiPickupConditionsRule()) && /決め打ちしない/.test(takeuchiPickupConditionsRule()));
t("条件の数が分かる時はその数を添える", /この方の条件は5つ/.test(deliveredPickupConditionRule(5)));
process.env.PICKUP_COND_COUNT = "off";
t("PICKUP_COND_COUNT=off で旧の「2つまで」", /2つまで/.test(takeuchiPickupConditionsRule()));
delete process.env.PICKUP_COND_COUNT;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

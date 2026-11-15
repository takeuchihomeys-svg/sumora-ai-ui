// つなぎの型（2026-11-15 作業員H）
// 実行: npx tsx scripts/lib/__tests__/tsunagi.test.ts
import { tsunagiOf, turnTsunagi, tsunagiMiss, noneReasonOf, kAimOf } from "../tsunagi";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
// 実物の形（試験 q428・q439・q174 の竹内さんの文）
const q428 = "ご確認頂きありがとうございます😊！！ 周辺ですと現在こちらのお部屋のみになります！！ お気に召されましたら一度ご案内させて頂きます！！ 並行して新着で条件に合うお部屋が出次第お送りさせて頂きます！！";
const q439 = "お送りさせて頂きましたお部屋でカウンターキッチン付のお部屋はこちらの1部屋になります！！ お気に召されましたらご都合よろしいお日にちにご案内させて頂きます😊 お手隙の際にご査収下さいませ！！";
const q174 = "ご査収頂きありがとうございます😊！！ かしこまりました！！ YUMAさんにオススメできるお部屋を新たにピックアップしてお送りさせて頂きます！！ 確認出来次第ご連絡させて頂きます！！";
const a = tsunagiOf(q428);
t("q428: 内覧の誘い（添える）＋次の連絡の約束", a.kind === "viewing" && a.strength === "soft" && a.all.includes("next_contact"), a);
t("q439: 内覧の誘い", tsunagiOf(q439).kind === "viewing", tsunagiOf(q439));
t("q174: 次の連絡の約束（内覧の誘いは無い）", tsunagiOf(q174).kind === "next_contact", tsunagiOf(q174));
t("見積の誘い", tsunagiOf("こちらのお部屋で最大限割引した御見積書を作成しお送りさせて頂きます！！").kind === "estimate");
t("申込の誘い（押す）", (() => { const r = tsunagiOf("人気のお部屋で埋まってしまう可能性がございますので是非お早めにお申込み頂ければと思います！！"); return r.kind === "apply" && r.strength === "push"; })());
t("物件を送ってもらう誘い", tsunagiOf("気になるお部屋がございましたらURLをお送り頂けましたら確認させて頂きます！！").kind === "ask_send");
t("質問で返事をもらう", tsunagiOf("入居希望日はいつ頃でしょうか？").kind === "question");
t("入れない", tsunagiOf("かしこまりました！！ ありがとうございます😊").kind === "none");
const tt = turnTsunagi(["かしこまりました！！", q439]);
t("番: 2通目に誘い", tt.kind === "viewing" && tt.msg === 2);
t("外れ: 入れていない", tsunagiMiss([q428], "周辺ですと現在こちらのお部屋のみになります！！").miss === "missing");
t("外れ: 位置（竹内さんは2通目）", tsunagiMiss(["かしこまりました！！", q439], "かしこまりました！！").miss === "position");
t("外れ: 種類が違う（q428 で探す約束だけ）", tsunagiMiss([q428.replace("並行して新着で条件に合うお部屋が出次第お送りさせて頂きます！！", "")], q174).miss === "kind");
t("外れ: 入れない所に入れた", tsunagiMiss(["かしこまりました！！"], "よろしければご案内させて頂きます！！").miss === "extra");
t("合う: どちらも入れない", tsunagiMiss(["かしこまりました！！"], "承知致しました！！").miss === "both_none");
t("入れない理由: AIX の後・受けだけ・約束", noneReasonOf({ afterAix: true, scene: "after_aix", purpose: "appeal" }) === "after_aix" && noneReasonOf({ afterAix: false, scene: "ack", purpose: "ack" }) === "ack_only" && noneReasonOf({ afterAix: false, scene: "conditions", purpose: "promise" }) === "promise_is_next");
t("K の aim に写す", kAimOf("viewing") === "viewing_date" && kAimOf("apply") === "apply_hold" && kAimOf("next_contact") === "none");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);

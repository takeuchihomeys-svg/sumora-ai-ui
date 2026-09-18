// app/lib/__tests__/phrase-shape.test.ts
// 実行: npx tsx app/lib/__tests__/phrase-shape.test.ts
import { splitClauses, maskVariables, predicateOf, extractPhraseShapes, isPredicateLike } from "../phrase-shape";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
}

console.log("── 節に切る");
{
  const c = splitClauses("YUMAさんお世話になっております！！\n\n野田阪神周辺から1Kのお部屋、追加でピックアップさせて頂きました！！");
  t("句点・改行・読点で切れる", c.length >= 3, JSON.stringify(c));
  t("短すぎる断片は捨てる", c.every((x) => x.length >= 4), JSON.stringify(c));
}

console.log("── 会話ごとに変わる部分を落とす");
{
  t("お客様名が落ちる", !maskVariables("YUMAさんお世話になっております").includes("YUMA"), maskVariables("YUMAさんお世話になっております"));
  t("数字と単位が落ちる", maskVariables("家賃67,000円・管理費7,000円の1K") === "家賃管理費の", maskVariables("家賃67,000円・管理費7,000円の1K"));
  t("絵文字が落ちる", !/😊/.test(maskVariables("お手隙の際にご査収ください😊")));
  t("ローマ字の物件名が落ちる", !/UMEDA/.test(maskVariables("UMEDA ILAND REIDENCE 302号室")));
  t("括弧の補足が落ちる", maskVariables("洋室8.2帖（エアコン付き）の1K") === "洋室の", maskVariables("洋室8.2帖（エアコン付き）の1K"));
}

console.log("── 述部（言い回しの指紋）を取る");
{
  // 実データで件数が分かっているもの
  t("「お手隙の際にご査収ください」→ ご査収ください を含む",
    (predicateOf("お手隙の際にご査収ください😌") ?? "").includes("ご査収ください"),
    String(predicateOf("お手隙の際にご査収ください😌")));
  t("「重複しないよう選定しております」→ 選定しております を含む",
    (predicateOf("前回お送りさせて頂いた物件とは重複しないよう選定しております") ?? "").includes("選定しております"),
    String(predicateOf("前回お送りさせて頂いた物件とは重複しないよう選定しております")));
  t("「ピックアップさせて頂きました」が取れる",
    (predicateOf("野田阪神周辺全域からYUMAさんにオススメできるお部屋ピックアップさせて頂きました") ?? "").includes("させて頂きました"),
    String(predicateOf("野田阪神周辺全域からYUMAさんにオススメできるお部屋ピックアップさせて頂きました")));
  t("助詞で始まる切り方を避ける",
    !/^(?:て|で|に|を|が|は|の)/.test(predicateOf("お気に召されましたらご都合よろしいお日にちにご案内させて頂きます") ?? ""),
    String(predicateOf("お気に召されましたらご都合よろしいお日にちにご案内させて頂きます")));
  t("短い節はそのまま", predicateOf("かしこまりました") === "かしこまりました");
  t("短すぎる節は null", predicateOf("はい") === null);
}

console.log("── 述部かどうか（固有名詞・物件情報の断片を外す）");
{
  // 2026-09-18 本番の点検でノイズとして出た実例
  t("物件名で終わるものは述部ではない", !isPredicateLike("🌟パークハイツアイリス2号館 307号室"));
  t("駅名で終わるものは述部ではない", !isPredicateLike("・大国町駅徒歩9分"));
  t("物件情報の箇条書きは述部ではない", !isPredicateLike("専有面積31.97㎡）") && !isPredicateLike("モニタ付インターホン"));
  t("「〜ます」は述部", isPredicateLike("お手隙の際にご査収ください！！") && isPredicateLike("ピックアップさせて頂きました！！"));
  t("「〜です」は述部", isPredicateLike("駅徒歩1分の好立地です！！"));
  t("「〜しております」は述部", isPredicateLike("重複しないよう選定しております"));
  t("「〜可能です」は述部", isPredicateLike("15:00〜17:00にてご案内可能です😊"));
}

console.log("── 文から言い回しを取り出す");
{
  const shapes = extractPhraseShapes(
    "YUMAさんお世話になっております！！\n\n野田阪神周辺から追加でオススメできるお部屋をピックアップさせて頂きました！！\n\n前回お送りした物件とは重複しないよう選定しております！！\n\nお手隙の際にご査収ください😌！！",
  );
  t("複数の言い回しが取れる", shapes.length >= 3, JSON.stringify(shapes.map((s) => s.predicate)));
  t("元の節が一緒に残る（人が読んで判断するため）", shapes.every((s) => s.clause.length > 0));
  t("創作の候補（選定しております）が入る",
    shapes.some((s) => s.predicate.includes("選定しております")),
    JSON.stringify(shapes.map((s) => s.predicate)));
  t("定型（ご査収ください）も入る", shapes.some((s) => s.predicate.includes("ご査収ください")));
  const preds = shapes.map((s) => s.predicate);
  t("同じ言い回しは畳まれる", new Set(preds).size === preds.length);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);

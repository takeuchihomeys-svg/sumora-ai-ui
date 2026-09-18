// app/lib/__tests__/selection-claim.test.ts
// 実行: npx tsx app/lib/__tests__/selection-claim.test.ts
import { stripUnfoundedSelectionClaim } from "../selection-claim";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
}

console.log("── 落とす（実送信0件の主張・本番検証で出た実例）");
{
  const a = stripUnfoundedSelectionClaim(
    "YUMAさん\n\n野田阪神周辺全域から1Kのお部屋ピックアップさせて頂きました！！\n\n前回お送りさせて頂いた物件とは重複しないよう選定しております😊！！\n\nお手隙の際にご査収ください😌！！",
  );
  t("「重複しないよう選定しております」の行が消える", !a.text.includes("重複しないよう") && !a.text.includes("選定"), a.text);
  t("他の行は残る", a.text.includes("ピックアップさせて頂きました") && a.text.includes("お手隙の際にご査収"), a.text);
  t("落とした物が記録される", a.removed.length > 0, JSON.stringify(a.removed));

  const b = stripUnfoundedSelectionClaim(
    "前回お送りした物件とは重複しないよう、新着で条件に近いお部屋を中心に選ばせて頂いております！！",
  );
  t("「重複しないよう」を含む節だけ落ちる", !b.text.includes("重複しないよう"), b.text);

  const c = stripUnfoundedSelectionClaim("以前のお部屋と被らないようにお選びしました！！\n\nお手隙の際にご査収ください！！");
  t("「被らないよう」も落ちる", !c.text.includes("被らない"), c.text);
}

console.log("── 落とさない（実送信にある正直な断り 9件）");
{
  const keep = [
    "過去にお送りさせていただいた重複する物件もございますがお手隙の際にご査収ください！！",
    "以前お送りさせていただきましたお部屋と重複するお部屋もございますがお手隙の際にご査収ください😌！！",
    "重複する物件2件ございますがお手隙の際にご査収ください😌！！",
    "以前お送りさせていただいたお部屋と重複しますがお手隙の際にご査収ください😌！！",
  ];
  for (const [i, k] of keep.entries()) {
    const r = stripUnfoundedSelectionClaim(k);
    t(`正直な断りは触らない（${i + 1}）`, r.text === k && r.removed.length === 0, r.text);
  }
}

console.log("── 安全側");
{
  t("空はそのまま", stripUnfoundedSelectionClaim("").text === "");
  const only = stripUnfoundedSelectionClaim("重複しないよう選定しております");
  t("主張だけの文は元のまま（全部消えるなら触らない）", only.text === "重複しないよう選定しております", only.text);
  const normal = "野田阪神周辺全域からYUMAさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！";
  t("普通のピックアップ文は触らない", stripUnfoundedSelectionClaim(normal).text === normal);
  const gensen = "新築で条件に合うお部屋を厳選させて頂きました！！";
  t("「厳選」は実送信にあるので落とさない", stripUnfoundedSelectionClaim(gensen).text === gensen);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);

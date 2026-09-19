// app/lib/__tests__/pii-pseudonym.test.ts
// 2026-09-19 竹内「マスキングする仕組みを作る、個人情報は渡さないようにする、しかし、
//   どこに何がいるか山田太郎 大阪市○○などにすれば何が必要か分かる」
// 実行: npx tsx app/lib/__tests__/pii-pseudonym.test.ts（全 PASS で exit 0）
import { createMasker } from "../pii-pseudonym";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const mk = (o: Partial<Parameters<typeof createMasker>[0]> = {}) =>
  createMasker({ conversationId: "conv-1", thisYear: 2026, ...o });

console.log("── ★ 往復（マスク → 戻す）で一字一句元に戻る");
{
  const samples: Array<[string, string]> = [
    ["ゆうこ", "ゆうこさん、お世話になっております！！\n本日はありがとうございました！！"],
    ["谷 瑞希", "【緊急連絡先欄】\n氏名:谷 瑞希(タニ ミズキ)\n生年月日:1995年(平成7年)3月15日\n現住所:兵庫県西宮市今津曙町1-23-456\n携帯番号:090-1234-5678\n続柄:姉\n勤務先名:兵庫トヨタ自動車株式会社"],
    ["田中", "田中さんのご希望の梅田エリアで、セジュール入江（3階/2LDK/55㎡）が空きました！！\n住所: 大阪府大阪市北区西天満6丁目1-2\n家賃8.2万円・管理費5,000円です！！"],
    ["M", "Mさん、お問い合わせありがとうございます！！お住まいのエリアはどちらでしょうか？"],
    ["𝒮❦", "𝒮❦さん、内覧の件かしこまりました！！9月28日以降でご案内可能です！！"],
  ];
  for (const [name, text] of samples) {
    const m = mk({ customerName: name });
    const masked = m.mask(text);
    const back = m.unmask(masked);
    t(`★ 往復で元に戻る（${name}）`, back === text, `\n  元: ${JSON.stringify(text.slice(0, 60))}\n  戻: ${JSON.stringify(back.slice(0, 60))}`);
  }
}

console.log("── ★ 伏せるもの（竹内「本名や電話番号は絶対にマスキング」）");
{
  const m = mk({ customerName: "谷 瑞希" });
  const out = m.mask("谷 瑞希さん\n携帯番号:090-1234-5678\nメール: mizuki@example.jp\n生年月日:1995年3月15日生\n現住所:兵庫県西宮市今津曙町1-23-456\n勤務先名:兵庫トヨタ自動車株式会社");
  t("★ 本名が消えている", !out.includes("谷 瑞希"));
  t("★ 携帯番号が消えている", !out.includes("090-1234-5678"));
  t("★ メールが消えている", !out.includes("mizuki@example.jp"));
  t("★ 生年月日が消えている", !out.includes("1995年3月15日"));
  t("★ 現住所の番地が消えている", !out.includes("今津曙町1-23-456"));
  t("★ 勤務先が消えている", !out.includes("兵庫トヨタ自動車株式会社"));
  t("★ 市区までは残る（どこに住んでいるかは分かる）", out.includes("兵庫県西宮市"), out);
  t("仮名は普通の名前（記号に潰さない）", /山田太郎|佐藤花子|鈴木一郎|高橋直美|田中健太|伊藤美咲|渡辺大輔|中村七海|小林拓也|加藤陽子|吉田翔太|山本結衣|松本和也|井上彩香|木村涼介/.test(out), out);
}

console.log("── ★ 伏せないもの（竹内「物件情報や探している条件はマスキング不要」）");
{
  const m = mk({ customerName: "田中" });
  const src = "田中さん\nセジュール入江（3階/2LDK/55㎡）\n住所: 大阪府大阪市北区西天満6丁目1-2\n家賃8.2万円 管理費5,000円 築12年 梅田駅徒歩7分\nご希望: 梅田まで30分以内・ペット可・10月中ご入居\n管理会社 06-6210-1234";
  const out = m.mask(src);
  t("★ 物件名はそのまま", out.includes("セジュール入江"));
  t("★ 物件の住所（「住所：」）はそのまま", out.includes("大阪府大阪市北区西天満6丁目1-2"), out);
  t("★ 家賃・間取り・築年数・駅徒歩はそのまま", out.includes("8.2万円") && out.includes("2LDK") && out.includes("築12年") && out.includes("梅田駅徒歩7分"));
  t("★ 希望条件はそのまま", out.includes("ペット可") && out.includes("10月中ご入居") && out.includes("梅田まで30分以内"));
  t("★ 固定電話（管理会社）はそのまま", out.includes("06-6210-1234"), out);
}

console.log("── ★ 日付: 生年月日は伏せる / 入居希望日・入社日は伏せない（実データの監査で見つけた誤爆）");
{
  const m = mk({ customerName: "山中葵" });
  const src = "・入居希望日 2026年11月26日\n・氏名、フリガナ 山中葵 ヤマナカアオイ\n・生年月日 2000年4月30日\n入社日2026年10月1日\n9月28日以降ご内覧可能です！！";
  const out = m.mask(src);
  t("★ 入居希望日はそのまま（条件なので伏せない）", out.includes("2026年11月26日"), out);
  t("★ 入社日もそのまま", out.includes("2026年10月1日"), out);
  t("★ 内覧日（9月28日）はそのまま", out.includes("9月28日"), out);
  t("★ 生年月日は伏せる", !out.includes("2000年4月30日"), out);
  t("★ 往復で元に戻る", m.unmask(out) === src);

  const m2 = mk();
  t("★「◯年◯月◯日生」は伏せる", !m2.mask("平成7年3月15日生").includes("平成7年3月15日"));
  t("★ 昭和・平成の元号つきは伏せる", !m2.mask("昭和60年1月2日").includes("昭和60年1月2日"));
  t("★ 令和は伏せない（交付日・入居日に当たるため）", m2.mask("令和8年10月1日").includes("令和8年10月1日"));
  t("★ 十分に昔の西暦は生年月日とみなす", !m2.mask("1995年3月15日").includes("1995年3月15日"));
}

console.log("── ★ 短い名前で誤爆しない（実測: 1文字の名前は12%が誤爆する形だった）");
{
  const m1 = mk({ customerName: "み" });
  const out1 = m1.mask("みさん、お住まいのエリアはどちらでしょうか？皆さまのご希望を伺います");
  t("★ 1文字の名前: 敬称つきだけ置換する", !out1.startsWith("み"), out1);
  t("★ 1文字の名前: 本文の「お住まい」は壊れない", out1.includes("お住まい"), out1);
  t("★ 1文字の名前: 「皆さま」を巻き込まない", out1.includes("皆さま"), out1);

  const m2 = mk({ customerName: "はる" });
  const out2 = m2.mask("はるさん、はるばるお越し頂きありがとうございます");
  t("★ 2文字の名前: 敬称つきだけ置換する", out2.includes("はるばる"), out2);

  const m3 = mk({ customerName: "山田太郎" });
  const out3 = m3.mask("山田太郎の物件を確認しました");
  t("3文字以上の名前は敬称が無くても置換する", !out3.includes("山田太郎の物件"), out3);
}

console.log("── ★ 事例（他のお客様の会話）の名前も照合して伏せる");
{
  // 一番大きい漏れ口。当事者ではなく他人の名前が毎回8件載る
  const m = mk({ customerName: "田中", knownNames: ["佐々木", "𝒮❦", "ゆうこ"] });
  const out = m.mask("【実例】佐々木さん: 内覧希望です → スモラ: かしこまりました！！\n【実例】ゆうこさん: ありがとうございます");
  t("★ 他のお客様の名前も消えている", !out.includes("佐々木") && !out.includes("ゆうこ"), out);
  t("★ 別の人には別の仮名が割り当たる（戻す時に混ざらない）",
    new Set(m.table().filter((e) => e.kind === "name").map((e) => e.fake)).size === m.table().filter((e) => e.kind === "name").length);
}

console.log("── ★ 仮名は一意・決定論（同じ会話なら毎回同じ＝キャッシュが効く・ログで追える）");
{
  const a = mk({ conversationId: "conv-A", customerName: "田中" }).mask("田中さん");
  const b = mk({ conversationId: "conv-A", customerName: "田中" }).mask("田中さん");
  t("★ 同じ会話なら毎回同じ仮名", a === b, `${a} / ${b}`);
  const m = mk({ customerName: "田中", knownNames: ["佐藤", "鈴木", "高橋"] });
  m.mask("田中さん 佐藤さん 鈴木さん 高橋さん");
  const fakes = m.table().map((e) => e.fake);
  t("★ 仮名は重複しない（重複すると戻せない）", new Set(fakes).size === fakes.length, fakes.join(","));
}

console.log("── ★ 戻し漏れを見つける（fail-closed の材料）");
{
  const m = mk({ customerName: "谷 瑞希" });
  const masked = m.mask("谷 瑞希さん、お世話になっております");
  const fake = m.table().find((e) => e.kind === "name")!.fake;
  t("★ ちゃんと戻れば残りは無い", m.leftovers(m.unmask(masked)).length === 0);
  t("★ 仮名がそのまま残っていたら見つける", m.leftovers(`${fake}さん、ありがとうございます`).length > 0);
  t("★ 姓だけで書かれた時も見つける（LLM は「山田太郎さん」を「山田さん」と書く）",
    m.leftovers(`${fake.slice(0, 2)}さん、ありがとうございます`).length > 0, fake);
  t("実物に戻っていれば何も出ない", m.leftovers("谷 瑞希さん、ありがとうございます").length === 0);
}

console.log("── ★ 壊れない（空・未設定・記号つきの名前）");
{
  t("空文字は空文字", mk().mask("") === "" && mk().unmask("") === "");
  t("null / undefined でも落ちない", mk().mask(null) === "" && mk().unmask(undefined) === "");
  t("名前が未設定でも電話・メールは伏せる", !mk().mask("090-1111-2222 a@b.jp").includes("090-1111-2222"));
  const m = mk({ customerName: "a🤫" });
  const src = "a🤫さん、ありがとうございます！！";
  t("★ 絵文字つきの LINE 名でも往復で戻る", m.unmask(m.mask(src)) === src, m.mask(src));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);

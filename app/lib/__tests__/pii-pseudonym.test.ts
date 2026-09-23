// app/lib/__tests__/pii-pseudonym.test.ts
// 2026-09-19 竹内「マスキングする仕組みを作る、個人情報は渡さないようにする、しかし、
//   どこに何がいるか山田太郎 大阪市○○などにすれば何が必要か分かる」
// 実行: npx tsx app/lib/__tests__/pii-pseudonym.test.ts（全 PASS で exit 0）
import { readFileSync } from "node:fs";
import { createMasker, isApplicationPayload, APPLICATION_FORM_PLACEHOLDER } from "../pii-pseudonym";

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
    // ※ 申込フォームそのもの（氏名＋生年月日＋現住所…が揃う形）は丸ごと落とす対象なので、
    //   往復の見本には「普通の会話の中に個人情報が1〜2個ある」形を使う
    ["谷 瑞希", "谷 瑞希さん、お電話番号は090-1234-5678でお間違いないでしょうか？\nご連絡先メール mizuki@example.jp も承りました！！"],
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
  // 項目が3つ以上そろうと「申込フォーム」として丸ごと落ちるので、1つずつ普通の会話の形で確かめる
  const m = mk({ customerName: "谷 瑞希" });
  const o1 = m.mask("谷 瑞希さん、お電話番号は090-1234-5678でお間違いないでしょうか？ mizuki@example.jp");
  t("★ 本名が消えている", !o1.includes("谷 瑞希"), o1);
  t("★ 携帯番号が消えている", !o1.includes("090-1234-5678"));
  t("★ メールが消えている", !o1.includes("mizuki@example.jp"));
  t("仮名は普通の名前（記号に潰さない）", /山田太郎|佐藤花子|鈴木一郎|高橋直美|田中健太|伊藤美咲|渡辺大輔|中村七海|小林拓也|加藤陽子|吉田翔太|山本結衣|松本和也|井上彩香|木村涼介/.test(o1), o1);

  const o2 = m.mask("生年月日 1995年3月15日生 でよろしいでしょうか？");
  t("★ 生年月日が消えている", !o2.includes("1995年3月15日"), o2);

  const o3 = m.mask("現住所:兵庫県西宮市今津曙町1-23-456 でお間違いないですか？");
  t("★ 現住所の番地が消えている", !o3.includes("今津曙町1-23-456"), o3);
  t("★ 市区までは残る（どこに住んでいるかは分かる）", o3.includes("兵庫県西宮市"), o3);

  const o4 = m.mask("勤務先: 兵庫トヨタ自動車株式会社 とお伺いしました！！");
  t("★ 勤務先が消えている", !o4.includes("兵庫トヨタ自動車株式会社"), o4);
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
  // 項目が3つ以上そろうと申込フォームとして丸ごと落ちるので、ここは条件の話の中に生年月日が1つある形
  const src = "入居希望日 2026年11月26日でご相談です！\n山中葵さんの生年月日 2000年4月30日 で承っております。\n入社日2026年10月1日とのことでした。\n9月28日以降ご内覧可能です！！";
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

console.log("── ★ 申込に関わる個人情報は丸ごと落とす / 物件検索のフォーマットは全部残す");
{
  // 竹内「物件の情報やお客さんが探している物件の情報や要望物件検索のフォーマットはちゃんと全部のこして、
  //   お申込みに関係するお客さんの個人情報は渡らないようにする形」

  // ① 物件検索のフォーマット（うちが送るテンプレートが埋まって返ってきた形）＝ 絶対に残す
  const searchForm = [
    "（ご希望のお部屋探しご条件）",
    "①【ご入居の時期】⇒10月中",
    "②【ご希望の家賃（◯万円〜◯万円）】⇒45000~50000",
    "③【希望の広さ・間取り】⇒1LDK",
    "④【希望築年数】⇒築浅",
    "⑤【ご希望のエリア・駅名】⇒桜川・心斎橋・難波",
    "⑥【ご希望の駅徒歩分数】⇒10分以内",
    "⑦【初期費用の限度額】⇒30万まで",
    "⑧【その他ご要望あれば】⇒ペット可、バストイレ別",
  ].join("\n");
  t("★ 物件検索のフォーマットは落とさない", !isApplicationPayload(searchForm));
  const mS = mk({ customerName: "田中" });
  const outS = mS.mask(searchForm);
  t("★ 条件の中身が全部残る（入居時期・家賃・間取り・築年数・エリア・徒歩・初期費用・要望）",
    outS.includes("10月中") && outS.includes("45000~50000") && outS.includes("1LDK")
    && outS.includes("築浅") && outS.includes("桜川・心斎橋・難波") && outS.includes("10分以内")
    && outS.includes("30万まで") && outS.includes("ペット可、バストイレ別"), outS);
  t("★ 項目のラベルも全部残る", outS.includes("【ご入居の時期】") && outS.includes("【その他ご要望あれば】"));
  t("★ 丸ごと落としていない", mS.droppedCount() === 0);

  // ② 申込フォーム（個人） ＝ 丸ごと落とす
  const applyForm = [
    "・氏名、フリガナ 山中葵 ヤマナカアオイ",
    "・生年月日 2000年4月30日",
    "・現住所 〒554-0000 大阪府大阪市此花区〇〇1-2-3",
    "・住居年数 3年2ヶ月",
    "・勤務先 〇〇株式会社",
    "・年収 380万円",
    "・緊急連絡先 090-1234-5678 続柄:母",
  ].join("\n");
  t("★ 申込フォームは丸ごと落とす対象", isApplicationPayload(applyForm));
  const mA = mk({ customerName: "山中葵" });
  const outA = mA.mask(applyForm);
  t("★ 申込フォームの中身が1つも残らない",
    !outA.includes("山中葵") && !outA.includes("2000年4月30日") && !outA.includes("大阪市此花区")
    && !outA.includes("〇〇株式会社") && !outA.includes("380万円") && !outA.includes("090-1234-5678"), outA);
  t("★ 「受け取った」という事実だけ残る", outA === APPLICATION_FORM_PLACEHOLDER, outA);
  t("★ 落とした数を数えている", mA.droppedCount() === 1);

  // ③ 緊急連絡先欄（実データにあった形）＝ 落とす
  const emergency = "【緊急連絡先欄】\n氏名:谷 瑞希(タニ ミズキ)\n生年月日:1995年3月15日\n現住所:兵庫県西宮市今津曙町1-23-456\n住居年数:3年2ヶ月\n携帯番号:090-1234-5678\n続柄:姉\n勤務先名:兵庫トヨタ自動車株式会社";
  t("★ 緊急連絡先欄も丸ごと落とす", isApplicationPayload(emergency));

  // ④ 法人申込 ＝ 落とす
  t("★ 法人の申込も丸ごと落とす", isApplicationPayload("【法人御契約】\n法人名 株式会社〇〇\n代表者名 〇〇\n代表者生年月日 1980/01/01\n登記住所 大阪市中央区〇〇"));

  // ⑤ 普通の会話は落とさない
  t("普通の会話は落とさない", !isApplicationPayload("内覧希望です！9月28日は空いてますか？"));
  t("物件の話も落とさない", !isApplicationPayload("セジュール入江の2LDK、家賃8.2万円で募集中です！！"));

  // ⑥ 「申込フォーム」という語だけで中身が無い文は落とさない（実データ365日で15件あった誤爆）
  t("★「申込みフォームお送りします」は落とさない（中身が無い）",
    !isApplicationPayload("203号室で大丈夫なら申込みフォームお送りします！！"));
  t("★「入居申込書を送らせて頂きます」も落とさない",
    !isApplicationPayload("かしこまりました！！入居申込書を送らせて頂きます！！"));
  t("★ 語＋項目が2つ以上そろえば落とす",
    isApplicationPayload("入居申込書\n氏名: 〇〇\n生年月日: 1990年1月1日"));
  const mN = mk();
  const notice = "203号室で大丈夫なら申込みフォームお送りします！！";
  t("★ 落とさない文は会話としてそのまま残る", mN.mask(notice) === notice, mN.mask(notice));
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
  // 2026-09-23 YUMA の DeepSeek 実測: 事例の他のお客様を可逆の仮名にすると、モデルが手本の「佐藤花子さんから3親等以内」を写し、
  //   出口で「黒明さん」（別のお客様の実名）に戻った。他のお客様は「〇〇」（戻さない）にする
  t("★ 他のお客様の名前は「〇〇」で、戻さない", out.includes("〇〇さん") && m.table().filter((e) => e.kind === "name" && e.real !== "田中").every((e) => !e.reversible), out);
  const copied = m.unmask("〇〇さんから3親等以内の方で設定をお願い致します");
  t("★ モデルが手本の「〇〇さん」を写しても別のお客様の実名に戻らない", !/佐々木|ゆうこ|𝒮❦/.test(copied), copied);
  t("★ 「〇〇」は戻し漏れに数えない", m.leftovers(copied).length === 0);
}

console.log("── ★ 実物の漏れ（YUMA 2026-09-23・2件目）: 会話名は「【グループ】〇〇様お部屋探し」の形で、手本には姓・名が短く出る");
{
  const m = mk({ customerName: "YUMA", knownNames: ["【グループ】黒明拓也様お部屋探し", "田中 花子"] });
  const out = m.maskBlock("スモラ: 黒明さんから3親等以内の方で設定ください！！\nスモラ: 拓也さん、お世話になっております！！\nスモラ: 花子さんありがとうございます\nスモラ: 黒明拓也様のご契約");
  t("★ 姓だけ・名だけ・空白区切りの名も伏せる", !/黒明|拓也|花子/.test(out), out);
  t("★ 伏せた物は「〇〇」で戻さない", out.includes("〇〇さん") && m.unmask(out) === out, m.unmask(out));
  t("★ 装飾は名前として登録しない（グループ・お部屋探し）", !m.table().some((e) => /グループ|お部屋探し/.test(e.real)));
}

console.log("── ★ 実物の漏れ（YUMA 2026-09-23・3件目）: 希望条件の「顧客名: 登録名さん」は表示名と違い、一覧にも無い");
{
  const m = mk({ customerName: "YUMA", knownNames: ["【グループ】黒明拓也様お部屋探し"], partyAliases: ["田中 花子"] });
  const out = m.maskBlock("【お客様の希望条件（DB登録済み）】\n顧客名: 田中 花子さん\n家賃: 〜55000\nスモラ: 黒明さん、お世話になっております");
  t("★ 登録名（当事者の別名）は仮名になり、素のまま外に出ない", !out.includes("田中 花子") && !out.includes("黒明"), out);
  const fake = m.table().find((e) => e.real === "田中 花子")!;
  t("★ 登録名は可逆（当事者なので戻る）・他人は戻らない", fake.reversible === true && m.unmask(`${fake.fake}さん、〇〇さん`) === "田中 花子さん、〇〇さん");
}

console.log("── ★ 実物の漏れ（YUMA 2026-09-23）: 事例に黒明さん・当事者は YUMA");
{
  const m = mk({ customerName: "YUMA", knownNames: ["黒明", "あっぴ"] });
  const prompt = m.maskBlock("お客様: YUMAさん\n【実例】黒明さん: 緊急連絡先は必要ですか → スモラ: 黒明さんから3親等以内の方で設定ください😌！！");
  t("★ 当事者は仮名・他人は〇〇", !prompt.includes("黒明") && !prompt.includes("YUMA") && prompt.includes("〇〇さんから3親等以内"), prompt);
  const yumaFake = m.table().find((e) => e.real === "YUMA")!.fake;
  const reply = m.unmask(`${yumaFake}さんお世話になっております！！\n緊急連絡先は必須となります！！\n〇〇さんから3親等以内の方で設定をお願い致します`);
  t("★ 戻した本文に黒明が入らない（当事者だけ戻る）", reply.startsWith("YUMAさん") && !reply.includes("黒明"), reply);
}

console.log("── ★ 仮名は一意・決定論（同じ会話なら毎回同じ＝キャッシュが効く・ログで追える）");
{
  const a = mk({ conversationId: "conv-A", customerName: "田中" }).mask("田中さん");
  const b = mk({ conversationId: "conv-A", customerName: "田中" }).mask("田中さん");
  t("★ 同じ会話なら毎回同じ仮名", a === b, `${a} / ${b}`);
  const m = mk({ customerName: "田中", knownNames: ["佐藤", "鈴木", "高橋"] });
  m.mask("田中さん 佐藤さん 鈴木さん 高橋さん");
  const fakes = m.table().filter((e) => e.reversible).map((e) => e.fake);
  t("★ 可逆の仮名は重複しない（重複すると戻せない）", new Set(fakes).size === fakes.length, fakes.join(","));
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

console.log("── ★ AIX に実際に配線されているか（消えても型が通る箇所なので実ファイルで照合）");
{
  const aix = readFileSync("app/api/aix/action/route.ts", "utf8");
  t("★ 送る前に読み替えている（user と 動的 system の両方）",
    (aix.match(/maskOut\(/g) ?? []).length >= 4,
    "callClaude / callClaudeHaiku の user・dynamicSuffix の4か所");
  t("★ 返ってきた文を実名に戻している",
    (aix.match(/unmaskIn\(/g) ?? []).length >= 2);
  t("★ 戻し切れなかったら例外にしている（お客様に仮名で送らない＝fail-closed）",
    /leftovers\(back\)/.test(aix) && /throw new Error\("生成文の伏せ字を元に戻せませんでした/.test(aix));
  t("★ 申込以降の印を付けている",
    /store\?\.postApply\)\s*h\[LLM_POST_APPLY_HEADER\]\s*=\s*"1"/.test(aix));
  t("★ 回る時だけ読み替え器を作る（Claude へ行く時は素通し）",
    /if \(!willRouteAlt\(action, \{ postApply: ctx\.postApply \}\)\) return;/.test(aix),
    "常にマスクすると今までの品質が全経路で一度に変わる");
  t("★ 判定に失敗したら回さない側へ倒す（fail-closed）",
    /ctx\.postApply = true;\s*\n\s*ctx\.masker = null;/.test(aix));
  t("★ 事例の他人の名前も照合対象にしている（当事者だけでは足りない）",
    /knownNames:\s*await loadKnownCustomerNames\(\)/.test(aix));
  t("★ 画像つきの呼び出しは素通し（対象外なので読み替えない）",
    /callClaudeVision[\s\S]{0,400}?dynamicSuffix: dynamicSystemSuffix/.test(aix));
  t("★ 名前の正解集合は AIX と返信生成で同じ物を使う（同じ事実を2か所に置かない）",
    /loadKnownCustomerNames\(\)/.test(aix));
}

console.log("── ★ 返信文の生成にも配線されているか（竹内「返信の部分も deepseek に切り替えよかな」）");
{
  const gen = readFileSync("app/api/generate-reply/route.ts", "utf8");
  t("★ 回る時だけ読み替え器を作る（Claude へ行く時は素通し）",
    /willRouteAlt\("reply_generate", \{[\s\S]{0,120}?postApply: postApplyConversation, autoSend: autoSendConversation/.test(gen));
  t("★ キャッシュの印が無いブロックだけ読み替える（前置きを壊さない）",
    /if \(b\.cache_control\) return b;/.test(gen) && /maskUncachedBlocks\(messages, replyMasker\)/.test(gen));
  t("★ 生成文を実名に戻している（後処理より先）", /replyMasker\.unmask\(fullText\)/.test(gen));
  t("★ 戻し切れなければその下書きを使わない（fail-closed）",
    /gen:unmask-leftover/.test(gen) && /throw new Error\("生成文の伏せ字を元に戻せませんでした/.test(gen));
  t("★ 修正ループ（再生成）にも同じ読み替えを通す（1回目だけ伏せても2回目で実名が出る）",
    /\.\.\.genMessages,\s*\n\s*new AIMessage\(replyMasker \? replyMasker\.maskBlock\(draftBody\)/.test(gen));
  t("★ 申込以降は印を付けて回さない（竹内「申込以降はいれない」）",
    /postApplyConversation \? \{ \[LLM_POST_APPLY_HEADER\]: "1" \}/.test(gen)
    // 2026-09-23: 判定は status だけでなく記録（申込へ押下・本人確認書類・戻し）を見る post-apply.ts に移した
    && /loadPostApplyFacts\(supabase, conversationId\)/.test(gen) && /postApplyConversation = r\.postApply/.test(gen));
  t("★ 状態が読めない時は「回さない」側へ倒す（fail-closed）",
    /\/\/ 読めなければ自動返信は false[\s\S]{0,120}?postApplyConversation = true;/.test(gen));
}

// ─── 2026-09-22 みなみさん事例: 材料の塊を丸ごと差し替えない（maskBlock）───────────────
{
  console.log("\n--- 材料の塊（maskBlock）---");
  const m = createMasker({ conversationId: "minami", customerName: "みなみ" });
  // ルール・手本の文に項目名が並んでいる塊（旧: mask だとこの塊全体が「申込情報を受け取りました」の1行に差し替わった）
  const rulesBlock = [
    "【申込の流れ】申込書の記入項目（氏名・生年月日・現住所・緊急連絡先・勤務先・保証人）はAIX【申込へ】で送る",
    "【🔁 往復文脈】直前: こちらの確認の約束 ／ お客様: 了承だけ",
    "スモラ: かしこまりました！！\n確認させて頂きます😊！！",
    "お客様: お願いします🤭",
  ].join("\n");
  const outRules = m.maskBlock(rulesBlock);
  t("★ 旧処理（mask）なら塊ごと差し替わる形（再現）", m.mask(rulesBlock) === APPLICATION_FORM_PLACEHOLDER);
  t("★ maskBlock は塊を残す（会話・往復文脈・ルールが LLM に届く）", outRules.includes("お客様: お願いします🤭") && outRules.includes("【🔁 往復文脈】") && !outRules.includes(APPLICATION_FORM_PLACEHOLDER), outRules.slice(0, 120));
  // 会話履歴の中のお客様の記入済み申込フォームは、その1通だけ置き換える
  const histBlock = [
    "スモラ: こちらお申込に必要なご情報となります😊！！\n【お申込者様記入欄】\n・氏名、フリガナ\n・生年月日\n・現住所\n・勤務先",
    "お客様: 【お申込者様記入欄】\n・氏名、フリガナ 中村七海 ナカムラナナミ\n・生年月日 1995年5月5日\n・現住所 大阪市西区北堀江1-2-3\n・勤務先 株式会社サンプル",
    "スモラ: お送り頂きありがとうございます😊！！",
  ].join("\n");
  const outHist = m.maskBlock(histBlock);
  t("★ お客様の記入済みフォームの1通だけ置き換わる", outHist.includes(`お客様: ${APPLICATION_FORM_PLACEHOLDER}`) && !outHist.includes("中村七海") && !outHist.includes("北堀江1-2-3"), outHist);
  t("★ こちらが送った空欄のフォーマットと、その後のこちらの発言は残る", outHist.includes("スモラ: こちらお申込に必要なご情報となります") && outHist.includes("スモラ: お送り頂きありがとうございます"), outHist);
  t("★ 置き換えの文は「こちらが受け取りました」と述べない（LLM が写して『お申込み情報のご連絡ありがとうございます』と書いた）", !/受け取りました|ありがとう/.test(APPLICATION_FORM_PLACEHOLDER));
}
console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);

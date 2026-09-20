// app/lib/__tests__/estimate-cover.test.ts
// 実行: npx tsx app/lib/__tests__/estimate-cover.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内（H さん事例）の検証中に見つけた2つ目の崩れ。
// 材料は**本番の実物**（本番で出た混入と、実送信365日の835通から読んだ形）。
import { stripEstimateAmountBlock, isEstimateAmountLine, fixNamePlaceholder, sanitizeCoverLetter } from "../estimate-cover";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`\nexpected:\n${String(exp)}\ngot:\n${String(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が入っている`); },
  };
}

console.log("\n── ★ 本番で出た混入（別の物件の金額文が2通目に入った）──");

// 2026-09-20 ハイツカトレア B 202号室で【見積書送る】を通した時に出た実物
const LEAKED = `YUMAさんご連絡頂きありがとうございます😊！！

ご指定いただいたお部屋につきまして募集状況を確認させて頂きました。

**【プレサンス阿倍野松崎805号室】**

初期費用さらに
🌟68,000円割引させて頂き
初期費用：152,000円

※ご入居日によって日割家賃が発生致します。

こちらのお部屋は現在空室となっており、すぐにご内覧のお手配も可能です！！お気に召されましたらお申込みでお部屋押さえさせて頂きます！！ご確認よろしくお願いします！！`;

it("★ 別の物件の金額ブロックが丸ごと落ちる", () => {
  const { text, removed } = stripEstimateAmountBlock(LEAKED);
  expect(text).notToContain("プレサンス阿倍野松崎");
  expect(text).notToContain("68,000円割引");
  expect(text).notToContain("152,000円");
  expect(text).notToContain("初期費用さらに");
  expect(text).notToContain("日割家賃");
  expect(removed.length).toBe(5);
});

it("★ カバーレターの本文（お客様への言葉）は残る", () => {
  const { text } = stripEstimateAmountBlock(LEAKED);
  expect(text).toContain("YUMAさんご連絡頂きありがとうございます");
  expect(text).toContain("募集状況を確認させて頂きました");
  expect(text).toContain("すぐにご内覧のお手配も可能です");
  expect(text).toContain("ご確認よろしくお願いします！！");
});

it("★ 落とした後に3行以上の空行が残らない", () => {
  expect(stripEstimateAmountBlock(LEAKED).text).notToContain("\n\n\n");
});

console.log("\n── 実送信の形は落とさない（誤削除0の線）──");

// 実送信 2026-09-06: 文の中で金額を数えている（行まるごとが金額文ではない）
const IN_SENTENCE = `お待たせ致しました！！

リーダースパーク21 202号室最大限割引しました初期費用の御見積書となります！！

初期費用74,250円・ギガ賃貸なら一般的な不動産業者より65,600円節約出来ますので、名無しの権兵衛さんの初期費用8万円以内のご希望にも合うお部屋となります！！

なおご入居日によって日割家賃が別途発生致しますのでご了承ください！！

名無しの権兵衛さんお気に召されましたらお申込みしお部屋抑えさせて頂きます！！
お手隙の際にご査収ください😌！！`;

it("文の中で金額に触れている形は1行も落とさない（実送信 2026-09-06）", () => {
  const { text, removed } = stripEstimateAmountBlock(IN_SENTENCE);
  expect(removed.length).toBe(0);
  expect(text).toBe(IN_SENTENCE);
});

it("「合計で139,000円割引させて頂きます！！」は残る（🌟が無い・実送信 2026-08-10）", () => {
  const t = "SHIGIさんお待たせ致しました！！\n弊社代表から割引の承認がおりました！！\nこちら最終の最大限割引しました初期費用の御見積書となり合計で139,000円割引させて頂きます！！";
  expect(stripEstimateAmountBlock(t).removed.length).toBe(0);
});

it("物件名が【】無しで文中にある形は残る（実送信の主流）", () => {
  const t = "ゆーたさん確認させていただきました！！\nエイペックス神戸みなと元町CoastLine 704号室現在募集中となります！！\n初期費用御見積書同封させて頂きました！！";
  expect(stripEstimateAmountBlock(t).removed.length).toBe(0);
});

it("「初期費用御見積書同封させて頂きました」を消さない", () => {
  expect(isEstimateAmountLine("最大限割引しました初期費用御見積書同封させて頂きました。")).toBe(false);
});

console.log("\n── 1行ずつの判定 ──");

it("落とす形", () => {
  for (const l of [
    "初期費用さらに",
    "🌟68,000円割引させて頂き",
    "🌟100,000円割引させていただき",
    "初期費用：152,000円",
    "初期費用 ： 152,000円",
    "スモラなら一般的な不動産業者より61,910円節約出来ます！！",
    "ギガ賃貸なら一般的な不動産業者より205,900円節約出来ます！！",
  ]) if (!isEstimateAmountLine(l)) throw new Error(`落ちない: ${l}`);
});

it("★ 日割の注記は単独では落とさない（実送信の物件オススメ文・2026-08-22）", () => {
  const rec = "🌟SOAR SHINIMAMIYA 703\n\n（オススメポイント）\n・家賃72,500円・管理費6,000円（合計78,500円）\n・礼金御座いますがスモ割で初期費用20万円以内に収まります！！\n※ご入居日によって日割家賃が発生致します";
  expect(stripEstimateAmountBlock(rec).removed.length).toBe(0);
});

it("金額行と一緒にある時だけ日割の注記も落ちる（1通目と重複するため）", () => {
  const t = "ご案内です\n\n初期費用：152,000円\n\n※ご入居日によって日割家賃が発生致します。\n\nよろしくお願いします！！";
  expect(stripEstimateAmountBlock(t).text).toBe("ご案内です\n\nよろしくお願いします！！");
});

it("落とさない形（お客様への言葉・文中の金額）", () => {
  for (const l of [
    "YUMAさんご連絡頂きありがとうございます😊！！",
    "お手隙の際にご査収ください😌！！",
    "初期費用74,250円・ギガ賃貸なら一般的な不動産業者より65,600円節約出来ますので、ご希望にも合うお部屋となります！！",
    "こちら最終の最大限割引しました初期費用の御見積書となり合計で139,000円割引させて頂きます！！",
    "リーダースパーク21 202号室最大限割引しました初期費用の御見積書となります！！",
    "なおご入居日によって日割家賃が別途発生致しますのでご了承ください！！",
    "初期費用を最大限割引させて頂きました🌟",
    "【物件名 号室】の書き方についてご説明します",   // 【】の後ろに文が続く
    "こちらのお部屋は現在空室となっており、すぐにご内覧のお手配も可能です！！",
    // ★【…】だけの行は単独では落とさない（実送信835通で2通の誤削除が出たので線を引き直した）
    "【プレサンス阿倍野松崎805号室】",
    "**【ハイツカトレア B 202号室】**",
    "①【ジーメゾン石津町東プリシェ 102号室】",
    "④【希望築年数】",
  ]) if (isEstimateAmountLine(l)) throw new Error(`落としてはいけない: ${l}`);
});

console.log("\n── ★ 本番で出た変形（箇条書きに合体・〇でマスク）──");

it("★ 箇条書きに合体した形が落ちる（本番 2026-09-20）", () => {
  for (const l of [
    "・初期費用さらに🌟36,000円割引させて頂き",
    "・家賃：60,000円".replace("家賃", "初期費用"),   // 「・初期費用：60,000円」
    "- 初期費用：152,000円",
  ]) if (!isEstimateAmountLine(l)) throw new Error(`落ちない: ${l}`);
});

it("★ 〇でマスクされた形が落ちる（手本の金額を伏せた形を写していた・本番 2026-09-20）", () => {
  for (const l of [
    "🌟〇〇〇,〇〇〇円割引させて頂き",
    "初期費用：〇〇〇,〇〇〇円",
    "スモラなら一般的な不動産業者より〇〇〇,〇〇〇円節約出来ます！！",
  ]) if (!isEstimateAmountLine(l)) throw new Error(`落ちない: ${l}`);
});

it("★ 〇のまま残さない（お客様に送っても意味が無い）", () => {
  const t = "YUMAさんご連絡頂きありがとうございます😊！！\n\n🌟〇〇〇,〇〇〇円割引させて頂き\n初期費用：〇〇〇,〇〇〇円\n\nスモラなら一般的な不動産業者より〇〇〇,〇〇〇円節約出来ます！！\n\nご確認よろしくお願いします！！";
  const { text } = stripEstimateAmountBlock(t);
  expect(text).notToContain("〇");
  expect(text).toContain("ご確認よろしくお願いします！！");
});

it("家賃の箇条書き（金額文ではない）は残る", () => {
  expect(isEstimateAmountLine("・家賃：60,000円")).toBe(false);
  expect(isEstimateAmountLine("・家賃72,500円・管理費6,000円（合計78,500円）")).toBe(false);
});

console.log("\n── ★ 【物件名】は「直後が金額行」の時だけ落とす（誤削除0の線）──");

it("★ 条件ヒアリングフォームの項目を消さない（実送信 2026-06-28）", () => {
  const form = "（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒\n②【ご希望の家賃（◯万円〜◯万円）】⇒\n③【希望の広さ・間取り】⇒\n④【希望築年数】\n⑤【ご希望のエリア・駅名】⇒\n⑦【初期費用の限度額】⇒";
  expect(stripEstimateAmountBlock(form).removed.length).toBe(0);
});

it("★ スタッフが物件名を見出しにして書いた本物の文を消さない（実送信 2026-07-09）", () => {
  const t = "大野さんお世話になっております！！\n\n【エスティメゾン南堀江 1103号室】\n\n最大限割引した初期費用のお見積書作成しお送りさせて頂きます😊！！\n\nお手隙の際にご査収ください！！";
  const { text, removed } = stripEstimateAmountBlock(t);
  expect(removed.length).toBe(0);
  expect(text).toContain("【エスティメゾン南堀江 1103号室】");
});

it("金額行が続く【物件名】だけ落ちる（本番の混入）", () => {
  const t = "ご案内です\n\n【プレサンス阿倍野松崎805号室】\n\n初期費用さらに\n🌟68,000円割引させて頂き\n初期費用：152,000円\n\nよろしくお願いします！！";
  const { text } = stripEstimateAmountBlock(t);
  expect(text).toBe("ご案内です\n\nよろしくお願いします！！");
});

console.log("\n── ★「○○さん」をそのまま送らない（実送信365日で0件・本番 2026-09-20 で出た）──");

it("★ 名前が分かっていれば名前に置き換える", () => {
  const { text, fixed } = fixNamePlaceholder("○○さんお世話になっております😊\nご連絡いただきありがとうございます！！", "YUMA");
  expect(text).toBe("YUMAさんお世話になっております😊\nご連絡いただきありがとうございます！！");
  expect(fixed).toBe(1);
});

// 2026-09-20 本番で「YUMAさんさん」「YUMAさん様」が出た（最初の実装の誤り）。
//   route.ts が渡すのは `${familyName}さん` か「お客様」＝**既に敬称付き**。
it("★ 敬称付きの名前を渡されても二重にしない（本番で出た誤り）", () => {
  expect(fixNamePlaceholder("○○さんお世話になっております", "YUMAさん").text).toBe("YUMAさんお世話になっております");
  expect(fixNamePlaceholder("○○様のご希望に合うお部屋", "YUMAさん").text).toBe("YUMA様のご希望に合うお部屋");
  expect(fixNamePlaceholder("〇〇さんのご条件", "前田様").text).toBe("前田さんのご条件");
});

it("★「お客様」を渡されたら「お客様さん」にしない", () => {
  expect(fixNamePlaceholder("○○さんお世話になっております", "お客様").text).toBe("お客様お世話になっております");
  expect(fixNamePlaceholder("○○様のご希望", "お客様").text).toBe("お客様のご希望");
});

it("ナレッジに入っている手本の形（3種類の丸・様）も直す", () => {
  expect(fixNamePlaceholder("○○さんお気に召されましたらお部屋ご案内させて頂きます😊", "まりあ").text).toContain("まりあさんお気に召され");
  expect(fixNamePlaceholder("〇〇様のご希望条件で物件探させていただきます！", "前田").text).toContain("前田様のご希望条件");
  expect(fixNamePlaceholder("◯◯さんのご条件に合ったお部屋", "H").text).toContain("Hさんのご条件");
});

it("名前が分からない時は呼びかけごと外す（文は壊さない）", () => {
  const { text } = fixNamePlaceholder("○○さんお気に召されましたらお部屋ご案内させて頂きます😊", "");
  expect(text).toBe("お気に召されましたらお部屋ご案内させて頂きます😊");
  expect(text).notToContain("○○");
});

it("★ 時刻のプレースホルダ（○月○日 ○○:○○）には当てない", () => {
  const t = "○月○日（曜日）○○:○○、[物件名]にてお待ちしております";
  expect(fixNamePlaceholder(t, "YUMA").fixed).toBe(0);
  expect(fixNamePlaceholder(t, "YUMA").text).toBe(t);
});

it("○○が無い文は一切触らない", () => {
  const t = "YUMAさんご連絡頂きありがとうございます😊！！\nお手隙の際にご査収ください😌！！";
  expect(fixNamePlaceholder(t, "YUMA").fixed).toBe(0);
  expect(fixNamePlaceholder(t, "YUMA").text).toBe(t);
});

console.log("\n── 壊れない ──");

it("空・空白・金額文だけの時に落ちない", () => {
  expect(stripEstimateAmountBlock("").text).toBe("");
  expect(stripEstimateAmountBlock("   ").removed.length).toBe(0);
  // 全部が金額文なら空になる（カバーレターとして送る物が無い＝呼び出し側が空を扱う）
  expect(stripEstimateAmountBlock("【A 101号室】\n初期費用：100,000円").text).toBe("");
  // 【】だけで終わる文（直後に何も無い）は落とさない
  expect(stripEstimateAmountBlock("ご案内です\n\n【A 101号室】").removed.length).toBe(0);
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }

console.log("\n── ★ 本番14パターンで出た2通目の欠陥（実送信365日で全部0通）──");

it("★【お客様に送る文】の見出しを外して本文は残す（本番 F）", () => {
  const { text, removed } = sanitizeCoverLetter("【お客様に送る文】\nYUMAさんお世話になっております！！\n最大限割引しました初期費用御見積書をお送りさせて頂きました😊！！", "YUMAさん");
  expect(text).toBe("YUMAさんお世話になっております！！\n最大限割引しました初期費用御見積書をお送りさせて頂きました😊！！");
  expect(removed.length).toBe(1);
});

it("★ 同じ行に本文が続く見出しは、見出しだけ外す（本番 H）", () => {
  const { text } = sanitizeCoverLetter("【お客様の現在の状況（状態）】お申込み情報を受け取りました", "YUMAさん");
  expect(text).toBe("お申込み情報を受け取りました");
});

it("★【お客様名】さん は名前に置き換える（外すと文が壊れる・本番 N）", () => {
  const { text } = sanitizeCoverLetter("【お客様名】さんお世話になっております！！", "YUMAさん");
  expect(text).toBe("YUMAさんお世話になっております！！");
});

it("★ 会社名の名乗りだけ落として挨拶は残す（本番 L）", () => {
  expect(sanitizeCoverLetter("お世話になっております。ギガ賃貸です。", "YUMAさん").text).toBe("お世話になっております。");
  expect(sanitizeCoverLetter("スモラでございます😊\nご連絡ありがとうございます！！", "YUMAさん").text).toContain("ご連絡ありがとうございます！！");
});

it("★ 先頭がスタッフ名なら顧客名に直す（本番 J・K／実送信0通）", () => {
  const { text, fixed } = sanitizeCoverLetter("鈴木さんお世話になっております😊\nお申込み情報受け取りました！", "YUMAさん");
  expect(text).toContain("YUMAさんお世話になっております");
  expect(text).notToContain("鈴木さん");
  expect(fixed.length).toBe(1);
});

it("顧客名と同じなら触らない", () => {
  expect(sanitizeCoverLetter("YUMAさんお世話になっております😊", "YUMAさん").fixed.length).toBe(0);
  expect(sanitizeCoverLetter("前田様お世話になっております", "前田さん").text).toBe("前田様お世話になっております");
});

it("★「皆さん」「奥様」のような一般語は名前として扱わない", () => {
  expect(sanitizeCoverLetter("皆さんお揃いでのご内覧も可能です！！", "YUMAさん").fixed.length).toBe(0);
  expect(sanitizeCoverLetter("お客様お世話になっております", "YUMAさん").fixed.length).toBe(0);
});

it("★ 短すぎる壊れた出力は2通目を送らない（本番 D の「〈」）", () => {
  expect(sanitizeCoverLetter("〈", "YUMAさん").text).toBe("");
  expect(sanitizeCoverLetter("。", "YUMAさん").text).toBe("");
  expect(sanitizeCoverLetter("", "YUMAさん").text).toBe("");
  // 4文字以上は残す
  expect(sanitizeCoverLetter("承知致しました", "YUMAさん").text).toBe("承知致しました");
});

it("★ 本物のカバーレター（実送信の形）は1文字も変えない", () => {
  // 宛先の名前も実物に合わせる（route.ts が渡すのは `${familyName}さん`）
  for (const [t, who] of [
    ["YUMAさんお待たせ致しました！！\nスプランディッド大阪EAST 603号室最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！", "YUMAさん"],
    ["ゆーたさん確認させていただきました！！\nエイペックス神戸みなと元町CoastLine 704号室現在募集中となります！！\n初期費用御見積書同封させて頂きました！！", "ゆーたさん"],
    ["こちらのお部屋スモ割が適用出来ないお部屋となっており、お送りさせていただきました初期費用お見積書がご案内できる最安値のお見積書となります😌！！", "Hinaさん"],
  ] as const) {
    const r = sanitizeCoverLetter(t, who);
    if (r.removed.length || r.fixed.length) throw new Error(`触ってしまった: ${r.removed.join("/")} ${r.fixed.join("/")}`);
    expect(r.text).toBe(t);
  }
});

// ★ 呼び名が分からない時（route.ts は「お客様」を渡す）に正当な呼びかけを壊さない
it("★「お客様」を渡された時は先頭の呼びかけを書き換えない（「お客さん」にしない）", () => {
  const t = "ゆーたさん確認させていただきました！！\n初期費用御見積書同封させて頂きました！！";
  const r = sanitizeCoverLetter(t, "お客様");
  expect(r.fixed.length).toBe(0);
  expect(r.text).toBe(t);
  expect(r.text).notToContain("お客さん");
});

it("★ 金額ブロックと見出しが同時にあっても本文は残る（本番の混入の全部入り）", () => {
  const t = "【お客様に送る文】\nYUMAさんご連絡頂きありがとうございます😊！！\n\n**【プレサンス阿倍野松崎805号室】**\n\n初期費用さらに\n🌟68,000円割引させて頂き\n初期費用：152,000円\n\n※ご入居日によって日割家賃が発生致します。\n\nご確認よろしくお願いします！！";
  const { text } = sanitizeCoverLetter(t, "YUMAさん");
  expect(text).toBe("YUMAさんご連絡頂きありがとうございます😊！！\n\nご確認よろしくお願いします！！");
});


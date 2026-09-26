// 2026-09-12 竹内（あや事例）: AI の作業メモは下書き欄に絶対に入れない
// 実行: npx tsx app/lib/__tests__/meta-narration.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { readFileSync } from "node:fs";
import { stripMetaNarration, isMetaNarrationLine, isNotACustomerReply } from "../meta-narration";
import { applySurfaceFixes } from "../validate-reply";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const AYA_DRAFT = "「284,500円になる感じですか？」という金額確認質問への直接回答を組み立てます。\n\nかしこまりました！！\n最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！";

it("あや: 先頭の作業メモ「〜への直接回答を組み立てます。」を消す", () => {
  const r = stripMetaNarration(AYA_DRAFT);
  expect(r.text).toBe("かしこまりました！！\n最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！");
  expect(r.removed.length).toBe(1);
});
// 2026-09-23 YUMA の DeepSeek 実測（実物）: システムの印【…】の中の絵文字で「お客様向け」と誤認され、作業メモが残った
it("実物: 「「〜」への返信です。会話履歴（【🏢】ブロック）にある…疑問に直接答えます。」＋「---」を消す", () => {
  const r = stripMetaNarration("「緊急連絡先は必ず必要ですか？」への返信です。会話履歴（【🏢】ブロック）にある会社の確定事実に基づき、疑問に直接答えます。\n\n---\n\n緊急連絡先は必須となります！！\n\nYUMAさんから3親等以内の方（ご両親・ご兄弟など）でご設定ください😊！！");
  expect(r.text).toBe("緊急連絡先は必須となります！！\n\nYUMAさんから3親等以内の方（ご両親・ご兄弟など）でご設定ください😊！！");
});
it("実物: 「【✅ 確認対象（決定論）】と【🔗 写真/URL要求検出】を踏まえ、…一言のみで返します。」を消す", () => {
  const r = stripMetaNarration("【✅ 確認対象（決定論）】と【🔗 写真/URL要求検出】を踏まえ、室内写真の要求には受付・確認の一言のみで返します。\n\nYUMAさん\nお世話になっております！！\n\nこちらのお部屋の室内写真確認させて頂きます！！");
  expect(r.text).toBe("YUMAさん\nお世話になっております！！\n\nこちらのお部屋の室内写真確認させて頂きます！！");
});
it("印つきでもお客様への文（！！・させて頂き）は残る", () => {
  const t = "【🌟コンフォートマンション】\n家賃を抑えられるお部屋ご案内させて頂きます！！";
  expect(stripMetaNarration(t).text).toBe(t);
});
it("過去に送られた作業メモ「シミズリルナさんへの返信案：」を消す", () => {
  expect(stripMetaNarration("シミズリルナさんへの返信案：\n\nシミズリルナさんお世話になっております！！").text).toBe("シミズリルナさんお世話になっております！！");
});
it("過去に送られた作業メモ「…親切に対応する返信を作成します。」を消す", () => {
  expect(isMetaNarrationLine("TikTokのリンク送信が続いているため、お客様の意図を確認しながら、親切に対応する返信を作成します。")).toBe(true);
});
it("見出しと本文が同じ行「修正後：〇〇さんお世話に…」→ 見出しだけ外す", () => {
  expect(stripMetaNarration("修正後：あやさんお世話になっております！！").text).toBe("あやさんお世話になっております！！");
});
it("お客様への問いかけ「「明日行けます」というお返事が、どのご質問に対するお返事なのか…」は消さない", () => {
  const t = "申し訳ございません、シミズリルナさんの「明日行けます」というお返事が、どのご質問に対するお返事なのかがちょっと理解できなくて申し訳ないです";
  expect(stripMetaNarration(t).text).toBe(t);
});
it("お客様への宣言「御見積書を作成しお送りさせて頂きます！！」は消さない", () => {
  expect(isMetaNarrationLine("最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！")).toBe(false);
});
it("「ご質問への回答をまとめさせて頂きます！！」（お客様への文）は消さない", () => {
  expect(isMetaNarrationLine("ご質問への回答をまとめさせて頂きます！！")).toBe(false);
});
it("YUMA 9/15「お客様がスタンプのみで返信されている状況ですね。…待つ姿勢のみを示します。」を消す", () => {
  const t = "お客様がスタンプのみで返信されている状況ですね。電話をかけてほしいという依頼を既に伝えているため、追加の催促にならないよう、短く待つ姿勢のみを示します。\n\nはい😊！！\nお電話お待ちしております！！";
  expect(stripMetaNarration(t).text).toBe("はい😊！！\nお電話お待ちしております！！");
});
it("方針の独り言「〜の方針で返信します。」だけの行を消す／お客様への文は消さない", () => {
  expect(isMetaNarrationLine("前向きな反応のため、内覧のご案内を添える方針で返信します。")).toBe(true);
  expect(isMetaNarrationLine("お客様のご都合に合わせてご案内させて頂きます！！")).toBe(false);
});
// 形で見分ける（AI 下書き180日の実際の作業メモ・言い回しの一覧に無い物）
const REAL_NARRATIONS = [
  "物件資料を確認します。",
  "まず物件情報を確認します。",
  "いくつか確認してから出力します。",
  "確認事項がいくつかあります。出力前に整理します。",
  "35万円の物件については、募集状況を確認する旨のみ伝え、断言はしないパターンで返信します。",
  "会社所在地の情報を持ち合わせていないため、正直に確認する形で対応します。",
  "分割払いの可否について、正確な回答が必要な質問です。",
  "クリーニング代の質問には物件固有の確認が必要な事項として即答せず、確認宣言で対応します。",
  "お客様名は「Nakayama」、送られてきた物件は1件と特定しました。",
  "「ここは誰か住んでましたか？」への回答が抜けているため、その点を踏まえます。",
];
for (const n of REAL_NARRATIONS) {
  it(`先頭の作業メモ「${n.slice(0, 24)}…」を落とす`, () => {
    expect(stripMetaNarration(`${n}\n\nかしこまりました！！\nお調べさせて頂きます😊！！`).text).toBe("かしこまりました！！\nお調べさせて頂きます😊！！");
  });
}
it("作業メモ＋「---」の区切り → 区切りごと落とす", () => {
  expect(stripMetaNarration("まず物件資料を確認します。\n\n---\n\nこちらのお部屋募集中となります！！").text).toBe("こちらのお部屋募集中となります！！");
});
// スタッフの実送信の先頭行（誤って消さない）
const STAFF_FIRST_LINES = [
  "住所は住民票記載の住所となります。",
  "こちら外観と室内の写真掲載されております。",
  "かしこまりました。",
  "承知しました。",
  "駅近のお部屋で本日ご案内可能なお部屋現在募集中では無い状況となります。",
  "管理会社定休日となり洋室にエアコンが設置可能か確認が取れませんでした。",
  "はい。",
];
for (const s of STAFF_FIRST_LINES) {
  it(`スタッフの先頭行「${s.slice(0, 20)}」は消さない`, () => {
    const t = `${s}\n\n何卒よろしくお願い致します！！`;
    expect(stripMetaNarration(t).text).toBe(t);
  });
}
it("全部が地の文なら触らない（空の下書きにしない）", () => {
  expect(stripMetaNarration("物件資料を確認します。").text).toBe("物件資料を確認します。");
});
it("仕上げ処理（applySurfaceFixes）でも消える", () => {
  const r = applySurfaceFixes(AYA_DRAFT, { customerName: "あや" });
  expect(r.text.startsWith("かしこまりました！！")).toBe(true);
  expect(r.applied.some((a) => a.startsWith("META_NARRATION_REMOVED"))).toBe(true);
});

// 2026-09-18 本番検証: 見積書のカバーレター（Haiku）が Markdown の見出しを付けて返した
it("Markdown の見出し行（# 〇〇さんへの見積書送付メッセージ）を落とす", () => {
  const r = stripMetaNarration("# YUMAさんへの見積書送付メッセージ\n\nYUMAさんお世話になっております😊！！\n御見積書を作成させて頂きました！！");
  expect(r.text).toBe("YUMAさんお世話になっております😊！！\n御見積書を作成させて頂きました！！");
  expect(r.removed.length).toBe(1);
});
it("## でも ### でも落とす", () => {
  expect(stripMetaNarration("## 返信文\n\nかしこまりました！！").text).toBe("かしこまりました！！");
  expect(stripMetaNarration("### お客様への文面\n\nはい！！").text).toBe("はい！！");
});
it("本文の「#」は落とさない（見出しらしい語で終わらない行）", () => {
  const body = "お部屋 # 302号室のご案内です！！";
  expect(stripMetaNarration(body).text).toBe(body);
  const hash = "#スモラ";
  expect(stripMetaNarration(hash).text).toBe(hash);
});

// 2026-09-19 竹内「本来でない文がなぜ出たのか原因見つけて根本的なところ改善する」
//   AIX【内覧へ！】を DeepSeek に切り替えた本番の検証で出た実物
it("★ AI がスタッフに材料を要求する文は返信ではない（丸ごと使わない）", () => {
  expect(isNotACustomerReply("お客様のお名前が会話履歴から特定できませんでした。\nお手数ですが、お客様のお名前または会話履歴をご提示いただけますでしょうか？")).toBe(true);
  expect(isNotACustomerReply("会話履歴から物件名が特定できませんでした")).toBe(true);
  expect(isNotACustomerReply("情報が不足しており特定出来ません")).toBe(true);
});
// 2026-09-20 本番検証（見積書のカバーレター）で出た実物
it("★ AI がスタッフに指示を求める文は返信ではない（実送信365日で0件）", () => {
  expect(isNotACustomerReply("どう対応すればよいか分かりません。お客様に直接お聞きしてもよろしいでしょうか？")).toBe(true);
  expect(isNotACustomerReply("どう返信すればいいのか分かりかねます")).toBe(true);
  expect(isNotACustomerReply("お客様に確認してもよろしいでしょうか")).toBe(true);
  // 2026-09-20 本番14パターンの検証で出た形（実送信365日で0通）
  expect(isNotACustomerReply("こちらのメッセージには返信できません。")).toBe(true);
  expect(isNotACustomerReply("この内容には返信出来ません")).toBe(true);
});

// 2026-09-20 出口を直した後の2回目の本番検証で出た実物（実送信365日 12,007通で全部0通）
it("★ AI が自分の作業・材料について語る文は返信ではない", () => {
  for (const t of [
    "以下は 2026-09-18 の学習ナレッジに基づく返信文です",
    "顧客名は「YUMAさん」として出力します",
    "お客様への返信対象となる入力内容が存在しないため、出力すべき内容がありません",
    "物件も特定できていないため送付内容の言及も不可能です",
    "よって見積書カバーレターとして成立する文面は生成できません",
    "スタッフが直近に呼んだ名前を確認してください",
  ]) if (!isNotACustomerReply(t)) throw new Error(`落ちない: ${t}`);
});
it("★ お客様への本物の文は落とさない（確認・出力・存在の語は本物にも出る）", () => {
  for (const t of [
    "YUMAさん管理会社に確認させて頂きますので少々お待ちください😊！！",
    "募集状況確認出来次第ご連絡させて頂きます！！",
    "こちらのお部屋は現在空室となっております！！",
    "お送りさせて頂いたお部屋の中でも特にオススメ出来るお部屋となります！！",
  ]) if (isNotACustomerReply(t)) throw new Error(`落としてはいけない: ${t}`);
});
it("★ お客様への本物の問いかけは落とさない（「お客様に直接」単体では落とさない）", () => {
  expect(isNotACustomerReply("YUMAさんご都合よろしいお日にちお聞かせください😊！！")).toBe(false);
  expect(isNotACustomerReply("管理会社に確認させて頂きますのでよろしくお願い致します！！")).toBe(false);
  expect(isNotACustomerReply("ご希望のお日にちお伺いしてもよろしいでしょうか😊！！")).toBe(false);
});

it("★ 本物の送信文は落とさない（実送信365日で「特定できませ」「ご提示いただけ」は0件）", () => {
  // 「会話履歴」「お名前」「ご提示」単体では落ちないこと（本物の文に出る語）
  expect(isNotACustomerReply("YUMAさんお世話になっております！！\nご内覧のお日にちご提示いただけますと幸いです😊！！")).toBe(false);
  expect(isNotACustomerReply("かしこまりました！！\nお名前をお伺いできますでしょうか😊！！")).toBe(false);
  expect(isNotACustomerReply("物件名が確認できましたらお送りさせて頂きます！！")).toBe(false);
  expect(isNotACustomerReply("空室状況を確認させて頂きます！！")).toBe(false);
});
it("★ AIX の出口にも配られている（返信生成だけに入れても AIX から漏れる）", () => {
  // 設計知見「入口（材料・指示）だけ直しても生成後の癖は残る — 出口の決定論も同じ関数で全経路に配る」
  const aix = readFileSync("app/api/aix/action/route.ts", "utf8");
  expect(/isNotACustomerReply\(stripped\)/.test(aix)).toBe(true);
  expect(/tag: "aix:not-a-reply"/.test(aix)).toBe(true);
  // 竹内「スタッフへの指示の部分はテキストボックス外に注意として入れる／テキストボックスにはいれない」
  //   捨てる（エラー）のではなく、message は空・notice に載せて返す
  expect(/return \{ message: "", notice: `⚠ お客様への返信になっていません/.test(aix)).toBe(true);
  const ui = readFileSync("app/components/AixModal.tsx", "utf8");
  // notice はテキストボックス（textarea）ではなく専用の枠に出る
  expect(/\{aixNotice && \(/.test(ui)).toBe(true);
  expect(/whitespace-pre-wrap break-words">\{aixNotice\}/.test(ui)).toBe(true);
  // 本文が空なら送信ボタンは押せない（空のまま送られない）
  expect(/disabled=\{loading \|\| !preview\.trim\(\)\}/.test(ui)).toBe(true);
  const gen = readFileSync("app/api/generate-reply/route.ts", "utf8");
  expect(/isNotACustomerReply/.test(gen)).toBe(true);
  const draft = readFileSync("app/lib/draft-text.ts", "utf8");
  expect(/isNotACustomerReply/.test(draft)).toBe(true);
});

it("2行目に入った見出し「以下、返信案です。」を消す（YUMA 2026-09-22・実送信11件で誤削除0）", () => {
  expect(stripMetaNarration("かしこまりました！！\n以下、返信案です。\n\nYUMAさんに気に入っていただけて嬉しいです😊！！").text).toBe("かしこまりました！！\n\nYUMAさんに気に入っていただけて嬉しいです😊！！");
});

it("判定の塊「【今回の判定】＋・箇条書き」を空行まで消す（YUMA 2026-09-22 実物・実送信506通で誤削除0）", () => {
  const real = "【今回の判定】\n・直前スタッフ送信＝物件送付済み（3件）＋ご査収依頼で終了済み。\n・お客様は3通を1つの流れとして送っており、②の「もう少し見てみたい」＝エスリードレジデンス大阪天王寺1006号室への前向き反応＋追加情報希望。\n・見積書解禁条件（送付済み物件への前向き反応）を満たすので、見積作成宣言を1回だけ書く。\n\nはい😊！！\n\nエスリードレジデンス大阪天王寺1006号室、最大限割引させて頂いた御見積書作成しお送りさせて頂きます！！";
  expect(stripMetaNarration(real).text).toBe("はい😊！！\n\nエスリードレジデンス大阪天王寺1006号室、最大限割引させて頂いた御見積書作成しお送りさせて頂きます！！");
  // スタッフの物件紹介の「・」は残す（見出しが無い）
  const card = "🌟ラクラス阿倍野元町 507号室\n・家賃6.4万円\n・敷金礼金なし\n\nお手隙の際にご査収ください😌！！";
  expect(stripMetaNarration(card).text).toBe(card);
});
it("場面の見出し「【〜場面での返信】」を消す（YUMA 2026-09-22 実物・実送信506通で誤削除0）", () => {
  const real = "【画像を2枚送付済み・エスリードレジデンス大阪天王寺1006号室にご興味を示された場面での返信】\n\nYUMAさん、この2部屋気になって頂き嬉しいです😊！！";
  expect(stripMetaNarration(real).text).toBe("YUMAさん、この2部屋気になって頂き嬉しいです😊！！");
});
it("節の名前の見出し「【AIX実行済み・確認結果報告済みを踏まえた返信】」を消す（YUMA 2026-09-26 DeepSeek 実物・実送信0行）", () => {
  const real = "【AIX実行済み・確認結果報告済みを踏まえた返信】\n\nYUMAさん\nかしこまりました！！\n\nサンメゾンの件も併せて確認させて頂き、分かり次第ご連絡させて頂きます！！";
  expect(stripMetaNarration(real).text).toBe("YUMAさん\nかしこまりました！！\n\nサンメゾンの件も併せて確認させて頂き、分かり次第ご連絡させて頂きます！！");
  // 本文の中の【物件名】ラベル（見積書の①【グランパシフィック花園Luxe 1006号室】）は消さない
  const label = "①【グランパシフィック花園Luxe 1006号室】\n初期費用：287,480円";
  expect(stripMetaNarration(label).text).toBe(label);
});
it("判定メモの行「〜時点、直前に物件送付済み…これは事実確認質問だが…断言は禁止」を消す（YUMA 2026-09-22 実物・実送信0行）", () => {
  const real = "9/22（火）14:20時点、直前に物件送付済み・見積は未送付、お客様は特定物件（ラクラス阿倍野元町 or エスリードレジデンス大阪天王寺）について更新料の質問。これは事実確認質問だが、管理会社確認前の断言は禁止（契約条件の詳細は個別物件情報）。\n\nYUMAさんお世話になっております！！\n更新料につきましては物件によって異なりますので、管理会社に確認させて頂きます！！";
  expect(stripMetaNarration(real).text).toBe("YUMAさんお世話になっております！！\n更新料につきましては物件によって異なりますので、管理会社に確認させて頂きます！！");
});
it("1行目がお客様の発言の引用だけ「「その後どうなりましたか？」」→ 消す（YUMA 2026-09-22・「で始まる実送信0通）／本文の途中の引用は残す", () => {
  expect(stripMetaNarration("「その後どうなりましたか？」\n\nかしこまりました！！\nまだ管理会社より回答をいただけていない状況です！").text).toBe("かしこまりました！！\nまだ管理会社より回答をいただけていない状況です！");
  const mid = "かしこまりました！！\n「11月から」のご入居で進めさせて頂きます！！";
  expect(stripMetaNarration(mid).text).toBe(mid);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

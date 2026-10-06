// app/lib/__tests__/confirm-target-property.test.ts — 確認した（条件・交渉）の物件を会話から決める／手打ちの「とのご返答でした」を報告に数える／
//   約束の後の「〇〇の件よろしくお願いします」で AIX【確認した→〈要件〉】を立てる／濁点だけ違う同じ部屋を寄せる
// 実行: npx tsx app/lib/__tests__/confirm-target-property.test.ts
// 2026-10-06 竹内さん（R 事例）「ここは確認した で管理会社にエアコンを確認した事を入れる形となる。これ別の物件がはいりこんでしまっているので
//   原因見つけて改善する（物件特定できる能力高める必要がある）」
import { resolveConfirmTargetProperty, staffLabelsOf, otherPropertyNamedInText } from "../confirm-target-property";
import { classifyStaffTextFacts, buildActionLedger, customerAskedConfirmTopic } from "../action-ledger";
import { resolveStaffPromiseAix } from "../aix-task-link";
import { planPromiseCompletion } from "../promise-calendar";
import { matchRoomRefs, splitPropertyName } from "../customer-state";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// R の実物（10/02〜10/05・お客様の表示名は R のまま・URL は同じ形）
const R = [
  { sender: "staff", text: "🌟EIJU牧野駅前B 102\n\n新築・カウンターキッチン完備・家賃管理費込80,000円とかなりオススメ出来るお部屋となります！！", createdAt: "2026-10-02T06:24:55Z" },
  { sender: "staff", text: "お送りさせていただいたお部屋の中でもEIJU牧野駅前B102号室、206号室が特におすすめのお部屋となります！！", createdAt: "2026-10-02T06:27:46Z" },
  { sender: "customer", text: "詳細ありがとうございます！\n\nちなみに旭区、都島区、城東区、阿倍野区、今里方面で同じような条件でお部屋はありますか？", createdAt: "2026-10-03T04:31:18Z" },
  { sender: "staff", text: "かしこまりました！！\n旭区・都島区・城東区・阿倍野区・今里方面でも、管理費込み10万以内・1LDK・築5年以内・カウンターキッチンの条件でオススメできるお部屋を新たにピックアップしてお送りさせて頂きます！！", createdAt: "2026-10-03T04:51:02Z" },
  { sender: "customer", text: "https://www.homes.co.jp/chintai/b-1522840038291/", createdAt: "2026-10-04T06:45:52Z" },
  { sender: "customer", text: "お世話になっております。\nこの物件の見積もりと入居可能日を教えていただきたいです。\n他のところで見積もりをだしてもらって、28万くらいやったんですけどもっと安くなる可能性はありますか？", createdAt: "2026-10-04T06:45:54Z" },
  { sender: "staff", text: "かしこまりました！！\nお送り頂きました物件の募集状況を確認させて頂きます！！\n他社様の28万円より抑えられるよう、最大限割引して御見積書をご用意いたします😊！！", createdAt: "2026-10-04T06:47:05Z" },
  { sender: "customer", text: "よろしくお願いします🙇🏻‍♀️", createdAt: "2026-10-04T06:50:43Z" },
  { sender: "customer", text: "ちなみにこの物件はエアコン各部屋で2台付いているかも確認していただけるとうれしいです！", createdAt: "2026-10-04T06:53:17Z" },
  { sender: "staff", text: "[画像]", createdAt: "2026-10-04T07:06:58Z" },
  { sender: "staff", text: "【カーサピエント 203号室】\n\n初期費用：355,880円\n\nスモラなら一般的な不動産業者より70,400円節約出来ます！！", createdAt: "2026-10-04T07:06:58Z" },
  { sender: "staff", text: "お待たせ致しました！！\n初期費用の御見積書となります！！", createdAt: "2026-10-04T07:08:52Z" },
  { sender: "staff", text: "エアコンにつきまして\n管理会社本日お休みでしたので、明日確認しご連絡させて頂きます！！\n何卒よろしくお願い致します！！", createdAt: "2026-10-04T07:09:24Z" },
  { sender: "customer", text: "見積もりありがとうございます。\nエアコンの件よろしくお願いします！", createdAt: "2026-10-04T07:11:34Z" },
];

console.log("■ 物件の特定（confirm-target-property）");
{
  const r = resolveConfirmTargetProperty(R, { topic: "設備" });
  t("R: エアコンの質問 → 答えた御見積書の カーサピエント 203号室（EIJU牧野駅前B ではない）", r?.name === "カーサピエント 203号室" && r?.source === "answered_after_question", JSON.stringify(r));
  t("R: 要件が違う（駐車場）質問は無い → 決めない", resolveConfirmTargetProperty(R, { topic: "駐車場" }) === null);
  const gen = "Rさんお世話になっております！！\nEIJU牧野駅前B 102号室の設備状況につきまして管理会社へ確認させて頂きました！！";
  t("R: 生成文に別の物件（EIJU牧野駅前B）が出たら印", otherPropertyNamedInText(gen, "カーサピエント 203号室", R).length === 1);
  t("R: 決めた物件だけなら印なし", otherPropertyNamedInText("カーサピエント 203号室の設備状況につきまして", "カーサピエント 203号室", R).length === 0);
}
{
  // 8590144d 型: 持ち込みの画像の連投で、送った物件の名前が出ても号室が合わない（同じ階の角部屋）→ 決めない
  const m = [
    { sender: "staff", text: "【Luxe難波WEST 403号室】\n\n初期費用：120,000円" },
    { sender: "customer", text: "[画像] 物件情報 Luxe難波 WEST 11階" },
    { sender: "customer", text: "こちら抑えて頂いた物件の同じ階の角部屋が空いているの見つけたのですが、こちら入居日等含めてマッチしそうですか？" },
  ];
  t("持ち込みで名前だけ出て号室が合わない → 決めない", resolveConfirmTargetProperty(m, {}) === null);
}
{
  // ff668bb2 型: 起点の質問より後に別の物件を持ち込んだ → 決めない
  const m = [
    { sender: "customer", text: "Ｌａ　Ｃａｓａ　Ｓｅｇｕｒａ 1階\nhttps://suumo.jp/chintai/bc_100508223664/\nby SUUMO" },
    { sender: "customer", text: "↑ちなみにここの入居可能時期と、空き状況も確認いただけますか！" },
    { sender: "staff", text: "La Casa Segura確認させて頂きましたが、現在募集に出ていないお部屋となっております。" },
    { sender: "customer", text: "[画像]" },
    { sender: "customer", text: "ちなみにここはまだ空いてますか！" },
  ];
  t("質問の後に別の持ち込み → 決めない", resolveConfirmTargetProperty(m, { topic: "入居時期" }) === null);
}
{
  // 2ae0d94e 型: 「〇〇は候補から外れました…△△のみご確認」→ 外した物件にしない
  const m = [
    { sender: "staff", text: "🌟プレリス大阪今里サヴィア 801号室\n\nかなりオススメ出来るお部屋となります！！" },
    { sender: "customer", text: "2件の物件について礼金のご相談をさせていただきましたが、プレリス大阪今里サヴィアは候補から外れましたので、そちらについては確認不要です。モラーダのみご確認いただけますと幸いです。礼金はどうなりますか？" },
  ];
  t("外した物件は選ばない（決めない）", resolveConfirmTargetProperty(m, { topic: "初期費用" }) === null, JSON.stringify(resolveConfirmTargetProperty(m, { topic: "初期費用" })));
}
{
  // d25e07d1 型: お客様が名前を出した
  const m = [
    { sender: "staff", text: "YUYAさんお送り頂きました物件の中で\n\n・グラシャトー4F B号室\n・新大阪ハイツ 407号室\n・木川東エクセルハイツ 814号室\nこちら現在募集中となります！！" },
    { sender: "customer", text: "新大阪ハイツは洗濯機置場はベランダですか？" },
  ];
  const r = resolveConfirmTargetProperty(m, { topic: "設備" });
  t("お客様が名前を出した物件（新大阪ハイツ 407号室）", r?.name === "新大阪ハイツ 407号室" && r?.source === "customer_named", JSON.stringify(r));
}
{
  // 0133b787 型: 「この物件はペット可でしょうか」→ 直前の手打ちの「〇〇 702号室現在募集中」
  const m = [
    { sender: "staff", text: "🌟L-IDEA MINAMI HORIE 204号室\n\nオススメ出来るお部屋となります！！" },
    { sender: "customer", text: "[画像]" },
    { sender: "customer", text: "この物件空いてるか調べてもらえますか？" },
    { sender: "staff", text: "エストボワール堂江 702号室現在募集中となります！！\n\n初期費用のお見積書お送りさせていただきました！！" },
    { sender: "customer", text: "この物件はペット可でしょうか？" },
  ];
  const r = resolveConfirmTargetProperty(m, { topic: "ペット" });
  t("直前の手打ちの「〇〇 702号室」を指す（古い🌟ではない）", r?.name === "エストボワール堂江 702号室", JSON.stringify(r));
  t("手打ちの号室の名前を物件に数える", staffLabelsOf("8/20 18:30にモラーダ 301号室\n現地エントランスお待ち合わせ").includes("モラーダ 301号室"));
}

console.log("■ 手打ちの報告「とのご返答でした」（action-ledger）");
{
  const text = "Rさん\nお世話になっております！！\n\n管理会社にエアコンの件確認させていただき、リビング洋室共に備わっております。とのご返答でした！！\n\nお手隙の際にご確認の程よろしくお願いいたします！！";
  const f = classifyStaffTextFacts(text, "2026-10-05T01:41:43Z");
  const rep = f.find((e) => e.kind === "confirmation_reported");
  t("R 10/5 の手打ち → 確認結果の報告（要件=設備）", rep?.detail?.object === "設備", JSON.stringify(f));
  const ids = planPromiseCompletion([{ kind: "confirmation_reported", object: rep?.detail?.object ?? null }],
    [{ id: 1062, event_type: "follow_up", notes: "【必ず】設備の確認→ご連絡\n約束: 「エアコンにつきまして」\nAIX: 【確認した（条件・交渉）→設備】を送ったら完了", is_done: false }]);
  t("【必ず】設備の確認→ご連絡 が閉じる", ids.includes(1062));
  const led = buildActionLedger({ messages: [...R, { sender: "staff", text, createdAt: "2026-10-05T01:41:43Z" }] } as never);
  t("台帳: 確認約束が報告済みになる", !led.facts.confirmationPromisedUnfulfilled);
  t("「とのご回答でした」「とのご返事でした」も報告", ["管理会社より敷地内駐車場現在空き無しとのご回答でした！！", "管理会社に確認させていただき、洗濯機置き場はベランダ部分に外置きとのご返答でした。"]
    .every((x) => classifyStaffTextFacts(x, null).some((e) => e.kind === "confirmation_reported")));
  t("約束の文は報告にしない", !classifyStaffTextFacts("エアコンの件、明日確認してご連絡させて頂きます😌！！", null).some((e) => e.kind === "confirmation_reported"));
}

console.log("■ 約束の後の「エアコンの件よろしくお願いします」（aix-task-link）");
{
  const led = buildActionLedger({ messages: R } as never);
  const r = resolveStaffPromiseAix(led.facts, R, { customerRequestedCheck: false, customerAckAfter: false, propertyInPlay: true });
  t("R 10/4 16:11 → AIX【確認した→設備】（物件ピックアップではない）", r?.action === "property_check_result" && r?.checkPattern === "mgmt_equipment", JSON.stringify(r));
  t("お客様が要件を頼んだ（約束の前の質問）", customerAskedConfirmTopic(R, R.length - 2, "設備"));
  const other = [...R.slice(0, -1), { sender: "customer", text: "見積もりありがとうございます。駐車場は何台までですか？", createdAt: "2026-10-04T07:11:34Z" }];
  const r2 = resolveStaffPromiseAix(buildActionLedger({ messages: other } as never).facts, other, { customerRequestedCheck: false, customerAckAfter: false, propertyInPlay: true });
  t("別の新しい質問（駐車場は何台？）の番は約束の AIX にしない", r2 === null, JSON.stringify(r2));
}

console.log("■ 濁点だけ違う同じ部屋（customer-state）");
{
  const a = splitPropertyName("カーサピエント 203号室"), b = splitPropertyName("カーサビエント", "203");
  t("カーサピエント 203 ＝ カーサビエント 203", !!a && !!b && matchRoomRefs(a, b) === "same_room");
  const c = splitPropertyName("スプランディッド本町グラン 1003号室"), d = splitPropertyName("スプランディット本町グラン 1604号室");
  t("号室が違えば別の部屋", !!c && !!d && matchRoomRefs(c, d) === "different_room");
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);

// 2026-10-15 保留の番の柔らかい次の一手（hold-soft-next.ts）・迷いの返し方の但し書き（customer-mindset.ts）
// 実行: npx tsx app/lib/__tests__/hold-soft-next.test.ts
// お客様の発言は実物（scripts/audit-sales-mind.ts・audit-hold-soft-next.ts で読んだ竹内さんの番・名前と物件名は伏せた）
import { holdTurnKind, softNextMoveOf, holdSoftNextMaterial, rule8HoldNote, holdSoftReplyNote, isThanksOnly } from "../hold-soft-next";
import { hesitationMoveOf, buildMindsetReplyLinesNote, mindsetFreshOutputItem } from "../customer-mindset";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const ok = (c: boolean, label = "") => { if (!c) throw new Error(label || "false"); };
const ON = { HOLD_SOFT_NEXT: "on", HOLD_SOFT_1015: "off" }, OFF = { HOLD_SOFT_NEXT: "off" };
const V15 = { HOLD_SOFT_NEXT: "on" }; // 10/15 竹内さんの決定④（既定）

console.log("■ 保留の言い方（実物）");
it("検討してみます! → 検討", () => eq(holdTurnKind("ありがとうございます！\n検討してみます!"), "検討"));
it("帰ってからゆっくり見て返信します → 確認", () => eq(holdTurnKind("また帰ってからゆっくり見て返信します\nありがとうございます"), "確認"));
it("友人に相談の上…よろしいでしょうか（許しを求める言い方）→ 相談", () => eq(holdTurnKind("確認いたしました！\nでは送っていただいた2件に関しては、友人に相談の上、またご連絡させていただいてもよろしいでしょうか。"), "相談"));
it("一度考えさせてください → 検討", () => eq(holdTurnKind("良さそうなお家ありがとうございます\n一度考えさせてください🙇‍♀️"), "検討"));
it("質問が主（洗面台とトイレ一緒ですか）→ null", () => eq(holdTurnKind("ここって洗面台とトイレ一緒な感じですか？"), null));
it("この物件空いてるの1部屋だけですか？ → null", () => eq(holdTurnKind("ありがとうございます🙇🏻‍♀️\nちなみにこの物件空いてるの1部屋だけですか？"), null));
it("条件の依頼（もう少し探していただけますか）→ null", () => eq(holdTurnKind("もう少し探していただけますか？"), null));

console.log("■ 竹内さんの柔らかい次の一手（実送信）");
it("お気に召されたお部屋すべてご案内させて頂きます → viewing", () => eq(softNextMoveOf("はい😊！！\nごゆっくりご確認ください！！\n〇〇さんお気に召されたお部屋すべてご案内させて頂きます！！"), "viewing"));
it("お申込みしお部屋抑えさせていただきます → apply", () => eq(softNextMoveOf("お気に召されましたらお申込みしお部屋抑えさせていただきます！！"), "apply"));
it("扉の文だけ → null", () => eq(softNextMoveOf("はい😊！！\nごゆっくりご検討ください！！\nお気に召されましたらいつでもご連絡ください😌！！"), null));
it("初期費用抑えさせて頂きます は apply ではない", () => eq(softNextMoveOf("初期費用面も出来る限り抑えさせて頂きます！！"), null));

console.log("■ ブレインの材料（場面・部屋は訴求のタイミングの読み）");
it("1件オススメの後の検討・空室 → 47% の材料と内覧の1文", () => { const s = holdSoftNextMaterial({ customerText: "検討します！", scene: "after_recommend", room: "vacant", env: ON }); ok(s.includes("47%") && s.includes("ご都合よろしいお日にちにお部屋ご案内"), s); });
it("確認の保留は 6/11 も添える", () => ok(holdSoftNextMaterial({ customerText: "また帰ってからゆっくり見て返信します", scene: "after_pickup", room: "vacant", env: ON }).includes("6/11")));
it("まだ内覧できない部屋 → 添えない事が多い", () => ok(holdSoftNextMaterial({ customerText: "検討します", scene: "after_recommend", room: "move_out_not_viewable", env: ON }).includes("添えない事が多い")));
it("物件を見せた後でない場面 → 空", () => eq(holdSoftNextMaterial({ customerText: "検討します", scene: "other", room: "vacant", env: ON }), ""));
it("保留でない（質問）→ 空", () => eq(holdSoftNextMaterial({ customerText: "駐車場空いてますか？", scene: "after_recommend", room: "vacant", env: ON }), ""));
it("HOLD_SOFT_NEXT=off → 空", () => eq(holdSoftNextMaterial({ customerText: "検討します", scene: "after_recommend", room: "vacant", env: OFF }), ""));
it("ルール⑧の但し書き on/off", () => { ok(rule8HoldNote(ON).includes("申込誘導・催促に当たらない")); eq(rule8HoldNote(OFF), ""); });

console.log("■ 返信の材料（ブレインが書いた時だけ）");
it("ブレインが内覧案内の1文 → 内覧の1文を渡す", () => ok(holdSoftReplyNote({ customerText: "友人に相談の上、またご連絡させていただいてもよろしいでしょうか。", brainDirection: "友人相談を受け止め、お気に召されたらご都合のよい日にちに内覧案内する旨を添える", env: ON }).includes("ご都合よろしいお日にちにお部屋ご案内")));
it("ブレインが抑える → 抑えるの1文", () => ok(holdSoftReplyNote({ customerText: "検討します", brainDirection: "扉の文に申込でお部屋を抑える柔らかい1文を添える", env: ON }).includes("抑えさせて")));
it("ブレインが待つだけ → 空", () => eq(holdSoftReplyNote({ customerText: "検討します", brainDirection: "検討を見守る待ちの姿勢で締める", env: ON }), ""));
it("保留でない番 → 空", () => eq(holdSoftReplyNote({ customerText: "内覧できますか？", brainDirection: "内覧案内する", env: ON }), ""));
it("off → 空", () => eq(holdSoftReplyNote({ customerText: "検討します", brainDirection: "内覧案内の1文を添える", env: OFF }), ""));
// fix(review) 10/15: 言い過ぎの道
it("押しを抑えて待つ → 抑えるの1文にしない", () => eq(holdSoftReplyNote({ customerText: "検討します", brainDirection: "押しを抑えて検討を見守る待ちの姿勢で締める", env: ON }), ""));
it("初期費用を抑えた → 抑えるの1文にしない", () => eq(holdSoftReplyNote({ customerText: "検討します", brainDirection: "初期費用を抑えた点を添えて見守る", env: ON }), ""));
it("内覧はまだできない → 空", () => eq(holdSoftReplyNote({ customerText: "検討します", brainDirection: "退去予定で内覧はまだできないため、案内は控えて見守る", env: ON }), ""));
it("新着が出次第ご案内 → 内覧の1文にしない", () => eq(holdSoftReplyNote({ customerText: "検討します", brainDirection: "新着が出次第ご案内する旨で閉じる", env: ON }), ""));
it("申込の催促はせず・内覧案内を添える → 内覧の1文", () => ok(holdSoftReplyNote({ customerText: "検討します", brainDirection: "申込の催促はせず、お気に召されたらご都合のよい日に内覧案内する1文を添える", env: ON }).includes("ご案内させて")));
it("退去予定のお部屋（room）→ 内覧の1文は渡さない", () => eq(holdSoftReplyNote({ customerText: "検討します", brainDirection: "内覧案内の1文を添える", scene: "after_recommend", room: "move_out_not_viewable", env: ON }), ""));
it("申込の後（scene）→ 空", () => eq(holdSoftReplyNote({ customerText: "確認します", brainDirection: "申込でお部屋を抑える1文を添える", scene: "post_apply", room: "vacant", env: ON }), ""));
it("抑えました（申込の後の言い方）→ 空", () => eq(holdSoftReplyNote({ customerText: "確認します", brainDirection: "お申込でお部屋を押さえました旨を伝える", env: ON }), ""));

console.log("■ 10/15 竹内さんの決定④（HOLD_SOFT_1015 既定 on）");
it("空室の保留 → 内覧のご案内の1文", () => { const s = holdSoftNextMaterial({ customerText: "検討します！", scene: "after_recommend", room: "vacant", env: V15 }); ok(s.includes("竹内さんの決定") && s.includes("ご都合よろしいお日にちにお部屋ご案内"), s); });
it("退去予定の部屋の保留 → 申込で抑えるの1文（添えない事が多い とは言わない）", () => { const s = holdSoftNextMaterial({ customerText: "検討します", scene: "after_recommend", room: "move_out_not_viewable", env: V15 }); ok(s.includes("お申込みしお部屋抑えさせて") && !s.includes("添えない事が多い"), s); });
it("家族・友人に相談 → 添える（相談も同じ）", () => { const s = holdSoftNextMaterial({ customerText: "確認いたしました！\n友人に相談の上、またご連絡させていただいてもよろしいでしょうか。", scene: "after_pickup", room: "vacant", env: V15 }); ok(s.includes("ご家族やご友人との相談も同じ") && s.includes("ご案内"), s); });
it("すぐ来られない（delayed）→ 申込で抑える", () => ok(holdSoftNextMaterial({ customerText: "検討します", scene: "after_recommend", room: "vacant", delayed: true, env: V15 }).includes("お申込みしお部屋抑えさせて")));
it("内覧の後 → 申込で抑える", () => ok(holdSoftNextMaterial({ customerText: "検討します", scene: "post_viewing", room: "vacant", env: V15 }).includes("お申込みしお部屋抑えさせて")));
it("返信: 退去予定の部屋でブレインが内覧と書いても抑えるの1文", () => ok(holdSoftReplyNote({ customerText: "検討します", brainDirection: "受け止め＋扉の文＋お気に召されたら内覧案内の1文", scene: "after_recommend", room: "move_out_not_viewable", env: V15 }).includes("抑えさせて")));
it("返信: 空室でブレインが抑えると書いても場面どおり内覧の1文", () => ok(holdSoftReplyNote({ customerText: "検討します", brainDirection: "扉の文に申込でお部屋を抑える1文を添える", scene: "after_recommend", room: "vacant", env: V15 }).includes("ご案内させて")));
it("返信: すぐ来られない → 抑えるの1文", () => ok(holdSoftReplyNote({ customerText: "検討します", brainDirection: "内覧案内の1文を添える", scene: "after_recommend", room: "vacant", delayed: true, env: V15 }).includes("抑えさせて")));
it("ルール⑧の但し書き: 退去予定・すぐ来られない → 抑える", () => ok(rule8HoldNote(V15).includes("退去予定のお部屋・遠方などすぐ来られない")));
it("迷いの返し方: 10/15 の文", () => ok(hesitationMoveOf("家族・同居人に相談", V15).includes("退去予定・遠方などすぐ来られない")));

console.log("■ 迷いの返し方（customer-mindset）");
it("家族・同居人に相談 → 扉＋柔らかい一手の但し書き", () => ok(hesitationMoveOf("家族・同居人に相談", ON).includes("柔らかい次の一手")));
it("複数物件で迷う には付けない", () => ok(!hesitationMoveOf("複数物件で迷う", ON).includes("柔らかい次の一手")));
it("off → 旧の文", () => ok(!hesitationMoveOf("家族・同居人に相談", OFF).includes("柔らかい次の一手")));
it("迷いの状態の1行は変えない（返信はブレインが書いた時だけ）", () => ok(!buildMindsetReplyLinesNote("迷い", null, { ...ON, MINDSET_REPLY_LINES: "on" }).includes("47%")));
it("ブレインの出力の説明 on/off", () => { ok(mindsetFreshOutputItem({ CUSTOMER_MINDSET: "on", ...ON }).includes("【保留の番の柔らかい次の一手】")); ok(!mindsetFreshOutputItem({ CUSTOMER_MINDSET: "on", ...OFF }).includes("【保留の番の柔らかい次の一手】")); });

console.log("■ 10/15 竹内さんの追加の決定（紗季さん 10/11）: 送った物件が刺さっているか");
it("お礼だけ（ありがとうございます🙇）", () => ok(isThanksOnly("ありがとうございます🙇")));
it("物件に触れた反応はお礼だけではない", () => ok(!isThanksOnly("ありがとうございます！2件目めっちゃいいですね")));
it("質問はお礼だけではない", () => ok(!isThanksOnly("ありがとうございます！空いてますか？")));
it("ピックアップの後のお礼だけ → 刺さっているかの材料（全力サポートの手本）", () => { const m = holdSoftNextMaterial({ customerText: "ありがとうございます🙇", scene: "after_pickup", room: "vacant", env: V15 }); ok(m.includes("刺さっているか") && m.includes("全力でサポート") && m.includes("新着物件も随時確認"), m); });
it("HOLD_SOFT_1015=off → 出さない", () => eq(holdSoftNextMaterial({ customerText: "ありがとうございます🙇", scene: "after_pickup", room: "vacant", env: ON }), ""));
it("内覧の後は対象外", () => eq(holdSoftNextMaterial({ customerText: "ありがとうございます", scene: "post_viewing", room: "vacant", env: V15 }), ""));
it("保留の材料も刺さっていない時は添えない", () => ok(holdSoftNextMaterial({ customerText: "検討します", scene: "after_pickup", room: "vacant", env: V15 }).includes("刺さっていない")));
it("ルール⑧の但し書き: お礼だけの締めは全力サポート", () => ok(rule8HoldNote(V15).includes("全力でサポート")));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exitCode = 1; }

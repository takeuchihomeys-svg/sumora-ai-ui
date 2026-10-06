// 2026-10-07 竹内（R・チンシャン）訴求のタイミング: 申込（お部屋を抑える）／内覧／入れない を場面と部屋の状況から決める
// 実行: npx tsx app/lib/__tests__/appeal-timing.test.ts
// 本文は実送信のまま（名前は会話のまま・個人の値は無い）
import {
  detectAppeal, resolveAppealTiming, buildAppealInput, resolveAppealFromConversation, withAppealDirection, buildAppealReplyNote,
  APPEAL_LINES, adjustCtaForRoom, type AppealTimingInput,
} from "../appeal-timing";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 120))} to contain ${JSON.stringify(sub)}`); }

console.log("detectAppeal（実送信の文）");
it("R 10/05 16:46 の締め＝申込・締めの位置", () => {
  const d = detectAppeal("はい😊！！\nごゆっくりご検討ください！！\nお気に召されましたらお申込みしお部屋抑えさせていただきます！！\n気になる点等出てきましたらいつでもご連絡ください😌！！");
  eq(d.apply, true); eq(d.viewing, false); eq(d.position, "closing");
});
it("チンシャン 10/05 物件オススメの締め＝内覧", () => {
  const d = detectAppeal("こちらのお部屋如何でしょうか！！\n\nリノベーション済みの角部屋で南向き・エアコン3基新設と設備も充実しており、チンシャンさんにかなりオススメ出来るお部屋となります！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！\nお手隙の際にご査収ください😊！！");
  eq(d.viewing, true); eq(d.apply, false);
});
it("AI の下書き「お気に召されましたらいつでもご連絡ください」は訴求ではない", () => {
  const d = detectAppeal("はい😊！！ ごゆっくりご検討ください！！ お気に召されましたらいつでもご連絡ください😌！！");
  eq(d.apply || d.viewing, false);
});
it("「10月1日以降にご内覧可能です」（いつから見られるかの説明）は誘いではない", () => {
  eq(detectAppeal("9月30日退去予定のため10月1日以降にご内覧可能です！！").viewing, false);
});
it("日時を決めた案内（6/16日お部屋ご案内させていただきます）は誘いではない", () => {
  eq(detectAppeal("6/16日お部屋ご案内させていただきます😊！！").viewing, false);
});
it("「初期費用をかなり抑えられる」は申込の訴求ではない", () => {
  eq(detectAppeal("敷金礼金0円の為初期費用かなり抑える事ができます😊！！").apply, false);
});
it("退去予定の申込の形（抑えた状態でご内覧）＝申込", () => {
  eq(detectAppeal("お気に召されましたらお部屋埋まってしまう前にお申込みいただきお部屋抑えた状態でご内覧いただくのをオススメいたします😌！！").apply, true);
});

console.log("resolveAppealTiming（判定）");
const base = (o: Partial<AppealTimingInput>): AppealTimingInput => ({ scene: "after_recommend", customer: "positive", room: "vacant", ...o });
it("チンシャン: 物件オススメ後×前向き（いいですね）×空室 → 内覧（必須）", () => {
  const v = resolveAppealTiming(base({}));
  eq(v.kind, "viewing"); eq(v.level, "must"); has(v.note, APPEAL_LINES.viewing); has(v.note, "御見積書の約束・送付を書く時も");
});
it("見積書後×前向き×空室 → 内覧（必須・実送信 75%）", () => {
  const v = resolveAppealTiming(base({ scene: "after_estimate" }));
  eq(v.kind, "viewing"); eq(v.level, "must");
});
it("前向き×退去予定（まだ見られない）→ 申込（抑えた状態でご内覧）・材料", () => {
  const v = resolveAppealTiming(base({ room: "move_out_not_viewable" }));
  eq(v.kind, "apply"); eq(v.level, "suggest"); eq(v.line, APPEAL_LINES.apply_hold_then_view);
});
it("R: 見積書後×検討します×空室 → 申込（材料）・ごゆっくりの後・扉の文は申込誘導に当たらない", () => {
  const v = resolveAppealTiming(base({ scene: "after_estimate", customer: "thinking", estimateSent: true }));
  eq(v.kind, "apply"); eq(v.level, "suggest"); eq(v.line, APPEAL_LINES.apply); has(v.note, "ごゆっくり"); has(v.note, "当たらない");
});
it("見積書後×了承×空室 → 内覧（材料・見積書の後は内覧のご案内が中心）", () => {
  const v = resolveAppealTiming(base({ scene: "after_estimate", customer: "ack", estimateSent: true }));
  eq(v.kind, "viewing"); eq(v.level, "suggest");
});
it("内覧の後×了承 → 申込（材料）", () => {
  const v = resolveAppealTiming(base({ scene: "post_viewing", customer: "ack" }));
  eq(v.kind, "apply");
});
it("物件オススメ後×検討×1部屋のみ → 申込（1部屋のみの形）", () => {
  const v = resolveAppealTiming(base({ customer: "thinking", onlyOneRoom: true, scarcity: true }));
  eq(v.kind, "apply"); eq(v.line, APPEAL_LINES.apply_scarce);
});
it("質問 → 入れない（答えるだけ）", () => {
  const v = resolveAppealTiming(base({ scene: "after_estimate", customer: "question" }));
  eq(v.kind, "none"); eq(v.level, "avoid");
});
it("懸念・条件変更・断り → 入れない", () => {
  for (const c of ["concern", "condition_change", "decline"] as const) eq(resolveAppealTiming(base({ customer: c })).level, "avoid", c);
});
it("内覧の取り消し → 別日のご案内", () => {
  const v = resolveAppealTiming(base({ customer: "decline", viewingCancelled: true }));
  eq(v.kind, "viewing"); eq(v.line, APPEAL_LINES.viewing_reschedule);
});
it("内覧の日にちが決まった後×了承 → 入れない（誘い直さない）", () => {
  eq(resolveAppealTiming(base({ scene: "viewing_confirmed", customer: "ack" })).level, "avoid");
});
it("内覧の調整中×しばらく来られない → 申込（抑えた状態でご内覧）", () => {
  const v = resolveAppealTiming(base({ scene: "viewing_adjusting", customer: "other", viewingDelayed: true }));
  eq(v.kind, "apply");
});
it("内覧の希望×空室 → 受ける（ご案内させて頂きます・日時は AIX）", () => {
  const v = resolveAppealTiming(base({ customer: "viewing_wish" }));
  eq(v.kind, "viewing"); eq(v.line, APPEAL_LINES.viewing_accept); has(v.note, "AIX【内覧へ！】");
});
it("内覧の希望×退去予定 → 申込（抑えた状態でご内覧）", () => {
  eq(resolveAppealTiming(base({ customer: "viewing_wish", room: "move_out_not_viewable" })).kind, "apply");
});
it("申込の意思 → 入れない（受けて手続き）", () => {
  eq(resolveAppealTiming(base({ customer: "apply_intent" })).level, "avoid");
});
it("申込へ！の直後 → 入れない", () => {
  eq(resolveAppealTiming(base({ scene: "after_apply_push", customer: "ack" })).level, "avoid");
});

console.log("buildAppealInput / resolveAppealFromConversation（会話から）");
const chinshan = [
  { sender: "staff", text: "🌟カシミマンション 401号室\n\n（オススメポイント）\n・家賃86,000円・共益費4,000円・水道代3,000円（合計93,000円）\n・リノベーション物件・角部屋", createdAt: "2026-10-05T07:22:00Z" },
  { sender: "staff", text: "こちらのお部屋如何でしょうか！！\n\nリノベーション済みの角部屋で南向き・エアコン3基新設と設備も充実しており、チンシャンさんにかなりオススメ出来るお部屋となります！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！\nお手隙の際にご査収ください😊！！", createdAt: "2026-10-05T07:25:00Z" },
  { sender: "customer", text: "いいですね！", createdAt: "2026-10-05T10:46:00Z" },
];
it("チンシャン 10/05 19:46 の会話 → 物件オススメ後×前向き×空室 → 内覧（必須）", () => {
  const r = resolveAppealFromConversation({ msgs: chinshan, aixLogs: [{ aixType: "property_recommendation", at: "2026-10-05T07:25:00Z" }] });
  if (!r) throw new Error("null");
  eq(r.input.scene, "after_recommend"); eq(r.input.customer, "positive"); eq(r.input.room, "vacant");
  eq(r.verdict.kind, "viewing"); eq(r.verdict.level, "must");
});
it("チンシャン: 2段の見積書の約束の方向に内覧の訴求を1文足す", () => {
  const r = resolveAppealFromConversation({ msgs: chinshan, aixLogs: [{ aixType: "property_recommendation", at: "2026-10-05T07:25:00Z" }] })!;
  const dir = "最大限割引した初期費用の御見積書を作成しお送りすると約束する返信にする（金額は書かない・送るのは後で AIX【見積書送る】）。言い方は実際の送信の形「最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！」同じ発言の他のご希望・ご質問（内覧の日時のご希望など）にも一言ずつ応える（例: ご希望の日時でご案内出来るよう合わせて確認する）。";
  const out = withAppealDirection(dir, r.verdict)!;
  has(out, APPEAL_LINES.viewing);
});
const rConv = [
  { sender: "staff", text: "【カーサピエント 203号室】\n\n初期費用：355,880円\n\nスモラなら一般的な不動産業者より70,400円節約出来ます！！", createdAt: "2026-10-04T07:06:00Z" },
  { sender: "staff", text: "お待たせ致しました！！\n初期費用の御見積書となります！！", createdAt: "2026-10-04T07:08:00Z" },
  { sender: "customer", text: "見積もりありがとうございます。\nエアコンの件よろしくお願いします！", createdAt: "2026-10-04T07:11:00Z" },
  { sender: "staff", text: "はい😊！！\n\nエアコンの件、明日確認してご連絡させて頂きます😌！！", createdAt: "2026-10-04T07:17:00Z" },
  { sender: "staff", text: "Rさん\nお世話になっております！！\n\n管理会社にエアコンの件確認させていただき、リビング洋室共に備わっております。とのご返答でした！！\n\nお手隙の際にご確認の程よろしくお願いいたします！！", createdAt: "2026-10-05T01:41:00Z" },
  { sender: "customer", text: "確認していただきありがとうございます！\n検討します！", createdAt: "2026-10-05T06:57:00Z" },
];
it("R 10/05 15:57 の会話 → 見積書後×検討します×空室 → 申込（材料）", () => {
  const r = resolveAppealFromConversation({ msgs: rConv, aixLogs: [{ aixType: "estimate_sheet", at: "2026-10-04T07:06:00Z" }] });
  if (!r) throw new Error("null");
  eq(r.input.scene, "after_estimate"); eq(r.input.customer, "thinking"); eq(r.verdict.kind, "apply"); eq(r.verdict.level, "suggest");
  has(buildAppealReplyNote(r.verdict), "- 【訴求のタイミング】");
});
it("材料（suggest）の時は方向に足さない", () => {
  const r = resolveAppealFromConversation({ msgs: rConv, aixLogs: [{ aixType: "estimate_sheet", at: "2026-10-04T07:06:00Z" }] })!;
  eq(withAppealDirection("検討中のお客様をごゆっくりと受け止める", r.verdict), "検討中のお客様をごゆっくりと受け止める");
});
it("退去予定の物件オススメ → 部屋はまだ見られない（月で判定）", () => {
  const i = buildAppealInput({
    msgs: [
      { sender: "staff", text: "🌟ラージヒル鶴見緑地\n7月29日退去予定のお部屋となります！！", createdAt: "2026-07-18T03:00:00Z" },
      { sender: "customer", text: "ありがとうございます！！ 検討させてください🙇‍♀️", createdAt: "2026-07-18T09:00:00Z" },
    ],
    aixLogs: [{ aixType: "property_recommendation", at: "2026-07-18T03:00:00Z" }], customerKind: "thinking",
  });
  eq(i.room, "move_out_not_viewable");
  eq(resolveAppealTiming(i).kind, "apply");
});
it("内覧の後の文（本日お時間頂きありがとうございました）→ 内覧後", () => {
  const i = buildAppealInput({
    msgs: [
      { sender: "staff", text: "きえさん本日お時間頂きありがとうございました！！", createdAt: "2026-08-20T09:00:00Z" },
      { sender: "customer", text: "かしこまりました！", createdAt: "2026-08-20T10:00:00Z" },
    ],
    aixLogs: [{ aixType: "meeting_place", at: "2026-08-18T03:00:00Z" }], customerKind: "ack_only",
  });
  eq(i.scene, "post_viewing"); eq(resolveAppealTiming(i).kind, "apply");
});
it("前の内覧の後に別のお部屋を推した → 物件オススメ後（内覧後にしない）", () => {
  const i = buildAppealInput({
    msgs: [
      { sender: "staff", text: "本日はお時間頂きありがとうございました！！", createdAt: "2026-10-01T09:00:00Z" },
      ...chinshan,
    ],
    aixLogs: [], customerKind: "positive",
  });
  eq(i.scene, "after_recommend"); eq(resolveAppealTiming(i).kind, "viewing");
});
// uran. 10/05 の実物（app/lib/__tests__/ack-topic-scope.test.ts と同じ通・名前は実物のまま・個人の値なし）
const uran = [
  { sender: "staff", createdAt: "2026-08-18T08:52:35.589+00:00", text: "かしこまりました！！\n玉造周辺全域でuranさんのご条件に合うお部屋、追加で探させて頂きます😊！！\n\n23日にまとめてご案内出来るよう、ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します😌！！" },
  { sender: "customer", createdAt: "2026-08-23T04:30:32.09+00:00", text: "暑い中ありがとうございました🙇🏼‍♀️" },
  { sender: "staff", createdAt: "2026-08-23T04:35:18.326+00:00", text: "こちらこそ本日はお暑い中ご同行頂きありがとうございました😊！！\n\nお友達の方にこちらのLINE追加いただくようご連絡頂けますと幸いです😌！！" },
  { sender: "customer", createdAt: "2026-10-05T04:06:33.875+00:00", text: "こんにちは！\n\nあと一人紹介してるので連絡くるかもしれないです🙇🏼‍♀️" },
  { sender: "staff", createdAt: "2026-10-05T04:09:35.407+00:00", text: "uran さん\nお世話になっております😊！！\nお友達のご紹介ありがとうございます！！\nご連絡いただけましたら私の方で迅速に対応させて頂きます😌！！" },
  { sender: "customer", createdAt: "2026-10-05T04:10:03.424+00:00", text: "よろしくお願いいたします🙇🏼‍♀️" },
];
it("uran. 10/05: 友達の紹介の締めへのお礼（範囲が閉じている）→ 入れない（内覧の後の申込を持ち込まない）", () => {
  const i = buildAppealInput({ msgs: uran, aixLogs: [{ aixType: "greeting_viewing", at: "2026-08-23T04:35:18.326+00:00" }], customerKind: "ack_only", viewingStage: "done" });
  eq(i.topicClosed, true);
  const v = resolveAppealTiming(i);
  eq(v.kind, "none"); eq(v.level, "avoid");
});
it("物件の話へのお礼（範囲が開いている）は閉じていない扱い", () => {
  const i = buildAppealInput({ msgs: chinshan.concat([{ sender: "staff", text: "はい😊！！\nカシミマンション401号室ご都合よろしいお日にちにご案内させて頂きます！！", createdAt: "2026-10-05T11:00:00Z" }, { sender: "customer", text: "ありがとうございます", createdAt: "2026-10-05T11:05:00Z" }]), aixLogs: [], customerKind: "ack_only" });
  eq(i.topicClosed, false);
});
it("最後がこちらの発言なら決めない", () => {
  eq(resolveAppealFromConversation({ msgs: chinshan.slice(0, 2), aixLogs: [] }), null);
});

console.log("adjustCtaForRoom（AIX の2通目）");
it("退去予定で内覧の誘い → 申込（抑えた状態でご内覧）", () => {
  const g = adjustCtaForRoom({ mode: "push", kind: "viewing" as const, note: "x", reason: "r" }, true);
  eq(g.kind, "apply"); has(g.note, APPEAL_LINES.apply_hold_then_view);
});
it("空室・誘わない時はそのまま", () => {
  eq(adjustCtaForRoom({ mode: "push", kind: "viewing" as const, note: "x", reason: "r" }, false).kind, "viewing");
  eq(adjustCtaForRoom({ mode: "none", kind: null, note: "", reason: "r" }, true).kind, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }

// 返信の文の統括（2026-11-05 作業員9・KB P1 26bfdcbf）
// 実行: npx tsx app/lib/__tests__/reply-compose-conductor.test.ts
// 下書きと送信は本番の竹内さんの番（直近14日に大きく直した24通から・名前は〇〇に伏せた）
import {
  composeConductorOn, readComposeInputs, decideMessageFocus, keepPromiseLine, messageFocusNote, composeOrder, verifyDraft, sendBackDecision, sendBackNote,
  composeConductorDigest, detectOmitKinds, hasKeepPromise, scoreAgainstTakeuchi, prevStaffKindOf, customerAskedNewOf, buildComposeConductor, type FocusInput, type ComposeInputs,
} from "../reply-compose-conductor";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };
const empty: ComposeInputs = { focus: null, plan: null, replyMsg: null, read: [] };
const base = (o: Partial<FocusInput> = {}): FocusInput => ({ inputs: empty, scene: "ack", ackOnly: true, prevStaff: "other", customerAskedNew: false, keepSaidToday: false, ...o });

// スイッチ
t("既定 off", composeConductorOn({}) === false);
t("on で on", composeConductorOn({ COMPOSE_CONDUCTOR: "on" }) === true);

// ① 読む
const r0 = readComposeInputs(null);
t("メタが無い時は全部 null", r0.focus === null && r0.plan === null && r0.replyMsg === null && r0.read.length === 0);
const r1 = readComposeInputs({ conductor_focus: { focus: "relation", why: "お礼だけ", keepPromise: true } });
t("重点と keepPromise を読む（作業員5 の名前）", r1.focus?.focus === "relation" && r1.focus?.keepPromise === true && r1.read.includes("重点"));
const r2 = readComposeInputs({ two_message_plan: { order: "single", count: 1, why: "x", shape: "R", shapeWhy: "", messages: [{ no: 1, slot: "reply", aix: null, answers: ["床の色白ですか？"], role: "受け・答え", duties: ["answer", "trust"] }] } });
t("組み合わせのこの通を読む", r2.replyMsg?.duties.includes("answer") === true || r2.plan === null);

// ② 重点・案A の線
t("条件の番は継続の約束を添える（59%）", keepPromiseLine(base({ scene: "conditions", ackOnly: false })).keep === true);
t("了承の番の既定は添えない（9%）", keepPromiseLine(base()).keep === false);
t("物件を送った後のお礼だけでは添えない（候補・試験 q164・relationKeep）", keepPromiseLine(base({ prevStaff: "property_sent" })).keep === false);
t("募集終了の報告の了承だけでも添えない（候補）", keepPromiseLine(base({ prevStaff: "ended_report" })).keep === false);
t("新着を頼まれたら添える", keepPromiseLine(base({ scene: "considering", customerAskedNew: true })).keep === true);
t("近い番の過半数なら添える", keepPromiseLine(base({ nearKeepShare: 0.6 })).keep === true);
t("今日もう言ったら添えない（1日1回）", keepPromiseLine(base({ scene: "conditions", ackOnly: false, keepSaidToday: true })).keep === false);
t("統括の keepPromise=false に従う", keepPromiseLine(base({ prevStaff: "property_sent", inputs: { ...empty, focus: { focus: "relation", keepPromise: false } } })).keep === false);

const f1 = decideMessageFocus(base({ prevStaff: "property_sent", nearKeepShare: 0.6 }));
t("お礼（物件を送った後）→ relation_keep", f1.key === "relation_keep" && f1.keep && f1.source === "scene", f1);
const f2 = decideMessageFocus(base({ inputs: { ...empty, focus: { focus: "answer", why: "床の色の質問" } }, scene: "question", ackOnly: false }));
t("統括の重点 answer をそのまま（決め直さない）", f2.key === "answer" && f2.source === "conductor");
const f3 = decideMessageFocus(base({ inputs: { ...empty, focus: { focus: "close" } }, scene: "viewing" }));
t("close の番は申込の誘いを止めない", !f3.omit.includes("apply_promise"));
t("了承の番は復唱・言い切り・期日を書かない", ["restate_viewing", "cost_assert", "deadline_promise"].every((k) => decideMessageFocus(base()).omit.includes(k as never)));

// 注記（竹内さんの実送信の形だけ）
const n1 = messageFocusNote(f1, { name: "〇〇" });
t("注記に継続の約束の実送信の形・中身を省かない", n1.includes("引き続き新着で〇〇さんにオススメ出来るお部屋募集に出次第お送りさせて頂きます") && n1.includes("中身を省かない"));
t("注記に書かない事", n1.includes("書かない事"));
t("順番: 設計図 → 書き手 → 確かめ", composeOrder(f2, { blueprint: true }).join(">") === "compose>writer>verify");

// ④ 確かめ（本番の下書き）
const dHours = "かしこまりました！！ お送り頂きました3件の募集状況確認させて頂きます！！ 本日は管理会社の営業時間が終了しておりますので、明日一番で確認しご連絡させて頂きます😌！！";
const sHours = "かしこまりました！！ お送り頂きました合計3物件の募集状況確認させて頂きます！！ 確認出来次第ご連絡させて頂きます😌！！";
t("営業時間の一言を見つける", detectOmitKinds(dHours).includes("hours") && !detectOmitKinds(sHours).includes("hours"));
const dAck = "はい！！ 明日10/29（木）13:00、〇〇103号室にて現地エントランスでお待ちしております！！ お気をつけてお越しくださいませ。 明日何卒よろしくお願い致します！！";
t("内覧の詳細の復唱を見つける", detectOmitKinds(dAck).includes("restate_viewing") && detectOmitKinds("はい！！ 何卒よろしくお願い致します！！").length === 0);
const dApply = "〇〇さん本日お時間頂きありがとうございました！！ お申込しお部屋抑えさせて頂きます！";
t("根拠の無い申込の約束を見つける", detectOmitKinds(dApply).includes("apply_promise"));
t("「お気に召されましたら」付きは申込の約束に数えない", !detectOmitKinds("はい😊！！ お気に召されましたらお申し込みしお部屋押さえさせていただきます😌！！").includes("apply_promise"));
const dApology = "〇〇さん、ご連絡遅くなり申し訳御座いません！！ ご連絡が遅くなり申し訳ございません。 割引は現時点で最大限でございます。";
t("二重の謝罪と割引の言い切り", detectOmitKinds(dApology).includes("double_apology") && detectOmitKinds(dApology).includes("cost_assert"));
const dThanks = "はい😊！！ こちらこそご丁寧にありがとうございます！！ 何卒よろしくお願い致します😌！！";
const sThanks = "はい😊！！ 引き続き新着でオススメできるお部屋募集に出次第お送りさせていただきます！！ 何卒よろしくお願い致します😌！！";
t("継続の約束の有無", !hasKeepPromise(dThanks) && hasKeepPromise(sThanks));
const v1 = verifyDraft(dThanks, f1);
t("重点 relation_keep で継続の約束が無い → 外れ", v1.some((m) => m.kind === "keep_absent"));
t("竹内さんの送信は外れ無し", verifyDraft(sThanks, f1).length === 0, verifyDraft(sThanks, f1));
const sb1 = sendBackDecision(v1, { alreadySentBack: false });
const sb2 = sendBackDecision(v1, { alreadySentBack: true });
t("1回目は統括に戻す・2回目は戻さない", sb1.action === "send_back" && sb2.action === "keep_after_once");
t("外れが無ければ keep", sendBackDecision([], { alreadySentBack: false }).action === "keep");
t("差し戻しの注記", sendBackNote(v1, f1).includes("1回だけ") && sendBackNote([], f1) === "");

// ⑤ digest
const dg = composeConductorDigest({ mf: f1, read: ["重点"], order: composeOrder(f1, { blueprint: false }), misses: v1, action: sb1.action });
t("digest に重点・順・確かめ", dg.includes("重点=relation_keep") && dg.includes("確かめ=keep_absent") && dg.includes("send_back"), dg);

// ⑥ 物差し
const sc = scoreAgainstTakeuchi({ draft: dHours, sent: sHours, mainPoint: "送られた3物件の募集状況を確認して、分かり次第連絡する。", skippedTypes: ["hours"] });
t("原則: 竹内さんに無い営業時間の一言", sc.extraKinds.includes("hours") && sc.skippedButWritten.includes("hours"));
t("要点は当たっている", sc.mainPointHit === true);
t("近さは 0〜1", sc.sim > 0.5 && sc.sim < 1);
const sc2 = scoreAgainstTakeuchi({ draft: dThanks, sent: sThanks });
t("竹内さんが入れた継続の約束が無い", sc2.keepMissed === true && sc2.mainPointHit === null);
const scFloor = scoreAgainstTakeuchi({ draft: "かしこまりました！！ 床の色でご希望のグレーのお部屋が空いているか、確認させて頂きます！！", sent: "こちら床の色グレーとなります！！", mainPoint: "床の色はグレーである" });
t("要点の語（床・グレー）は下書きにある＝語の当たりだけでは要点の外れを拾えない（限界の記録）", scFloor.mainPointHit === true);

// 前の流れ
t("物件を送った", prevStaffKindOf("🔺3口コンロの物件となります。") === "property_sent");
t("申込が入っていた報告", prevStaffKindOf("管理会社確認させていただきましたところ別の方で先にお申込みがはいっておりました。") === "ended_report");
t("開いている約束", prevStaffKindOf("募集状況確認させて頂きます！！") === "promise_open");
t("新着を頼んだ", customerAskedNewOf("また新着でましたらお願いします。") && !customerAskedNewOf("ありがとうございます"));

// route の口（①〜③）
const now = Date.parse("2026-10-28T09:32:00Z"); // JST 18:32
const bc1 = buildComposeConductor({ meta: null, scene: "ack", customerText: "ご丁寧に有難うございます", ackOnly: true, recent: [{ sender: "staff", text: "🔺3口コンロの物件となります。", createdAt: "2026-10-28T09:00:00Z" }, { sender: "customer", text: "ご丁寧に有難うございます" }], name: "〇〇", nowMs: now, blueprint: false, nearKeepShare: 0.6 });
t("口: 物件を送った後のお礼 → 継続の約束の注記", bc1.mf.key === "relation_keep" && bc1.note.includes("新着で〇〇さん") && bc1.order.join(">") === "writer(継続の約束を1つ)>verify", bc1);
const bc2 = buildComposeConductor({ meta: null, scene: "ack", customerText: "ありがとうございます", ackOnly: true, recent: [{ sender: "staff", text: "〇〇さんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！", createdAt: "2026-10-28T08:00:00Z" }, { sender: "staff", text: "🔺物件となります。", createdAt: "2026-10-28T09:00:00Z" }], name: "〇〇", nowMs: now, blueprint: true });
t("口: 今日もう継続の約束を言った → 添えない", bc2.mf.key === "relation_ack" && !bc2.mf.keep);
const bc3 = buildComposeConductor({ meta: { conductor_focus: { focus: "answer", why: "床の色" } }, scene: "question", customerText: "床の色白ですか？", ackOnly: false, recent: [], nowMs: now, blueprint: true });
t("口: 統括の重点を読んだ記録", bc3.read.includes("重点") && bc3.mf.source === "conductor" && bc3.order[0] === "compose");

// 2026-11-06 統括役の決め: 試験では takeuchi_compose_examples が読めず割合が null になる＝(c) の線は配線のテストで実物の割合を入れて確かめる
{
  const recent = [{ sender: "staff", text: "🔺3口コンロの物件となります。", createdAt: "2026-10-28T09:00:00Z" }, { sender: "customer", text: "ありがとうございます" }];
  const run = (share: number | null) => buildComposeConductor({ meta: null, scene: "ack", customerText: "ありがとうございます", ackOnly: true, recent, name: "〇〇", nowMs: now, blueprint: false, nearKeepShare: share });
  t("割合 0.67（近い竹内さんの番の過半数）→ 継続の約束を添える", run(0.67).mf.keep === true && run(0.67).mf.key === "relation_keep");
  t("割合 0.2 → 添えない（物件を送った直後でも）", run(0.2).mf.keep === false && run(0.2).mf.key === "relation_ack");
  t("割合 0.5 ちょうど → 添えない（過半数ではない）", run(0.5).mf.keep === false);
  t("割合 null（試験で読めない時）→ 添えない", run(null).mf.keep === false);
  const cond = buildComposeConductor({ meta: null, scene: "conditions", customerText: "家賃もう少し上げてもいいです", ackOnly: false, recent, nowMs: now, blueprint: false, nearKeepShare: 0.2 });
  t("条件の番は割合に関係なく添える（59%）", cond.mf.keep === true);
}

// 2026-11-06 統括の重点が無い番の既定は「受けて締める」（試験 cc2-on の q023・q164）
{
  const f23 = decideMessageFocus(base({ scene: "viewing", ackOnly: false }));
  t("重点なし・内覧の場面（q023 内覧のキャンセル）→ 決めに行かず受けて締める", f23.key === "relation_ack" && f23.source === "scene");
  const f164 = decideMessageFocus(base({ scene: "question", ackOnly: false }));
  const n164 = messageFocusNote(f164, { name: "〇〇" });
  t("重点なし・質問の場面 → 受けて締める・重点の行も「中身を足さない」も出さない（答えを止めない）", f164.key === "relation_ack" && !n164.includes("この通の重点") && !n164.includes("新しい中身"), n164);
  t("重点なし・条件の番 → 約束（継続の約束つき）", decideMessageFocus(base({ scene: "conditions", ackOnly: false })).key === "promise");
  t("統括の重点がある番は今まで通り（answer）", decideMessageFocus(base({ scene: "viewing", inputs: { ...empty, focus: { focus: "answer" } } })).key === "answer");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

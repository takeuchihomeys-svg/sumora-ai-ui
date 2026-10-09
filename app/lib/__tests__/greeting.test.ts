// G32（2026-09-09 Fable5 じゅにあ事例）: 冒頭二層（挨拶行＋開口語）の回帰テスト。「お待たせ致しました」は如何なる場合も出ない。
// 実行: npx tsx app/lib/__tests__/greeting.test.ts（全 PASS で exit 0）
import {
  resolveGreeting, enforceOpening, buildGreetingNote, stripWaited, isProgressPushMessage, normalizeGreetingLite, toGreetingLite, buildFirstGreeting, continuedSameDay, computeAlreadyGreetedToday,
} from "../greeting";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "../reply-context";
import { runDeterministicChecks } from "../final-check";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (Array.isArray(actual) ? !actual.includes(item) : typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    not: { toContain(item: unknown) { if (Array.isArray(actual) ? actual.includes(item) : typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); } },
    toStartWith(prefix: string) { if (typeof actual !== "string" || !actual.startsWith(prefix)) throw new Error(`expected ${JSON.stringify(actual)} to start with ${JSON.stringify(prefix)}`); },
  };
}

type M = { sender: string; text: string; createdAt: string };
const NOW_1616 = Date.parse("2026-09-09T07:16:00Z"); // JST 16:16
const isSub = (t: string) => analyzeSubstance(t).has;
/** generate-reply と同じ順で decision を作る（classifyCustomerResponse → resolveGreeting） */
function decide(msgs: M[], now: number, jstHour: number, extra: { isFirst?: boolean; deliverable?: boolean; greetedToday?: boolean } = {}) {
  const lastStaff = [...msgs].reverse().find((m) => m.sender === "staff");
  const custs = msgs.slice(msgs.findIndex((m) => m === lastStaff) + 1).filter((m) => m.sender === "customer").map((m) => m.text).join("\n");
  const staff = classifyLastStaffTurn(lastStaff?.text ?? "", { lastStaffAt: lastStaff?.createdAt ?? null });
  const sub = analyzeSubstance(custs, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const cr = classifyCustomerResponse(sub, staff);
  const greetedToday = extra.greetedToday ?? (lastStaff ? Date.parse(lastStaff.createdAt) >= Date.parse("2026-09-08T15:00:00Z") : false);
  return resolveGreeting({
    customerName: "じゅにあ", isFirstEverReply: !!extra.isFirst, alreadyGreetedToday: greetedToday, recentMessages: msgs, jstHour, now,
    isProgressPush: isProgressPushMessage(custs, { isAckOnly: sub.isAckOnly }), isSubstantive: isSub,
    customerKind: cr.kind, customerSecondary: cr.secondary, substanceKinds: sub.kinds, isDeliverableReply: !!extra.deliverable,
  });
}
const JUNIA: M[] = [
  { sender: "staff", text: "じゅにあさんお世話になっております！！\nはい😊！！ごゆっくりご検討頂けますと幸いです！！\n\nまたじゅにあさんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きますので、気になる点等出てきましたら何時でもお気軽にご連絡ください😌！！", createdAt: "2026-09-09T02:13:16Z" },
  { sender: "customer", text: "よろしくお願いします🙇‍♀️", createdAt: "2026-09-09T02:45:31Z" },
  { sender: "customer", text: "我孫子駅から天王寺駅までの間で探して頂いてもいいですか？", createdAt: "2026-09-09T06:36:54Z" },
  { sender: "customer", text: "出来たらネット環境がある物件が良いです。", createdAt: "2026-09-09T06:37:16Z" },
];
const BODY = "我孫子駅から天王寺駅までの間で探させて頂きます！！ネット環境ありのお部屋も含めてじゅにあさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します！！";

describe("じゅにあ事例", () => {
  it("T1 16:16 当日挨拶済み＋依頼形 → 挨拶行なし・開口語かしこまりました", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    expect(d.kind).toBe("none"); expect(d.openingLine).toBe(""); expect(d.opener).toBe("kashikomari");
    expect(buildGreetingNote(d, 16)).not.toContain("必ず「");
    expect(buildGreetingNote(d, 16)).toContain("かしこまりました");
  });
  it("T1b AI旧生成「じゅにあさんお待たせ致しました！！」は剥がれ、正解文はそのまま通る", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    const bad = enforceOpening(`じゅにあさんお待たせ致しました！！\n${BODY}`, d);
    expect(bad.cleaned).not.toContain("お待たせ"); expect(bad.cleaned).toStartWith("我孫子駅");
    const ok = enforceOpening(`かしこまりました😊！！\n${BODY}`, d);
    expect(ok.cleaned).toBe(`かしこまりました😊！！\n${BODY}`); expect(ok.fixes.length).toBe(0);
  });
  it("T2 同じ会話で 15:36 依頼を 4h 放置（JST 19:36）→ それでも お待たせ は出ず かしこまりました", () => {
    const d = decide(JUNIA, Date.parse("2026-09-09T10:36:54Z"), 19);
    expect(d.kind).toBe("none"); expect(d.opener).toBe("kashikomari");
    expect(d.audit.waitedMs).toBe(4 * 3600 * 1000);
    expect(d.audit.originTextHead ?? "").toStartWith("我孫子駅"); // 起点は了承のみ(11:45)ではなく実質のある依頼
    expect(buildGreetingNote(d, 19)).not.toContain("必ず「");
  });
  it("T3 final-check ⑦: 正解文は OPENING_GREETING_*／OPENER_MISMATCH／BANNED_WORD を出さない", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    const codes = runDeterministicChecks(`かしこまりました😊！！\n${BODY}`, { recentMessages: JUNIA, lastCustomerMessage: JUNIA[3].text, customerName: "じゅにあ", greetingDecision: toGreetingLite(d) }).map((i) => i.code);
    expect(codes.some((c) => c.startsWith("OPENING_GREETING") || c === "OPENER_MISMATCH" || c === "BANNED_WORD")).toBe(false);
  });
  it("T4 final-check: 「お待たせ致しました」を含む文は BANNED_WORD block", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    const issues = runDeterministicChecks(`じゅにあさんお待たせ致しました！！\n${BODY}`, { recentMessages: JUNIA, lastCustomerMessage: JUNIA[3].text, customerName: "じゅにあ", greetingDecision: toGreetingLite(d) });
    expect(issues.some((i) => i.code === "BANNED_WORD" && i.severity === "block" && /お待たせ/.test(i.evidence ?? ""))).toBe(true);
  });
});

describe("挨拶行の決定", () => {
  const YESTERDAY_STAFF: M = { sender: "staff", text: "じゅにあさんお世話になっております！！\n🌟サンピアザ 503号室\nお手隙の際にご査収ください😌！！", createdAt: "2026-09-08T05:30:00Z" };
  it("T5 了承のみを 5h 放置・当日未挨拶 → standard（お世話に）＋はい", () => {
    const d = decide([YESTERDAY_STAFF, { sender: "customer", text: "よろしくお願いします🙇", createdAt: "2026-09-09T02:00:00Z" }], NOW_1616, 16);
    expect(d.kind).toBe("standard"); expect(d.openingLine).toBe("じゅにあさんお世話になっております！！"); expect(d.opener).toBe("hai");
    expect(d.audit.waitedMs).toBe(null); // 了承のみは起点にならない
  });
  it("T5b 了承のみ 5h 放置・当日挨拶済み → none＋はい", () => {
    const d = decide([{ ...YESTERDAY_STAFF, createdAt: "2026-09-09T01:00:00Z" }, { sender: "customer", text: "ありがとうございます！", createdAt: "2026-09-09T02:00:00Z" }], NOW_1616, 16);
    expect(d.kind).toBe("none"); expect(d.opener).toBe("hai");
  });
  it("T6 約束の結果報告（deliverable）当日未挨拶 → お世話に＋開口語なし。当日挨拶済み → 挨拶行なし。どちらも お待たせ は出ない", () => {
    const req: M = { sender: "customer", text: "こちらの物件の空室確認お願いします", createdAt: "2026-09-09T00:00:00Z" };
    const a = decide([YESTERDAY_STAFF, req], NOW_1616, 16, { deliverable: true });
    expect(a.kind).toBe("standard"); expect(a.opener).toBe("none"); expect(buildGreetingNote(a, 16)).not.toContain("お待たせ致しました」で");
    const b = decide([YESTERDAY_STAFF, req], NOW_1616, 16, { deliverable: true, greetedToday: true });
    expect(b.kind).toBe("none"); expect(b.openingLine).toBe(""); expect(b.opener).toBe("none");
    const out = enforceOpening("じゅにあさんお待たせ致しました！！\n🌟サンピアザ 503号室 現在募集中となります！！\nお手隙の際にご査収ください😌！！", b);
    expect(out.cleaned).toStartWith("🌟サンピアザ"); expect(out.cleaned).not.toContain("お待たせ");
  });
  it("T7 情報質問 → 開口語なし（はい／かしこまりました も許容）。「はい！！」で始めた生成はそのまま", () => {
    const d = decide([YESTERDAY_STAFF, { sender: "customer", text: "この物件の初期費用はいくらになりますか？", createdAt: "2026-09-09T06:00:00Z" }], NOW_1616, 16, { greetedToday: true });
    expect(d.opener).toBe("none"); expect(d.openerAllowed).toContain("hai");
    expect(enforceOpening("はい😊！！\n初期費用は約25万円となります！！", d).cleaned).toBe("はい😊！！\n初期費用は約25万円となります！！");
  });
  it("T8 初回 → first・はじめまして固定・開口語なし", () => {
    const d = decide([{ sender: "customer", text: "難波で1LDK探してます", createdAt: "2026-09-09T06:00:00Z" }], NOW_1616, 16, { isFirst: true });
    expect(d.kind).toBe("first"); expect(d.openingLine).toBe(buildFirstGreeting("じゅにあ")); expect(d.opener).toBe("none");
    expect(enforceOpening("かしこまりました！！\n難波周辺でピックアップさせて頂きます！！", d).cleaned).toStartWith(buildFirstGreeting("じゅにあ"));
  });
  // 2026-09-12 竹内（Aoi 事例）: 返信に「夜遅くに失礼します」は入れない → 深夜でも夜間接頭辞は付けない（旧 T9 は付与を期待していた）
  it("T9 深夜（JST 23 時・直前スタッフ発言 5h 前・当日挨拶済み）→ 夜間接頭辞は付けない", () => {
    const d = decide([{ ...YESTERDAY_STAFF, createdAt: "2026-09-09T09:00:00Z" }, { sender: "customer", text: "2LDKでも探してもらえますか？", createdAt: "2026-09-09T13:50:00Z" }], Date.parse("2026-09-09T14:00:00Z"), 23);
    expect(d.kind).toBe("none"); expect(d.openingLine).toBe(""); expect(d.opener).toBe("kashikomari");
    expect(enforceOpening("かしこまりました！！\n2LDKでもピックアップさせて頂きます！！", d).cleaned).toStartWith("かしこまりました！！");
  });
  it("T10 当日挨拶済み＋依頼: LLM が「お世話になっております」を書いても剥がれて かしこまりました のみ", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    expect(enforceOpening(`じゅにあさんお世話になっております！！\nかしこまりました！！\n${BODY}`, d).cleaned).toStartWith("かしこまりました！！\n我孫子駅");
  });
});

describe("催促（late_apology）", () => {
  const staff: M = { sender: "staff", text: "かしこまりました！！\n空室確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", createdAt: "2026-09-09T01:00:00Z" };
  it("T11 「まだですか？連絡ないんですけど」→ late_apology・開口語なし", () => {
    const d = decide([staff, { sender: "customer", text: "空室確認まだですか？連絡ないんですけど", createdAt: "2026-09-09T06:00:00Z" }], NOW_1616, 16);
    expect(d.kind).toBe("late_apology"); expect(d.openingLine).toBe("じゅにあさん、ご連絡遅くなり申し訳御座いません！！"); expect(d.opener).toBe("none");
  });
  it("T12 催促の実質が無い（了承のみ・依頼 4h 放置）では late_apology にならない", () => {
    expect(isProgressPushMessage("よろしくお願いします🙇", { isAckOnly: true })).toBe(false);
    expect(isProgressPushMessage("ありがとうございます、お願いします", { isAckOnly: true })).toBe(false);
    const d = decide([staff, { sender: "customer", text: "我孫子駅から天王寺駅までの間で探して頂いてもいいですか？", createdAt: "2026-09-09T03:00:00Z" }], NOW_1616, 16);
    expect(d.kind).toBe("none"); expect(d.opener).toBe("kashikomari");
  });
});

describe("開口語の後処理・禁止語", () => {
  it("T13 承知いたしました → かしこまりました に正規化", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    expect(enforceOpening(`承知いたしました！！\n${BODY}`, d).cleaned).toStartWith("かしこまりました！！\n");
  });
  it("T14 了承のみに LLM が かしこまりました → はい に置換", () => {
    const d = decide([{ sender: "staff", text: "🌟サンピアザ 503号室\nお手隙の際にご査収ください😌！！", createdAt: "2026-09-09T05:00:00Z" }, { sender: "customer", text: "ありがとうございます！仕事終わりに見させて頂きます", createdAt: "2026-09-09T06:00:00Z" }], NOW_1616, 16);
    expect(d.opener).toBe("hai");
    expect(enforceOpening("かしこまりました😊！！\nごゆっくりご確認ください！！", d).cleaned).toBe("はい😊！！\nごゆっくりご確認ください！！");
  });
  it("T15 文中2行目の「お待たせいたしました」も除去される", () => {
    const r = stripWaited("かしこまりました！！\nじゅにあさんお待たせいたしました！！ 募集状況確認させて頂きました！！\nお手隙の際にご査収ください😌！！");
    expect(r.removed).toBe(1); expect(r.text).not.toContain("お待たせ"); expect(r.text).toContain("募集状況確認させて頂きました！！");
  });
  it("T16 旧 DB 形式 kind=waited の復元は standard に写像し、お待たせ→お世話に", () => {
    const l = normalizeGreetingLite({ kind: "waited", opening: "じゅにあさんお待たせ致しました！！", reason: "返信まで約5時間" });
    expect(l?.kind).toBe("standard"); expect(l?.openingLine).toBe("じゅにあさんお世話になっております！！");
  });
  it("T17 final-check ⑦: none なのに お世話に 開始 → OPENING_GREETING_UNEXPECTED、了承場面で かしこまりました → OPENER_MISMATCH", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    const c1 = runDeterministicChecks(`じゅにあさんお世話になっております！！\nかしこまりました！！\n${BODY}`, { recentMessages: JUNIA, lastCustomerMessage: JUNIA[3].text, customerName: "じゅにあ", greetingDecision: toGreetingLite(d) }).map((i) => i.code);
    expect(c1).toContain("OPENING_GREETING_UNEXPECTED");
    const ack: M[] = [JUNIA[0], { sender: "customer", text: "ありがとうございます！検討します", createdAt: "2026-09-09T06:00:00Z" }];
    const d2 = decide(ack, NOW_1616, 16);
    const c2 = runDeterministicChecks("かしこまりました！！\nごゆっくりご検討頂けますと幸いです！！", { recentMessages: ack, lastCustomerMessage: ack[1].text, customerName: "じゅにあ", greetingDecision: toGreetingLite(d2) }).map((i) => i.code);
    expect(c2).toContain("OPENER_MISMATCH");
  });
});

describe("2026-09-12 竹内（あや事例）: 条件フォームを送ってくれた → 感謝してピックアップ宣言", () => {
  const ASK: M = { sender: "staff", text: "よろしければ、私の方でご希望のご条件に合ったお部屋お探しさせて頂きます！\nお手隙の際にご入力頂きますと、ご条件に合ったお部屋ピックアップしお送りさせて頂きます😌！！", createdAt: "2026-09-06T14:15:16Z" };
  const FORM: M = { sender: "customer", text: "（あやさんご希望のお部屋探しご条件）\n①ご入居時期　10月29日〜11月1日\n②ご希望家賃（管理費込み）　6万〜7万\n③ご希望間取り　1K、1LDK\n⑤ご希望エリア・最寄り駅　大国町", createdAt: "2026-09-06T18:42:52Z" };
  const NOW = Date.parse("2026-09-07T03:15:00Z");
  it("F1 フォーム記入の依頼は条件ヒアリング・フォームは条件の提示", () => {
    const staff = classifyLastStaffTurn(ASK.text);
    const cr = classifyCustomerResponse(analyzeSubstance(FORM.text), staff);
    expect(staff.kind).toBe("condition_ask"); expect(cr.kind).toBe("condition_change");
  });
  it("F2 開口語は かしこまりました ではなく感謝（conditionFormThanks）", () => {
    const d = decide([ASK, FORM], NOW, 12);
    expect(d.opener).toBe("none"); expect(d.conditionFormThanks).toBe(true);
    expect(buildGreetingNote(d, 12)).toContain("ご条件お送り頂きありがとうございます😊！！");
  });
  it("F3 「かしこまりました！！」で始めた下書き → 感謝の1文に置き換わる", () => {
    const d = decide([ASK, FORM], NOW, 12);
    expect(enforceOpening("かしこまりました！！\n大国町周辺全域から6万〜7万・1K、1LDKでピックアップしお送りさせて頂きます！！", d).cleaned)
      .toStartWith("じゅにあさんお世話になっております！！\nご条件お送り頂きありがとうございます😊！！\n大国町周辺全域から"); // 10/08 今日はじめての会話文は必ず挨拶の行
  });
  it("F4 既に感謝がある下書きは足さない", () => {
    const d = decide([ASK, FORM], NOW, 12);
    const t = "ご条件お送り頂きありがとうございます😊！！\n大国町周辺全域からピックアップしお送りさせて頂きます！！";
    expect(enforceOpening(t, d).cleaned).toBe(`じゅにあさんお世話になっております！！\n${t}`); // 10/08 感謝は足さない・挨拶の行だけ置く
  });
});

describe("2026-09-18 竹内（ゆうこ事例）: かしこまりました と はい の使い分けは「返信の中身」で決まる", () => {
  // 実データ（365日・お客様の質問への返信1,112件。依頼形の質問は除く）
  //   その場で答える  … はい 76 ／ かしこまりました 29
  //   これから動く    … はい 36 ／ かしこまりました 175
  const STAFF: M = { sender: "staff", text: "🌟昭和町ハイツ 302号室\nお手隙の際にご査収ください😌！！", createdAt: "2026-09-18T02:00:00Z" };
  const ASK: M = { sender: "customer", text: "昭和町駅周辺の治安はどうですか？", createdAt: "2026-09-18T05:00:00Z" };
  const NOW = Date.parse("2026-09-18T06:00:00Z");
  const ANSWER_BODY = "昭和町駅周辺は住宅街も多く、治安面で特別懸念となる点はございません！！\nご不安な点等ございましたら、いつでもお申し付けください！！";

  it("Y1 治安の質問 → 返信の中身で決める線が立つ（openerBodyRule）", () => {
    const d = decide([STAFF, ASK], NOW, 15, { greetedToday: true });
    expect(d.openerBodyRule).toBe(true);
    expect(buildGreetingNote(d, 15)).toContain("返信の中身");
  });
  it("★ Y2 生成「かしこまりました😊！！」＋その場で答える本文 → 実送信どおり「はい😊！！」になる", () => {
    const d = decide([STAFF, ASK], NOW, 15, { greetedToday: true });
    const out = enforceOpening(`かしこまりました😊！！\n${ANSWER_BODY}`, d);
    expect(out.cleaned).toBe(`はい😊！！\n${ANSWER_BODY}`);
  });
  it("Y3 その場で答える本文に「はい」は触らない（絵文字もそのまま）", () => {
    const d = decide([STAFF, ASK], NOW, 15, { greetedToday: true });
    const t = `はい😊！！\n${ANSWER_BODY}`;
    expect(enforceOpening(t, d).cleaned).toBe(t);
  });
  it("★ Y4 引き受け・承諾の側は触らない（実データ はい77／かしこまりました227 で割れるため）", () => {
    const d = decide([STAFF, ASK], NOW, 15, { greetedToday: true });
    // これから動く側に新ルールは関与しない（ここが かしこまりました になるのは従来どおり
    //  「エリアの質問は substance に condition が付く → allowed=[かしこまりました/なし]」という既存の線）
    const move = "昭和町駅周辺の治安について管理会社に確認させて頂きます！！";
    // 2026-10-02: 「はい」＋これから動く中身は入れ替えない（実データ はい77／かしこまりました227＝はいも普通に使う。
    //   人の実送信 46通を出口が入れ替えていた・scripts/audit-exits-vs-human.ts）。旧の期待値は かしこまりました への入れ替え
    expect(enforceOpening(`はい😊！！\n${move}`, d).cleaned).toBe(`はい😊！！\n${move}`);
    expect(enforceOpening(`かしこまりました😊！！\n${move}`, d).cleaned).toBe(`かしこまりました😊！！\n${move}`);
    // お客様のご希望を飲む（「13時は可能ですか？」の型。実送信29件がこれだった）
    const accept = "かしこまりました😊！！\n8月9日13:00でご案内可能です😊！！";
    expect(enforceOpening(accept, d).cleaned).toBe(accept);
  });
  it("Y5 どちらとも取れない本文は触らない（fail-closed）", () => {
    const d = decide([STAFF, ASK], NOW, 15, { greetedToday: true });
    const t = "かしこまりました😊！！\n引き続き何卒よろしくお願い致します";
    expect(enforceOpening(t, d).cleaned).toBe(t);
  });
  it("Y6 依頼形の質問（探して頂けますか）＋引き受けの本文 → かしこまりました のまま", () => {
    const d = decide(JUNIA, NOW_1616, 16);
    expect(enforceOpening(`かしこまりました😊！！\n${BODY}`, d).cleaned).toStartWith("かしこまりました😊！！");
  });
  it("★ Y8 検査も同じ線を見る（四者同名）: 直した「はい😊！！」に OPENER_MISMATCH を出さない", () => {
    const d = decide([STAFF, ASK], NOW, 15, { greetedToday: true });
    const codes = runDeterministicChecks(`はい😊！！\n${ANSWER_BODY}`, {
      recentMessages: [STAFF, ASK], lastCustomerMessage: ASK.text, customerName: "ゆうこ", greetingDecision: toGreetingLite(d),
    }).map((i) => i.code);
    expect(codes).not.toContain("OPENER_MISMATCH");
    // 逆に「引き受け」の語で始めた文は、この場面の許容外として拾う
    const codes2 = runDeterministicChecks(`かしこまりました😊！！\n${ANSWER_BODY}`, {
      recentMessages: [STAFF, ASK], lastCustomerMessage: ASK.text, customerName: "ゆうこ", greetingDecision: toGreetingLite(d),
    }).map((i) => i.code);
    expect(codes2).toContain("OPENER_MISMATCH");
  });
  it("H1 2026-10-02 人の実送信「今からでも大丈夫ですか？」→「はい！！お手隙の際にお電話おかけください！！」はそのまま", () => {
    const d = decide([STAFF, { sender: "customer", text: "今からでも大丈夫ですか？", createdAt: "2026-09-18T05:00:00Z" }], NOW, 15, { greetedToday: true });
    const t = "はい！！\nお手隙の際にお電話おかけください！！";
    expect(enforceOpening(t, d).cleaned).toBe(t);
  });
  it("H2 人の実送信「抑えるだけ抑えててもいいんですか？」→「はい！！もちろんです😊！！」はそのまま", () => {
    const d = decide([STAFF, { sender: "customer", text: "抑えるだけ抑えててもいいんですか？", createdAt: "2026-09-18T05:00:00Z" }], NOW, 15, { greetedToday: true });
    const t = "はい！！\nもちろんです😊！！";
    expect(enforceOpening(t, d).cleaned).toBe(t);
  });
  it("H3 人の実送信「お願いします🙇‍♀️」→「かしこまりました！！お部屋お申込みさせていただきます！！」はそのまま（動く中身）", () => {
    const d = decide([STAFF, { sender: "customer", text: "お願いします🙇‍♀️🙇‍♀️", createdAt: "2026-09-18T05:00:00Z" }], NOW, 15, { greetedToday: true });
    const t = "かしこまりました！！\nお部屋お申込みさせていただきます！！";
    expect(enforceOpening(t, d).cleaned).toBe(t);
  });
  it("H4 竹内さんが名指しした場面（はじめまして）は openerStrict＝従来どおり開口語を外す", () => {
    const d = decide([{ sender: "customer", text: "初めまして！お部屋探しています", createdAt: "2026-09-18T05:00:00Z" }], NOW, 15, { isFirst: true });
    expect(d.openerStrict).toBe(true);
    expect(enforceOpening("かしこまりました！！\nお部屋探させて頂きます！！", d).cleaned).not.toContain("かしこまりました");
  });
  it("Y7 依頼ではない場面（了承のみ）には掛けない＝既存の T14 の線が生きる", () => {
    const ack: M[] = [STAFF, { sender: "customer", text: "ありがとうございます！仕事終わりに見させて頂きます", createdAt: "2026-09-18T05:00:00Z" }];
    const d = decide(ack, NOW, 15, { greetedToday: true });
    expect(d.openerBodyRule).toBe(false);
    expect(d.opener).toBe("hai");
  });
});

// 2026-10-02 ⑫: この LINE で最初の返事でも、お客様が以前のやり取りを示す時は「お世話になっております」（実物 22bbce86 9/26・再生 first_contact_05）
describe("以前のお客様の最初の返事（⑫）", () => {
  const first = (t: string) => decide([{ sender: "customer", text: t, createdAt: "2026-09-09T07:10:00Z" }], NOW_1616, 16, { isFirst: true });
  it("お世話になっております → standard・お世話になっております・自己紹介を剥がす", () => {
    const d = first("お世話になっております。\nまだ家探ししてるのですが、相談よろしいでしょうか？");
    expect(d.kind).toBe("standard");
    expect(d.openingLine).toContain("お世話になっております！！");
    const out = enforceOpening("YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\nもちろんです！！", d).cleaned;
    expect(out).not.toContain("はじめまして");
    expect(out).not.toContain("鈴木と申します");
    expect(out).toContain("お世話になっております！！");
  });
  it("紹介で来た人（お世話になっております＋紹介）は初回のまま", () => {
    expect(first("お世話になっております。〇〇様から紹介いただきました、田中と申します。").kind).toBe("first");
  });
  it("挨拶の語が無い初回は初回のまま", () => {
    expect(first("はじめまして！難波周辺で1Kを探しています").kind).toBe("first");
    expect(first("難波周辺で1Kを探しています").kind).toBe("first");
  });
  it("以前お世話になった → standard", () => {
    expect(first("以前お世話になったものです。こちらの物件は仲介手数料無料や礼金の交渉はむずかしい物件なのか").kind).toBe("standard");
  });
});

// 2026-10-02 ⑫ 8巡目: 「お待たせしております」の言い換え（DeepSeek の下書き flow8 t08）も禁止
describe("お待たせの言い換え（⑫）", () => {
  it("お待たせしております の文を落とす", () => {
    const r = stripWaited("YUMAさんお待たせしております😊！！\n本日撮影して参りますので、撮影出来次第お送りさせて頂きます😌！！");
    expect(r.removed).toBe(1);
    expect(r.text).toBe("本日撮影して参りますので、撮影出来次第お送りさせて頂きます😌！！");
  });
  it("お待たせしてしまい申し訳… の謝りは触らない", () => {
    expect(stripWaited("お待たせしてしまい申し訳御座いません！！").removed).toBe(0);
  });
});

// 2026-10-06 ⑫ 朱莉: 続けての会話（お客様の発言がこちらの前の発言と同じ日）に、翌日下書きを作っても挨拶を入れない
describe("会話の続きは挨拶なし（continuedSameDay）", () => {
  const staff = { sender: "staff", text: "かしこまりました！！ご確認させて頂きます😊！！", createdAt: "2026-10-04T09:10:00Z" };
  it("同じ日にお客様が続けた → 続き", () => expect(continuedSameDay([staff as never, { sender: "customer", text: "審査通るかだけ試してもらうことって可能でしょうか？", createdAt: "2026-10-04T09:30:00Z" } as never])).toBe(true));
  it("こちらの後の画像だけの発言は飛ばす", () => expect(continuedSameDay([staff as never, { sender: "staff", text: "[画像]", createdAt: "2026-10-04T09:11:00Z" } as never, { sender: "customer", text: "はい", createdAt: "2026-10-04T10:00:00Z" } as never])).toBe(true));
  it("お客様の発言が翌日（JST）→ 続きではない", () => expect(continuedSameDay([staff as never, { sender: "customer", text: "おはようございます", createdAt: "2026-10-05T01:00:00Z" } as never])).toBe(false));
  // 2026-10-08 8巡目 竹内さん「日にちをまたいだら挨拶を入れている。日にち意識」→ 既定は「その日の最初のこちらの会話文か」だけ（続きの線は GREETING_BY_DAY_R8=off で旧）
  const akari = (now: string) => resolveGreeting({ recentMessages: [staff, { sender: "customer", text: "審査通るかだけ試してもらうことって可能でしょうか？", createdAt: "2026-10-04T09:30:00Z" }], now: Date.parse(now), customerName: "朱莉", isFirstEverReply: false, alreadyGreetedToday: computeAlreadyGreetedToday([staff, { sender: "customer", text: "審査通るかだけ試してもらうことって可能でしょうか？", createdAt: "2026-10-04T09:30:00Z" }], Date.parse(now)) ?? false, jstHour: 11, isSubstantive: (x: string) => analyzeSubstance(x).has, customerKind: null } as never);
  it("8巡目: 日をまたいで送る続きの会話は挨拶の番（standard・必須ではない）", () => expect(akari("2026-10-05T02:00:00Z").kind).toBe("standard"));
  it("8巡目: 同じ日に返す続きは挨拶なし（当日送信済み）", () => expect(akari("2026-10-04T09:40:00Z").kind).toBe("none"));
  it("GREETING_BY_DAY_R8=off で旧（続きは翌日でも挨拶なし）", () => { process.env.GREETING_BY_DAY_R8 = "off"; try { expect(akari("2026-10-05T02:00:00Z").kind).toBe("none"); } finally { delete process.env.GREETING_BY_DAY_R8; } });
});

// 2026-10-08 8巡目: 「今日こちらが送ったか」は資料文（🌟物件カード・【】見積の本体・室内イメージの URL）を数えない（staffTalkedToday と同じ線）
describe("当日の会話文の判定は資料文を数えない（8巡目）", () => {
  const card = { sender: "staff", text: "🌟メゾンクレール 201号室\n〇〇さんにかなりオススメ出来るお部屋となります！！\n（オススメポイント）\n・間取り：2LDK", createdAt: "2026-08-11T09:50:00Z" };
  const url = { sender: "staff", text: "（室内イメージ）\nhttps://www.homes.co.jp/chintai/room/xxxx", createdAt: "2026-08-11T09:51:00Z" };
  const est = { sender: "staff", text: "【L-IDEA MINAMI HORIE（リデア南堀江） 204号室】\n初期費用さらに\n🌟40,000円割引させて頂き", createdAt: "2026-08-11T09:52:00Z" };
  const talk = { sender: "staff", text: "かしこまりました！！ご確認させて頂きます😊！！", createdAt: "2026-08-11T09:53:00Z" };
  const now = Date.parse("2026-08-11T10:04:00Z");
  it("資料文だけの日 → まだ（添え文に挨拶を置ける）", () => expect(computeAlreadyGreetedToday([card, url, est] as never, now)).toBe(false));
  it("会話文がある日 → 済み", () => expect(computeAlreadyGreetedToday([card, talk] as never, now)).toBe(true));
  it("前日の会話文は数えない", () => expect(computeAlreadyGreetedToday([{ ...talk, createdAt: "2026-08-10T09:53:00Z" }] as never, now)).toBe(false));
  it("GREETING_TALK_ONLY_R8=off で旧（資料文も数える）", () => { process.env.GREETING_TALK_ONLY_R8 = "off"; try { expect(computeAlreadyGreetedToday([card] as never, now)).toBe(true); } finally { delete process.env.GREETING_TALK_ONLY_R8; } });
});

// 2026-10-07 7巡目: 開口語なしの決定で「〜で始めても良い」と誘わない（人は本題から 6〜8割）
describe("開口語なしの決定の注記（7巡目）", () => {
  const base = resolveGreeting({ recentMessages: [{ sender: "staff", text: "お送りさせて頂きました！！", createdAt: "2026-10-04T09:10:00Z" }, { sender: "customer", text: "駐車場は近くのパーキングでよろしいですか？", createdAt: "2026-10-04T09:30:00Z" }], now: Date.parse("2026-10-04T09:31:00Z"), customerName: "YUMA", isFirstEverReply: false, alreadyGreetedToday: true, jstHour: 14, isSubstantive: (x: string) => analyzeSubstance(x).has, customerKind: "question" } as never);
  it("情報質問は開口語なし・本題から 6〜8割と書く", () => { expect(base.opener).toBe("none"); expect(buildGreetingNote(base, 14)).toContain("本題から書き出すのが6〜8割"); expect(buildGreetingNote(base, 14)).not.toContain("で始めても良い"); });
  it("物件を送ってきただけ（URL のみ）→ かしこまりましたで始めないと書く", () => {
    const d = resolveGreeting({ recentMessages: [{ sender: "staff", text: "お送りさせて頂きました！！", createdAt: "2026-10-04T09:10:00Z" }, { sender: "customer", text: "キャナルコート神田 5階\nhttps://suumo.jp/chintai/bc_100527822742/\nby SUUMO", createdAt: "2026-10-04T09:30:00Z" }], now: Date.parse("2026-10-04T09:31:00Z"), customerName: "YUMA", isFirstEverReply: false, alreadyGreetedToday: true, jstHour: 14, isSubstantive: (x: string) => analyzeSubstance(x).has, customerKind: null } as never);
    expect(d.propertyShareNoAsk).toBe(true); expect(buildGreetingNote(d, 14)).toContain("物件を送ってきただけ");
  });
  it("物件＋「初期費用いくらですか？」は当てない", () => {
    const d = resolveGreeting({ recentMessages: [{ sender: "customer", text: "ここの初期費用いくらですか？\nTC天美南 1階\nhttps://suumo.jp/chintai/bc_100527713926/", createdAt: "2026-10-04T09:30:00Z" }, { sender: "staff", text: "x", createdAt: "2026-10-04T09:00:00Z" }].reverse(), now: Date.parse("2026-10-04T09:31:00Z"), customerName: "YUMA", isFirstEverReply: false, alreadyGreetedToday: true, jstHour: 14, isSubstantive: (x: string) => analyzeSubstance(x).has, customerKind: null } as never);
    expect(!!d.propertyShareNoAsk).toBe(false);
  });
  it("GREETING_OPENER_R7=off で前の文", () => { process.env.GREETING_OPENER_R7 = "off"; try { expect(buildGreetingNote(base, 14)).toContain("で始めても良い"); } finally { delete process.env.GREETING_OPENER_R7; } });
});

describe("10/09 竹内さん: その日最初でも了承・お礼だけの番は挨拶を省いてよい", () => {
  const staff = { sender: "staff", text: "ピックアップしお送りさせて頂きます！！", createdAt: "2026-10-03T09:10:00Z" };
  const g = (text: string) => resolveGreeting({ recentMessages: [staff, { sender: "customer", text, createdAt: "2026-10-04T09:30:00Z" }], now: Date.parse("2026-10-04T09:31:00Z"), customerName: "YUMA", isFirstEverReply: false, alreadyGreetedToday: false, jstHour: 18, isSubstantive: (x: string) => analyzeSubstance(x).has, customerKind: null } as never);
  it("お願いします🙏 → 挨拶は必ずではない", () => expect(g("お願いします🙏").enforce).toBe(false));
  it("質問の番 → 今まで通り必ず", () => expect(g("駐車場はありますか？").enforce).toBe(true));
  it("GREETING_SKIP_ACK_DAILY=off で旧（必ず）", () => { process.env.GREETING_SKIP_ACK_DAILY = "off"; try { expect(g("お願いします🙏").enforce).toBe(true); } finally { delete process.env.GREETING_SKIP_ACK_DAILY; } });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }

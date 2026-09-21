// 直前に自分が送った文を「繰り返さないための材料」に変える（竹内 2026-09-21）。
//
// 竹内「生成した文は送った内容と同じ内容を再度送っていた形となるので、これを防ぐ。
//   全く同じ内容いれたら文がおかしいので、ここの根本的な原因を見つける」
//
// ⚠ テストに使う本文は**全部実物**（scripts/audit-repeat-previous.ts・audit-after-ack.ts が
//   直近180日の実送信から拾った物）。想像で作った文は使わない。
//
// 実行: npx tsx app/lib/__tests__/previous-send-note.test.ts（全 PASS で exit 0）
import {
  buildPreviousSendNote, extractClosingClauses, extractConcreteFacts, classifyClosings,
  shouldSkipDraftAfterClosing, isShortAckOnly,
  AFTER_ACK_MEDIAN_CHARS,
} from "../previous-send-note";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    notToContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} NOT to contain ${JSON.stringify(item)}`); },
  };
}

// ── 実物（竹内さんのスクショ・9/02・9/07・9/12・9/15 の実送信）──
const SCREENSHOT = "はい！！\nその間もゆーたさん気になる点出てきましたらお気軽にご質問ください😊！！\n何卒よろしくお願い致します！！";
const VIEWING_FIXED = "かしこまりました！！\n9/8（火）ご案内させて頂きます！！\n\n9/8 15:00にウェルスクエア池田井口堂 \n現地エントランスお待ち合わせで何卒よろしくお願い致します！！";
const AFTER_VIEWING = "YUMAさん本日お時間頂きありがとうございました！！\n\nお気に召されましたらお申込しお部屋抑えさせて頂きます！\n\nYUMAさんご帰宅後ご相談いただきご返事お待ちしております😊！！\n気になる点出てきましたらお気軽にご連絡ください！";
const ESTIMATE = "こちら初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！\n何卒よろしくお願い致します！！";
const ESTIMATE_BODY = "【ハイツカトレア B 202号室】\n\n初期費用さらに\n🌟30,000円割引させて頂き\n初期費用：148,090円\n\nスモラなら一般的な不動産業者より91,920円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。";

describe("締めの言い回しを取り出す", () => {
  it("★ C1 竹内さんのスクショから2つの締めを取る", () => {
    const c = extractClosingClauses(SCREENSHOT);
    expect(c.length).toBe(2);
    expect(c.join(" / ")).toContain("お気軽にご質問ください");
    expect(c.join(" / ")).toContain("何卒よろしくお願い致します");
  });
  it("★ C2 内覧後の締め（9/07）— 「お待ちしております」「お気軽にご連絡」", () => {
    const c = extractClosingClauses(AFTER_VIEWING);
    // 実物は「ご返答」ではなく「ご返事お待ちしております」（実送信をそのまま使う）
    expect(c.join(" / ")).toContain("ご返事お待ちしております");
    expect(c.join(" / ")).toContain("お気軽にご連絡ください");
  });
  it("★ C3 見積書の締め（9/12）— 「ご査収ください」を締めとして拾う", () => {
    expect(extractClosingClauses(ESTIMATE).join(" / ")).toContain("ご査収ください");
  });
  it("C4 締めが無い本文では空（見積書の中身だけの送信）", () => {
    expect(extractClosingClauses(ESTIMATE_BODY).length).toBe(0);
  });
  it("C5 同じ締めが2回出ても1つに畳む", () => {
    expect(extractClosingClauses("何卒よろしくお願い致します！！\n何卒よろしくお願い致します！！").length).toBe(1);
  });
  it("C6 空文字・null で落ちない", () => {
    expect(extractClosingClauses("").length).toBe(0);
    expect(extractClosingClauses(null).length).toBe(0);
  });
});

describe("足せる具体を取り出す（直前送信に書いてある物だけ）", () => {
  it("★ F1 内覧日が確定した送信から 日程・時刻・物件名 を取る（9/02 実例）", () => {
    const f = extractConcreteFacts(VIEWING_FIXED);
    const s = f.map((x) => `${x.kind}=${x.value}`).join(" / ");
    expect(s).toContain("日程=9/8");
    expect(s).toContain("時刻=15:00");
    expect(s).toContain("物件名=ウェルスクエア池田井口堂");
  });
  it("★ F2 費用の行を物件名にしない（見積書の本文）", () => {
    const names = extractConcreteFacts(ESTIMATE_BODY).filter((x) => x.kind === "物件名").map((x) => x.value);
    for (const n of names) {
      if (/初期費用|割引|節約|日割/.test(n)) throw new Error(`費用の行を物件名にした: ${n}`);
    }
  });
  it("★ F3 🌟 付きの物件行を取る（サロゲートペア・u フラグ）", () => {
    const f = extractConcreteFacts("🌟スプランディッド大阪EAST 204号室\n\nお手隙の際にご査収ください😌！！");
    const s = f.map((x) => `${x.kind}=${x.value}`).join(" / ");
    expect(s).toContain("物件名=スプランディッド大阪EAST");
    expect(s).toContain("号室=204号室");
  });
  it("★ F4 具体が何も無ければ空（竹内さんのスクショ＝締めだけ）", () => {
    expect(extractConcreteFacts(SCREENSHOT).length).toBe(0);
  });
  it("F5 全角の数字を半角にする", () => {
    expect(extractConcreteFacts("９月８日ご案内させて頂きます").some((f) => f.value === "9月8日")).toBe(true);
  });
  it("F6 「明日」「本日」も日程として拾う（実送信で復唱されている）", () => {
    expect(extractConcreteFacts("明日16:00にJ's Gardenでお待ちしております😊！！").some((f) => f.kind === "日程" && f.value === "明日")).toBe(true);
  });

  // ── 全件監査（scripts/audit-previous-send-note.ts・実送信12,093通）で出た誤りをそのまま固定する ──
  it("★ F7 前置きを物件名にしない（監査②で22件・実送信そのまま）", () => {
    const f = extractConcreteFacts("お送りさせて頂きましたお部屋の中でも特にジェントリー3 201号室がお部屋の条件良く、敷金礼金なしで費用を抑える事ができます！！");
    const names = f.filter((x) => x.kind === "物件名").map((x) => x.value);
    expect(names.join("/")).toBe("ジェントリー3");
  });
  it("★ F8 「中でも」だけの形でも前置きを落とす", () => {
    const names = extractConcreteFacts("お送りさせて頂きましたお部屋の中でもプラウド南堀江 1404号室が南向きの広々としたバルコニー備わっております！！")
      .filter((x) => x.kind === "物件名").map((x) => x.value);
    expect(names.join("/")).toBe("プラウド南堀江");
  });
  it("★ F9 設備の説明を物件名にしない（「お風呂部分　140cm」→ 物件名0件）", () => {
    const names = extractConcreteFacts("こちらの長さは\nお風呂部分　140cm\nクローゼット部分　63cm\nとなります！！")
      .filter((x) => x.kind === "物件名");
    expect(names.length).toBe(0);
  });
  it("★ F10 署名の人名を物件名にしない（個人情報を材料に混ぜない）", () => {
    const names = extractConcreteFacts("代表者 竹村 大樹 タケムラ ダイキ 1234")
      .filter((x) => x.kind === "物件名");
    expect(names.length).toBe(0);
  });
  it("★ F11 日付を物件名にしない（「9/15(火)」）", () => {
    const names = extractConcreteFacts("9/15(火) 1500")
      .filter((x) => x.kind === "物件名");
    expect(names.length).toBe(0);
  });
  it("★ F12 述語の断片を物件名にしない（「てご案内可能」監査②で39件）", () => {
    const names = extractConcreteFacts("9月末退去予定のためてご案内可能 1000号室")
      .filter((x) => x.kind === "物件名");
    expect(names.length).toBe(0);
  });
  it("F13 号室も目印も無い行は物件名にしない（迷う物は捨てる）", () => {
    expect(extractConcreteFacts("グランドメゾン 1234 という長さです").filter((x) => x.kind === "物件名").length).toBe(0);
  });
  it("F14 🌟の行は号室が無くても取る（実送信の物件カード）", () => {
    const f = extractConcreteFacts("🌟パルビゾン箕面 203\n\n水回りリノベーションのお部屋です！！");
    const s = f.map((x) => `${x.kind}=${x.value}`).join("/");
    expect(s).toContain("物件名=パルビゾン箕面");
    expect(s).toContain("号室=203号室");
  });
});

describe("締めを「種類の名前」に変える（言い回しは渡さない）", () => {
  it("★ K1 竹内さんのスクショ → ご連絡のお願い・お願いの挨拶", () => {
    expect(classifyClosings(SCREENSHOT).join("・")).toBe("ご連絡のお願い・お願いの挨拶");
  });
  it("★ K2 見積書の締め → ご査収の依頼・お願いの挨拶", () => {
    expect(classifyClosings(ESTIMATE).join("・")).toBe("ご査収の依頼・お願いの挨拶");
  });
  it("K3 締めが無ければ空", () => {
    expect(classifyClosings(ESTIMATE_BODY).length).toBe(0);
  });
});

describe("渡す材料の文", () => {
  it("★ N1 締めは『種類の名前』だけを渡す（竹内さんのスクショ）", () => {
    const n = buildPreviousSendNote(SCREENSHOT);
    expect(n).toContain("既に【ご連絡のお願い・お願いの挨拶】で締めてある");
    expect(n).toContain("同じ種類の締めをもう一度書かない");
  });
  it("★ N1-2 締めの言い回しそのものは渡さない（渡すとモデルが写す・YUMA ③で実証）", () => {
    for (const t of [SCREENSHOT, ESTIMATE, AFTER_VIEWING]) {
      const n = buildPreviousSendNote(t);
      for (const phrase of ["ご査収ください", "お気軽にご質問ください", "お気軽にご連絡ください", "何卒よろしくお願い致します", "お待ちしております"]) {
        if (n.includes(phrase)) throw new Error(`締めの言い回しが材料に入っている: ${phrase}`);
      }
    }
  });
  it("★ N2 足せる具体がある時はそれを名指しする（9/02 実例）", () => {
    const n = buildPreviousSendNote(VIEWING_FIXED);
    expect(n).toContain("直前の送信に出ている具体");
    expect(n).toContain("ウェルスクエア池田井口堂");
    expect(n).toContain("15:00");
  });
  it("★ N3 「繰り返すな」とは書かない（定型の締めは実送信の述部1位・2位）", () => {
    for (const t of [SCREENSHOT, VIEWING_FIXED, AFTER_VIEWING, ESTIMATE]) {
      expect(buildPreviousSendNote(t)).notToContain("絶対に繰り返さない");
      expect(buildPreviousSendNote(t)).notToContain("禁止");
    }
  });
  it("N3-3 締めが無い時は締めの話をしない（余計な指示を増やさない）", () => {
    expect(buildPreviousSendNote(ESTIMATE_BODY)).notToContain("締めてある");
  });
  it("★ N4 具体が無い時は「足せ」と言わず、短く終えるよう言う（実送信 中央値54字）", () => {
    const n = buildPreviousSendNote(SCREENSHOT);
    expect(n).toContain("足せる具体（確定した日程・時刻・物件名）は直前の送信に無い");
    expect(n).toContain("開口語1行＋一言だけで終える");
    expect(n).toContain(String(AFTER_ACK_MEDIAN_CHARS));
    expect(n).notToContain("1文だけ足す");
  });
  it("★ N4-2 具体が無い時は作り話を止める（YUMA ①で「書類お送りいただき…」が出た）", () => {
    expect(buildPreviousSendNote(SCREENSHOT)).toContain("履歴に無い事");
  });
  it("★ N4-3 具体が有る時だけ「1文だけ足す」と言う（9/02 実例）", () => {
    const n = buildPreviousSendNote(VIEWING_FIXED);
    expect(n).toContain("まだ言っていない物を1文だけ足す");
    expect(n).notToContain("履歴に無い事");
  });
  it("★ N5 材料が何も無ければ空文字（余計な指示を増やさない）", () => {
    expect(buildPreviousSendNote("")).toBe("");
    expect(buildPreviousSendNote(null)).toBe("");
    expect(buildPreviousSendNote("あ")).toBe("");
    expect(buildPreviousSendNote("[画像]")).toBe("");
  });
  it("N6 締めが無く具体だけでも材料になる（見積書の本文）", () => {
    const n = buildPreviousSendNote(ESTIMATE_BODY);
    expect(n).toContain("直前の送信に出ている具体");
    expect(n).notToContain("既に伝えた締め");
  });
  it("★ N7 上書きの見出しで始まる（呼び出し側は userPrompt の一番最後に置く）", () => {
    expect(buildPreviousSendNote(SCREENSHOT).startsWith("\n\n【最後に確認：")).toBe(true);
  });
});

describe("完全に締まっていたら下書きを作らない（竹内 2026-09-21）", () => {
  // 竹内「文締めることなくて完全にしまってたら返信しなくて大丈夫」
  const PICKUP_PROMISE = "かしこまりました！！\n塚本・大国町エリアでもオススメ出来るお部屋ピックアップさせて頂きます！！\nピックアップ出来次第ご連絡させて頂きます😌！！";

  it("★ S1 竹内さんのスクショの場面は止める（締めだけ＋短い了承）", () => {
    const v = shouldSkipDraftAfterClosing({ prevStaffText: SCREENSHOT, customerText: "はい！ありがとうございます" });
    expect(v.skip).toBe(true);
  });
  it("★ S2 内覧後の締め→お礼も止める（9/07 実例）", () => {
    expect(shouldSkipDraftAfterClosing({ prevStaffText: AFTER_VIEWING, customerText: "ありがとうございます" }).skip).toBe(true);
  });
  it("★ S3 ピックアップの約束が残っていれば作る（返事を待っている場面）", () => {
    const v = shouldSkipDraftAfterClosing({ prevStaffText: PICKUP_PROMISE, customerText: "はい、よろしくお願いします" });
    expect(v.skip).toBe(false);
    expect(v.reason).toContain("未履行の約束");
  });
  it("★ S4 内覧日が確定していれば作る（9/02 実例・約束も具体も残っている）", () => {
    const v = shouldSkipDraftAfterClosing({ prevStaffText: VIEWING_FIXED, customerText: "はい！" });
    expect(v.skip).toBe(false);
  });
  it("★ S5 見積書を送った直後は作る（ご査収＝こちらの動きが残っている）", () => {
    // 「ご査収ください」は締めだが、直前に見積書という物が届いている。
    // ESTIMATE には具体が無く約束も無いので**止まる**。これは竹内さんの判断どおり。
    expect(shouldSkipDraftAfterClosing({ prevStaffText: ESTIMATE, customerText: "ありがとうございます！" }).skip).toBe(true);
  });
  it("★ S6 お客様が質問していたら必ず作る", () => {
    expect(shouldSkipDraftAfterClosing({ prevStaffText: SCREENSHOT, customerText: "ありがとうございます！内覧っていつできますか？" }).skip).toBe(false);
  });
  it("★ S7 お客様が条件を足していたら作る", () => {
    expect(shouldSkipDraftAfterClosing({ prevStaffText: SCREENSHOT, customerText: "ありがとうございます。あとペット可でお願いします" }).skip).toBe(false);
  });
  it("★ S8 直前が締めで終わっていなければ作る（物件カードだけの送信）", () => {
    expect(shouldSkipDraftAfterClosing({ prevStaffText: ESTIMATE_BODY, customerText: "ありがとうございます" }).skip).toBe(false);
  });
  it("S9 直前のスタッフ送信が無ければ作る", () => {
    expect(shouldSkipDraftAfterClosing({ prevStaffText: "", customerText: "ありがとうございます" }).skip).toBe(false);
    expect(shouldSkipDraftAfterClosing({ prevStaffText: null, customerText: "ありがとうございます" }).skip).toBe(false);
  });
  it("S10 お客様が何も送っていなければ作る（判定の材料が無い）", () => {
    expect(shouldSkipDraftAfterClosing({ prevStaffText: SCREENSHOT, customerText: "" }).skip).toBe(false);
  });
});

describe("短いお礼・了承だけかを見る", () => {
  it("★ A1 止めてよい形（実送信で実際に来ている返事）", () => {
    for (const s of ["はい", "はい！", "ありがとうございます", "ありがとうございます😊", "よろしくお願いします。",
      "かしこまりました", "了解です", "わかりました", "はい！ありがとうございます", "大丈夫です！！"]) {
      if (!isShortAckOnly(s)) throw new Error(`短い了承と判定されなかった: ${s}`);
    }
  });
  it("★ A2 止めてはいけない形（中身がある）", () => {
    for (const s of ["ありがとうございます！内覧お願いします", "はい、9/8で大丈夫ですか？", "もう少し駅近ないですか",
      "ありがとうございます。あと駐車場も必要です", "やっぱり今回は見送ります",
      "ありがとうございます！これめちゃくちゃ良いですね、申し込みしたいです"]) {
      if (isShortAckOnly(s)) throw new Error(`短い了承と誤判定した: ${s}`);
    }
  });
  it("A3 スタンプ・画像だけは対象外（別の経路で止まる）", () => {
    expect(isShortAckOnly("[スタンプ]")).toBe(false);
    expect(isShortAckOnly("[画像]")).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

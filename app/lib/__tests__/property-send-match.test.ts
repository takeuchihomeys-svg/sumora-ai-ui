// 2026-09-15 竹内（カイナ事例）: 物件ピックアップの「会話を合わせる」— 会話の糸口の抽出と内覧誘導の除去
// 実行: npx tsx app/lib/__tests__/property-send-match.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { extractPropertySendThreads, buildPropertySendThreadsBlock, stripViewingInviteLines, stripRepeatedThanksLines, fixPickupTense, ensureRequirementLine, ensureDeadlineSupportLine, stripUnanchoredThanksLines, freshCustomerTexts, stripUngroundedClaims } from "../property-send-match";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected not to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

// カイナ（🐈‍⬛）の実会話（9/10〜9/15）
const KAINA = [
  { sender: "staff", text: "カイナさんお世話になっております！！\n\n大国町・桜川・南船場エリア周辺全域からカイナさんにオススメできるお部屋ピックアップさせて頂きました😊！！\nお気に召されお部屋全て代理契約可能か貸主側へ交渉させて頂きます！！\nお手隙の際にご査収ください😌！！" },
  { sender: "customer", text: "ありがとうございます！\n1度この2つで代理契約可能か確認していただけますでしょうか？💭" },
  { sender: "staff", text: "かしこまりました！！\n代理契約可能か明日管理会社に確認出来次第ご連絡させて頂きます😌！！" },
  { sender: "staff", text: "お待たせ致しました！！\nS-RESIDENCE難波大国町Deux\nS-RESIDENCE難波Brillerともに\n代理契約可能となります！！\n\nよろしければ一度お部屋ご内覧如何でしょうか😊！！" },
  { sender: "customer", text: "内覧してみて、もう少し広めのお部屋も見てみたいです！" },
  { sender: "staff", text: "カイナさん\n本日お時間頂きありがとうございました！！\nエリア広げさせていただき、大きめのお部屋ピックアップしお送りさせていただきます😊！！" },
];

it("カイナ: 前回のピックアップ送付より後の糸口だけ拾う（代理契約の依頼・広めのお部屋・エリアを広げる約束）", () => {
  const th = extractPropertySendThreads(KAINA);
  expect(th.customer.join(" | ")).toContain("広めのお部屋");
  expect(th.customer.join(" | ")).toContain("代理契約可能か確認");
  expect(th.staff.join(" | ")).toContain("エリア広げさせていただき");
  expect(th.staff.join(" | ")).toContain("代理契約可能か明日管理会社に確認");
  // 前回の送付（9/10 の「ピックアップさせて頂きました」）とその中の約束は含めない
  expect(th.staff.join(" | ")).notToContain("貸主側へ交渉");
});
it("定型の「ピックアップしてお送りさせて頂きます」は約束の糸口にしない", () => {
  const th = extractPropertySendThreads([{ sender: "staff", text: "かしこまりました！！\n梅田周辺からピックアップしてお送りさせて頂きます！！" }]);
  expect(th.staff.length).toBe(0);
});
it("カイナ: 続いている事情（代理契約）は前回の送付より前からも拾い、ブロックで「今回の物件でどうするか」を求める", () => {
  const th = extractPropertySendThreads(KAINA);
  expect(th.requirements.join(" | ")).toContain("代理契約");
  const b = buildPropertySendThreadsBlock(th);
  expect(b).toContain("続いている事情");
  expect(b).toContain("代理契約可能か全て交渉させて頂きます");
  // 2026-09-22: 代理契約以外の「全て確認させて頂きます」は実送信0通なので求めない
  expect(b.includes("交渉（確認）させて頂きます")).toBe(false);
});
it("続いている事情は requirementSources（お客様の発言を長めに）から拾える（直近の窓に無くても）", () => {
  const th = extractPropertySendThreads(
    [{ sender: "staff", text: "本日16時よりお部屋ご案内させて頂きます！" }, { sender: "customer", text: "こちらこそよろしくお願いいたします" }],
    { requirementSources: [{ sender: "customer", text: "こちらの物件は代理契約可能でしょうか？" }, { sender: "customer", text: "こちらこそよろしくお願いいたします" }] },
  );
  expect(th.requirements.join(" | ")).toContain("代理契約");
  expect(th.customer.length).toBe(0);
});
it("糸口が無ければブロックは「無し」", () => {
  expect(buildPropertySendThreadsBlock({ customer: [], requirements: [], staff: [] })).toContain("無し");
});
it("こちらの前の発言のお礼の繰り返し（本日はお時間頂きありがとうございました）を落とす", () => {
  const r = stripRepeatedThanksLines("カイナさんお世話になっております！！\n\n本日はお時間頂きありがとうございました！！\n\nエリア広げさせていただき、大きめのお部屋でカイナさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
  expect(r.removed).toBe(1);
  expect(r.text).toBe("カイナさんお世話になっております！！\n\nエリア広げさせていただき、大きめのお部屋でカイナさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
});
it("画像だけの発言・関係ない雑談は拾わない", () => {
  const th = extractPropertySendThreads([{ sender: "customer", text: "[画像]" }, { sender: "customer", text: "ありがとうございます！" }]);
  expect(th.customer.length).toBe(0);
});
it("内覧誘導・日時の行を落とす（内覧提案 OFF）", () => {
  const r = stripViewingInviteLines("〇〇さんお世話になっております！！\n\n梅田から〇〇さんにオススメできるお部屋ピックアップさせて頂きました！！\n\n〇〇さんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます😊！！\n直近ですと\n9/16（水）15:00〜17:00\nご案内可能です！！\n\nお手隙の際にご査収ください😌！！");
  expect(r.removed).toBe(4);
  expect(r.text).toBe("〇〇さんお世話になっております！！\n\n梅田から〇〇さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
});
it("内覧誘導が無ければそのまま", () => {
  const t = "〇〇さん\n\n条件広げてお送りしております！！\nお手隙の際にご査収ください😌！！";
  expect(stripViewingInviteLines(t).text).toBe(t);
});

it("ピックアップ行の未来形を過去形に（本番で写した「ピックアップしお送りさせていただきます」）", () => {
  const r = fixPickupTense("カイナさんお世話になっております！！\n\nエリア広げさせていただき、大きめのお部屋でカイナさんにオススメできるお部屋ピックアップしお送りさせていただきます😊！！\n\nお手隙の際にご査収ください😌！！");
  expect(r.fixed).toBe(1);
  expect(r.text).toContain("お部屋ピックアップさせていただきました😊！！");
  expect(fixPickupTense("お部屋ピックアップさせて頂きました！！").fixed).toBe(0);
});

it("代理契約の事情があるのに本文に無ければ、ご査収の前に交渉の一文を差し込む（カイナの実送信と同じ文）", () => {
  const r = ensureRequirementLine("カイナさんお世話になっております！！\n\nエリア広げさせていただき、大きめのお部屋でカイナさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！", ["1度この2つで代理契約可能か確認していただけますでしょうか？"]);
  expect(r.added).toBe("お気に召されたお部屋代理契約可能か全て交渉させて頂きます！！");
  expect(r.text).toBe("カイナさんお世話になっております！！\n\nエリア広げさせていただき、大きめのお部屋でカイナさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお気に召されたお部屋代理契約可能か全て交渉させて頂きます！！\nお手隙の際にご査収ください😌！！");
});
it("本文に既に代理契約の話があれば足さない・事情が無ければ足さない", () => {
  expect(ensureRequirementLine("お気に召されたお部屋代理契約可能か交渉させて頂きます！！\nお手隙の際にご査収ください😌！！", ["代理契約可能でしょうか？"]).added).toBe(null);
  expect(ensureRequirementLine("お手隙の際にご査収ください😌！！", []).added).toBe(null);
});

// 慶次の実会話（9/10〜9/15 22:05 の物件ピックアップの直前）
const KEIJI = [
  { sender: "customer", text: "【お申込者様記入欄】\n・入居希望日 10月25日前後\n・駐輪場利用の有無（台数）0\n・駐車場利用の有無（台数）0\n・ペット飼育有無 無し" },
  { sender: "staff", text: "慶次さん\n無事一番手にてお申込み完了しております！！\n審査の進捗あり次第ご連絡させていただきます😊！！" },
  { sender: "customer", text: "労働条件通知書の他への提出はコンプライアンス違反になる為出せないので\n在籍証明を用意しますので少しお時間ください。\n北区、福島区ではやはりいい条件の物件はないですか？" },
  { sender: "staff", text: "かしこまりました！！\n在籍証明のご用意、何卒よろしくお願い致します！！\n\n北区・福島区周辺全域から慶次さんにオススメできるお部屋ピックアップさせていただきます！！" },
  { sender: "customer", text: "お世話になっております。\n在籍証明を用意するとかなり時間が掛かるので\n労働条件通知書で期日、給与額は公表しないで許可をもらいましたので\n給与明細と一緒に送ります。" },
  { sender: "staff", text: "お送りいただきありがとうございます😊！！\n管理会社に共有させていただきます！！" },
  { sender: "staff", text: "慶次さん\nお世話になっております。\n\nメロディーハイム九条の管理会社より保証会社審査否決とのご連絡がございました。\n\n審査否決理由につきましてはご教授いただけませんでした。\n\n引き続き、北区、福島区中心に慶次さんにオススメできるお部屋探しさせていただきます！！" },
  { sender: "customer", text: "まさか、ダメだと思ってなかったので\n10月末で今の家を退去する旨を管理会社に言ってしまったので困りました😓" },
];

it("慶次: 退去を伝えてしまった困りごとを期限の糸口に、審査否決・お部屋探しの約束をこちらの経緯に拾う", () => {
  const th = extractPropertySendThreads(KEIJI);
  expect((th.deadline ?? []).join(" | ")).toContain("退去する旨を管理会社に言ってしまった");
  expect(th.staff.join(" | ")).toContain("保証会社審査否決");
  expect(th.staff.join(" | ")).toContain("お部屋探しさせていただきます");
  // 労働条件通知書（書類の話）は糸口にしない
  expect(th.customer.join(" | ")).notToContain("労働条件通知書");
  const b = buildPropertySendThreadsBlock(th);
  expect(b).toContain("期限・困りごと");
  expect(b).toContain("無事ご入居間に合いますようにサポートさせて頂きます！！");
});
it("慶次: 申込フォームの「ペット飼育有無 無し」「駐車場…（台数）0」は続いている事情にしない（ペット・駐車場の一文を足さない）", () => {
  const th = extractPropertySendThreads(KEIJI);
  expect(th.requirements.length).toBe(0);
  expect(ensureRequirementLine("慶次さんお世話になっております！！\n\nお手隙の際にご査収ください😌！！", th.requirements).added).toBe(null);
});
it("「友人に名義を貸した」（信用の話）は代理契約の事情にしない・「契約者名義」は代理契約", () => {
  const a = extractPropertySendThreads([{ sender: "customer", text: "今回、通らなかったのは以前、友人に名義を貸した際に飛ばれてるのでそれが影響してるかもしれないです。" }]);
  expect(ensureRequirementLine("お手隙の際にご査収ください😌！！", a.requirements).added).toBe(null);
  const b = extractPropertySendThreads([{ sender: "customer", text: "契約者名義は父にしたいです" }]);
  expect(ensureRequirementLine("お手隙の際にご査収ください😌！！", b.requirements).added).toBe("お気に召されたお部屋代理契約可能か全て交渉させて頂きます！！");
});
it("物件の退去予定を聞く質問（203はいつ退去予定ですか）は期限の糸口にしない", () => {
  const th = extractPropertySendThreads([{ sender: "customer", text: "203はいつ退居予定なのでしょうか？" }, { sender: "customer", text: "こちらのお部屋はいつ退去予定ですか？" }]);
  expect((th.deadline ?? []).length).toBe(0);
});
it("期限の一文が無ければ挨拶の次に差し込む（慶次の実送信の並び）・既に「間に合」があれば足さない", () => {
  const r = ensureDeadlineSupportLine("慶次さん夜分遅くに失礼致します！！\n\n北区・福島区周辺全域から慶次さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！", ["10月末で今の家を退去する旨を管理会社に言ってしまったので困りました😓"]);
  expect(r.added).toBe(true);
  expect(r.text).toBe("慶次さん夜分遅くに失礼致します！！\n\n無事ご入居間に合いますようにサポートさせて頂きます！！\n\n北区・福島区周辺全域から慶次さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
  expect(ensureDeadlineSupportLine("慶次さん\n\n10月末退去のご予定に間に合いますようサポートさせて頂きます！！\nお手隙の際にご査収ください😌！！", ["退去する旨"]).added).toBe(false);
  expect(ensureDeadlineSupportLine("慶次さん\nお手隙の際にご査収ください😌！！", []).added).toBe(false);
});
it("古い話へのお礼（5日前の給与明細）を落とす・まだ応えていない発言へのお礼とピックアップ行は残す", () => {
  const fresh = freshCustomerTexts(KEIJI);
  expect(fresh.length).toBe(1);
  const r = stripUnanchoredThanksLines("慶次さんお世話になっております！！\n\n給与明細と労働条件通知書のご準備ありがとうございます😊！！\n\n北区・福島区周辺全域から慶次さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！", fresh);
  expect(r.removed.length).toBe(1);
  expect(r.text).toBe("慶次さんお世話になっております！！\n\n北区・福島区周辺全域から慶次さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
  const keep = stripUnanchoredThanksLines("〇〇さん\n\n物件資料お送り頂きありがとうございます！！\n\nお手隙の際にご査収ください😌！！", ["[画像]", "こちらの物件資料の物件も見たいです"]);
  expect(keep.removed.length).toBe(0);
  const cond = stripUnanchoredThanksLines("〇〇さん\nご条件お送り頂きありがとうございます！！\n梅田から…ピックアップさせて頂きました！！", ["①10月 ②家賃8万 ③1LDK"]);
  expect(cond.removed.length).toBe(0);
});

it("入力に無い保証会社・審査の話を落とす（本番で出た2つの形）・キーワードにあれば残す", () => {
  const a = stripUngroundedClaims("慶次さん夜分遅くに失礼致します！！\n\n無事ご入居間に合いますようにサポートさせて頂きます！！\n\n北区・福島区周辺全域から独立系保証会社でご案内可能なお部屋を中心に慶次さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！", "");
  expect(a.text).toBe("慶次さん夜分遅くに失礼致します！！\n\n無事ご入居間に合いますようにサポートさせて頂きます！！\n\n北区・福島区周辺全域から慶次さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
  expect(a.unresolved).toBe(false);
  const b = stripUngroundedClaims("慶次さんお世話になっております！！\n\n北区・福島区周辺全域から慶次さんにオススメできるお部屋ピックアップさせて頂きました！！\n\n独立系の保証会社が使えるお部屋を中心にお探しさせて頂いておりますので、10月末のご退去に間に合いますよう並行して進めさせて頂きます！！\n\n複数のお部屋で並行してお申込み・審査を進めさせて頂くことも可能ですので、お気に召されたお部屋ございましたらお知らせください😊！！\n\nお手隙の際にご査収ください😌！！", "");
  expect(b.removed.length).toBe(2);
  expect(b.text).toBe("慶次さんお世話になっております！！\n\n北区・福島区周辺全域から慶次さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
  const kw = "島之内から審査通過しやすい築浅の1LDKのお部屋ピックアップさせて頂きました😊！！";
  expect(stripUngroundedClaims(kw, "審査通過しやすい").text).toBe(kw);
});
it("手本から写した代理契約の一文は事情が無ければ落とす・事情があれば残す", () => {
  const t = "慶次さんお世話になっております！！\n\n北区からお部屋ピックアップさせて頂きました！！\n\nお気に召されたお部屋、代理契約可能か全て交渉させて頂きます！！\nお手隙の際にご査収ください😌！！";
  expect(stripUngroundedClaims(t, "").text).toBe("慶次さんお世話になっております！！\n\n北区からお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
  expect(stripUngroundedClaims(t, "1度この2つで代理契約可能か確認していただけますでしょうか？").text).toBe(t);
});

it("2026-09-22: ペットの事情だけなら「全て確認させて頂きます」を差し込まない（実送信0通・下書き12回とも削除）", () => {
  const r = ensureRequirementLine("〇〇さんお世話になっております！！\nペット可のお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！", ["猫を1匹飼っています"]);
  expect(r.added === null).toBe(true);
  const p = ensureRequirementLine("〇〇さんお世話になっております！！\nピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！", ["代理契約でお願いしたいです"]);
  expect(p.added ?? "").toContain("代理契約可能か全て交渉させて頂きます");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

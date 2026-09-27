// app/lib/edit-diff.ts: 生成された文と送った文の差（量と型）。本番の実物の対（ai_reply_examples・messages）で固定する
// 実行: npx tsx app/lib/__tests__/edit-diff.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { classifyEdit, droppedEdit, isUntouched, bigramSim } from "../edit-diff";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function ok(c: unknown, m = "") { if (!c) throw new Error(m || "assertion failed"); }
const has = (kinds: string[], k: string) => kinds.includes(k);

console.log("edit-diff");

it("同じ文はそのまま（手直しなし）", () => {
  const t = "かしこまりました😊！！\n現地でお待ちしておりますので、お気をつけてお越しください！！";
  const d = classifyEdit(t, t);
  ok(d.amount === "none" && d.kinds.length === 0 && isUntouched(d), JSON.stringify(d));
});

it("絵文字だけの違いはごく少し＋絵文字（手直しに数える）", () => {
  const d = classifyEdit("はい😊！！\nお気をつけてお越しください！！", "はい！！\nお気をつけてお越しください😌！！");
  ok(d.amount === "tiny" && has(d.kinds, "emoji") && !isUntouched(d), JSON.stringify(d));
});

it("実物: 号室の打ち間違いを直した（見積書送る・100→1003／130→1302）は物件・号室", () => {
  const g = "①【スプランディッド本町グラン 100号室】\n\n初期費用さらに\n🌟203,000円割引させて頂き\n初期費用：102,900円\n\n②【ミラージュパレス本町Depart 130号室】";
  const s = "①【スプランディッド本町グラン 1003号室】\n\n初期費用さらに\n🌟203,000円割引させて頂き\n初期費用：102,900円\n\n②【ミラージュパレス本町Depart 1302号室】";
  const d = classifyEdit(g, s);
  ok(d.amount === "tiny" && has(d.kinds, "property") && !has(d.kinds, "money"), JSON.stringify(d));
});

it("実物: 冒頭の受けを替えた（はい😊 → かしこまりました）＋一文を消した", () => {
  const d = classifyEdit("はい😊！！\nお気をつけてお越しください！！\n到着までのんびりお待ちしております😌！！", "かしこまりました！！\nお気をつけてお越しください😌！！");
  ok(has(d.kinds, "opening") && has(d.kinds, "delete"), JSON.stringify(d));
});

it("実物: 呼びかけの名前を足した（Hinaさん）は名前", () => {
  const d = classifyEdit(
    "本日はお時間頂きありがとうございました！！花園の駐車場の件、管理会社に確認させていただきます！！確認出来次第ご連絡させていただきます😊！！何卒よろしくお願い致します😌！！",
    "Hinaさん\n本日はお時間頂きありがとうございました！！\n花園の駐車場の件、管理会社に確認させていただきます！！\n空き状況確認出来次第ご連絡させていただきます😊！！");
  ok(has(d.kinds, "name") && !has(d.kinds, "property"), JSON.stringify(d));
});

it("実物: 「本日」を足した内覧の候補（日時）", () => {
  const g = "かしこまりました！！\nお部屋ご案内させて頂きます！！\n\n直近ですと\n9/14(月) 17:45〜18:30\n9/15(火) 16:30〜18:30";
  const s = "はい！！\nお部屋ご案内させて頂きます！！\n\n直近ですと\n本日 9/14(月) 17:45〜18:30\n9/15(火) 16:30〜18:30";
  const d = classifyEdit(g, s);
  ok(has(d.kinds, "datetime") && has(d.kinds, "opening"), JSON.stringify(d));
});

it("実物: 一般のカタカナ語（アクセス・ピックアップ）は物件名に数えない", () => {
  const d = classifyEdit(
    "YUYAさん本日お時間頂きありがとうございました！！\n引き続き新着でおすすめできる物件が出次第ご連絡させて頂きます！",
    "YUYAさん\n本日お時間頂きありがとうございました！！\n\n洋室6.5帖以上で地下鉄沿線沿いと大阪梅田にアクセスしやすいエリア全域から、引き続き新着でおすすめできる物件お送りさせていただきます😊！！");
  ok(!has(d.kinds, "property") && has(d.kinds, "add"), JSON.stringify(d));
});

it("実物: 送り間違いの書き直し（申込の受け → 工事中の報告）は書き直し", () => {
  const d = classifyEdit(
    "はい！！\nお申込み情報のご連絡ありがとうございます！！\n\nお気に召されましたらお申込みでお部屋を先に押さえさせて頂きますので、いつでもお気軽にご連絡ください😊！！",
    "確認させて頂きましたところ、10月中旬まで工事中となり工事中はご内覧出来ないとの事です！！\n工事完了日が決まりましたらご報告頂く形となっております！！");
  ok(d.amount === "rewrite" && has(d.kinds, "delete") && has(d.kinds, "add"), JSON.stringify(d));
});

it("量の線は save-reply-example と同じ（0.9 以上＝ごく少し）", () => {
  const g = "ゆうこさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n\n動画みていただきありがとうございます！！\n\n最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！\nゆうこさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！";
  const s = "ゆうこさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n\n動画みていただきありがとうございます！！\n\nゆうこさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！";
  const d = classifyEdit(g, s);
  ok(bigramSim(g, s) >= 0.6 && has(d.kinds, "delete") && !has(d.kinds, "add"), JSON.stringify(d));
});

it("生成文を使わなかった時は dropped だけ", () => {
  const d = droppedEdit(0.12);
  ok(d.amount === "rewrite" && d.kinds.length === 1 && d.kinds[0] === "dropped", JSON.stringify(d));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(" - " + f); process.exit(1); }

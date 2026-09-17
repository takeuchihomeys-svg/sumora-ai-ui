// 2026-09-16 竹内（YUYA 事例）: SUUMO 以外のポータルはオトリ広告があるので、聞かれたらこの説明を出す
// 実行: npx tsx app/lib/__tests__/portal-notice.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolvePortalQuestion, detectCustomerPortals, ensurePortalNotice, buildOtoriExplain, buildPortalPromptNote, WHICH_SITE_ANSWER } from "../portal-notice";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

// YUYA の会話（お客様はニフティ経由で物件を送っている）
const NIFTY_SHARE = "阪急神戸本線 十三 徒歩7分\n1R 5万円\n[詳細]\nhttps://myhome.nifty.com/smp/rent/osaka/osakashiyodogawaku/homesf_01162600032704/\n\nニフティ不動産アプリ版はこちら\nhttps://myhome.nifty.com/apps/";
const MSGS = [
  { sender: "customer", text: NIFTY_SHARE },
  { sender: "customer", text: "こちらの物件ニフティで価格更新(9/13付)されてたのですが、募集終わってるか専任物件でしょうか？" },
];

it("YUYA: お客様が使っているポータル（SUUMO 以外）を拾う", () => {
  expect(detectCustomerPortals(MSGS)).toBe({ untrusted: ["ニフティ"], trusted: [] });
});
it("YUYA: 「ニフティで価格更新されてたのですが募集終わってるか専任物件でしょうか？」→ オトリの説明", () => {
  const v = resolvePortalQuestion({ customerText: MSGS[1].text, messages: MSGS });
  expect(v.kind).toBe("otori_explain");
  expect(v.portalLabel).toBe("ニフティ");
});
it("YUYA: 募集終了を伝えた後の「そうですか。。ありがとうございます！」でも補足する（実送信の型）", () => {
  const msgs = [...MSGS, { sender: "staff", text: "お送り頂きました2件につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！" }, { sender: "customer", text: "そうですか。。\nありがとうございます！" }];
  // お礼だけの発言でも、直前に募集終了を伝えていてポータルの疑問が出ている流れでは説明を添える
  const v = resolvePortalQuestion({ customerText: "こちらの物件ニフティで価格更新(9/13付)されてたのですが、募集終わってるか専任物件でしょうか？", messages: msgs, lastStaffText: msgs[2].text });
  expect(v.kind).toBe("otori_explain");
});
it("YUYA: 「SUUMOかホームズで見るのがいちばんおとり物件がすくないですか？」→ どのサイトが良いかの回答", () => {
  const v = resolvePortalQuestion({ customerText: "SUUMOかホームズで見るのがいちばんおとり物件がすくないですか？", messages: MSGS });
  expect(v.kind).toBe("which_site");
});

it("ポータルの話でない発言・SUUMO だけのお客様には出さない", () => {
  expect(resolvePortalQuestion({ customerText: "内見は可能でしょうか？", messages: MSGS }).kind).toBe("none");
  const suumoOnly = [{ sender: "customer", text: "プルス新北野 3階\nhttps://suumo.jp/chintai/bc_100526248899/\nby SUUMO" }];
  // SUUMO しか使っていない時は「SUUMO 以外はオトリ」の説明に当たらない（SUUMO 用の説明は物件確認したの文が担当）
  expect(resolvePortalQuestion({ customerText: "募集終了て言われた物件がSUUMOで即入居でありますが見落としとかではないですか？", messages: suumoOnly }).kind).toBe("none");
  expect(resolvePortalQuestion({ customerText: "", messages: MSGS }).kind).toBe("none");
});

it("説明はスタッフの実送信そのまま（ポータル名だけ差し替え）", () => {
  const t = buildOtoriExplain("ニフティ");
  expect(t).toBe([
    "ニフティ等のポータルサイトは終了したお部屋を、お客様ご来店頂く為のオトリ物件として掲載されている場合御座います！！",
    "SUUMOですと掲載のルールが厳しく、実際募集されている物件が掲載されております（2週間毎の更新となりますので掲載終了している場合御座います）",
    "",
    "ニフティ等で募集されているお部屋もお送り頂きますと、募集状況確認させて頂きますので、お気軽にお送りの程よろしくお願い致します😌！！",
  ].join("\n"));
  expect(buildOtoriExplain("アットホーム")).toContain("アットホーム等のポータルサイトは");
  expect(buildOtoriExplain(null)).toContain("ニフティ等のポータルサイトは");
});

it("出口: 生成文の後ろに足す・同じ説明が既にあれば触らない・場面でなければ触らない", () => {
  const draft = "お送り頂きました2件につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！";
  const v = resolvePortalQuestion({ customerText: MSGS[1].text, messages: MSGS });
  expect(ensurePortalNotice(draft, v)).toBe(`${draft}\n\n${buildOtoriExplain("ニフティ")}`);
  const already = `${draft}\n\n${buildOtoriExplain("ニフティ")}`;
  expect(ensurePortalNotice(already, v)).toBe(already);
  expect(ensurePortalNotice(draft, { kind: "none", portalLabel: null, reason: "x" })).toBe(draft);
  // どのサイトが良いかの回答は実送信そのまま
  expect(ensurePortalNotice("", { kind: "which_site", portalLabel: "ニフティ", reason: "x" })).toBe(WHICH_SITE_ANSWER);
});
it("本番検証で出た「LLM が書いた逆の説明」を落として、決まった説明に置き換える", () => {
  // 実際に本番の生成が書いた文（2/2）。SUUMO・ホームズはオトリが少ない、が正しい
  const llm = "YUYAさんお世話になっております！！\nSUUMOやホームズも当社と同じ物件情報を掲載している場合が多く、実際にはおとり物件かどうかはサイトによる差はあまりございません😌！！\nそれよりも私の方で日々新着物件を確認しておりますので、YUYAさんのご希望条件でオススメできるお部屋を継続してピックアップしお送りさせて頂きます！！";
  const out = ensurePortalNotice(llm, { kind: "which_site", portalLabel: "ニフティ", reason: "x" });
  expect(out).toBe([
    "YUYAさんお世話になっております！！",
    "それよりも私の方で日々新着物件を確認しておりますので、YUYAさんのご希望条件でオススメできるお部屋を継続してピックアップしお送りさせて頂きます！！",
    "",
    WHICH_SITE_ANSWER,
  ].join("\n"));
  // 「おとり」の行が全部落ちて本文が空になっても、説明だけは残る
  expect(ensurePortalNotice("おとり物件は少ないです", { kind: "which_site", portalLabel: null, reason: "x" })).toBe(WHICH_SITE_ANSWER);
});
it("再検証（9/17）で残った2つの抜け: 「オトリ」の語が無い逆の説明・部分一致で「既にある」と見なした弱い文", () => {
  const v = { kind: "which_site" as const, portalLabel: "ニフティ", reason: "x" };
  // ②(1): 「オトリ」の語が無いのに逆の内容（サイトによる差はあまりございません）→ ポータル名を含む行として落ちる
  const wrong = "YUYAさんお世話になっております！！\nSUUMOやHOMESに載っているお部屋も、既に募集終了・お申込みが入っている情報がそのまま掲載されているケースが多く、サイトによる差はあまりございません😊！！\n\n気になる物件がございましたらいつでもお気軽にお送りください！！";
  expect(ensurePortalNotice(wrong, v)).toBe(`YUYAさんお世話になっております！！\n\n気になる物件がございましたらいつでもお気軽にお送りください！！\n\n${WHICH_SITE_ANSWER}`);
  // ②(2): 「比較的オトリ物件が少ないポータルサイトとなっております」は決まった文ではない → 落として置き換える
  const weak = "YUYAさんお世話になっております！！\n\nSUUMOとホームズは比較的オトリ物件が少ないポータルサイトとなっております！！\n\n気になる物件がございましたら、その都度URLをお送りいただければ募集状況確認させて頂きます！！";
  expect(ensurePortalNotice(weak, v)).toBe(`YUYAさんお世話になっております！！\n\n気になる物件がございましたら、その都度URLをお送りいただければ募集状況確認させて頂きます！！\n\n${WHICH_SITE_ANSWER}`);
  // 指示層の文はこの場面だけ
  expect(buildPortalPromptNote(v)).toContain("本文には書かないでください");
  expect(buildPortalPromptNote({ kind: "none", portalLabel: null, reason: "x" })).toBe("");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

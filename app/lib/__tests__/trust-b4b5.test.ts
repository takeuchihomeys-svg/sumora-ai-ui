// app/lib/__tests__/trust-b4b5.test.ts — 信頼の土台 B4（正直）・B5（聞き直さない）の決まり（2026-11-21 作業員N）
//   実行: npx tsx app/lib/__tests__/trust-b4b5.test.ts
//   文は本番の AIX・竹内さんの送信の形（名前は伏せた）
import { unfavorableFactsOf, hideVerdictOf, reaskedKeysOf } from "../trust-b4b5";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

// B4: 不利な事実の拾い
const aix1 = "お世話になっております！！\n〇〇さんお送り頂きました物件の中で\n・ディアコート曽根 304号室\nこちら現在募集中となります！！\n\nプレイス曽根は既にお申込みが入っているお部屋となります！！\n\n他1件は\n募集終了しているお部屋となります。";
const f1 = unfavorableFactsOf(aix1);
t("申込ありと募集終了を拾う", f1.some((f) => f.kind === "taken") && f1.some((f) => f.kind === "ended"));
t("申込ありの建物の名前", f1.find((f) => f.kind === "taken")?.name === "プレイス曽根");
const aix2 = "エスリード中之島クロスゲート募集状況確認させて頂きましたところ、現在お部屋お申込が入っており、2番手でのお申込となります！！";
const f2 = unfavorableFactsOf(aix2);
t("2番手を拾う", f2.some((f) => f.kind === "second") && f2[0].name === "エスリード中之島クロスゲート");
t("募集中だけは拾わない", unfavorableFactsOf("ディアコート曽根 304号室 現在募集中となります！！").length === 0);

// B4: 返信が伏せたか
t("代わりに触れた＝told", hideVerdictOf("かしこまりました！！ 並行して〇〇さんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます！！", f1) === "told");
t("不利なお部屋の名前で内覧に誘った＝hid", hideVerdictOf("プレイス曽根もかなりオススメ出来るお部屋となります！！ お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！", f1) === "hid");
t("別のお部屋に誘うだけ＝not_about", hideVerdictOf("ディアコート曽根 304号室お気に召されましたらご案内させて頂きます！！", f1) === "not_about");
t("2番手を言った＝told", hideVerdictOf("エスリード中之島クロスゲートは2番手でのお申込となりますが、お部屋抑えさせて頂きます！！", f2) === "told");
t("不利な事実が無い＝not_about", hideVerdictOf("ご案内させて頂きます！！", []) === "not_about");

// B5: 聞き直し
const prior = ["梅田周辺で家賃8万以内、1LDKがいいです", "3月入居予定です"];
t("答えた家賃をまた聞く", reaskedKeysOf("ご予算（家賃）はおいくらほどをお考えでしょうか？", prior).includes("rent"));
t("答えた入居時期をまた聞く", reaskedKeysOf("ご入居時期はいつ頃をお考えでしょうか？", prior).includes("move_in"));
t("まだ答えていない広さは数えない", reaskedKeysOf("広さのご希望は御座いますでしょうか？", prior).length === 0);
t("問いでない文は数えない（家賃の説明）", reaskedKeysOf("家賃8万円以内で1LDKのお部屋ピックアップさせて頂きます！！", prior).length === 0);
t("日程の誘いは数えない", reaskedKeysOf("お気に召されましたらご都合よろしいお日にち御座いますでしょうか！！", prior).length === 0);
t("前に答えが無ければ数えない", reaskedKeysOf("ご予算はおいくらほどでしょうか？", []).length === 0);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);

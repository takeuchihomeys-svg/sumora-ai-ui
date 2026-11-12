// 会話の中の事実の種類の語彙（app/lib/conversation-fact-kinds.ts）のテスト。文は人が直した番（weak-spots 2026-10-16）の実物（名前は伏せた）
// 実行: npx tsx app/lib/__tests__/conversation-fact-kinds.test.ts
import { conversationFactKind, CONVERSATION_FACT_KINDS, CONVERSATION_FACT_SPEC } from "../conversation-fact-kinds";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };
const K = (c: string, s: string) => conversationFactKind(c, s);
ok("全部の種類に K と説明", CONVERSATION_FACT_KINDS.every((k) => CONVERSATION_FACT_SPEC[k].label && Array.isArray(CONVERSATION_FACT_SPEC[k].k)));
ok("K は K1〜K16 の名前だけ", CONVERSATION_FACT_KINDS.every((k) => CONVERSATION_FACT_SPEC[k].k.every((x) => /^K(?:[1-9]|1[0-6])$/.test(x))));
ok("内覧の所要時間", K("内覧時間は大体どのくらいになりますでしょうか？", "はい😊！！ お部屋のご内覧お時間30分程をみていただけますと幸いです！！") === "viewing_logistics");
ok("駐車場", K("駐車場は近くのパーキングでよろしいですか？", "はい！！ お近くのパーキングにお停めください！！") === "viewing_logistics");
ok("内覧の日の変更", K("本日の内覧なんですが、諸事情により明日以降に変更可能でしょうか？？", "かしこまりました！！お日にち変更させていただきます😌！！ 他直近ですと 10/8(木) 16:00〜17:00") === "viewing_schedule");
ok("管理会社に確かめた結果", K("分かりました！", "管理会社に確認させていただき、お部屋ご両親での代理契約でのお申込みも可能とのことです！！") === "check_result");
ok("募集状況の結果", K("ちなみにここってどうですか？", "お送り頂きましたメゾン〇〇につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております") === "vacancy_result");
ok("治安（会社・地域の知識）", K("大阪市で多少治安悪いとこだとどこになりますか？", "治安が良くないと言われるエリアは〇〇区…と言われております") === "company_knowledge");
ok("資料の事実（間取りの形）", K("ここって洗面台とトイレ一緒な感じですか？", "洗面台とトイレが同じ間取りであるアメリカンセパレートの間取りとなります！！") === "doc_fact");
ok("探す範囲", K("それと同じ価格帯の低層階過ぎない心斎橋近くのタワマンで良さそうな物件あれば", "心斎橋周辺全域から10階以上のタワーマンションのお部屋ピックアップさせて頂きました😊") === "search_scope");
ok("申込の手続き", K("明日旦那の方は難しいらしく、私一人で行くことが困難なので", "【代理契約 〇〇様ご入力欄】 ・氏名、フリガナ") === "apply_procedure");
ok("お礼だけ", K("ありがとうございます！10/12日13時からよろしくおねがいします！", "はい！！ 10/12 当日は何卒よろしくお願い致します！！") === "ack_only");
ok("人の送信が無い行の設備の変更の問い", K("こちら畳は変えて頂けるのですか？？", "") === "check_result");
console.log(`conversation-fact-kinds: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);

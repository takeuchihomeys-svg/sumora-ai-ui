// 試験の AIX の文の段（scripts/lib/exam-aix-text.ts・2026-10-22）
// 実行: npx tsx scripts/lib/__tests__/exam-aix-text.test.ts（自己完結・LLM も DB も使わない。全 PASS で exit 0）
import { scoreAixText, factsOf, propNamesOf, sectionsOf, lcsRatio, closePartsOf, pickerClaims, needsJudge, withJudge, pickQuestions, goldUnusable, compareRows, summarize, questionHash, aixShiftDays, shiftQuestionDates, isAppFormat, type AixQuestion } from "../exam-aix-text";

let fail = 0, n = 0;
const ok = (c: boolean, name: string) => { n++; if (c) console.log(`PASS ${name}`); else { fail++; console.log(`FAIL ${name}`); } };

// 事実・物件名
const f = factsOf("10/24 12:00にレオン 1301号室・家賃113,000円・徒歩4分・2021年3月築");
ok(f.get("日付")?.has("10/24") === true, "日付");
ok(f.get("時刻")?.has("12/0") === true, "時刻（12:00）");
ok(f.get("金額")?.has("113000") === true, "金額のカンマ");
ok(f.get("号室")?.has("1301") === true, "号室");
ok(propNamesOf("10/24 12:00にレオンコンフォート難波南 1301号室\n現地").includes("レオンコンフォート難波南"), "物件名（号室の前）");
ok(propNamesOf("🌟リンクハウス南堀江 502号室").includes("リンクハウス南堀江"), "物件名（🌟の見出し）");

// 待ち合わせ: 入力にある日時・物件・住所を全部書いた生成は合格
const meet = {
  body: { action: "meeting_place", meeting_property_name: "レオンコンフォート難波南 1301号室", meeting_property_address: "大阪府大阪市浪速区大国1丁目1-3", meeting_date: "10/24 12:00" },
  inputText: "YUMAさん 10/24の12時でお願いします\n{\"meeting_property_name\":\"レオンコンフォート難波南 1301号室\",\"meeting_property_address\":\"大阪府大阪市浪速区大国1丁目1-3\",\"meeting_date\":\"10/24 12:00\"}",
  gold: "かしこまりました！！\n10/24（土）ご案内させて頂きます！！\n\n10/24 12:00にレオンコンフォート難波南 1301号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市浪速区大国1丁目1-3",
};
const good = scoreAixText(meet, meet.gold);
ok(good.pass && good.score >= 95, `同じ文は満点近く（${good.score}）`);
const wrongTime = scoreAixText(meet, meet.gold.replace(/12:00/g, "13:00"));
ok(!wrongTime.pass && wrongTime.fabricated.includes("時刻:13/0") && wrongTime.missing.includes("時刻:12/0"), "時刻の取り違え＝作り事＋抜け");
const noAddr = scoreAixText(meet, "かしこまりました！！\n10/24 12:00にご案内させて頂きます！！");
ok(noAddr.missing.some((m) => m.startsWith("物件名")), "物件名の抜け");

// スタッフだけが知る事: 募集中は物件確認した（available）の入力で渡す
const chk = { body: { action: "property_check_result", check_pattern: "available", property_names: ["セレニテフラン難波 1501号室"] }, inputText: "これ空いてますか\n{\"property_names\":[\"セレニテフラン難波 1501号室\"]}", gold: "YUMAさんお送り頂きましたお部屋の募集状況を確認致しましたところ、セレニテフラン難波1501号室は現在募集中のお部屋となります！！\n\nお手隙の際にご査収ください😌！！" };
ok(pickerClaims(chk.body).has("募集中"), "available→募集中");
const chkMiss = scoreAixText(chk, "YUMAさんセレニテフラン難波1501号室の件ご連絡致します！！\nお手隙の際にご査収ください😌！！");
ok(chkMiss.staffOnly.includes("抜け:募集中"), "入力の募集中が抜けた");
const vacate = scoreAixText(chk, chk.gold.replace("現在募集中のお部屋となります", "退去予定のお部屋となります"));
ok(vacate.staffOnly.includes("根拠なし:退去予定"), "根拠の無い退去予定");

// 訴求・締め・形
ok(closePartsOf("お気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！\nお手隙の際にご査収ください😌！！").join() === "内覧へ,査収", "締めの要素");
ok(sectionsOf("YUMAさん夜分遅くに失礼致します！！\n🌟A 101号室\n・敷金礼金0円\nお手隙の際にご査収ください").join() === "冒頭,見出し,箇条,査収", "段の並び");
ok(Math.abs(lcsRatio(["a", "b", "c"], ["a", "c"]) - 0.8) < 1e-9, "LCS の比");

// 判定（lazy）
const s1 = scoreAixText(meet, "承知しました！！\n10/24 12:00にレオンコンフォート難波南 1301号室の現地エントランスで何卒よろしくお願い致します！！\n住所: 大阪府大阪市浪速区大国1丁目1-3");
ok(typeof needsJudge(s1) === "boolean", "needsJudge が答える");
ok(withJudge({ ...s1, pass: true }, { same: false, missing: ["日程"], extra: [] }).pass === false, "判定が違うと言えば不合格");

// 選び方・使えない正解・比べ
const q = (id: string, type: string, kind: "aix" | "tpl" | "second", picker: string | null, gold: string, at: string): AixQuestion => ({ id, aixType: type, button: type, picker, kind, route: "aix/action", body: {}, gold, inputText: "", at, src: id, hash: id });
const picked = pickQuestions([q("a", "property_send", "aix", "normal", "文A".repeat(20), "2026-10-03"), q("b", "property_send", "aix", "normal", "文B".repeat(20), "2026-10-02"), q("c", "property_send", "aix", "widen", "文C".repeat(20), "2026-10-01"), q("d", "property_send", "aix", "widen", "文A".repeat(20), "2026-09-01")], { "property_send:aix": 3 });
ok(picked.map((x) => x.id).join() === "a,c,b", `ピッカーを回して選ぶ（${picked.map((x) => x.id).join()}）`);
ok(goldUnusable("（室内イメージ）\n〈URL〉") !== null && goldUnusable(meet.gold) === null, "使えない正解");
const rows = [{ id: "x", hash: "h", button: "待ち合わせ", kind: "aix" as const, text: "", err: null, score: good }];
ok(compareRows(rows, [{ ...rows[0], score: wrongTime }])[0].flip === "pass→fail", "前後の比べ");
ok(summarize(rows).byButton[0].pass === 1, "集計");
ok(questionHash({ route: "aix/action", body: { a: 1, b: 2 }, gold: "g" }) === questionHash({ route: "aix/action", body: { b: 2, a: 1 }, gold: "g" }), "問題の印は鍵の順に依らない");

// 2026-10-23 試験の穴: 内覧日調整の過去の日付は今日以降へずらす（曜日はそのまま）・時刻の印は触らない・他のボタンはずらさない
const vq = { aixType: "viewing_invite", at: "2026-10-15T11:06:09Z", gold: "直近ですと\n10/16(金) 13:00〜15:00\n10/17(土) 16:00〜17:30", inputText: "{\"calendar_info\":\"10/16(金) 13:00〜15:00\"}", body: { calendar_info: "10/16(金) 13:00〜15:00", recent_messages: [{ text: "10/16はどうですか", createdAt: "2026-10-15T10:00:00Z" }] } as Record<string, unknown> };
const days = aixShiftDays(vq, Date.parse("2026-10-23T03:00:00Z"));
ok(days === 14, `ずらす日数は7の倍数（${days}）`);
const vs = shiftQuestionDates(vq, days);
ok(vs.gold.includes("10/30(金)") && vs.gold.includes("10/31(土)") && String(vs.body.calendar_info).startsWith("10/30(金)") && vs.inputText.includes("10/30(金)"), "正解・本文・入力を同じだけずらす");
const rm = (vs.body.recent_messages as Array<{ text: string; createdAt: string }>)[0];
ok(rm.text === "10/30はどうですか" && rm.createdAt === "2026-10-15T10:00:00Z", "会話の文はずらし・時刻の印は触らない");
const rd = aixShiftDays({ ...vq, at: "2026-10-11T04:41:16Z", gold: "明日10/12(月) 11:00〜11:30" }, Date.parse("2026-10-23T03:00:00Z"));
ok(rd === 12 && shiftQuestionDates({ ...vq, at: "2026-10-11T04:41:16Z", gold: "明日10/12(月) 11:00〜11:30" }, rd).gold === "明日10/24(土) 11:00〜11:30", `「明日」がある問題はちょうど今日へ（${rd}）・曜日を付け直す`);
ok(aixShiftDays({ aixType: "property_send", at: "2026-10-01T00:00:00Z" }) === 0, "他のボタンはずらさない");
ok(!propNamesOf("【緊急連絡先欄】\n・氏名").length, "記入の欄の見出しは物件名にしない");
ok(isAppFormat({ aixType: "application_push", body: { app_sub_mode: "format" } }) && !isAppFormat({ aixType: "application_push", body: { app_sub_mode: "push" } }), "申込へ・フォーマットは入口を呼ばない");

console.log(`\n${n - fail}/${n} PASS`);
process.exit(fail ? 1 : 0);

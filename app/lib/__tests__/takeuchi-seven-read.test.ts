// app/lib/__tests__/takeuchi-seven-read.test.ts — 7つの欄＋押す／待つ（npx tsx で回す）。例は Claude Code が読んだ竹内さんの実物（伏せ済み）
import { parseSevenRead, sevenPrompt, SEVEN_SYSTEM, latentIsConcrete, brainSevenGaps, sevenBlueprintNote, sevenReadOn, POINT_METHODS, TRUST_METHODS, parseLatentFour, LATENT_FOUR_SYSTEM } from "../takeuchi-seven-read";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

// c5a0b23b（学生の名義）を読んだ形
const raw = JSON.stringify({
  point: { what: "学生の名義で審査に通るか", how: "結論（代理契約なら1番通る）を先に", skipped: "第一候補の空き（確認結果は送付済み）" },
  bridge: null, lead: "none", appeal: null,
  latent: { what: "今は収入が無い＝自分の名義だと落ちて第一候補を逃すのが怖い", fact: "代理契約だと1番通りやすい", how: "代理契約という道を示し、本人名義でもサポート" },
  point_how: ["conclusion_first", "zzz"], trust_how: ["support", "options"],
  push: { push: false, strength: "strong", reason: "審査の不安の段＝答えるだけ" },
});
const r = parseSevenRead(`前置き ${raw} 後ろ`);
t("読み取り", !!r && r.point.what.startsWith("学生") && r.lead === "none" && r.appeal === null && r.latent?.fact === "代理契約だと1番通りやすい", r);
t("一覧の外は捨てる", r?.point_how.join() === "conclusion_first" && r?.trust_how.join() === "support,options", r);
t("押していなければ強さは null", r?.push.push === false && r?.push.strength === null, r?.push);
t("要点が無ければ null", parseSevenRead('{"point":{"what":""}}') === null && parseSevenRead("x") === null);

t("潜在: 種類だけは具体ではない", !latentIsConcrete("審査の不安") && !latentIsConcrete("費用の不安") && !latentIsConcrete("設備:床の色"));
t("潜在: 具体（事情・物件・時期）", latentIsConcrete("今は収入が無い＝自分の名義だと落ちて第一候補を逃すのが怖い") && latentIsConcrete("11月の内覧まで待つ間に埋まってしまう"));

// ブレインの記録との比べ（07e9f8a9 の形: 物件名はあるが推した点が無い・潜在は種類だけ）
const tk = parseSevenRead(JSON.stringify({ point: { what: "床の色", how: "結論を先に" }, lead: "viewing", appeal: { property: "〈物件〉701号室", point: "階で床の色を選べる", how: "階ごとの事実" }, latent: { what: "白い床が良い→この物件は合わないのでは", fact: "偶数階は白", how: "選択肢を残す" }, point_how: ["conclusion_first"], trust_how: ["fact", "options"], push: { push: true, strength: "mid", reason: "見積の後に設備を聞いた＝刺さっている" } }))!;
const gaps = brainSevenGaps(tk, { q: ["701号室の床の色は白ですか？"], dir: "答える", act: null, mode: "auto_reply", prop: "〈物件〉701号室", concern: "設備:床の色" });
t("比べ: 訴求は物件名だけ・潜在は種類だけ・押さえ方/信頼/押すは欄が無い", gaps.map((g) => `${g.field}:${g.state}`).join() === "appeal:kind_only,latent:kind_only,point_how:missing,trust_how:missing,push:missing", gaps);
t("比べ: 記録なしは全部 missing", brainSevenGaps(tk, null).length === 8);

t("既定 off", !sevenReadOn({}) && sevenBlueprintNote(tk, {}) === null);
const note = sevenBlueprintNote(tk, { TAKEUCHI_SEVEN_READ: "on" }) ?? "";
t("書き手への注記（on の時だけ）", note.includes("奥の心配: 白い床が良い") && note.includes("押す/待つ: 押す(mid)") && note.includes("推した点: 〈物件〉701号室の階で床の色を選べる"), note);
t("指示に欄と一覧", SEVEN_SYSTEM.includes("種類で止めず") && POINT_METHODS.every((m) => SEVEN_SYSTEM.includes(m)) && TRUST_METHODS.every((m) => SEVEN_SYSTEM.includes(m)) && SEVEN_SYSTEM.includes("push"));
const p = sevenPrompt({ maskedCustomer: "山田花です！", maskedBody: "山田花さんお世話になっております！！", scene: "other" });
t("材料: 名乗った本名を伏せる", !p.includes("山田花") && p.includes("YUMAさんお世話"), p);

// 潜在の4つ（KB d72ad06b）: 5f3a4daf の形
const lf = parseLatentFour(JSON.stringify({ trigger: { kind: "customer_words", text: "10／1希望です。" }, part: { property: "〈物件〉", point: "10/1の入居に間に合うか・空き" }, feeling: { what: "10/1まで待つ間に他の人に申し込まれて失う怖さ", strength: "weak" }, want: "10/1入居のまま、この部屋を確保したい", fact: "1部屋のみの募集・抑えられるのは1ヶ月間", phrase: "1部屋のみの募集となりますので、他の方からお申込がはいりますと、お部屋が埋まってしまいます！！", lead: "apply" }));
t("潜在の4つの読み取り", !!lf && lf.trigger.kind === "customer_words" && lf.feeling.strength === "weak" && lf.want.startsWith("10/1") && lf.lead === "apply", lf);
t("潜在の4つ: none・欠けは null・知らないきっかけは scene", parseLatentFour('{"none":true}') === null && parseLatentFour('{"feeling":{"what":"x"}}') === null && parseLatentFour('{"trigger":{"kind":"zzz"},"feeling":{"what":"不安"},"want":"確保したい"}')?.trigger.kind === "scene");
t("潜在の4つの指示", LATENT_FOUR_SYSTEM.includes("何でそれが分かったか") && LATENT_FOUR_SYSTEM.includes("本当はどうしたいのか") && LATENT_FOUR_SYSTEM.includes("strength"));
console.log(`takeuchi-seven-read: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);

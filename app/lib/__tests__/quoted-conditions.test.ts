// app/lib/__tests__/quoted-conditions.test.ts
// 2026-10-02 条件を「」で囲んだ下書き（⑫の再生）の回帰テスト
// 実行: npx tsx app/lib/__tests__/quoted-conditions.test.ts
import { unquoteConditions } from "../quoted-conditions";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} -- ${extra}`); } }

const a = unquoteConditions("はい😊！！\nこちらでも「大国町駅周辺・1K/1LDK・築20年以内・ペット猫可・初期費用30〜35万円」の条件でお部屋ピックアップしお送りさせて頂きます！！");
t("⑫の実物: 「」を外す", a.text === "はい😊！！\nこちらでも大国町駅周辺・1K/1LDK・築20年以内・ペット猫可・初期費用30〜35万円の条件でお部屋ピックアップしお送りさせて頂きます！！", a.text);
t("「〜」でオススメ も外す", unquoteConditions("「難波周辺・1LDK・10万以内」でオススメできるお部屋ピックアップさせて頂きます！！").removed.length === 1);
t("例文の引用（、がある）は変えない", unquoteConditions("例えば、「独立洗面台は必須だが、オートロックは無くても大丈夫」など").removed.length === 0);
t("物件名の引用は変えない", unquoteConditions("「エスリード長居」の募集状況確認させて頂きます！！").removed.length === 0);
t("お客様の言葉の引用（条件でない）は変えない", unquoteConditions("「お部屋お探し中！」のフォーマットでお送りください").removed.length === 0);

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);

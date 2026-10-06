// app/lib/__tests__/opener-repeat.test.ts — 2026-10-06 ⑫ 竹内さん「かしこまりました が並んでいるの文としておかしい」（ゆいと 10/03 の実物）
//   実行: npx tsx app/lib/__tests__/opener-repeat.test.ts
import { collapseRepeatedOpener } from "../opener-repeat";
import { draftToSendableText } from "../draft-text";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const real = "かしこまりました！！\nかしこまりました😊！！\n\n10月後半ご入居可能なお部屋も、茨木・豊中周辺全域からゆいとさんにオススメできるお部屋を新たにピックアップしてお送りさせて頂きます！！";
const r = collapseRepeatedOpener(real);
t("実物: 続く かしこまりました を1つに", r.collapsed === 1 && r.text.startsWith("かしこまりました！！\n\n10月後半"), JSON.stringify(r.text.slice(0, 30)));
t("画面・送信の文（draftToSendableText）でも1つ", (draftToSendableText(real) ?? "").split("かしこまりました").length === 2);
t("承知しました と かしこまりました の並びも1つ", collapseRepeatedOpener("かしこまりました！！\n承知しました😊！！\n本文です！！").collapsed === 1);
t("はい と かしこまりました（受け止め＋受諾）は触らない", collapseRepeatedOpener("はい😊！！\nかしこまりました！！\n本文").collapsed === 0);
t("本文を挟んだ2つ目は触らない", collapseRepeatedOpener("かしこまりました！！\n10/4の内覧をキャンセルさせて頂きます！！\nかしこまりました！！").collapsed === 0);
t("1行の中の かしこまりました（本文つき）は触らない", collapseRepeatedOpener("かしこまりました！！\nかしこまりました、10/4でご案内させて頂きます！！").collapsed === 0);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);

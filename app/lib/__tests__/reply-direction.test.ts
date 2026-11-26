// app/lib/__tests__/reply-direction.test.ts — 返信の下書きが向かった石（2026-11-26 作業員A・#787）
//   実行: npx tsx app/lib/__tests__/reply-direction.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replyCloseKindOf, replyStoneOf, replyDirectionRecordOn, decisionTsWindow } from "../reply-direction";
import { closeKindOf } from "../../../scripts/lib/guide-measure";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const samples = ["お気に召されましたらお申込みでお部屋を抑えさせて頂きます", "ご都合よろしいお日にちございますでしょうか", "ピックアップしてお送りさせて頂きます", "かしこまりました", "ご内覧頂けます", "御見積書作成してお送りします", "ご検討ください"];
t("網は guide-measure の closeKindOf と同じ（竹内さんの番の数え方とそろう）", samples.every((x) => replyCloseKindOf(x) === closeKindOf(x)));
t("見積の駅で内覧の誘い＝次の石へ", replyStoneOf("estimate|||v2", "ご内覧頂けます").rst === "next_stone");
t("提案中で申込のご案内＝申込へ飛ばした・内覧の後なら次の石", replyStoneOf("proposing||", "お申込み頂けます").rst === "skip_apply" && replyStoneOf("viewed||", "お申込み頂けます").rst === "next_stone");
t("約束・答え・駅が分からない", replyStoneOf("pickup||", "お調べします").rst === "promise" && replyStoneOf("pickup||", "かしこまりました").rst === "hold" && replyStoneOf(null, "お調べします").rst === "unknown");
t("既定 on（記録だけ）", replyDirectionRecordOn({}) && !replyDirectionRecordOn({ REPLY_DIRECTION_RECORD: "off" }));
const rt = readFileSync(join(__dirname, "..", "..", "api", "generate-reply", "route.ts"), "utf8");
t("付け先の確かめ: 元の判断が見た通の時刻の前後1秒・無い時は付けない", decisionTsWindow("2026-11-26T01:00:00.000Z")?.lo === "2026-11-26T00:59:59.000Z" && decisionTsWindow(null) === null && decisionTsWindow("x") === null);
t("配線: 元の判断と同じ analyzed_msg_ts の行にだけ rdir・rst（既にあれば上書きしない）", rt.includes("rd.replyStoneOf(") && rt.includes("dg.rdir) return") && rt.includes(".gte(\"analyzed_msg_ts\", win.lo)") && rt.includes("if (!win) return;"));
console.log(`reply-direction: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);

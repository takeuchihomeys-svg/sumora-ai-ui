// 実行: npx tsx app/lib/__tests__/latin-name-head.test.ts
// 2026-10-15 英字の語が空白で並ぶ物件名の頭を戻す（実物の形・スタッフの文 180日）
import { withLatinHead } from "../latin-name-head";
import { viewingPropertyLabels } from "../aix-prefill";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`✗ ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};
const at = (text: string, name: string) => withLatinHead(text, text.indexOf(name), name, {});

eq("Park Lane Minami", at("🌟Park Lane Minami 1302号室", "Minami"), "Park Lane Minami");
eq("改行で止まる", at("かしこまりました！！\nGRAN STELLA松屋町 302号室", "STELLA松屋町"), "GRAN STELLA松屋町");
eq("【 で止まる", at("【URBAN PARK難波南 602号室】", "PARK難波南"), "URBAN PARK難波南");
eq("J.GRAN", at("お送り頂きました\n🌟J.GRAN Court京町堀 1306号室", "Court京町堀"), "J.GRAN Court京町堀");
eq("Tom's House", at("【Tom's House IMAZATO 103号室", "IMAZATO"), "Tom's House IMAZATO");
eq("漢字を挟む", at("🌟Park Hills 難波南 Lumiere 303号室", "Lumiere"), "Park Hills 難波南 Lumiere");
eq("頭の和語は外す", at("お部屋 Tio Grace 101号室", "Grace"), "Tio Grace");
eq("平仮名だけの語で止まる", at("こちら Tio Grace 101号室", "Grace"), "Tio Grace");
eq("和名は触らない", at("先日の エステムコート難波 302号室", "エステムコート難波"), "エステムコート難波");
eq("空白なしは触らない", at("ルクレール今福502号室", "ルクレール今福"), "ルクレール今福");
eq("2つの空白で止まる", at("ご案内  Tio Fleur 102号室", "Fleur"), "Tio Fleur");
eq("時刻の字で止まる", at("13:00〜 Park Lane 302号室", "Lane"), "Park Lane");
eq("off で旧", withLatinHead("🌟Park Lane Minami 1302号室", 12, "Minami", { LATIN_NAME_HEAD: "off" }), "Minami");

eq("待ち合わせの先入れ", viewingPropertyLabels("10/20 13:00〜GRAN TOYONAKA 102号室ご案内させて頂きます！！"), ["GRAN TOYONAKA 102号室"]);
eq("待ち合わせの先入れ（和名）", viewingPropertyLabels("13:00〜アーバネックス堺筋本町 502号室、お部屋ご案内"), ["アーバネックス堺筋本町 502号室"]);

console.log(`latin-name-head: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);

// scripts/verify-sheet-vacancy-read.ts — 取り違えていた実物の資料の画像（12枚・物件の資料だけ＝個人情報なし）を、送った画像の読み方（書き写し→文字の読み取り）で読み直し、
// 現況・退去予定日・入居可能日・内覧可能日を、画像を目で読んだ正解と比べる（DB に書かない・DeepSeek・1枚 約$0.001〜0.002）。
// 2026-10-13 竹内「退去予定日がどこに書いていて、空室がどこに書いているか…正確に読み取る場所が分かるように」の見本の物差し（設計知見 7e96cade: 量を流す前に見本で）。
// 前: SHEET_READ_R2=off SHEET_VACANCY_FIELDS=off（今の本番と同じ読み方）／後: 何も付けない（読み方を直した版）
// 実行: npx tsx --env-file=.env.local scripts/verify-sheet-vacancy-read.ts --label=before   （env を付けて）
//       npx tsx --env-file=.env.local scripts/verify-sheet-vacancy-read.ts --label=after
// 1枚ずつ順に（並列にしない）。
const B = "https://wfwsmwxakhyxobytszoq.supabase.co/storage/v1/object/public/property-images/aix";
const P = "https://eggcrp3ajyl21x7a.public.blob.vercel-storage.com/pickups";
type Truth = { current: RegExp | null; vacate: string | null; moveIn: string | null; viewing?: string | null };
// 正解は画像を目で読んだ物（2026-10-13）。vacate は日付の鍵（M/D・M/末・M/中旬）、moveIn は資料の字（空白なし）
const SAMPLES: Array<{ id: string; name: string; url: string; truth: Truth; why: string }> = [
  { id: "b1", name: "maison de Villa 北畠 202（リアプロ・売上サポ）", url: `${P}/%E7%89%A9%E4%BB%B6%E3%81%BE%E3%81%A8%E3%82%81_2026-9-28_1790573595220_1_1790573598428_p2.png`, truth: { current: /退去予定/, vacate: null, moveIn: "2026年10月20日" }, why: "①入居時期を退去予定に（保存は「退去予定: 2026年10月20日」）" },
  { id: "b2", name: "ラクラス長堀橋 1504（リアプロ・売上サポ）", url: `${P}/%E7%89%A9%E4%BB%B6%E3%81%BE%E3%81%A8%E3%82%81_2026-9-28_1790573653849_7_1790573658787_p2.png`, truth: { current: /退去予定/, vacate: null, moveIn: "2026年11月28日" }, why: "①入居時期を退去予定に" },
  { id: "a5", name: "ジェントリー3 201（元付）", url: `${B}/ba1527de-d06a-4d4e-a889-2977b0d78e04/1787741261812_0_xgyjb.png`, truth: { current: /居住中/, vacate: "8/末", moveIn: "期日指定(2026年09月上旬)" }, why: "②案内方法の「8月末空き予定」を落とす・「期日指定」→「即日指定(2026年09月16日)」" },
  { id: "s5", name: "サザンパークス 705（リアプロ）", url: `${B}/f193d13d-7da3-4460-ae4e-25d9bed5a8e8/1789743123164_05fjy.jpeg`, truth: { current: /退去予定|空き予定/, vacate: "9/30", moveIn: "相談" }, why: "②備考【現況】「空き予定(9/30退去予定)」を落とす" },
  { id: "s7", name: "サンプラザ山坂 202 退去予定の版（リアプロ）", url: `${B}/3a026f56-0d2e-44b3-9ee1-dd4c8b6908a9/1786442818135_1_sj1rf.png`, truth: { current: /退去予定/, vacate: null, moveIn: "2026年8月下旬", viewing: "8/1" }, why: "④特記の内覧可能日が項目に無い" },
  { id: "s6", name: "サンプラザ山坂 202 空室の版（リアプロ）", url: `${B}/3a026f56-0d2e-44b3-9ee1-dd4c8b6908a9/1786443069910_zxs8p.png`, truth: { current: /空室/, vacate: null, moveIn: "2026年8月下旬" }, why: "（対照）" },
  { id: "s8", name: "エステムプラザ本町クロス 402（元付）", url: `${B}/b9b5b2c4-8347-4bef-bdce-322e6a36442d/1784343294083_0_53qd8.png`, truth: { current: null, vacate: "6/30", moveIn: "相談" }, why: "③解約予定日" },
  { id: "s9", name: "ハーモニーテラス森ノ宮 302（元付）", url: `${B}/b0314a3d-2bd9-4576-83ba-aed39af71e83/1786430189120_2_8a1s4.png`, truth: { current: null, vacate: "9/中旬", moveIn: null }, why: "③入居予定日の欄に退去予定" },
  { id: "a1", name: "ジュネスニッコー 1003（自社の資料）", url: `${B}/110b3053-0027-4037-baef-4af8c1c3917b/1789634055011_0_t60jz.jpeg`, truth: { current: null, vacate: null, moveIn: "2026年10月31日" }, why: "（対照）現況「—」・入居可能時期" },
  { id: "a4", name: "プレサンス松屋町駅前デュオ 201（自社の資料）", url: `${B}/63fa0c26-2e4a-4818-a225-16584ac7d842/1791772655211_0_mf0mh.jpeg`, truth: { current: /居住中/, vacate: null, moveIn: "2027年1月上旬" }, why: "（対照）" },
  { id: "a2", name: "Park Lane Minami 1302（リアプロ）", url: `${B}/9faff2ec-77a8-48c2-9b01-fafddfa5029c/1789717802897_q1nwk.jpeg`, truth: { current: /退去予定/, vacate: null, moveIn: "相談" }, why: "（対照）" },
  { id: "s10", name: "Goパレス福島（3室の一覧）", url: `${B}/62d01e33-7993-4f1e-aa7e-c6757e3f6c7c/1790674625096_d2h3h.jpeg`, truth: { current: null, vacate: null, moveIn: null }, why: "（一覧）「状況 10/末」は退去予定日と言い切らない" },
];

async function main() {
  const label = (process.argv.find((a) => a.startsWith("--label=")) ?? "--label=run").slice(8);
  const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
  const { readPropertyImageDetailByTranscript } = await import("../app/lib/property-image-read");
  const { sheetDateKey } = await import("../app/lib/sheet-vacancy");
  const { vacancyDateFromMaterial } = await import("../app/lib/viewing-check-first");
  const sq = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "");
  const tally = { right: 0, wrong: 0, unknown: 0, made: 0 };
  const t0 = Date.now(); let inTok = 0, outTok = 0;
  for (const s of SAMPLES.filter((x) => !only.length || only.includes(x.id))) {
    const d = await readPropertyImageDetailByTranscript(s.url, { timeoutMs: 90_000 });
    inTok += d.usage?.input ?? 0; outTok += d.usage?.output ?? 0;
    const val = (lab: string) => { const l = d.lines.find((x) => new RegExp(`^${lab}\\s*[:：]`).test(x.normalize("NFKC"))); return l ? l.replace(/^[^:：]+[:：]\s*/, "").trim() : null; };
    const got = { current: val("現況"), vacate: val("退去予定"), moveIn: val("入居可能日"), viewing: val("内覧可能日") };
    const res: string[] = [];
    const judge = (name: string, ok: boolean | null, hasTruth: boolean, hasGot: boolean) => {
      const r = ok ? "○" : !hasGot && hasTruth ? "？" : hasGot && !hasTruth ? "作" : "✕";
      if (r === "○") tally.right++; else if (r === "？") tally.unknown++; else if (r === "作") tally.made++; else tally.wrong++;
      res.push(`${name}${r}`);
    };
    // 現況: 正解が無い所は採点しない（作った現況は材料の害が小さい＝数えない）
    if (s.truth.current) judge("現況", !!got.current && s.truth.current.test(got.current), true, !!got.current);
    const gv = got.vacate ? sheetDateKey(got.vacate.replace(/^.*?(?=\d)/, "")) : null;
    if (s.truth.vacate || gv) judge("退去予定", !!gv && gv === sheetDateKey(s.truth.vacate), !!s.truth.vacate, !!gv);
    if (s.truth.moveIn || got.moveIn) judge("入居可能日", !!got.moveIn && sq(got.moveIn) === sq(s.truth.moveIn), !!s.truth.moveIn, !!got.moveIn);
    if (s.truth.viewing) judge("内覧可能日", !!got.viewing && sheetDateKey(got.viewing.replace(/^.*?(?=\d)/, "")) === sheetDateKey(s.truth.viewing), true, !!got.viewing);
    const answer = vacancyDateFromMaterial(d.lines);
    console.log(`■ ${s.id} ${s.name}（${s.why}）[${d.via}]\n   ${res.join(" ")}\n   行: ${d.lines.filter((l) => /^(現況|退去予定|入居可能日|内覧可能日)/.test(l.normalize("NFKC"))).join(" ／ ") || "（なし）"}\n   ブレインの内覧の答えの退去日: ${answer ?? "なし"}`);
  }
  console.log(`\n[${label}] 正しい ${tally.right}・誤り ${tally.wrong}・分からない ${tally.unknown}・作った ${tally.made}（${((Date.now() - t0) / 1000).toFixed(0)}秒・入力 ${inTok}・出力 ${outTok} トークン）`);
}
main().then(() => setTimeout(() => process.exit(0), 1500)).catch((e) => { console.error(e); process.exit(1); });

// scripts/lib/ext-test-parse.ts — ext-test-all.ts が試験の出力を読む部分（純関数・2.8.314）
//   実例: 「結果: ✓8 ✗0」「0 件 ✗」の件数の行の ✗ を失敗と数えて、青い試験 7 本がずっと赤扱いだった。
//   見張る道具の読み違いは「赤の山」を作って本物の赤を隠すので、読み方を純関数にして試験で守る（app/lib/__tests__/ext-test-parse.test.ts）。

/** 失敗の行を比べやすい形にする（版・数字・→以降の値は変わるので丸める） */
export function normFail(line: string): string {
  return line.trim().split(" → ")[0].replace(/\d+(\.\d+)*/g, "#").replace(/\s+/g, " ").slice(0, 140);
}

/** 失敗を示す行（行頭が ✗／❌ ／ NG: ／ FAIL）。件数の行（「✓8 ✗0」「0 件 ✗」）は含めない */
export function failLines(out: string): string[] {
  return out.split(/\r?\n/).filter((l) => /^\s*(NG:|✗|❌|FAIL)/.test(l));
}

/** ✗／❌ で始まる行の数（件数の行の ✗ は数えない） */
export function countNg(out: string): number {
  return out.split(/\r?\n/).filter((l) => /^\s*(✗|❌)/.test(l)).length;
}

/** 失敗した項目の一覧（丸めた形・重複なし） */
export function failKeys(out: string): string[] {
  return [...new Set(failLines(out).map(normFail))];
}

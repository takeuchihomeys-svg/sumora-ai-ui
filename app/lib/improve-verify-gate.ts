/**
 * 「改善したらちゃんと改善したか」の完了線（決定論）
 *
 * 2026-11-23 統括Pro:
 *   拡張再読込→自動1回→F55（read≥1∧新束後自動≥1∧reflect|flow_reflect|aim有≥1）
 *   ＋手順書版一致（自動が読んだ版＝コード版）
 */

export type ImproveVerifyInput = {
  readCount: number;
  autoAfterBundle: number;
  /** learn_reflect_ok / learn_flow_reflect_ok / aim有 のいずれか */
  hasReflectOrAim: boolean;
  playbookSeenRv?: string | null;
  codePlaybookRv: string;
};

export type ImproveVerifyResult = {
  ok: boolean;
  gaps: string[];
  line: string;
};

export function judgeImproveVerified(input: ImproveVerifyInput): ImproveVerifyResult {
  const gaps: string[] = [];
  const read = Number(input.readCount) || 0;
  const auto = Number(input.autoAfterBundle) || 0;
  const code = String(input.codePlaybookRv || "").trim();
  const seen = String(input.playbookSeenRv || "").trim();

  if (read < 1) gaps.push("read<1（拡張が束を読んでいない）");
  if (auto < 1) gaps.push("新束後自動<1");
  if (!input.hasReflectOrAim) gaps.push("reflect|flow_reflect|aim有 が無い");
  if (!seen) gaps.push("playbook_seen が無い");
  else if (code && seen !== code) gaps.push(`手順書版ずれ seen=${seen.slice(0, 8)}≠code=${code.slice(0, 8)}`);

  const ok = gaps.length === 0;
  return {
    ok,
    gaps,
    line: ok
      ? `改善検証✓ read=${read} 自動=${auto} pb=${seen.slice(0, 8)}`
      : `改善検証✗ ${gaps.join("／")}`.slice(0, 200),
  };
}

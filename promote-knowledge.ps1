$result = Invoke-RestMethod -Uri "http://localhost:3000/api/promote-knowledge" -Method POST -ErrorAction SilentlyContinue
if ($result) {
    if ($result.added -gt 0) {
        Write-Output "PHASE_GUIDE自動昇格完了: $($result.added)件追加"
        foreach ($r in $result.report) {
            Write-Output "  [$($r.phase)] $($r.rules -join ', ')"
        }
    } else {
        Write-Output "追加候補なし（全ルール既にカバー済み）"
    }
}

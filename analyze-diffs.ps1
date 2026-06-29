$result = Invoke-RestMethod -Uri "http://localhost:3000/api/analyze-diffs" -Method POST -ErrorAction SilentlyContinue
if ($result) {
    Write-Output "差分学習完了: $($result.learned)件"
}

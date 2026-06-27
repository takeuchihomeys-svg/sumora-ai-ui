Set-Location "c:\Users\竹内 悠馬\sumora-ai-ui"
$status = git status --short 2>$null
if ($status) {
    git add -A
    git commit -m "auto: 3時間自動保存"
    git push
}

# Turn 7 验收：连续两次触发 Dream，检查 dream_empty_backoff
$base = 'http://127.0.0.1:1024/api/memory/dream'

Write-Host 'POST Dream #1...'
Invoke-WebRequest -Method POST -Uri $base | Select-Object StatusCode, Content

Write-Host 'POST Dream #2...'
Invoke-WebRequest -Method POST -Uri $base | Select-Object StatusCode, Content

$telemetry = Join-Path $PSScriptRoot '..\data\runtime\telemetry.jsonl'
if (Test-Path $telemetry) {
  Write-Host "`nRecent dream_empty_backoff entries:"
  Select-String -Pattern 'dream_empty_backoff' -Path $telemetry | Select-Object -Last 5
} else {
  Write-Warning "telemetry not found: $telemetry"
}

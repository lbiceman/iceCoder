param(
    [string]$City = 'Zhengzhou'
)

$ErrorActionPreference = 'Stop'
$logDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $logDir 'weather-zhengzhou.log'
$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

try {
    $resp = Invoke-RestMethod -Uri "https://wttr.in/$City?format=j1" -TimeoutSec 20
    $cur = $resp.current_condition[0]
    $desc = $cur.weatherDesc[0].value
    $line = "$ts  $City  ${($cur.temp_C)}C  $desc  humidity $($cur.humidity)%  wind ${($cur.windspeedKmph)}km/h"
} catch {
    $line = "$ts  $City  ERROR: $($_.Exception.Message)"
}

Add-Content -Path $log -Value $line -Encoding UTF8

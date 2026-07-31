# Подписване на публикуван инсталатор с локален сертификат (USB токен / КЕП).
#
# Защо не стига само signtool: latest.yml носи SHA-512 на .exe файла и
# автоматичното обновяване проверява сваления файл срещу него. Подписването
# променя файла, значи и хеша — ако latest.yml не бъде обновен, всяка вече
# инсталирана програма ще СВАЛЯ новата версия и ще я ОТХВЪРЛЯ.
#
# Употреба (PowerShell, в папка с изтеглените от GitHub Release файлове):
#   .\sign-release.ps1                          # намира .exe и latest.yml сами
#   .\sign-release.ps1 -Subject "Plamen"        # ако на токена има няколко сертификата
#
# След това качете обратно в СЪЩИЯ release: подписания .exe и обновения
# latest.yml (замяна на старите), и ИЗТРИЙТЕ стария .exe.blockmap — той описва
# неподписания файл и вече не отговаря.

param(
  [string]$Exe = '',
  [string]$LatestYml = '',
  [string]$Subject = ''
)
$ErrorActionPreference = 'Stop'

# --- намиране на файловете ---
if (-not $Exe) {
  $found = Get-ChildItem -Path . -Filter 'Inventar-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $found) { throw 'Не е намерен Inventar-Setup-*.exe в текущата папка. Подайте -Exe <път>.' }
  $Exe = $found.FullName
}
if (-not $LatestYml) {
  $LatestYml = Join-Path (Split-Path $Exe) 'latest.yml'
}
if (-not (Test-Path $LatestYml)) { throw "Не е намерен latest.yml до инсталатора ($LatestYml). Изтеглете го от същия release." }
Write-Host "Инсталатор : $Exe"
Write-Host "latest.yml : $LatestYml"

# --- намиране на signtool ---
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($signtool) { $signtool = $signtool.Source }
else {
  $kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $kits) { throw 'signtool.exe не е намерен. Инсталирайте Windows SDK (компонент "Signing Tools").' }
  $signtool = $kits.FullName
}
Write-Host "signtool   : $signtool"

# --- подписване ---
# /a избира автоматично сертификат за подпис на код от личното хранилище
# (токенът трябва да е включен). /n стеснява избора по име, ако са няколко.
$args = @('sign')
if ($Subject) { $args += @('/n', $Subject) } else { $args += '/a' }
$args += @('/fd', 'sha256', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', $Exe)
& $signtool @args
if ($LASTEXITCODE -ne 0) {
  throw 'Подписването се провали. Най-честата причина: сертификатът е КЕП за документи и НЯМА право "Code Signing" — тогава той не може да подписва програми (вижте проверката в README).'
}

# --- проверка ---
& $signtool verify /pa $Exe
if ($LASTEXITCODE -ne 0) { throw 'Подписът не преминава проверка (verify /pa).' }
$sig = Get-AuthenticodeSignature $Exe
Write-Host "Подписан от: $($sig.SignerCertificate.Subject)"

# --- обновяване на latest.yml ---
$bytes  = [IO.File]::ReadAllBytes($Exe)
$sha    = [Security.Cryptography.SHA512]::Create()
$hash64 = [Convert]::ToBase64String($sha.ComputeHash($bytes))
$size   = $bytes.Length
$yml = Get-Content $LatestYml -Raw
$yml = $yml -replace '(?m)^(\s*sha512:\s*).*$', "`${1}$hash64"
$yml = $yml -replace '(?m)^(\s*size:\s*).*$', "`${1}$size"
[IO.File]::WriteAllText($LatestYml, $yml)
Write-Host ''
Write-Host "SHA-512 и размерът в latest.yml са обновени ($size байта)."
Write-Host ''
Write-Host 'Остава да качите в СЪЩИЯ GitHub Release, със замяна на старите:'
Write-Host "  1) $(Split-Path $Exe -Leaf)"
Write-Host '  2) latest.yml'
Write-Host 'и да ИЗТРИЕТЕ стария .exe.blockmap от release-а.'

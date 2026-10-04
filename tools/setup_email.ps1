# Puts a Gmail account into .env so the MKUYU system can e-mail receipts and
# reminders, then sends a sample receipt through the system to check it works.
# The app password is typed here, on this computer only, and written to .env.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$envFile = Join-Path $root '.env'

Write-Host ''
Write-Host 'MKUYU e-mail setup (Gmail)' -ForegroundColor Yellow
Write-Host 'You need a Gmail "app password" (16 letters): Google Account > Security > 2-Step Verification > App passwords.'
Write-Host ''
$address = Read-Host 'Gmail address that sends the receipts [saweanthony1@gmail.com]'
if ([string]::IsNullOrWhiteSpace($address)) { $address = 'saweanthony1@gmail.com' }
$secure = Read-Host 'App password (16 letters, hidden)' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$plain = ($plain -replace '\s', '')
if ($plain.Length -lt 8) { Write-Host 'That password looks too short. Nothing was changed.' -ForegroundColor Red; exit 1 }

$keys = 'SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS','MAIL_FROM','SMTP_TLS_INSECURE'
$lines = @()
if (Test-Path $envFile) {
  Copy-Item $envFile ($envFile + '.before-email') -Force
  $lines = Get-Content $envFile | Where-Object { $k = ($_ -split '=', 2)[0].Trim(); -not ($keys -contains $k) }
}
$lines += ''
$lines += '# Customer e-mails (receipts and reminders)'
$lines += 'SMTP_HOST=smtp.gmail.com'
$lines += 'SMTP_PORT=465'
$lines += 'SMTP_SECURE=true'
$lines += "SMTP_USER=$address"
$lines += "SMTP_PASS=$plain"
$lines += "MAIL_FROM=""MKUYU Real Estate <$address>"""
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
$plain = $null
Write-Host 'Saved in .env (the old file is kept as .env.before-email).' -ForegroundColor Green
Write-Host ''

$to = Read-Host 'Send a sample receipt to [saweanthony1@gmail.com]'
if ([string]::IsNullOrWhiteSpace($to)) { $to = 'saweanthony1@gmail.com' }
Push-Location $root
node tools/send_test_receipt.mjs $to
Pop-Location
Write-Host ''
Write-Host 'Restart the MKUYU system (start-mkuyu.bat) so it uses the new e-mail settings.' -ForegroundColor Yellow

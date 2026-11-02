# WET PAINT: pubblica (o ripubblica) il gioco su SuperRare Studio, da Windows. Si avvia con doppio clic su PUBBLICA.cmd.
#
# Pubblica sempre sulla stessa app, https://5hv4fjbq.srstudio.dev (non ne crea mai un'altra): installa cio' che manca,
# aggiorna i nomi del muro, rifa' i test, fa il login se serve, costruisce e aggiorna l'app. La prima volta su un
# computer chiede l'App ID. Non tocca crediti, pagamenti o wallet.
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
$Config = Join-Path $PSScriptRoot 'deploy\wet-paint.config.json'
$Zip = Join-Path $PSScriptRoot 'dist\wet-paint.zip'

function Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail([string]$text) { Write-Host ''; Write-Host "STOP: $text" -ForegroundColor Red; exit 1 }
function Run([string]$exe, [string[]]$argList, [string]$what) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { Fail "$what non e' riuscito (codice $LASTEXITCODE). Il messaggio e' qui sopra." }
}
# rare-profile con --json: l'ultima riga JSON della risposta, come oggetto (o $null)
function Invoke-Rare([string[]]$argList) {
  $lines = @(& rare-profile @argList --json 2>&1 | ForEach-Object { "$_" })
  $script:CliRaw = ($lines -join "`n")
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $line = "$($lines[$i])".Trim()
    if ($line.StartsWith('{')) { try { return ($line | ConvertFrom-Json) } catch { } }
  }
  return $null
}

Step 'Controllo Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Start-Process 'https://nodejs.org/'; Fail 'Node.js non e'' installato: installa la versione LTS (22 o piu'' recente) dalla pagina appena aperta, poi rilancia PUBBLICA.cmd.' }
$major = [int](((& node --version) -replace '^v', '').Split('.')[0])
if ($major -lt 22) { Start-Process 'https://nodejs.org/'; Fail "Node.js $major e' troppo vecchio: installa la versione LTS (22 o piu' recente), poi rilancia PUBBLICA.cmd." }

Step 'Controllo la riga di comando di SuperRare'
if (-not (Get-Command rare-profile -ErrorAction SilentlyContinue)) { Run 'npm' @('install', '--global', '@rareprotocol/rare-profile@0.1.0') 'L''installazione di rare-profile' }

Step 'Installo le dipendenze del gioco'
if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) { Run 'npm' @('ci') 'npm ci' } else { Write-Host 'gia'' installate.' }

Step 'Aggiorno i nomi del muro'
& node --import tsx scripts/snapshot-wall.ts
if ($LASTEXITCODE -ne 0) { Write-Host 'Il muro non risponde adesso: uso i nomi gia'' inclusi.' -ForegroundColor Yellow }

Step 'Provo il gioco (test delle regole e del verificatore, circa un minuto)'
Run 'npx' @('tsx', '--test', 'tests/wet-paint.test.ts') 'I test'

# WET PAINT ha UNA app, gia' creata: https://5hv4fjbq.srstudio.dev. Questo script non ne crea mai un'altra.
$Origin = 'https://5hv4fjbq.srstudio.dev'
$Answer = Join-Path $PSScriptRoot 'deploy\wet-paint.app.json'
if (-not (Test-Path $Config) -and (Test-Path $Answer)) {
  Step 'Scrivo la configurazione dalla risposta della prima pubblicazione'
  Run 'npx' @('tsx', 'scripts/wet-paint-config.ts', $Answer) 'La scrittura della configurazione'
}
if (-not (Test-Path $Config)) {
  Step "Collego questa cartella all'app di WET PAINT ($Origin)"
  Write-Host 'Serve il suo App ID (una volta sola su questo computer). Lo trovi su SuperRare Studio, nella pagina dell''app,'
  Write-Host 'oppure in deploy\wet-paint.config.json della cartella da cui hai pubblicato la prima volta.'
  $appId = (Read-Host 'Incolla l''App ID e premi Invio').Trim()
  Run 'npx' @('tsx', 'scripts/wet-paint-config.ts', '--app-id', $appId) 'La scrittura della configurazione'
}

$cfg = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
if ("$($cfg.appOrigin)" -ne $Origin) { Fail "deploy\wet-paint.config.json punta a $($cfg.appOrigin), non a $Origin. Cancella quel file e rilancia PUBBLICA.cmd." }
Step "Costruisco il gioco per $($cfg.appOrigin)"
Run 'npx' @('tsx', 'scripts/build.ts', '--config', 'deploy/wet-paint.config.json', '--output', 'dist/wet-paint.zip', '--force') 'La build'

Step 'Pubblico il gioco su SuperRare Studio (verificatore e evento di punteggio compresi)'
$updated = Invoke-Rare @('app', 'update', "$($cfg.appId)", '--zip', $Zip, '--max-attempts', '10000')
if ($null -eq $updated -or -not $updated.ok) {
  if ($updated -and $updated.error -and $updated.error.code -eq 'auth_required') {
    Run 'rare-profile' @('login') 'Il login'
    $updated = Invoke-Rare @('app', 'update', "$($cfg.appId)", '--zip', $Zip, '--max-attempts', '10000')
  }
  if ($null -eq $updated -or -not $updated.ok) { Fail "La pubblicazione non e' riuscita. Risposta: $script:CliRaw" }
}

$line = 'The names of the wall become living brush strokes: follow the brush before the paint dries. One artwork.'
Write-Host ''
Write-Host 'FATTO: WET PAINT e'' online.' -ForegroundColor Green
Write-Host ''
Write-Host "Indirizzo del gioco : $($cfg.appOrigin)"
Write-Host "App ID              : $($cfg.appId)"
Write-Host 'Titolo              : WET PAINT'
Write-Host "Riga                : $line"
Write-Host ''
Write-Host 'Ora apro il gioco (prova la Practice) e la pagina di invio all''arcade: entra con il wallet del tuo nome sul muro,'
Write-Host 'incolla indirizzo, App ID, titolo e riga qui sopra, il tuo wallet per i pagamenti, e spunta la casella.'
try { Set-Clipboard -Value "$($cfg.appOrigin)" } catch { }
Start-Process "$($cfg.appOrigin)/"
Start-Process 'https://thewallarcade.superrare.com/submit.html'

param(
  [string]$Token,
  [string]$Base,
  [switch]$ForceAuth,
  [switch]$DebugList,
  [int]$PageSize = 10,
  [switch]$All
)

if(-not $Base -or $Base -eq '') { $Base = $env:BASE }
if(-not $Base -or $Base -eq '') { $Base = 'https://api.kashflow.com/v2' }

function Acquire-SessionToken {
  Write-Host '--- KashFlow Session Authentication ---' -ForegroundColor Cyan
  # Prefer .env names KFUSERNAME/KFPASSWORD/KFMEMORABLE
  $username = if($env:KFUSERNAME){$env:KFUSERNAME}else{ if($env:KF_USER){$env:KF_USER}else{ Read-Host 'Username' } }
  $password = if($env:KFPASSWORD){$env:KFPASSWORD}else{ if($env:KF_PASS){$env:KF_PASS}else{ Read-Host 'Password (visible)' } }
  $memorable = if($env:KFMEMORABLE){$env:KFMEMORABLE}else{ $env:KF_MEMORABLE }
  $externalToken = $env:KASHFLOW_EXTERNAL_TOKEN
  if(-not $externalToken){ $externalToken = $env:KFEXTERNALTOKEN }
  $externalUid = $env:KASHFLOW_EXTERNAL_UID
  if(-not $externalUid){ $externalUid = $env:KFEXTERNALUID }

  # External token shortcut (spec GET /sessiontoken?externalToken=...&uid=...)
  if($externalToken){
    Write-Host 'Attempting external token exchange...' -ForegroundColor DarkCyan
    try {
      $params = @{ externalToken=$externalToken }
      if($externalUid){ $params.uid = $externalUid }
      $respExt = Invoke-RestMethod -Method Get -Uri "$Base/sessiontoken" -Headers @{ Accept='application/json'} -Body $null -ErrorAction Stop -Verbose:$false -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 30 -DisableKeepAlive -Proxy $null -SkipHeaderValidation:$true -ContentType 'application/json' -Authentication Basic -AllowUnencryptedAuthentication:$false -CertificateThumbprint '' -SslProtocol 'Tls12' @{} -StatusCodeVariable sc -FollowRelLink:$false -HttpVersion '1.1' -NoProxy
    } catch {
      try { $respExt = Invoke-RestMethod -Method Get -Uri "$Base/sessiontoken?externalToken=$externalToken&uid=$externalUid" -Headers @{ Accept='application/json'} -ErrorAction Stop } catch { $respExt = $null }
    }
    $extToken = $respExt.SessionToken, $respExt.Token, $respExt.sessionToken | Where-Object { $_ } | Select-Object -First 1
    if($extToken){ Write-Host 'Session token acquired via external token.' -ForegroundColor Green; return $extToken }
    Write-Host 'External token exchange failed; falling back to username/password.' -ForegroundColor Yellow
  }

  Write-Host 'Requesting step1 response...' -ForegroundColor DarkCyan
  $resp1 = $null
  $errors = @()
  foreach($attempt in @(
    @{ Body = @{ UserName=$username; Password=$password }; Desc='UserName/Password' },
    @{ Body = @{ username=$username; password=$password }; Desc='username/password' },
    @{ Body = 'username='+$username+'&password='+$password; Desc='form-encoded'; Form=$true }
  )){
    try {
      if($attempt.Form){
        $resp1 = Invoke-RestMethod -Method Post -Uri "$Base/sessiontoken" -ContentType 'application/x-www-form-urlencoded' -Headers @{ Accept='application/json'} -Body $attempt.Body -ErrorAction Stop
      } else {
        $resp1 = Invoke-RestMethod -Method Post -Uri "$Base/sessiontoken" -ContentType 'application/json' -Headers @{ Accept='application/json'} -Body ($attempt.Body | ConvertTo-Json) -ErrorAction Stop
      }
      Write-Host ("Step1 succeeded with variant: {0}" -f $attempt.Desc) -ForegroundColor Green
      break
    } catch {
      $errors += "Attempt {0} failed: {1}" -f $attempt.Desc, $_.Exception.Message
    }
  }
  if(-not $resp1){
    Write-Host 'All step1 attempts failed.' -ForegroundColor Red
    $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    return $null
  }

  # Direct token case
  $directToken = $resp1.SessionToken, $resp1.Token, $resp1.sessionToken | Where-Object { $_ }
  if($directToken){
    $tok = $directToken[0]
    Write-Host 'Session token returned directly (no memorable required).' -ForegroundColor Green
    return $tok
  }

  # Extract temporary token variants
  $tempToken = $resp1.TemporaryToken; if(-not $tempToken){ $tempToken = $resp1.TempToken }
  if(-not $tempToken){ $tempToken = $resp1.tempToken }
  if(-not $tempToken){ $tempToken = $resp1.Token }
  if(-not $tempToken){
    Write-Host 'Missing temporary token in step1 response.' -ForegroundColor Red
    Write-Host ('Keys: ' + ( ($resp1 | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name) -join ', ')) -ForegroundColor Yellow
    return $null
  }

  # Determine required positions
  $positions = $null
  if($resp1.MemorableWordList){
    $positions = @()
    foreach($x in $resp1.MemorableWordList){ if($x.Position){ $positions += [int]$x.Position } }
  }
  if(-not $positions -or $positions.Count -lt 3){
    $candidates = @($resp1.requiredChars,$resp1.RequiredCharacterPositions,$resp1.Positions,$resp1.CharacterPositions,$resp1.requiredCharacters) | Where-Object { $_ }
    foreach($c in $candidates){
      if($c -is [System.Collections.IEnumerable]){
        $arr = @(); foreach($n in $c){ if($n -match '^[0-9]+$'){ $arr += [int]$n } }
        if($arr.Count -ge 3){ $positions = $arr; break }
      }
    }
  }
  if(-not $positions -or $positions.Count -lt 3){
    Write-Host 'Step1 did not return character positions (requiredChars etc.).' -ForegroundColor Red
    Write-Host ("Raw step1 (redacted): " + (ConvertTo-Json $resp1 -Depth 5).Substring(0, [Math]::Min(1000,(ConvertTo-Json $resp1 -Depth 5).Length))) -ForegroundColor DarkYellow
    return $null
  }
  Write-Host ('Required positions: ' + ($positions -join ', ')) -ForegroundColor Yellow

  # Auto derive characters from memorable word if provided
  $charsMap = @{}
  if($memorable){
    for($i=0;$i -lt $positions.Count;$i++){
      $pos = $positions[$i]
      $idx = $pos - 1
      $char = if($idx -ge 0 -and $idx -lt $memorable.Length){ $memorable[$idx] } else { '' }
      if($char -and $char.Length -eq 1){ $charsMap[$pos] = $char }
    }
  }
  # Prompt for any missing characters
  foreach($p in $positions){
    if(-not $charsMap.ContainsKey($p)){
      $val = Read-Host "Character at position $p"
      if(-not $val -or $val.Length -ne 1){ Write-Host 'Each entry must be a single character.' -ForegroundColor Red; return $null }
      $charsMap[$p] = $val
    }
  }

  Write-Host 'Submitting step2...' -ForegroundColor DarkCyan
  $step2Token = $null; $step2Errors=@()
  # Variant A: TemporaryToken + MemorableWordList (service code pattern)
  try {
    # Build MemorableWordList preserving order supplied in step1 example
    $bodyA = @{ TemporaryToken=$tempToken; MemorableWordList=@() }
    foreach($p in $positions){ $bodyA.MemorableWordList += @{ Position=$p; Value=$charsMap[$p] } }
    $resp2A = Invoke-RestMethod -Method Put -Uri "$Base/sessiontoken" -ContentType 'application/json' -Headers @{ Accept='application/json'} -Body ($bodyA | ConvertTo-Json -Depth 6) -ErrorAction Stop
    $step2Token = $resp2A.sessionToken, $resp2A.SessionToken, $resp2A.Token | Where-Object { $_ } | Select-Object -First 1
    if($step2Token){ Write-Host 'Step2 succeeded (MemorableWordList).' -ForegroundColor Green }
  } catch { $step2Errors += "MemorableWordList variant failed: $($_.Exception.Message)" }
  # Variant B: tempToken + chars map
  if(-not $step2Token){
    try {
      $bodyB = @{ tempToken=$tempToken; chars=$charsMap }
      $resp2B = Invoke-RestMethod -Method Put -Uri "$Base/sessiontoken" -ContentType 'application/json' -Headers @{ Accept='application/json'} -Body ($bodyB | ConvertTo-Json -Depth 5) -ErrorAction Stop
      $step2Token = $resp2B.sessionToken, $resp2B.SessionToken, $resp2B.Token | Where-Object { $_ } | Select-Object -First 1
      if($step2Token){ Write-Host 'Step2 succeeded (tempToken/chars).' -ForegroundColor Green }
    } catch { $step2Errors += "tempToken/chars variant failed: $($_.Exception.Message)" }
  }
  # Variant C: Legacy Positions/Characters arrays
  if(-not $step2Token){
    try {
      $bodyC = @{ TemporaryToken=$tempToken; Positions=$positions; Characters=($positions | ForEach-Object { $charsMap[$_] }); Character1=$charsMap[$positions[0]]; Character2=$charsMap[$positions[1]]; Character3=$charsMap[$positions[2]] }
      $resp2C = Invoke-RestMethod -Method Put -Uri "$Base/sessiontoken" -ContentType 'application/json' -Headers @{ Accept='application/json'} -Body ($bodyC | ConvertTo-Json -Depth 6) -ErrorAction Stop
      $step2Token = $resp2C.sessionToken, $resp2C.SessionToken, $resp2C.Token | Where-Object { $_ } | Select-Object -First 1
      if($step2Token){ Write-Host 'Step2 succeeded (legacy Positions/Characters).' -ForegroundColor Green }
    } catch { $step2Errors += "Legacy variant failed: $($_.Exception.Message)" }
  }
  if(-not $step2Token){
    Write-Host 'All step2 variants failed.' -ForegroundColor Red
    $step2Errors | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
    return $null
  }
  Write-Host 'Session token acquired.' -ForegroundColor Green
  return $step2Token
}

if(-not $Token -or $Token -eq '' -or $ForceAuth) {
  $Token = Acquire-SessionToken
}
if(-not $Token){ Write-Host 'Cannot continue without session token.' -ForegroundColor Red; exit }

function Browse($Endpoint,$KeyProp,$DescProp){
  Write-Host ("Listing $Endpoint ...") -ForegroundColor DarkGray
  $raw = $null
  try {
    $raw = Invoke-RestMethod -Headers @{ Authorization = "KfToken $Token"; Accept='application/json'} -Uri "$Base/$Endpoint"
  } catch {
    Write-Host ("Error fetching {0}: {1}" -f $Endpoint, $_.Exception.Message) -ForegroundColor Red; return
  }
  if(-not $raw){ Write-Host "Empty response for $Endpoint" -ForegroundColor Yellow; return }

  # Resolve array: direct array OR wrapper property
  $arr = $null
  if($raw -is [System.Collections.IEnumerable] -and $raw.GetType().Name -ne 'String') {
    $arr = $raw
  } else {
    $candidateProps = @('Customers','Suppliers','Invoices','Purchases','Projects','Quotes','Nominals','Items','Data','Results','List')
    foreach($p in $candidateProps){
      if($raw.PSObject.Properties.Name -contains $p) {
        $val = $raw.$p
        if($val -is [System.Collections.IEnumerable] -and $val.Count -gt 0){ $arr = $val; break }
      }
    }
  }
  if(-not $arr){
    Write-Host "Could not resolve list array for $Endpoint" -ForegroundColor Yellow
    if($DebugList){
      Write-Host 'Raw (truncated 800 chars):' -ForegroundColor DarkYellow
      try { (ConvertTo-Json $raw -Depth 6).Substring(0,[Math]::Min(800,(ConvertTo-Json $raw -Depth 6).Length)) | Write-Host } catch {}
    }
    return
  }
  if($arr.Count -eq 0){ Write-Host "No records for $Endpoint" -ForegroundColor Yellow; return }
  if($All){ $PageSize = $arr.Count }
  if($PageSize -lt 1){ $PageSize = $arr.Count }
  $page = 0
  $maxPage = [math]::Floor( ($arr.Count - 1) / $PageSize )
  while($true){
    Clear-Host
    Write-Host ("Listing $Endpoint (page {0}/{1}, total {2})" -f ($page+1), ($maxPage+1), $arr.Count) -ForegroundColor DarkGray
    $start = $page * $PageSize
    $end = [math]::Min($start + $PageSize - 1, $arr.Count - 1)
    for($i=$start; $i -le $end; $i++){
      $item = $arr[$i]
      $key  = $item.$KeyProp
      $desc = $item.$DescProp
      if(-not $desc){ $desc='(no desc)' }
      Write-Host ("{0}: {1} - {2}" -f $i,$key,$desc)
    }
    Write-Host ''
    Write-Host 'Commands: index | code | n=next | p=prev | a=all | q=back'
    $sel = Read-Host ("Selection")
    if($sel -eq 'n'){ if($page -lt $maxPage){ $page++; continue } else { Write-Host 'Already at last page.' -ForegroundColor Yellow; Start-Sleep -Milliseconds 700; continue } }
    if($sel -eq 'p'){ if($page -gt 0){ $page--; continue } else { Write-Host 'Already at first page.' -ForegroundColor Yellow; Start-Sleep -Milliseconds 700; continue } }
    if($sel -eq 'a'){ $PageSize = $arr.Count; $page = 0; $maxPage = 0; continue }
    if($sel -eq 'q'){ return }
    break
  }
  # After break we treat $sel as index or key
  if($sel -match '^[0-9]+$'){
    $idx = [int]$sel
    if($idx -ge 0 -and $idx -lt $arr.Count){ $sel = $arr[$idx].$KeyProp }
  }
  if(-not $sel){ Write-Host 'No selection' -ForegroundColor Yellow; return }
  try {
    $detail = Invoke-RestMethod -Headers @{ Authorization = "KfToken $Token"; Accept='application/json'} -Uri "$Base/$Endpoint/$sel"
    $detail | ConvertTo-Json -Depth 8
  } catch {
    Write-Host "Detail fetch failed: $($_.Exception.Message)" -ForegroundColor Red
  }
}

while($true){
  Write-Host '==============================================='
  Write-Host '  KashFlow REST Interactive GET Browser'
  Write-Host ("  Base: $Base")
  Write-Host '==============================================='
  Write-Host '1) Customers'
  Write-Host '2) Suppliers'
  Write-Host '3) Invoices'
  Write-Host '4) Purchases'
  Write-Host '5) Projects'
  Write-Host '6) Quotes'
  Write-Host '7) Nominals'
  Write-Host 'Q) Quit'
  $choice = Read-Host 'Select resource'
  switch($choice){
    '1' { Browse 'customers' 'Code' 'Name' }
    '2' { Browse 'suppliers' 'Code' 'Name' }
    '3' { Browse 'invoices' 'InvoiceNumber' 'CustomerCode' }
    '4' { Browse 'purchases' 'PurchaseNumber' 'SupplierCode' }
    '5' { Browse 'projects' 'Number' 'Name' }
    '6' { Browse 'quotes' 'QuoteNumber' 'CustomerCode' }
    '7' { Browse 'nominals' 'Code' 'Description' }
    'Q' { break }
    Default { Write-Host 'Invalid choice' -ForegroundColor Yellow }
  }
  if($choice -eq 'Q'){ break }
  Write-Host ''
  Write-Host 'Press Enter to continue...'
  [void][Console]::ReadLine()
}
Write-Host 'Goodbye.'

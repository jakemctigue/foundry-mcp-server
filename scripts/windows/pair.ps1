[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AppDataPath,
    [string]$AdapterCommand = 'foundry-mcp-adapter',
    [string[]]$AdapterArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'pair.ps1 requires Windows because pairing secrets are protected with current-user DPAPI.'
}

Add-Type -AssemblyName System.Security

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($LiteralPath, $Value, $encoding)
}

if ([string]::IsNullOrWhiteSpace($AppDataPath)) {
    $basePath = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($basePath)) {
        $basePath = $env:APPDATA
    }
    if ([string]::IsNullOrWhiteSpace($basePath)) {
        throw 'LOCALAPPDATA or APPDATA must be available, or pass -AppDataPath explicitly.'
    }
    $AppDataPath = Join-Path -Path $basePath -ChildPath 'foundry-mcp'
}

$resolvedAppData = [System.IO.Path]::GetFullPath($AppDataPath)
$secretDirectory = Join-Path -Path $resolvedAppData -ChildPath 'secrets'
$secretPath = Join-Path -Path $secretDirectory -ChildPath 'pairing.secret'
$metadataPath = Join-Path -Path $secretDirectory -ChildPath 'pairing.json'

function ConvertTo-Base32 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    $bits = 0
    $value = 0
    $builder = [System.Text.StringBuilder]::new()
    foreach ($byte in $Bytes) {
        $value = ($value -shl 8) -bor $byte
        $bits += 8
        while ($bits -ge 5) {
            [void]$builder.Append($alphabet[($value -shr ($bits - 5)) -band 31])
            $bits -= 5
        }
    }
    if ($bits -gt 0) {
        [void]$builder.Append($alphabet[($value -shl (5 - $bits)) -band 31])
    }
    return $builder.ToString()
}

$rawSecret = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $random.GetBytes($rawSecret)
}
finally {
    $random.Dispose()
}
$displaySecret = ConvertTo-Base32 -Bytes $rawSecret
$protectedSecret = [System.Security.Cryptography.ProtectedData]::Protect(
    $rawSecret,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)

if ($PSCmdlet.ShouldProcess($secretPath, 'Generate or rotate current-user DPAPI pairing secret')) {
    New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
    [System.IO.File]::WriteAllBytes($secretPath, $protectedSecret)
    $metadata = [ordered]@{
        schemaVersion = 1
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        protection = 'DPAPI-CurrentUser'
    }
    Write-Utf8NoBom -LiteralPath $metadataPath -Value ($metadata | ConvertTo-Json)

    $identityName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $icaclsPath = Join-Path -Path $env:SystemRoot -ChildPath 'System32\icacls.exe'
    & $icaclsPath $secretPath '/inheritance:r' '/grant:r' "${identityName}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to restrict the pairing secret ACL to the current Windows user.'
    }
}

$clientConfig = [ordered]@{
    mcpServers = [ordered]@{
        'foundry-vtt' = [ordered]@{
            command = $AdapterCommand
            args = @($AdapterArguments)
        }
    }
}

Write-Output "Pairing secret (shown once; paste into the Foundry module): $displaySecret"
Write-Output 'MCP client configuration (contains no secret):'
Write-Output ($clientConfig | ConvertTo-Json -Depth 8)

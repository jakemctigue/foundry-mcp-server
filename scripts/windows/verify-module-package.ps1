[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ZipPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression

function Read-ZipEntryBytes {
    param(
        [Parameter(Mandatory = $true)]$Entry,
        [Parameter(Mandatory = $true)][int64]$MaximumBytes
    )

    if ([int64]$Entry.Length -gt $MaximumBytes) {
        throw "ZIP entry exceeds the $MaximumBytes-byte package limit: $($Entry.FullName)"
    }

    $inputStream = $null
    $outputStream = $null
    try {
        $inputStream = $Entry.Open()
        $outputStream = New-Object System.IO.MemoryStream
        $buffer = New-Object byte[] 65536
        [int64]$totalBytes = 0
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $totalBytes += $read
            if ($totalBytes -gt $MaximumBytes) {
                throw "ZIP entry expanded beyond the $MaximumBytes-byte package limit: $($Entry.FullName)"
            }
            $outputStream.Write($buffer, 0, $read)
        }
        if ($totalBytes -ne [int64]$Entry.Length) {
            throw "ZIP entry expanded byte count does not match its declaration: $($Entry.FullName)"
        }
        return ,$outputStream.ToArray()
    }
    finally {
        if ($null -ne $outputStream) {
            $outputStream.Dispose()
        }
        if ($null -ne $inputStream) {
            $inputStream.Dispose()
        }
    }
}

$resolvedZip = [System.IO.Path]::GetFullPath($ZipPath)
if (-not (Test-Path -LiteralPath $resolvedZip -PathType Leaf)) {
    throw "Foundry module package not found: $resolvedZip"
}
$zipItem = Get-Item -LiteralPath $resolvedZip -Force
if (($zipItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Foundry module package must be a regular file, not a reparse point.'
}
if ([int64]$zipItem.Length -gt 64MB) {
    throw 'Foundry module package exceeds the 64 MiB release limit.'
}

$expectedEntries = @(
    'foundry-mcp/module.json',
    'foundry-mcp/scripts/foundry-mcp.js'
)
$archiveStream = $null
$archive = $null
$manifest = $null
$bundleBytes = $null
try {
    $archiveStream = New-Object System.IO.FileStream(
        $resolvedZip,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $archive = New-Object System.IO.Compression.ZipArchive(
        $archiveStream,
        [System.IO.Compression.ZipArchiveMode]::Read,
        $true
    )
    $entries = @($archive.Entries)
    if ($entries.Count -ne $expectedEntries.Count) {
        throw "Foundry module package contains $($entries.Count) entries; expected exactly $($expectedEntries.Count)."
    }

    $entryMap = @{}
    foreach ($entry in $entries) {
        $entryName = ([string]$entry.FullName).Replace('\', '/')
        if ($entryName.EndsWith('/') -or [string]::IsNullOrWhiteSpace([string]$entry.Name)) {
            throw "Foundry module package contains a directory or empty entry: $entryName"
        }
        if ($entryMap.ContainsKey($entryName)) {
            throw "Foundry module package contains a duplicate entry: $entryName"
        }
        $entryMap[$entryName] = $entry
    }
    foreach ($expectedEntry in $expectedEntries) {
        if (-not $entryMap.ContainsKey($expectedEntry)) {
            throw "Foundry module package is missing allowlisted entry: $expectedEntry"
        }
    }
    foreach ($entryName in $entryMap.Keys) {
        if ($expectedEntries -notcontains $entryName) {
            throw "Foundry module package contains a non-allowlisted entry: $entryName"
        }
    }

    [byte[]]$manifestBytes = Read-ZipEntryBytes -Entry $entryMap['foundry-mcp/module.json'] -MaximumBytes 65536
    $bundleBytes = Read-ZipEntryBytes -Entry $entryMap['foundry-mcp/scripts/foundry-mcp.js'] -MaximumBytes 32MB
    if ($bundleBytes.Length -eq 0) {
        throw 'Foundry module package contains an empty browser bundle.'
    }
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $manifest = $strictUtf8.GetString($manifestBytes) | ConvertFrom-Json
    $bundleText = $strictUtf8.GetString([byte[]]$bundleBytes)
    if ($bundleText -match 'sourceMappingURL=' -or $bundleText -match '(?i)@foundry-mcp/') {
        throw 'Foundry module browser bundle contains a development-only reference.'
    }

    if ([string]$manifest.id -ne 'foundry-mcp' -or [string]$manifest.type -ne 'module') {
        throw 'Foundry module manifest has the wrong id or type.'
    }
    if (
        [string]$manifest.compatibility.minimum -ne '14' -or
        [string]$manifest.compatibility.verified -ne '14' -or
        [string]$manifest.compatibility.maximum -ne '14'
    ) {
        throw 'Foundry module manifest must target only Foundry v14.'
    }
    $esmodules = @($manifest.esmodules)
    if ($esmodules.Count -ne 1 -or [string]$esmodules[0] -ne 'scripts/foundry-mcp.js') {
        throw 'Foundry module manifest must expose only scripts/foundry-mcp.js.'
    }
}
finally {
    if ($null -ne $archive) {
        $archive.Dispose()
    }
    if ($null -ne $archiveStream) {
        $archiveStream.Dispose()
    }
}

$sha256 = (Get-FileHash -LiteralPath $resolvedZip -Algorithm SHA256).Hash.ToLowerInvariant()
[pscustomobject]@{
    zipPath = $resolvedZip
    sha256 = $sha256
    version = [string]$manifest.version
    foundryVersion = '14'
    entries = $expectedEntries
}

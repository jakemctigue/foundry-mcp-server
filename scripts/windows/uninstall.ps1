[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$FoundryUserDataPath,

    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')]
    [string]$ModuleId = 'foundry-mcp'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ownershipManifestName = '.foundry-mcp-install-manifest.json'

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    return [System.IO.Path]::GetFullPath($LiteralPath)
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($LiteralPath, $Value, $encoding)
}

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$RootPath
    )
    $candidate = Resolve-FullPath -LiteralPath $LiteralPath
    $root = (Resolve-FullPath -LiteralPath $RootPath).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
    if (($candidate -ne $root) -and (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Refusing path outside owned module root: $candidate"
    }
    return $candidate
}

$resolvedUserData = Resolve-FullPath -LiteralPath $FoundryUserDataPath
$modulesRoot = Join-Path -Path (Join-Path -Path $resolvedUserData -ChildPath 'Data') -ChildPath 'modules'
$targetPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $modulesRoot -ChildPath $ModuleId) -RootPath $modulesRoot
$ownershipManifestPath = Join-Path -Path $targetPath -ChildPath $ownershipManifestName

if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
    Write-Output "Module '$ModuleId' is already absent from '$targetPath'."
    return
}
if (-not (Test-Path -LiteralPath $ownershipManifestPath -PathType Leaf)) {
    throw "Refusing to remove unrecognized module directory without an ownership manifest: $targetPath"
}

$manifest = Get-Content -LiteralPath $ownershipManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (($manifest.schemaVersion -ne 1) -or ($manifest.moduleId -ne $ModuleId)) {
    throw 'Ownership manifest is invalid or belongs to another module.'
}
if ((Resolve-FullPath -LiteralPath ([string]$manifest.foundryUserDataPath)) -ne $resolvedUserData) {
    throw 'Ownership manifest targets a different Foundry User Data directory.'
}
if ((Resolve-FullPath -LiteralPath ([string]$manifest.targetPath)) -ne $targetPath) {
    throw 'Ownership manifest targets a different module directory.'
}

$ownedFiles = @()
foreach ($entry in @($manifest.files)) {
    $relativePath = [string]$entry.relativePath
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [System.IO.Path]::IsPathRooted($relativePath)) {
        throw 'Ownership manifest contains an unsafe file path.'
    }
    $ownedPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $targetPath -ChildPath $relativePath) -RootPath $targetPath
    if (Test-Path -LiteralPath $ownedPath -PathType Leaf) {
        $currentHash = Get-Sha256Hex -LiteralPath $ownedPath
        if ($currentHash -ne ([string]$entry.sha256).ToLowerInvariant()) {
            throw "Refusing to remove modified file whose hash no longer matches the ownership manifest: $ownedPath"
        }
    }
    $ownedFiles += $ownedPath
}

if ($PSCmdlet.ShouldProcess($targetPath, 'Remove only files recorded in the ownership manifest')) {
    foreach ($ownedPath in $ownedFiles) {
        if (Test-Path -LiteralPath $ownedPath -PathType Leaf) {
            Remove-Item -LiteralPath $ownedPath -Force
        }
    }

    $unknownFiles = @(
        Get-ChildItem -LiteralPath $targetPath -File -Recurse |
            Where-Object { $_.FullName -ne $ownershipManifestPath }
    )
    if ($unknownFiles.Count -gt 0) {
        $manifest.state = 'uninstalled-with-unowned-files-preserved'
        $manifest.files = @()
        Write-Utf8NoBom -LiteralPath $ownershipManifestPath -Value ($manifest | ConvertTo-Json -Depth 8)
        Write-Warning "Preserved $($unknownFiles.Count) unowned file(s) and the ownership marker under '$targetPath'."
    }
    else {
        Remove-Item -LiteralPath $ownershipManifestPath -Force
        $directories = @(Get-ChildItem -LiteralPath $targetPath -Directory -Recurse | Sort-Object FullName -Descending)
        foreach ($directory in $directories) {
            if (@(Get-ChildItem -LiteralPath $directory.FullName -Force).Count -eq 0) {
                Remove-Item -LiteralPath $directory.FullName -Force
            }
        }
        if (@(Get-ChildItem -LiteralPath $targetPath -Force).Count -eq 0) {
            Remove-Item -LiteralPath $targetPath -Force
        }
    }
}

Write-Output "Uninstalled owned files for module '$ModuleId' from '$targetPath'."

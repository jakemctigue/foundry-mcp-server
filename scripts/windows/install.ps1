[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$FoundryUserDataPath,

    [Parameter(Mandatory = $true)]
    [string]$ModuleSourcePath,

    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')]
    [string]$ModuleId = 'foundry-mcp',

    [ValidateSet('Desktop', 'DockerBindMount')]
    [string]$Layout = 'Desktop'
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

function Read-OwnershipManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$ExpectedModuleId,
        [Parameter(Mandatory = $true)][string]$ExpectedUserDataPath,
        [Parameter(Mandatory = $true)][string]$ExpectedTargetPath
    )
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (($manifest.schemaVersion -ne 1) -or ($manifest.moduleId -ne $ExpectedModuleId)) {
        throw 'Existing ownership manifest is invalid or belongs to another module.'
    }
    if ((Resolve-FullPath -LiteralPath ([string]$manifest.foundryUserDataPath)) -ne $ExpectedUserDataPath) {
        throw 'Existing ownership manifest targets a different Foundry User Data directory.'
    }
    if ((Resolve-FullPath -LiteralPath ([string]$manifest.targetPath)) -ne $ExpectedTargetPath) {
        throw 'Existing ownership manifest targets a different module directory.'
    }
    return $manifest
}

$resolvedUserData = Resolve-FullPath -LiteralPath $FoundryUserDataPath
if (-not (Test-Path -LiteralPath $resolvedUserData -PathType Container)) {
    throw "Foundry User Data directory does not exist: $resolvedUserData"
}

$dataRoot = Join-Path -Path $resolvedUserData -ChildPath 'Data'
$modulesRoot = Join-Path -Path $dataRoot -ChildPath 'modules'
$targetPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $modulesRoot -ChildPath $ModuleId) -RootPath $modulesRoot
$ownershipManifestPath = Join-Path -Path $targetPath -ChildPath $ownershipManifestName

$temporaryExtractPath = $null
try {
    $resolvedSource = Resolve-FullPath -LiteralPath $ModuleSourcePath
    if (Test-Path -LiteralPath $resolvedSource -PathType Container) {
        $sourceRoot = $resolvedSource
    }
    elseif ((Test-Path -LiteralPath $resolvedSource -PathType Leaf) -and ([System.IO.Path]::GetExtension($resolvedSource) -ieq '.zip')) {
        $temporaryExtractPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("foundry-mcp-install-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $temporaryExtractPath | Out-Null
        Expand-Archive -LiteralPath $resolvedSource -DestinationPath $temporaryExtractPath
        if (Test-Path -LiteralPath (Join-Path -Path $temporaryExtractPath -ChildPath 'module.json') -PathType Leaf) {
            $sourceRoot = $temporaryExtractPath
        }
        else {
            $candidates = @(
                Get-ChildItem -LiteralPath $temporaryExtractPath -Directory |
                    Where-Object { Test-Path -LiteralPath (Join-Path -Path $_.FullName -ChildPath 'module.json') -PathType Leaf }
            )
            if ($candidates.Count -ne 1) {
                throw 'Module zip must contain module.json at its root or in exactly one top-level directory.'
            }
            $sourceRoot = $candidates[0].FullName
        }
    }
    else {
        throw 'ModuleSourcePath must be a module directory or zip archive.'
    }

    $moduleManifestPath = Join-Path -Path $sourceRoot -ChildPath 'module.json'
    if (-not (Test-Path -LiteralPath $moduleManifestPath -PathType Leaf)) {
        throw 'Module source is missing module.json.'
    }
    $moduleManifest = Get-Content -LiteralPath $moduleManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$moduleManifest.id -ne $ModuleId) {
        throw "Module source id does not match requested ModuleId '$ModuleId'."
    }

    $previousManifest = $null
    $previousOwnedPaths = @{}
    if (Test-Path -LiteralPath $targetPath -PathType Container) {
        if (-not (Test-Path -LiteralPath $ownershipManifestPath -PathType Leaf)) {
            throw "Refusing to overwrite unowned module directory: $targetPath"
        }
        $previousManifest = Read-OwnershipManifest `
            -ManifestPath $ownershipManifestPath `
            -ExpectedModuleId $ModuleId `
            -ExpectedUserDataPath $resolvedUserData `
            -ExpectedTargetPath $targetPath
        foreach ($entry in @($previousManifest.files)) {
            $relativePath = [string]$entry.relativePath
            if ([System.IO.Path]::IsPathRooted($relativePath)) {
                throw 'Ownership manifest contains an absolute file path.'
            }
            [void](Assert-ContainedPath -LiteralPath (Join-Path -Path $targetPath -ChildPath $relativePath) -RootPath $targetPath)
            $previousOwnedPaths[$relativePath] = $true
        }
    }

    $sourceFiles = @(
        Get-ChildItem -LiteralPath $sourceRoot -File -Recurse |
            Where-Object { $_.Name -ne $ownershipManifestName }
    )
    if ($sourceFiles.Count -eq 0) {
        throw 'Module source contains no installable files.'
    }

    $plannedFiles = @()
    foreach ($sourceFile in $sourceFiles) {
        $relativePath = $sourceFile.FullName.Substring($sourceRoot.Length).TrimStart(
            [char[]]@(
                [System.IO.Path]::DirectorySeparatorChar,
                [System.IO.Path]::AltDirectorySeparatorChar
            )
        )
        if ([string]::IsNullOrWhiteSpace($relativePath) -or [System.IO.Path]::IsPathRooted($relativePath)) {
            throw 'Module source produced an unsafe relative path.'
        }
        $destination = Assert-ContainedPath -LiteralPath (Join-Path -Path $targetPath -ChildPath $relativePath) -RootPath $targetPath
        if ((Test-Path -LiteralPath $destination -PathType Leaf) -and (-not $previousOwnedPaths.ContainsKey($relativePath))) {
            throw "Refusing to overwrite unowned file: $destination"
        }
        $plannedFiles += [pscustomobject]@{
            source = $sourceFile.FullName
            destination = $destination
            relativePath = $relativePath
            sha256 = Get-Sha256Hex -LiteralPath $sourceFile.FullName
        }
    }

    if ($PSCmdlet.ShouldProcess($targetPath, "Install Foundry module for $Layout layout")) {
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        foreach ($file in $plannedFiles) {
            $destinationDirectory = Split-Path -Path $file.destination -Parent
            New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
            Copy-Item -LiteralPath $file.source -Destination $file.destination -Force
        }

        $currentRelativePaths = @{}
        foreach ($file in $plannedFiles) {
            $currentRelativePaths[$file.relativePath] = $true
        }
        if ($null -ne $previousManifest) {
            foreach ($entry in @($previousManifest.files)) {
                $relativePath = [string]$entry.relativePath
                if (-not $currentRelativePaths.ContainsKey($relativePath)) {
                    $stalePath = Assert-ContainedPath -LiteralPath (Join-Path -Path $targetPath -ChildPath $relativePath) -RootPath $targetPath
                    if (Test-Path -LiteralPath $stalePath -PathType Leaf) {
                        Remove-Item -LiteralPath $stalePath -Force
                    }
                }
            }
        }

        $manifest = [ordered]@{
            schemaVersion = 1
            moduleId = $ModuleId
            layout = $Layout
            foundryUserDataPath = $resolvedUserData
            targetPath = $targetPath
            installedAt = [DateTimeOffset]::UtcNow.ToString('o')
            state = 'installed'
            files = @(
                $plannedFiles | ForEach-Object {
                    [ordered]@{ relativePath = $_.relativePath; sha256 = $_.sha256 }
                }
            )
        }
        $temporaryManifestPath = $ownershipManifestPath + '.tmp'
        Write-Utf8NoBom -LiteralPath $temporaryManifestPath -Value ($manifest | ConvertTo-Json -Depth 8)
        Move-Item -LiteralPath $temporaryManifestPath -Destination $ownershipManifestPath -Force
    }

    Write-Output "Installed module '$ModuleId' at '$targetPath' for layout '$Layout'."
}
finally {
    if ($null -ne $temporaryExtractPath) {
        $resolvedTemporary = Resolve-FullPath -LiteralPath $temporaryExtractPath
        $temporaryRoot = (Resolve-FullPath -LiteralPath ([System.IO.Path]::GetTempPath())).TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        ) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $resolvedTemporary.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to remove a temporary extraction path outside the system temp directory.'
        }
        if (Test-Path -LiteralPath $resolvedTemporary) {
            Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
        }
    }
}

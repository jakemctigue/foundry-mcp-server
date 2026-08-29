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

function Assert-NoReparsePathComponents {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $candidate = Resolve-FullPath -LiteralPath $LiteralPath
    $pathRoot = [System.IO.Path]::GetPathRoot($candidate)
    if ([string]::IsNullOrWhiteSpace($pathRoot)) {
        throw "Path has no filesystem root: $candidate"
    }
    $current = $pathRoot
    $relative = $candidate.Substring($pathRoot.Length)
    $segments = $relative.Split(
        [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        ),
        [System.StringSplitOptions]::RemoveEmptyEntries
    )
    foreach ($segment in $segments) {
        $current = Join-Path -Path $current -ChildPath $segment
        if (-not (Test-Path -LiteralPath $current)) {
            break
        }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing reparse point or junction path component: $current"
        }
    }
    return $candidate
}

function Assert-NoReparseTree {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath)) {
        return
    }
    [void](Assert-NoReparsePathComponents -LiteralPath $LiteralPath)
    $rootItem = Get-Item -LiteralPath $LiteralPath -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse point or junction: $LiteralPath"
    }
    if (-not $rootItem.PSIsContainer) {
        return
    }
    $pending = New-Object System.Collections.Stack
    $pending.Push($rootItem.FullName)
    while ($pending.Count -gt 0) {
        $directory = [string]$pending.Pop()
        foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing reparse point or junction within module tree: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                $pending.Push($child.FullName)
            }
        }
    }
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )
    foreach ($entry in @(Get-ChildItem -LiteralPath $SourcePath -Force)) {
        Copy-Item -LiteralPath $entry.FullName -Destination $DestinationPath -Recurse -Force
    }
}

function Remove-OwnedSiblingTree {
    param(
        [string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$ModulesRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedPrefix
    )
    if ([string]::IsNullOrWhiteSpace($LiteralPath) -or (-not (Test-Path -LiteralPath $LiteralPath))) {
        return
    }
    $safePath = Assert-ContainedPath -LiteralPath $LiteralPath -RootPath $ModulesRoot
    $leaf = Split-Path -Path $safePath -Leaf
    if (-not $leaf.StartsWith($ExpectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove an unexpected sibling path: $safePath"
    }
    Assert-NoReparseTree -LiteralPath $safePath
    Remove-Item -LiteralPath $safePath -Recurse -Force
}

$resolvedUserData = Resolve-FullPath -LiteralPath $FoundryUserDataPath
$dataRoot = Join-Path -Path $resolvedUserData -ChildPath 'Data'
$modulesRoot = Join-Path -Path $dataRoot -ChildPath 'modules'
$targetPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $modulesRoot -ChildPath $ModuleId) -RootPath $modulesRoot
$ownershipManifestPath = Join-Path -Path $targetPath -ChildPath $ownershipManifestName

[void](Assert-NoReparsePathComponents -LiteralPath $resolvedUserData)
[void](Assert-NoReparsePathComponents -LiteralPath $dataRoot)
[void](Assert-NoReparsePathComponents -LiteralPath $modulesRoot)
[void](Assert-NoReparsePathComponents -LiteralPath $targetPath)

if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
    Write-Output "Module '$ModuleId' is already absent from '$targetPath'."
    return
}
Assert-NoReparseTree -LiteralPath $targetPath
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

$ownedEntries = @()
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
    $ownedEntries += [pscustomobject]@{
        relativePath = $relativePath
        expectedHash = ([string]$entry.sha256).ToLowerInvariant()
    }
}

if (-not $PSCmdlet.ShouldProcess($targetPath, 'Stage and atomically remove only files recorded in the ownership manifest')) {
    Write-Output "Planned: stage and atomically uninstall owned files for module '$ModuleId' from '$targetPath' while preserving unrelated files."
    return
}

$stagePrefix = ".$ModuleId.uninstall-stage-"
$backupPrefix = ".$ModuleId.uninstall-backup-"
$stagePath = $null
$backupPath = $null
$targetMovedToBackup = $false
$operationCommitted = $false

try {
    [void](Assert-NoReparsePathComponents -LiteralPath $resolvedUserData)
    [void](Assert-NoReparsePathComponents -LiteralPath $dataRoot)
    [void](Assert-NoReparsePathComponents -LiteralPath $modulesRoot)
    [void](Assert-NoReparsePathComponents -LiteralPath $targetPath)
    Assert-NoReparseTree -LiteralPath $targetPath

    $operationId = [guid]::NewGuid().ToString('N')
    $stagePath = Assert-ContainedPath -LiteralPath (Join-Path -Path $modulesRoot -ChildPath ($stagePrefix + $operationId)) -RootPath $modulesRoot
    $backupPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $modulesRoot -ChildPath ($backupPrefix + $operationId)) -RootPath $modulesRoot
    New-Item -ItemType Directory -Path $stagePath | Out-Null
    Copy-DirectoryContents -SourcePath $targetPath -DestinationPath $stagePath
    Assert-NoReparseTree -LiteralPath $stagePath

    foreach ($entry in $ownedEntries) {
        $stagedOwnedPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $stagePath -ChildPath $entry.relativePath) -RootPath $stagePath
        if (Test-Path -LiteralPath $stagedOwnedPath -PathType Leaf) {
            if ((Get-Sha256Hex -LiteralPath $stagedOwnedPath) -ne $entry.expectedHash) {
                throw "Staged file hash verification failed before uninstall: $($entry.relativePath)"
            }
            Remove-Item -LiteralPath $stagedOwnedPath -Force
        }
    }

    $stagedManifestPath = Join-Path -Path $stagePath -ChildPath $ownershipManifestName
    $unknownFiles = @(
        Get-ChildItem -LiteralPath $stagePath -File -Recurse -Force |
            Where-Object { $_.FullName -ne $stagedManifestPath }
    )
    $preserveTarget = $unknownFiles.Count -gt 0
    if ($preserveTarget) {
        $manifest.state = 'uninstalled-with-unowned-files-preserved'
        $manifest.files = @()
        Write-Utf8NoBom -LiteralPath $stagedManifestPath -Value ($manifest | ConvertTo-Json -Depth 8)
    }
    elseif (Test-Path -LiteralPath $stagedManifestPath -PathType Leaf) {
        Remove-Item -LiteralPath $stagedManifestPath -Force
    }
    Assert-NoReparseTree -LiteralPath $stagePath

    [void](Assert-NoReparsePathComponents -LiteralPath $modulesRoot)
    [void](Assert-NoReparsePathComponents -LiteralPath $targetPath)
    Assert-NoReparseTree -LiteralPath $targetPath

    if (-not $preserveTarget) {
        Remove-OwnedSiblingTree -LiteralPath $stagePath -ModulesRoot $modulesRoot -ExpectedPrefix $stagePrefix
        $stagePath = $null
    }

    Move-Item -LiteralPath $targetPath -Destination $backupPath
    $targetMovedToBackup = $true
    if ($preserveTarget) {
        try {
            Move-Item -LiteralPath $stagePath -Destination $targetPath
            $stagePath = $null
        }
        catch {
            $activationError = $_
            if (-not (Test-Path -LiteralPath $targetPath) -and (Test-Path -LiteralPath $backupPath)) {
                try {
                    Move-Item -LiteralPath $backupPath -Destination $targetPath
                    $targetMovedToBackup = $false
                }
                catch {
                    throw "Uninstall activation failed and rollback also failed. Preserved backup: $backupPath. Activation: $activationError Rollback: $_"
                }
            }
            throw $activationError
        }
        Write-Warning "Preserved $($unknownFiles.Count) unowned file(s) and the ownership marker under '$targetPath'."
    }
    $operationCommitted = $true

    if ($targetMovedToBackup -and (Test-Path -LiteralPath $backupPath)) {
        try {
            Remove-OwnedSiblingTree -LiteralPath $backupPath -ModulesRoot $modulesRoot -ExpectedPrefix $backupPrefix
            $targetMovedToBackup = $false
        }
        catch {
            Write-Warning "Uninstalled module, but could not remove the old owned-files backup '$backupPath': $_"
        }
    }

    Write-Output "Uninstalled owned files for module '$ModuleId' from '$targetPath'."
}
finally {
    try {
        Remove-OwnedSiblingTree -LiteralPath $stagePath -ModulesRoot $modulesRoot -ExpectedPrefix $stagePrefix
    }
    catch {
        Write-Warning "Could not safely clean uninstall staging path '$stagePath': $_"
    }
    if ($operationCommitted -and $targetMovedToBackup -and (Test-Path -LiteralPath $backupPath)) {
        try {
            Remove-OwnedSiblingTree -LiteralPath $backupPath -ModulesRoot $modulesRoot -ExpectedPrefix $backupPrefix
        }
        catch {
            Write-Warning "Preserved old owned-files backup for manual cleanup at '$backupPath': $_"
        }
    }
}

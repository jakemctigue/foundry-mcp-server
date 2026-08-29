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
Add-Type -AssemblyName System.IO.Compression

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

function Expand-ValidatedZipArchive {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )
    $maxEntries = 4096
    $maxDepth = 24
    $maxEntryNameLength = 512
    $maxArchiveBytes = 128MB
    $maxEntryExpandedBytes = 64MB
    $maxTotalExpandedBytes = 256MB
    $maxCompressionRatio = 100.0
    $nestedArchiveExtensions = @('.zip', '.jar', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.cab')

    if (Test-Path -LiteralPath $DestinationRoot) {
        throw "ZIP extraction destination must not already exist: $DestinationRoot"
    }
    [void](Assert-NoReparsePathComponents -LiteralPath (Split-Path -Path $DestinationRoot -Parent))
    [void](Assert-NoReparsePathComponents -LiteralPath $DestinationRoot)

    $archiveStream = $null
    $archive = $null
    try {
        $archiveStream = New-Object System.IO.FileStream(
            $ArchivePath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        if ($archiveStream.Length -gt $maxArchiveBytes) {
            throw "ZIP archive exceeds the compressed-byte limit of $maxArchiveBytes bytes."
        }
        $archive = New-Object System.IO.Compression.ZipArchive(
            $archiveStream,
            [System.IO.Compression.ZipArchiveMode]::Read,
            $true
        )
        $entries = @($archive.Entries)
        if ($entries.Count -gt $maxEntries) {
            throw "ZIP entry count $($entries.Count) exceeds the limit of $maxEntries."
        }

        $destinationRootFull = [System.IO.Path]::GetFullPath($DestinationRoot).TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )
        $destinationPrefix = $destinationRootFull + [System.IO.Path]::DirectorySeparatorChar
        $pathTypes = @{}
        $records = New-Object System.Collections.Generic.List[object]
        [int64]$totalDeclaredBytes = 0
        [int64]$totalCompressedBytes = 0

        foreach ($entry in $entries) {
            $entryName = [string]$entry.FullName
            if ([string]::IsNullOrWhiteSpace($entryName) -or $entryName.Length -gt $maxEntryNameLength) {
                throw "ZIP entry name is empty or exceeds the $maxEntryNameLength-character limit."
            }
            if ($entryName.IndexOf([char]0) -ge 0 -or $entryName -match '[\x00-\x1f]') {
                throw "ZIP entry name contains a control character: $entryName"
            }
            $normalizedName = $entryName.Replace('\', '/')
            if ($normalizedName.StartsWith('/') -or $normalizedName -match '^[a-zA-Z]:') {
                throw "ZIP entry uses an absolute path: $entryName"
            }
            $isDirectory = $normalizedName.EndsWith('/')
            $trimmedName = $normalizedName.TrimEnd('/')
            if ([string]::IsNullOrWhiteSpace($trimmedName) -or $normalizedName.Contains('//')) {
                throw "ZIP entry has an invalid or ambiguous path: $entryName"
            }
            $segments = @(
                $trimmedName.Split(
                    [char[]]@('/'),
                    [System.StringSplitOptions]::None
                )
            )
            if ($segments.Count -gt $maxDepth) {
                throw "ZIP entry path depth $($segments.Count) exceeds the limit of ${maxDepth}: $entryName"
            }
            foreach ($segment in $segments) {
                if (($segment -eq '.') -or ($segment -eq '..')) {
                    throw "ZIP entry contains a traversal parent segment: $entryName"
                }
                if ($segment.Contains(':')) {
                    throw "ZIP entry contains a colon or alternate data stream path: $entryName"
                }
                if ($segment -match '[<>"|?*]' -or $segment.Length -gt 255 -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
                    throw "ZIP entry contains an invalid Windows path segment: $entryName"
                }
                $deviceStem = [System.IO.Path]::GetFileNameWithoutExtension($segment)
                if ($deviceStem -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$') {
                    throw "ZIP entry contains a reserved Windows device name: $entryName"
                }
            }
            $canonicalName = $segments -join '/'
            if ($pathTypes.ContainsKey($canonicalName)) {
                throw "ZIP contains duplicate case-insensitive entry paths: $entryName"
            }

            [int64]$rawAttributes = ([int64]$entry.ExternalAttributes) -band 4294967295
            [int64]$dosAttributes = $rawAttributes -band 65535
            [int64]$unixMode = ($rawAttributes -shr 16) -band 65535
            [int64]$unixFileType = $unixMode -band 61440
            if (($dosAttributes -band 1024) -ne 0) {
                throw "ZIP entry carries a Windows reparse-point attribute: $entryName"
            }
            if ($unixFileType -eq 40960) {
                throw "ZIP entry is a symbolic link: $entryName"
            }
            if (($unixFileType -ne 0) -and ($unixFileType -notin @(16384, 32768))) {
                throw "ZIP entry is an unsupported special file: $entryName"
            }
            if (($isDirectory -and $unixFileType -eq 32768) -or (-not $isDirectory -and $unixFileType -eq 16384)) {
                throw "ZIP entry type conflicts with its path form: $entryName"
            }

            [int64]$declaredBytes = $entry.Length
            [int64]$compressedBytes = $entry.CompressedLength
            if ($declaredBytes -lt 0 -or $compressedBytes -lt 0) {
                throw "ZIP entry has an invalid declared size: $entryName"
            }
            if ($isDirectory) {
                if ($declaredBytes -ne 0 -or $compressedBytes -ne 0) {
                    throw "ZIP directory entry declares file content: $entryName"
                }
                $pathTypes[$canonicalName] = 'directory'
            }
            else {
                if ($nestedArchiveExtensions -contains [System.IO.Path]::GetExtension($segments[-1]).ToLowerInvariant()) {
                    throw "ZIP contains a nested archive, which is not allowed: $entryName"
                }
                if ($declaredBytes -gt $maxEntryExpandedBytes) {
                    throw "ZIP entry declared expanded size exceeds the per-entry limit of $maxEntryExpandedBytes bytes: $entryName"
                }
                if ($declaredBytes -gt 0 -and $compressedBytes -eq 0) {
                    throw "ZIP entry has an unbounded compression ratio: $entryName"
                }
                if ($compressedBytes -gt 0) {
                    $compressionRatio = [double]$declaredBytes / [double]$compressedBytes
                    if ($compressionRatio -gt $maxCompressionRatio) {
                        throw "ZIP entry compression ratio exceeds the limit of ${maxCompressionRatio}:1: $entryName"
                    }
                }
                $totalDeclaredBytes += $declaredBytes
                $totalCompressedBytes += $compressedBytes
                if ($totalDeclaredBytes -gt $maxTotalExpandedBytes) {
                    throw "ZIP total declared expanded size exceeds the limit of $maxTotalExpandedBytes bytes."
                }
                if ($totalCompressedBytes -gt $maxArchiveBytes) {
                    throw "ZIP total compressed entry size exceeds the limit of $maxArchiveBytes bytes."
                }
                $pathTypes[$canonicalName] = 'file'
            }

            $platformRelativePath = $canonicalName.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $destinationPath = [System.IO.Path]::GetFullPath((Join-Path -Path $destinationRootFull -ChildPath $platformRelativePath))
            if (-not $destinationPath.StartsWith($destinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "ZIP entry destination escapes the owned extraction root: $entryName"
            }
            [void]$records.Add([pscustomobject]@{
                entry = $entry
                canonicalName = $canonicalName
                destinationPath = $destinationPath
                isDirectory = $isDirectory
                declaredBytes = $declaredBytes
            })
        }

        foreach ($record in $records) {
            $recordSegments = @($record.canonicalName.Split('/'))
            for ($index = 1; $index -lt $recordSegments.Count; $index += 1) {
                $parentName = $recordSegments[0..($index - 1)] -join '/'
                if ($pathTypes.ContainsKey($parentName) -and $pathTypes[$parentName] -eq 'file') {
                    throw "ZIP entry path descends through another file entry: $($record.canonicalName)"
                }
            }
        }

        [void][System.IO.Directory]::CreateDirectory($destinationRootFull)
        [void](Assert-NoReparsePathComponents -LiteralPath $destinationRootFull)
        [int64]$totalExpandedBytes = 0
        foreach ($record in $records) {
            if ($record.isDirectory) {
                [void][System.IO.Directory]::CreateDirectory($record.destinationPath)
                [void](Assert-NoReparsePathComponents -LiteralPath $record.destinationPath)
                continue
            }
            $destinationDirectory = Split-Path -Path $record.destinationPath -Parent
            [void][System.IO.Directory]::CreateDirectory($destinationDirectory)
            [void](Assert-NoReparsePathComponents -LiteralPath $destinationDirectory)
            [void](Assert-NoReparsePathComponents -LiteralPath $record.destinationPath)

            $entryStream = $null
            $destinationStream = $null
            [int64]$entryExpandedBytes = 0
            try {
                $entryStream = $record.entry.Open()
                $destinationStream = New-Object System.IO.FileStream(
                    $record.destinationPath,
                    [System.IO.FileMode]::CreateNew,
                    [System.IO.FileAccess]::Write,
                    [System.IO.FileShare]::None
                )
                $buffer = New-Object byte[] 65536
                while (($read = $entryStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $entryExpandedBytes += $read
                    $totalExpandedBytes += $read
                    if ($entryExpandedBytes -gt $record.declaredBytes) {
                        throw "ZIP entry expanded beyond its declared byte count: $($record.canonicalName)"
                    }
                    if ($entryExpandedBytes -gt $maxEntryExpandedBytes -or $totalExpandedBytes -gt $maxTotalExpandedBytes) {
                        throw "ZIP actual expanded bytes exceeded the configured extraction limit: $($record.canonicalName)"
                    }
                    $destinationStream.Write($buffer, 0, $read)
                }
                if ($entryExpandedBytes -ne $record.declaredBytes) {
                    throw "ZIP entry actual expanded byte count does not match its declaration: $($record.canonicalName)"
                }
            }
            finally {
                if ($null -ne $destinationStream) {
                    $destinationStream.Dispose()
                }
                if ($null -ne $entryStream) {
                    $entryStream.Dispose()
                }
            }
        }
        Assert-NoReparseTree -LiteralPath $destinationRootFull
    }
    finally {
        if ($null -ne $archive) {
            $archive.Dispose()
        }
        if ($null -ne $archiveStream) {
            $archiveStream.Dispose()
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

$resolvedSource = Resolve-FullPath -LiteralPath $ModuleSourcePath
$sourceIsDirectory = Test-Path -LiteralPath $resolvedSource -PathType Container
$sourceIsZip = (Test-Path -LiteralPath $resolvedSource -PathType Leaf) -and ([System.IO.Path]::GetExtension($resolvedSource) -ieq '.zip')
if (-not $sourceIsDirectory -and -not $sourceIsZip) {
    throw 'ModuleSourcePath must be a module directory or zip archive.'
}

$dataRoot = Join-Path -Path $resolvedUserData -ChildPath 'Data'
$modulesRoot = Join-Path -Path $dataRoot -ChildPath 'modules'
$targetPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $modulesRoot -ChildPath $ModuleId) -RootPath $modulesRoot
$ownershipManifestPath = Join-Path -Path $targetPath -ChildPath $ownershipManifestName

if (-not $PSCmdlet.ShouldProcess($targetPath, "Stage and atomically install Foundry module for $Layout layout")) {
    Write-Output "Planned: validate, stage, and atomically install module '$ModuleId' at '$targetPath' without changing files."
    return
}

$stagePrefix = ".$ModuleId.stage-"
$backupPrefix = ".$ModuleId.backup-"
$extractPrefix = ".$ModuleId.extract-"
$stagePath = $null
$backupPath = $null
$extractPath = $null
$targetMovedToBackup = $false
$stageActivated = $false

try {
    [void](Assert-NoReparsePathComponents -LiteralPath $resolvedUserData)
    [void](Assert-NoReparsePathComponents -LiteralPath $dataRoot)
    [void](Assert-NoReparsePathComponents -LiteralPath $modulesRoot)
    [void](Assert-NoReparsePathComponents -LiteralPath $targetPath)
    [void](Assert-NoReparsePathComponents -LiteralPath $resolvedSource)

    New-Item -ItemType Directory -Path $modulesRoot -Force | Out-Null
    [void](Assert-NoReparsePathComponents -LiteralPath $modulesRoot)
    [void](Assert-NoReparsePathComponents -LiteralPath $targetPath)

    $operationId = [guid]::NewGuid().ToString('N')
    $stagePath = Assert-ContainedPath -LiteralPath (Join-Path -Path $modulesRoot -ChildPath ($stagePrefix + $operationId)) -RootPath $modulesRoot
    $backupPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $modulesRoot -ChildPath ($backupPrefix + $operationId)) -RootPath $modulesRoot
    New-Item -ItemType Directory -Path $stagePath | Out-Null

    if ($sourceIsZip) {
        $extractPath = Assert-ContainedPath -LiteralPath (Join-Path -Path $modulesRoot -ChildPath ($extractPrefix + $operationId)) -RootPath $modulesRoot
        Expand-ValidatedZipArchive -ArchivePath $resolvedSource -DestinationRoot $extractPath
        if (Test-Path -LiteralPath (Join-Path -Path $extractPath -ChildPath 'module.json') -PathType Leaf) {
            $sourceRoot = $extractPath
        }
        else {
            $candidates = @(
                Get-ChildItem -LiteralPath $extractPath -Directory |
                    Where-Object { Test-Path -LiteralPath (Join-Path -Path $_.FullName -ChildPath 'module.json') -PathType Leaf }
            )
            if ($candidates.Count -ne 1) {
                throw 'Module zip must contain module.json at its root or in exactly one top-level directory.'
            }
            $sourceRoot = $candidates[0].FullName
        }
    }
    else {
        $sourceRoot = $resolvedSource
    }

    Assert-NoReparseTree -LiteralPath $sourceRoot
    if (Test-Path -LiteralPath $targetPath) {
        Assert-NoReparseTree -LiteralPath $targetPath
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
            if ([string]::IsNullOrWhiteSpace($relativePath) -or [System.IO.Path]::IsPathRooted($relativePath)) {
                throw 'Ownership manifest contains an unsafe file path.'
            }
            [void](Assert-ContainedPath -LiteralPath (Join-Path -Path $targetPath -ChildPath $relativePath) -RootPath $targetPath)
            $previousOwnedPaths[$relativePath] = $true
        }
        Copy-DirectoryContents -SourcePath $targetPath -DestinationPath $stagePath
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
        $liveDestination = Assert-ContainedPath -LiteralPath (Join-Path -Path $targetPath -ChildPath $relativePath) -RootPath $targetPath
        if ((Test-Path -LiteralPath $liveDestination -PathType Leaf) -and (-not $previousOwnedPaths.ContainsKey($relativePath))) {
            throw "Refusing to overwrite unowned file: $liveDestination"
        }
        $stageDestination = Assert-ContainedPath -LiteralPath (Join-Path -Path $stagePath -ChildPath $relativePath) -RootPath $stagePath
        $plannedFiles += [pscustomobject]@{
            source = $sourceFile.FullName
            destination = $stageDestination
            relativePath = $relativePath
            sha256 = Get-Sha256Hex -LiteralPath $sourceFile.FullName
        }
    }

    foreach ($file in $plannedFiles) {
        $destinationDirectory = Split-Path -Path $file.destination -Parent
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
        Copy-Item -LiteralPath $file.source -Destination $file.destination -Force
        if ((Get-Sha256Hex -LiteralPath $file.destination) -ne $file.sha256) {
            throw "Staged file hash verification failed: $($file.relativePath)"
        }
    }

    $currentRelativePaths = @{}
    foreach ($file in $plannedFiles) {
        $currentRelativePaths[$file.relativePath] = $true
    }
    if ($null -ne $previousManifest) {
        foreach ($entry in @($previousManifest.files)) {
            $relativePath = [string]$entry.relativePath
            if (-not $currentRelativePaths.ContainsKey($relativePath)) {
                $stalePath = Assert-ContainedPath -LiteralPath (Join-Path -Path $stagePath -ChildPath $relativePath) -RootPath $stagePath
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
    Write-Utf8NoBom -LiteralPath (Join-Path -Path $stagePath -ChildPath $ownershipManifestName) -Value ($manifest | ConvertTo-Json -Depth 8)
    Assert-NoReparseTree -LiteralPath $stagePath

    [void](Assert-NoReparsePathComponents -LiteralPath $modulesRoot)
    [void](Assert-NoReparsePathComponents -LiteralPath $targetPath)
    if (Test-Path -LiteralPath $targetPath) {
        Assert-NoReparseTree -LiteralPath $targetPath
        Move-Item -LiteralPath $targetPath -Destination $backupPath
        $targetMovedToBackup = $true
    }
    try {
        Move-Item -LiteralPath $stagePath -Destination $targetPath
        $stageActivated = $true
    }
    catch {
        $activationError = $_
        if ($targetMovedToBackup -and (-not (Test-Path -LiteralPath $targetPath)) -and (Test-Path -LiteralPath $backupPath)) {
            try {
                Move-Item -LiteralPath $backupPath -Destination $targetPath
                $targetMovedToBackup = $false
            }
            catch {
                throw "Module activation failed and rollback also failed. Preserved backup: $backupPath. Activation: $activationError Rollback: $_"
            }
        }
        throw $activationError
    }

    if ($targetMovedToBackup -and (Test-Path -LiteralPath $backupPath)) {
        try {
            Remove-OwnedSiblingTree -LiteralPath $backupPath -ModulesRoot $modulesRoot -ExpectedPrefix $backupPrefix
            $targetMovedToBackup = $false
        }
        catch {
            Write-Warning "Installed module, but could not remove the preserved old-version backup '$backupPath': $_"
        }
    }

    Write-Output "Installed module '$ModuleId' at '$targetPath' for layout '$Layout'."
}
finally {
    foreach ($cleanup in @(
        [pscustomobject]@{ path = $stagePath; prefix = $stagePrefix },
        [pscustomobject]@{ path = $extractPath; prefix = $extractPrefix }
    )) {
        try {
            Remove-OwnedSiblingTree -LiteralPath $cleanup.path -ModulesRoot $modulesRoot -ExpectedPrefix $cleanup.prefix
        }
        catch {
            Write-Warning "Could not safely clean temporary path '$($cleanup.path)': $_"
        }
    }
    if ($stageActivated -and $targetMovedToBackup -and (Test-Path -LiteralPath $targetPath)) {
        try {
            Remove-OwnedSiblingTree -LiteralPath $backupPath -ModulesRoot $modulesRoot -ExpectedPrefix $backupPrefix
        }
        catch {
            Write-Warning "Preserved old-version backup for manual cleanup at '$backupPath': $_"
        }
    }
}

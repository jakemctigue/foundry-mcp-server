[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [ValidateSet('win-x64', 'win-arm64')]
    [string[]]$RuntimeIdentifiers = @('win-x64', 'win-arm64'),

    [uri]$NuGetSource = 'https://api.nuget.org/v3/index.json'
)

$ErrorActionPreference = 'Stop'
$nativeRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$projectPath = Join-Path $nativeRoot 'windows-pipe-broker/FoundryMcp.WindowsPipeBroker.csproj'
$outputRoot = Join-Path $nativeRoot 'bin'
$outputRootWithSeparator = $outputRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

foreach ($runtimeIdentifier in $RuntimeIdentifiers) {
    $outputPath = Join-Path $outputRoot $runtimeIdentifier
    $fullOutputPath = [IO.Path]::GetFullPath($outputPath)
    if (-not $fullOutputPath.StartsWith($outputRootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to publish outside the native output root: $fullOutputPath"
    }
    if (Test-Path -LiteralPath $fullOutputPath) {
        Remove-Item -LiteralPath $fullOutputPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $fullOutputPath -Force | Out-Null

    dotnet publish $projectPath `
        --configuration $Configuration `
        --runtime $runtimeIdentifier `
        --self-contained true `
        --source $NuGetSource.AbsoluteUri `
        --nologo `
        --output $fullOutputPath `
        -p:PublishBroker=true `
        -p:ContinuousIntegrationBuild=true `
        -p:Deterministic=true `
        -p:PathMap="$nativeRoot=/_/foundry-mcp-pipe-broker"
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet publish failed for $runtimeIdentifier"
    }

    $executablePath = Join-Path $fullOutputPath 'foundry-mcp-pipe-broker.exe'
    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        throw "Published broker executable was not produced for $runtimeIdentifier"
    }
    $executable = Get-Item -LiteralPath $executablePath
    $manifest = [ordered]@{
        schemaVersion = 1
        runtimeIdentifier = $runtimeIdentifier
        file = $executable.Name
        size = $executable.Length
        sha256 = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fullOutputPath 'manifest.json') -Encoding utf8NoBOM
}

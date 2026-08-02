[CmdletBinding()]
param(
    [string]$Vps = 'root@80.211.141.173',
    [string]$Key = "$env:USERPROFILE\.ssh\github_actions_sapius",
    [switch]$SkipSource,
    [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$Scp = Join-Path $env:WINDIR 'System32\OpenSSH\scp.exe'
$Tar = Join-Path $env:WINDIR 'System32\tar.exe'
$SshOptions = @('-i', $Key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=25')
$Version = (Get-Content -LiteralPath (Join-Path $Root 'apps\desktop\package.json') -Raw | ConvertFrom-Json).version

function Invoke-Native {
    param(
        [Parameter(Mandatory)] [string]$Command,
        [Parameter(Mandatory)] [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $Command"
    }
}

if (-not (Test-Path -LiteralPath $Key)) {
    throw "SSH key not found: $Key"
}

if (-not $SkipSource) {
    $Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
    $Archive = Join-Path $Root ".local-run\neurion-source-$Stamp.tar.gz"
    $RemoteArchive = "/tmp/neurion-source-$Stamp.tar.gz"
    $ProjectName = Split-Path $Root -Leaf
    $Parent = Split-Path $Root -Parent
    New-Item -ItemType Directory -Force -Path (Split-Path $Archive -Parent) | Out-Null

    try {
        Write-Host '=== creating sanitized source archive ==='
        $TarArguments = @(
            '-czf', $Archive,
            '--exclude=neurion/.env',
            '--exclude=neurion/.env.*',
            '--exclude=*/.env',
            '--exclude=*/.env.*',
            '--exclude=neurion/.git',
            '--exclude=neurion/.local-data',
            '--exclude=neurion/.local-run',
            '--exclude=neurion/.runtime',
            '--exclude=neurion/.turbo',
            '--exclude=neurion/node_modules',
            '--exclude=*/node_modules',
            '--exclude=*/node_modules/*',
            '--exclude=*/.next',
            '--exclude=*/.next/*',
            '--exclude=*/dist',
            '--exclude=*/dist/*',
            '--exclude=*/staging',
            '--exclude=*/staging/*',
            '--exclude=*/dist-installer',
            '--exclude=*/dist-installer/*',
            '--exclude=*/dist-installer-*',
            '--exclude=*/dist-installer-*/*',
            '--exclude=*/cache',
            '--exclude=*/cache/*',
            '--exclude=*/artifacts',
            '--exclude=*/artifacts/*',
            '--exclude=*.tsbuildinfo',
            '-C', $Parent,
            $ProjectName
        )
        Invoke-Native -Command $Tar -Arguments $TarArguments

        $Entries = & $Tar -tf $Archive
        if ($LASTEXITCODE -ne 0) {
            throw 'Unable to inspect the source archive.'
        }
        $SensitiveEntries = @($Entries | Where-Object { $_ -match '(^|/)\.env($|\.)' })
        if ($SensitiveEntries.Count -gt 0) {
            throw "Source archive contains environment files: $($SensitiveEntries -join ', ')"
        }

        Write-Host '=== uploading source archive ==='
        Invoke-Native -Command $Scp -Arguments ($SshOptions + @($Archive, "${Vps}:$RemoteArchive"))

        $RemoteDeploy = @"
set -euo pipefail
test -f /opt/neurion/.env.production
mkdir -p /opt/neurion-backups
tar -czf /opt/neurion-backups/neurion-before-$Stamp.tar.gz \
  --exclude='neurion/node_modules' --exclude='neurion/*/node_modules' \
  --exclude='neurion/*/*/node_modules' --exclude='neurion/*/.next' \
  --exclude='neurion/*/*/.next' --exclude='neurion/*/dist' \
  --exclude='neurion/*/*/dist' --exclude='neurion/*/staging' \
  --exclude='neurion/*/dist-installer' -C /opt neurion
test "`$(realpath /opt/neurion)" = '/opt/neurion'
find /opt/neurion -mindepth 1 -maxdepth 1 \
  ! -name '.env.production' ! -name '.dbpass' ! -name '.adminpw' \
  -exec rm -rf -- {} +
tar -xzf '$RemoteArchive' -C /opt
rm -f '$RemoteArchive'
bash /opt/neurion/infra/deploy-vps.sh
"@
        Write-Host '=== deploying application on the VPS ==='
        Invoke-Native -Command $Ssh -Arguments ($SshOptions + @($Vps, $RemoteDeploy))
    }
    finally {
        Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
    }
}

if (-not $SkipInstaller) {
    $Installer = Join-Path $Root "apps\desktop\dist-installer\Neurion-Setup-$Version.exe"
    if (-not (Test-Path -LiteralPath $Installer)) {
        throw "Installer not found: $Installer"
    }

    # Update manifest. The desktop app polls latest.json and verifies the
    # installer against this digest before running it, so the hash must be
    # computed from the exact file being uploaded.
    $Sha = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLower()
    $Manifest = [ordered]@{
        version = $Version
        url     = "Neurion-Setup-$Version.exe"
        sha256  = $Sha
        notes   = "Neurion $Version"
    }
    $ManifestPath = Join-Path $Root "apps\desktop\dist-installer\latest.json"
    # WriteAllText with an explicit BOM-less encoder: Set-Content -Encoding utf8
    # emits a UTF-8 BOM on Windows PowerShell 5.1, and JSON.parse rejects it.
    [System.IO.File]::WriteAllText(
        $ManifestPath,
        ($Manifest | ConvertTo-Json -Depth 3),
        (New-Object System.Text.UTF8Encoding $false)
    )
    Write-Host "=== manifest: v$Version sha256=$Sha ==="

    Write-Host "=== publishing Neurion installer v$Version ==="
    # The landing page is a static file that nothing else ever copied, so it sat
    # on the server advertising a product that had changed underneath it — at one
    # point promising a token the app no longer had. Published with the release
    # it belongs to.
    $Landing = Join-Path $Root 'apps\landing\index.html'
    if (Test-Path -LiteralPath $Landing) {
        Write-Host '=== publishing the landing page ==='
        Invoke-Native -Command $Scp -Arguments ($SshOptions + @($Landing, "${Vps}:/var/www/neurion/index.html"))
    }

    Invoke-Native -Command $Scp -Arguments ($SshOptions + @($Installer, "${Vps}:/var/www/neurion/download/"))
    Invoke-Native -Command $Scp -Arguments ($SshOptions + @($ManifestPath, "${Vps}:/var/www/neurion/download/"))
    # The version stamp matches ANY semver, not just 1.8.x — the old pattern
    # silently stopped rewriting the page as soon as the minor changed.
    $RemotePublish = "set -e; cd /var/www/neurion/download; cp -f 'Neurion-Setup-$Version.exe' 'Neurion-Setup-latest.exe'; chown www-data:www-data 'Neurion-Setup-$Version.exe' 'Neurion-Setup-latest.exe' latest.json; chown www-data:www-data /var/www/neurion/index.html; if [ -f /var/www/neurion/index.html ]; then sed -Ei 's/v[0-9]+\.[0-9]+\.[0-9]+/v$Version/g' /var/www/neurion/index.html; fi"
    Invoke-Native -Command $Ssh -Arguments ($SshOptions + @($Vps, $RemotePublish))
}

Write-Host "=== Neurion v$Version publication complete ==="

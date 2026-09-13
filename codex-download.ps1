#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('download', 'info', 'self-test')]
    [string]$Command,

    [Parameter(Position = 1)]
    [string]$Url = '',

    [string]$Output = '',

    [ValidateSet('auto', 'video', 'audio', 'images')]
    [string]$Media = 'auto',

    [string]$Quality = 'best',

    [ValidateSet('mp4', 'webm', 'mp3')]
    [string]$Format = 'mp4',

    [ValidateRange(1, 10000)]
    [int]$Index = 1,

    [switch]$NoCredentials,

    [ValidateRange(30, 86400)]
    [int]$TimeoutSeconds = 7200
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = $PSScriptRoot
$exeCandidates = @(
    (Join-Path $root '视频下载神器.exe')
    (Join-Path $root 'YouTube 下载器.exe')
)
$exe = $exeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
$localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localData)) {
    $localData = [IO.Path]::GetTempPath()
}
$runtime = Join-Path $localData 'shipin-xiazai-shenqi\codex-runtime'
$sessionDir = Join-Path (Join-Path $runtime 'sessions') ([guid]::NewGuid().ToString('N'))
$tempDir = Join-Path $sessionDir 'temp'
$resultDir = Join-Path $runtime 'results'
$resultFile = Join-Path $resultDir (([guid]::NewGuid().ToString('N')) + '.json')

if ([string]::IsNullOrWhiteSpace($exe)) {
    throw ('没有找到视频下载神器主程序，已检查：' + ($exeCandidates -join '；'))
}
if ($Command -in @('download', 'info') -and [string]::IsNullOrWhiteSpace($Url)) {
    throw 'download 和 info 命令必须提供 URL'
}
if ([string]::IsNullOrWhiteSpace($Output)) {
    $profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ([string]::IsNullOrWhiteSpace($profile)) {
        $profile = [IO.Path]::GetTempPath()
    }
    $Output = Join-Path $profile 'Downloads\视频下载神器'
}

New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
New-Item -ItemType Directory -Path $resultDir -Force | Out-Null
if ($Command -eq 'download') {
    New-Item -ItemType Directory -Path $Output -Force | Out-Null
}

$arguments = [System.Collections.Generic.List[string]]::new()
if ($NoCredentials) { $arguments.Add('--no-credentials') }
$encodedUrl = if ($Url) {
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Url))
} else { '' }
switch ($Command) {
    'download' {
        $arguments.Add('--codex-download')
        $arguments.Add('--codex-url-base64')
        $arguments.Add($encodedUrl)
        $arguments.Add('--output-dir')
        $arguments.Add([System.IO.Path]::GetFullPath($Output))
        $arguments.Add('--media')
        $arguments.Add($Media)
        $arguments.Add('--quality')
        $arguments.Add($Quality)
        $arguments.Add('--format')
        $arguments.Add($Format)
        $arguments.Add('--index')
        $arguments.Add([string]$Index)
        $arguments.Add('--timeout-seconds')
        $arguments.Add([string]$TimeoutSeconds)
    }
    'info' {
        $arguments.Add('--codex-info')
        $arguments.Add('--codex-url-base64')
        $arguments.Add($encodedUrl)
    }
    'self-test' {
        $arguments.Add('--codex-self-test')
    }
}
$arguments.Add('--result-file')
$arguments.Add($resultFile)

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $exe
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
$startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
$startInfo.Environment['CODEX_RUNTIME_SESSION'] = $sessionDir
$startInfo.Environment['CODEX_RUNTIME_DIR'] = $runtime
$startInfo.Environment['TEMP'] = $tempDir
$startInfo.Environment['TMP'] = $tempDir
foreach ($argument in $arguments) {
    $startInfo.ArgumentList.Add($argument)
}

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$stdoutTask = $null
$stderrTask = $null

try {
    if (-not $process.Start()) {
        throw '静默下载进程启动失败'
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $waitMilliseconds = [Math]::Min($TimeoutSeconds + 120, 86400) * 1000
    if (-not $process.WaitForExit($waitMilliseconds)) {
        try { $process.Kill($true) } catch {}
        throw '静默下载进程等待超时，已终止'
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()

    if (Test-Path -LiteralPath $resultFile -PathType Leaf) {
        $result = Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $lastLine = ($stdout -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -Last 1)
        if ($lastLine) {
            try { $result = $lastLine | ConvertFrom-Json } catch { $result = $null }
        }
        if (-not $result) {
            $detail = if ($stderr.Trim()) { $stderr.Trim() } else { '主程序没有返回结果文件' }
            throw $detail
        }
    }

    $result | ConvertTo-Json -Depth 12 -Compress
    if (-not $result.ok -or $process.ExitCode -ne 0) {
        exit 1
    }
} catch {
    [ordered]@{
        ok = $false
        command = $Command
        error = $_.Exception.Message
        timestamp = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($process) { $process.Dispose() }
    Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            Remove-Item -LiteralPath $sessionDir -Recurse -Force -ErrorAction Stop
            break
        } catch {
            if ($attempt -lt 2) { Start-Sleep -Milliseconds 250 }
        }
    }
}

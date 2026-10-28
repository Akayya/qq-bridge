param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [string]$Lang = 'zh-Hans-CN',
  [double]$Scale = 0,
  [string]$OutFile = ''
)

# Windows built-in WinRT OCR (Windows.Media.Ocr). Offline, no dependencies.
# Prints one line: "OK {json}" or "ERR reason" (exit 1).
# When -OutFile is given the JSON is also written as UTF-8 (no BOM) so that the
# console code page cannot mangle CJK characters on the way back.
# JSON shape: { ok, lang, width, height, text, lines: [...] }
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless the file starts with a UTF-8 BOM, and the Write tool does not add one.

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {}

function Await($op, $type) {
  $asTask = $script:asTaskGeneric.MakeGenericMethod($type)
  $task = $asTask.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  if (-not (Test-Path -LiteralPath $ImagePath)) { throw "image not found: $ImagePath" }
  $full = (Resolve-Path -LiteralPath $ImagePath).Path

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

  # Scale <= 0 means "auto": small images get upscaled (tiny text is the usual
  # failure mode), already-large ones are left alone to keep it fast.
  if ($Scale -le 0) {
    $short = [Math]::Min($decoder.PixelWidth, $decoder.PixelHeight)
    $long = [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight)
    if ($short -lt 600) { $Scale = 2.0 }
    elseif ($long -lt 1600) { $Scale = 1.5 }
    else { $Scale = 1.0 }
    # Never blow the bitmap past ~4000px on the long edge.
    if ($long * $Scale -gt 4000) { $Scale = [Math]::Max(1.0, [Math]::Round(4000 / $long, 2)) }
  }

  if ($Scale -ne 1.0 -and $Scale -gt 0) {
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $transform.ScaledWidth = [uint32][Math]::Round($decoder.PixelWidth * $Scale)
    $transform.ScaledHeight = [uint32][Math]::Round($decoder.PixelHeight * $Scale)
    $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
      )) ([Windows.Graphics.Imaging.SoftwareBitmap])
  }
  else {
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  }

  $language = New-Object Windows.Globalization.Language $Lang
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if (-not $engine) {
    $available = (( [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages ) | ForEach-Object { $_.LanguageTag }) -join ', '
    throw "no OCR engine for $Lang (available: $available)"
  }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  foreach ($line in $result.Lines) {
    $t = ($line.Text).Trim()
    if ($t) { $lines += $t }
  }

  $payload = [ordered]@{
    ok     = $true
    lang   = $Lang
    width  = $decoder.PixelWidth
    height = $decoder.PixelHeight
    lines  = $lines
    text   = ($lines -join "`n")
  }

  $json = $payload | ConvertTo-Json -Compress -Depth 5
  if ($OutFile) {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($OutFile, $json, $utf8)
    Write-Output ('OK ' + $OutFile)
  }
  else {
    Write-Output ('OK ' + $json)
  }
  exit 0
}
catch {
  Write-Output ('ERR ' + $_.Exception.Message)
  exit 1
}

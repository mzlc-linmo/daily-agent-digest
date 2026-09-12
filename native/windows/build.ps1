$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force $out | Out-Null
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $framework 'csc.exe'
$ref = Join-Path $framework 'System.Windows.Forms.dll'
$draw = Join-Path $framework 'System.Drawing.dll'
$output = Join-Path $out 'DailyAgentDigestTray.exe'
$source = Join-Path $PSScriptRoot 'DailyAgentDigestTray.cs'
if (!(Test-Path $csc)) { throw "C# compiler not found: $csc" }
& $csc /nologo /target:winexe "/out:$output" "/reference:$ref" "/reference:$draw" $source
if ($LASTEXITCODE -ne 0) { throw "C# compilation failed with exit code $LASTEXITCODE" }

# 找到 node.exe 所在目录并输出（找不到则以退出码 1 结束）。
# 被 一键启动.bat 调用，避免把某个人的安装路径写死在脚本里。
$candidates = @()

# 1) 已经在 PATH 里
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $candidates += $cmd.Source }

# 2) 常见安装位置
$candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' }
$candidates += Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'

# 3) nvm-windows
$candidates += Get-ChildItem (Join-Path $env:APPDATA 'nvm\*\node.exe') -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName

# 4) 各类 IDE 自带的运行时（按版本号倒序取最新的）
$candidates += Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions\*\node.exe') -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
$candidates += Get-ChildItem (Join-Path $env:USERPROFILE '.codebuddy\binaries\node\versions\*\node.exe') -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName

$found = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $found) { exit 1 }
Split-Path -Parent $found

@echo off
rem hweb.cmd: runs the hweb helper (scripts\hweb, next to this file) from cmd or PowerShell through
rem Git for Windows' bash. bun run hweb:install writes a hweb.cmd launcher for it into a folder on PATH.
setlocal
if not defined HWEB_BASH set "HWEB_BASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%HWEB_BASH%" (
  echo ERROR: Git for Windows Bash not found at "%HWEB_BASH%". Install Git for Windows or set HWEB_BASH. 1>&2
  exit /b 1
)
if not exist "%~dp0hweb" (
  echo ERROR: Missing Bash script "%~dp0hweb". 1>&2
  exit /b 1
)
"%HWEB_BASH%" -- "%~dp0hweb" %*
exit /b %errorlevel%

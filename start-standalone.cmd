@echo off
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0start.cmd" --standalone %*
exit /b %errorlevel%

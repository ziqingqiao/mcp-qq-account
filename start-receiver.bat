@echo off
REM ---------------------------------------------------------------------------
REM Standalone inbound event receiver.
REM
REM The MCP server runs the same receiver inside its own process, but that copy
REM dies every time the desktop host restarts or crashes - which on this machine
REM happens every few minutes. OneBot does not buffer and does not retry a failed
REM report, so every one of those windows loses messages outright.
REM
REM This process keeps the report port bound around the clock instead. Leave the
REM window open. The MCP tools keep working either way: the queue is a shared
REM directory, so the server reads whatever this process receives.
REM
REM Double-click to run in the foreground, or put a copy of startup-entry.bat in
REM shell:startup to have it come up with Windows.
REM
REM Edit the node path below if your Node lives elsewhere. %USERPROFILE% is used
REM rather than a literal path so this file carries no machine-specific name.
REM ---------------------------------------------------------------------------
cd /d "%~dp0"
"%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe" --env-file-if-exists=.env dist\scripts\receiver.js
echo.
echo Receiver exited with code %ERRORLEVEL%.
pause

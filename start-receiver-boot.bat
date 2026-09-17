@echo off
REM ---------------------------------------------------------------------------
REM Boot-time launcher for the standalone receiver.
REM
REM Same process as start-receiver.bat, with one difference: its output goes to
REM receiver.log instead of a console nobody is watching. That matters because
REM the whole reason this receiver exists is a failure that was invisible from
REM the outside - a report that gets refused leaves the sender holding a bare
REM status code and nothing else.
REM
REM Used by the shortcut in shell:startup. Run start-receiver.bat by hand if you
REM want to watch it work.
REM
REM Do not delete receiver.log while the receiver runs; Windows keeps the handle
REM and the redirect simply stops writing.
REM
REM Edit the node path below if your Node lives elsewhere. %USERPROFILE% is used
REM rather than a literal path so this file carries no machine-specific name.
REM ---------------------------------------------------------------------------
cd /d "%~dp0"
"%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe" --env-file-if-exists=.env dist\scripts\receiver.js >> "%~dp0receiver.log" 2>&1

@echo off
REM ---------------------------------------------------------------------------
REM Startup entry for the standalone receiver.
REM
REM A copy of this file lives in shell:startup. It launches the receiver
REM minimised and returns immediately, so nothing sits on screen while the port
REM stays bound. The receiver's own output goes to receiver.log next to it.
REM
REM Why this exists at all: the MCP server starts the same receiver inside its
REM own process, and that process is replaced every couple of minutes on this
REM machine. Each replacement is a window with nothing listening on the report
REM port, and OneBot does not buffer or retry - messages in those windows are
REM gone. A receiver that outlives the host closes that window.
REM
REM If the project ever moves, re-copy this file: the path below is absolute.
REM
REM Edit the path on the last line to match where this project actually lives,
REM then copy this file into shell:startup (type shell:startup in the Explorer
REM address bar). No admin rights and no registry keys are involved - undoing it
REM is deleting that copy.
REM ---------------------------------------------------------------------------
start "mcp-qq-account receiver" /min cmd /c "E:\workbuddy\mcp-qq-gateway\mcp-qq-account\start-receiver-boot.bat"

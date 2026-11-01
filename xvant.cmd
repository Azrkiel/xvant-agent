@echo off
rem Starts XVANT from any folder: with no arguments, the interactive shell
rem in the current Git repository; otherwise the command given.
rem Node comes from XVANT_NODE, then this checkout's .tools, then PATH.
setlocal
if not defined XVANT_NODE set "XVANT_NODE=%~dp0.tools\node_modules\node-win-x64\bin\node.exe"
if not exist "%XVANT_NODE%" set "XVANT_NODE=node"
"%XVANT_NODE%" "%~dp0scripts\xvant.mjs" %*

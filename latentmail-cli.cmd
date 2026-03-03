@echo off
set ELECTRON_RUN_AS_NODE=1
"%~dp0LatentMail.exe" "%~dp0resources\app.asar\dist-electron\cli\cli-client.js" %*

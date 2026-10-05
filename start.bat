@echo off
setlocal
cd /d "%~dp0"
title Mining Alert - App

REM ===== Mining Safety Alert: start backend + Flutter app together =====
REM   start.bat                          -> local server + app on your phone
REM   start.bat web                      -> local server + app in Chrome
REM   start.bat https://xxx.onrender.com -> use an online server instead

set "DEVICE="
set "MODE=%~1"
if /i "%MODE%"=="web" (
  set "DEVICE=-d chrome"
  set "MODE="
)
if not "%MODE%"=="" (
  set "BACKEND_URL=%MODE%"
  echo Using online server: %MODE%
  goto runapp
)

REM --- 1. Start the backend in its own window (if it is not already running)
curl.exe -s -o nul http://localhost:3000/api/health
if %errorlevel%==0 (
  echo Backend is already running.
) else (
  if not exist "backend\node_modules" (
    echo Installing backend packages...
    pushd backend
    call npm install
    popd
  )
  echo Starting backend in a new window...
  start "Mining Alert - Backend" /D "%~dp0backend" cmd /k node server.js
)

REM --- 2. Wait until the backend answers (max 30 s)
set /a tries=0
:wait
curl.exe -s -o nul http://localhost:3000/api/health && goto ready
set /a tries+=1
if %tries% GEQ 30 goto notready
timeout /t 1 /nobreak >nul
goto wait

:notready
echo.
echo [!] Backend did not start. Look at the "Mining Alert - Backend" window for the error.
pause
exit /b 1

:ready
echo Backend is up.

REM --- 3. Chrome runs on this laptop, so it can simply use localhost
if defined DEVICE (
  set "BACKEND_URL=http://localhost:3000"
  if not exist "frontend\web" (
    echo Adding web support to the Flutter project...
    pushd frontend
    call flutter create --platforms=web .
    popd
  )
  goto runapp
)

REM --- Phone: find this laptop's current Wi-Fi/LAN IP so the phone can reach it
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$ip=(Find-NetRoute -RemoteIPAddress 8.8.8.8 -ErrorAction SilentlyContinue | Where-Object IPAddress | Select-Object -First 1).IPAddress; if(-not $ip){$ip=(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notmatch '^(127|169\.254)'} | Select-Object -First 1).IPAddress}; $ip"`) do set "IP=%%i"
if "%IP%"=="" (
  echo [!] Could not find this laptop's IP address. Is Wi-Fi connected?
  pause
  exit /b 1
)
set "BACKEND_URL=http://%IP%:3000"
echo Laptop IP: %IP%
echo Phone must be on the SAME Wi-Fi. Test on the phone: %BACKEND_URL%/api/health

:runapp
REM --- 4. Run the Flutter app with that server address
echo.
echo Starting app with BACKEND_URL=%BACKEND_URL%
cd frontend
call flutter pub get
call flutter run %DEVICE% --dart-define=BACKEND_URL=%BACKEND_URL%
pause
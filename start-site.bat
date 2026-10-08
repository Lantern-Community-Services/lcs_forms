@echo off
setlocal
cd /d "%~dp0"

rem -- Docker (SQL Server runs in it) --
docker info >nul 2>&1
if errorlevel 1 (
  echo Starting Docker Desktop...
  rem After a Windows restart Docker Desktop can crash on its own leftover
  rem socket files ("The file cannot be accessed by the system"). It isn't
  rem running, so they're safe to clear; it makes new ones.
  del /f /q "%LOCALAPPDATA%\Docker\run\*" >nul 2>&1
  del /f /q "%LOCALAPPDATA%\docker-secrets-engine\engine.sock" >nul 2>&1
  start "" "%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"
  if not exist "%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
  for /l %%i in (1,1,60) do (
    docker info >nul 2>&1 && goto docker_ready
    timeout /t 3 /nobreak >nul
  )
  echo.
  echo   Docker Desktop didn't start. Open it, wait for "Engine running", and run this again.
  echo.
  pause
  exit /b 1
)
:docker_ready

echo Starting SQL Server (docker compose service "db", port 1433)...
docker compose up -d --wait db
if errorlevel 1 (
  echo.
  echo   Couldn't start SQL Server. Is MSSQL_SA_PASSWORD set in .env?
  echo.
  pause
  exit /b 1
)

echo Starting Lantern Forms backend (port 4200)...
start "Lantern Forms - Backend" cmd /k "cd /d "%~dp0backend" && npx prisma migrate deploy && npm run dev"

echo Starting Lantern Forms frontend (port 5200)...
start "Lantern Forms - Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

echo Starting HTTPS for iPad testing (port 5443, setup page on 5480)...
start "Lantern Forms - HTTPS" cmd /k "cd /d "%~dp0frontend" && npm run dev:https"

echo Waiting for the site to come up...
for /l %%i in (1,1,40) do (
  curl -s -o nul http://localhost:5200/api/health/ready && goto site_ready
  timeout /t 3 /nobreak >nul
)
:site_ready

start "" "http://localhost:5200"

endlocal

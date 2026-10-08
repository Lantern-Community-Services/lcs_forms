@echo off
setlocal
cd /d "%~dp0"

echo Starting SQL Server (docker compose service "db", port 1433)...
docker compose up -d db
if errorlevel 1 (
  echo.
  echo   Couldn't start SQL Server. Is Docker Desktop running? Is MSSQL_SA_PASSWORD set in .env?
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

echo Waiting for the frontend to come up...
timeout /t 6 /nobreak >nul

start "" "http://localhost:5200"

endlocal

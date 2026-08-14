@echo off
setlocal
cd /d "%~dp0\sprite_padder"

echo Cerrando la version Desktop anterior si esta abierta...
taskkill /IM "JOA_Sprite_Padder_Desktop.exe" /F >nul 2>&1

echo [1/3] Instalando dependencias necesarias...
call npm install

if %errorlevel% neq 0 (
    echo Error durante la instalacion de dependencias. Asegurate de tener Node.js instalado.
    pause
    exit /b %errorlevel%
)

echo [2/3] Compilando HTML y EXE con los ultimos cambios...
call npm run build

if %errorlevel% neq 0 (
    echo Error durante la compilacion o empaquetado. Revisa el codigo en src.
    pause
    exit /b %errorlevel%
)

echo [3/3] HTML y EXE desplegados...
echo.
echo EXITO: JOA_Sprite_Padder_Desktop.exe actualizado.
echo Abriendo version Desktop...
start "" "%~dp0JOA_Sprite_Padder_Desktop.exe"
exit /b 0

@echo off
setlocal
cd /d "%~dp0\sprite_padder"

echo [1/3] Instalando dependencias necesarias...
call npm install

if %errorlevel% neq 0 (
    echo Error durante la instalacion de dependencias. Asegurate de tener Node.js instalado.
    pause
    exit /b %errorlevel%
)

echo [2/3] Compilando el proyecto con los ultimos cambios...
call npm run build

if %errorlevel% neq 0 (
    echo Error durante la compilacion. Revisa el codigo en src.
    pause
    exit /b %errorlevel%
)

echo [3/3] Actualizando JOA_Sprite_Padder.html...
copy /y "dist\index.html" "..\JOA_Sprite_Padder.html"

echo.
echo !EXITO! Los cambios de opacidad y sincronizacion ya estan disponibles.
echo Abriendo JOA_Sprite_Padder.html...
start "" "..\JOA_Sprite_Padder.html"

exit /b 0

@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0JOA_Sprite_Padder_Desktop.exe" (
    start "" "%~dp0JOA_Sprite_Padder_Desktop.exe"
    exit /b 0
)

if exist "C:\JOA\JOA_Sprite_Padder_Desktop.exe" (
    start "" "C:\JOA\JOA_Sprite_Padder_Desktop.exe"
    exit /b 0
)

echo No se encontro JOA_Sprite_Padder_Desktop.exe.
echo Ejecuta Actualizar_Y_Ejecutar_Sprite_Padder.bat para generarlo.
pause
exit /b 1

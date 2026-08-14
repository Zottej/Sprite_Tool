import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(scriptsDir, '..');
const repoDir = join(projectDir, '..');
const fileName = 'JOA_Sprite_Padder_Desktop.exe';
const source = join(projectDir, 'release', fileName);

if (!existsSync(source)) {
  console.error('No se encontró el ejecutable generado:', source);
  process.exit(1);
}

const targets = [
  join(repoDir, fileName),
  'C:\\JOA\\JOA_Sprite_Padder_Desktop.exe',
];

for (const target of targets) {
  const targetDir = dirname(target);
  if (target.startsWith('C:\\JOA') && !existsSync(targetDir)) {
    console.log('EXE omitido (carpeta no existe):', target);
    continue;
  }
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  copyFileSync(source, target);
  console.log('EXE actualizado:', target);
}

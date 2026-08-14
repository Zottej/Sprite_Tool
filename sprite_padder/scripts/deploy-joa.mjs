import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, '..', 'dist', 'index.html');

if (!existsSync(src)) {
  console.error('No se encontró dist/index.html. Ejecuta npm run build primero.');
  process.exit(1);
}

const targets = [
  join(root, '..', '..', 'JOA_Sprite_Padder.html'),
  'C:\\JOA\\JOA_Sprite_Padder.html',
];

let deployed = 0;
for (const dest of targets) {
  const dir = dirname(dest);
  if (dest.startsWith('C:\\JOA') && !existsSync(dir)) {
    console.log('Omitido (carpeta no existe):', dest);
    continue;
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  copyFileSync(src, dest);
  console.log('Desplegado:', dest);
  deployed++;
}

if (deployed === 0) {
  console.error('No se pudo desplegar en ningún destino.');
  process.exit(1);
}

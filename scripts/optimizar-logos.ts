/**
 * Genera versiones reducidas de los logos para embeberlas en los PDF.
 *
 * Los originales rondan 1.2 MB y 1300 px, pero en el pase se dibujan a ~30 pt.
 * Sin reducirlos, cada ticket pesaría ~2 MB. Esto se ejecuta una sola vez y el
 * resultado se versiona; en producción no hace falta ninguna librería de imágenes.
 *
 * Uso: npx ts-node scripts/optimizar-logos.ts
 */
import { Jimp } from 'jimp';
import { mkdirSync, statSync } from 'fs';
import { join } from 'path';

const ORIGEN = join(process.cwd(), 'logos');
const DESTINO = join(ORIGEN, 'optimizados');
/** 4x el tamaño de impresión (~30 pt) para que se vea nítido a 300 dpi. */
const ALTO_MAXIMO = 140;

async function main() {
  mkdirSync(DESTINO, { recursive: true });

  for (const archivo of ['actun.png', 'Propeten.png']) {
    const rutaOrigen = join(ORIGEN, archivo);
    const rutaDestino = join(DESTINO, archivo);

    const imagen = await Jimp.read(rutaOrigen);
    const escala = ALTO_MAXIMO / imagen.bitmap.height;

    imagen.resize({
      w: Math.round(imagen.bitmap.width * escala),
      h: ALTO_MAXIMO,
    });

    await imagen.write(rutaDestino as `${string}.png`);

    const antes = statSync(rutaOrigen).size / 1024;
    const despues = statSync(rutaDestino).size / 1024;
    console.log(
      `${archivo}: ${antes.toFixed(0)} KB -> ${despues.toFixed(0)} KB ` +
        `(${imagen.bitmap.width}x${imagen.bitmap.height}px)`,
    );
  }

  console.log(`\nListo. Los PDF leen de: ${DESTINO}`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

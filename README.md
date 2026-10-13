# Music Studio · Minecraft Bedrock

Creador de paquetes de música `.mcpack` de Preciseweb. Convierte los audios en el dispositivo del visitante, permite personalizar de 1 a 22 discos y transforma la portada en un PNG cuadrado de 256 × 256 píxeles.

## Desarrollo

Requiere Node.js 20 o posterior y npm.

```bash
npm ci
npm run dev
```

Abre `http://localhost:4173`. Después de editar los archivos, ejecuta `npm run build` y recarga la página, o reinicia `npm run dev`. La compilación genera `dist/` con la página y sus dependencias. Los archivos originales siguen en la raíz; `dist/` y `node_modules/` están ignorados en Git.

## Publicación en Vercel

`vercel.json` configura la compilación con `npm run build` y la carpeta de salida `dist/`. El despliegue necesita ejecutar `npm install` o `npm ci`: ya no basta con servir la raíz del repositorio. FFmpeg y JSZip se sirven desde el mismo sitio y se cargan cuando se necesitan; el motor de audio (~31 MB) se descarga en la primera conversión y se reutiliza durante la sesión. Las dependencias con versión en su ruta tienen caché persistente.

## Descripción automática

La descripción escrita por el usuario se conserva y se añaden estas dos líneas al final de `header.description` y `modules[0].description` en `manifest.json`:

```text
Echo por Preciseweb
link para crear tu mod de musica: https://musica-minecraft-bedrock.vercel.app/
```

La vista previa permite comprobar la descripción final antes de descargar. La escritura `Echo` se conserva tal como fue solicitada.

## Redes sociales

Edita `social-links.js` para añadir los perfiles:

```js
export const SOCIAL_LINKS = Object.freeze({
  instagram: 'https://www.instagram.com/tu_perfil/',
  tiktok: 'https://www.tiktok.com/@tu_perfil',
  telegram: 'https://t.me/tu_perfil'
});
```

Los iconos aparecen al final de la página. Mientras una URL esté vacía, su icono se muestra como pendiente; al añadir una URL HTTPS se activa y abre el perfil en otra pestaña.

## Comprobaciones

```bash
npm test
npx playwright install chromium
npm run test:browser
```

Las pruebas de navegador convierten WAV con el motor real, descargan e inspeccionan el paquete, comprueban la portada y verifican cancelaciones, validaciones y el diseño móvil. Las pruebas no equivalen a una instalación dentro de Minecraft.

## Compatibilidad

El paquete solo redefine los discos seleccionados; los restantes conservan los sonidos originales. La versión mínima se ajusta a los discos elegidos: Tears requiere 1.21.90, Lava Chicken 1.21.93 y Bounce 26.30. Las definiciones usan reproducción por streaming y el alcance de 64 bloques del recurso original.

Referencias: [recursos oficiales de Mojang](https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/sounds/sound_definitions.json), [sonidos personalizados de Bedrock](https://learn.microsoft.com/en-us/minecraft/creator/documents/addcustomsounds?view=minecraft-bedrock-stable), [uso de FFmpeg](https://ffmpegwasm.netlify.app/docs/getting-started/usage/).

import { copyFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('releases/FaceGuard-Android.apk');
const destinationDirectory = resolve('dist/downloads');
const destination = resolve(destinationDirectory, 'FaceGuard-Android.apk');

await stat(source);
await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
console.log(`APK copied to ${destination}`);

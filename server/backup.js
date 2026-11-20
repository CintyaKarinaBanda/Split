import { backup, DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const source = process.env.DB_PATH;
const destination = process.argv[2];
if (!source || !destination) throw new Error('Configura DB_PATH y ejecuta npm run backup -- ruta/del-respaldo.sqlite.');
if (resolve(source) === resolve(destination)) throw new Error('Usa una ruta distinta para el respaldo.');

const directory = await mkdtemp(join(tmpdir(), 'split-backup-'));
const temporary = join(directory, 'backup.sqlite');
try {
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, temporary); }
  finally { db.close(); }

  const snapshot = new DatabaseSync(temporary, { readOnly: true });
  try {
    if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
      throw new Error('El respaldo de SQLite no pasó la comprobación de integridad.');
    }
  } finally { snapshot.close(); }

  await copyFile(temporary, resolve(destination), constants.COPYFILE_EXCL);
  console.log('Respaldo SQLite comprobado y guardado.');
} finally {
  await rm(temporary, { force: true });
  await rmdir(directory);
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface JsonPersist {
  read(): Promise<string | null>
  write(data: string): Promise<void>
}

export function filePersist(filePath: string): JsonPersist {
  return {
    async read() {
      try {
        return await readFile(filePath, 'utf8')
      } catch {
        return null
      }
    },
    async write(data: string) {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, data, 'utf8')
    },
  }
}

export function kvPersist(
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> },
  key: string,
): JsonPersist {
  return {
    read: () => kv.get(key),
    write: (data) => kv.put(key, data),
  }
}

export function persistFrom(
  dataDirOrPersist: string | JsonPersist,
  filename: string,
): JsonPersist {
  if (typeof dataDirOrPersist === 'string') {
    return filePersist(path.join(dataDirOrPersist, filename))
  }
  return dataDirOrPersist
}

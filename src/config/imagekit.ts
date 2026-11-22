import { env } from './env.js';
import logger from './logger.js';

const UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
const UPLOAD_TIMEOUT_MS = 30_000;

export type ImageKitUploadResult = {
  url: string;
  /** ImageKit fileId — use it to delete the file later */
  publicId: string;
};

const authHeader = () =>
  `Basic ${Buffer.from(`${env.IMAGEKIT_PRIVATE_KEY}:`).toString('base64')}`;

const uploadOnImageKit = async (
  fileBuffer: Buffer,
  options: { folder?: string; fileName?: string; mimeType?: string } = {},
): Promise<ImageKitUploadResult | null> => {
  const { folder = '/superior_trends', fileName = `upload_${Date.now()}`, mimeType } = options;

  if (!fileBuffer?.length) {
    logger.error('ImageKit Upload Error: File buffer is empty');
    return null;
  }

  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(fileBuffer)], mimeType ? { type: mimeType } : undefined),
      fileName,
    );
    form.append('fileName', fileName);
    form.append('folder', folder);
    form.append('useUniqueFileName', 'true');

    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: authHeader() },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Log status only — never the response body/credentials
      logger.error(`ImageKit Upload Error: HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { url?: string; fileId?: string };
    if (data?.url && data?.fileId) {
      return { url: data.url, publicId: data.fileId };
    }
    logger.error('ImageKit Upload Error: unexpected response shape');
    return null;
  } catch (error) {
    logger.error(`ImageKit Upload Error: ${(error as Error).message}`);
    return null;
  }
};

export { uploadOnImageKit };

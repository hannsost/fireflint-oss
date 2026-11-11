export interface InstagramComposition { image: string; logo: string; color: string }

export function coverCrop(width: number, height: number, targetWidth: number, targetHeight: number) {
  if (![width, height, targetWidth, targetHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error("Das Bild hat ungültige Abmessungen.");
  const scale = Math.max(targetWidth / width, targetHeight / height);
  const cropWidth = targetWidth / scale, cropHeight = targetHeight / scale;
  return { x: (width - cropWidth) / 2, y: (height - cropHeight) / 2, width: cropWidth, height: cropHeight };
}

async function imageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => { image.src = ""; reject(new Error("Das Bild konnte nicht rechtzeitig geladen werden. Bitte erneut versuchen.")); }, 15_000);
    image.crossOrigin = "anonymous";
    image.onload = () => {
      window.clearTimeout(timer);
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32_000_000) reject(new Error("Bitte ein Bild mit gültigen Abmessungen und höchstens 32 Megapixeln verwenden."));
      else resolve(image);
    };
    image.onerror = () => { window.clearTimeout(timer); reject(new Error("Das Bild konnte nicht für den Export geladen werden. Bitte in die Medienbibliothek hochladen und erneut auswählen.")); };
    image.src = url;
  });
}

/** The source photo and optional logo remain inputs; exported pixels are a new
 * JPEG asset. No third-party editor or API key participates in this operation. */
export async function composeInstagramImage(source: InstagramComposition): Promise<Blob> {
  if (!source.image) throw new Error("Bitte zuerst ein Website-Bild oder ein Standardbild im Markenprofil auswählen.");
  const [photo, logo] = await Promise.all([imageFromUrl(source.image), source.logo ? imageFromUrl(source.logo) : Promise.resolve(null)]);
  const canvas = document.createElement("canvas");
  canvas.width = 1080; canvas.height = 1350;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Dieser Browser kann das Bild nicht vorbereiten. Bitte einen aktuellen Browser verwenden.");
  context.fillStyle = "#fff"; context.fillRect(0, 0, 1080, 1350);
  const crop = coverCrop(photo.naturalWidth, photo.naturalHeight, 1080, 1110);
  context.drawImage(photo, crop.x, crop.y, crop.width, crop.height, 0, 0, 1080, 1110);
  context.fillStyle = /^#[0-9a-f]{6}$/i.test(source.color) ? source.color : "#376b50";
  context.fillRect(0, 1110, 1080, 12);
  if (logo) {
    const scale = Math.min(390 / logo.naturalWidth, 172 / logo.naturalHeight);
    const width = logo.naturalWidth * scale, height = logo.naturalHeight * scale;
    context.drawImage(logo, (1080 - width) / 2, 1142 + (172 - height) / 2, width, height);
  }
  try {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", .9));
    if (!blob || blob.type !== "image/jpeg" || blob.size > 5 * 1024 * 1024) throw new Error("export_failed");
    return blob;
  } catch { throw new Error("Das Bild konnte nicht als JPEG exportiert werden. Bitte die Vorlagenbilder in die Medienbibliothek hochladen und erneut versuchen."); }
}

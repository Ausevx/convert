import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";

import { pdfToImg } from "pdftoimg-js/browser";

function base64ToBytes(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/** PDF render quality presets */
export interface PdfQualityPreset {
  label: string;
  scale: number;      // Canvas scale factor (1 = 72 DPI, 2 = 144 DPI, etc.)
  quality: number;     // JPEG quality 0–1 (ignored for PNG)
  estimateKb: string;  // Approx output size per A4 page (JPEG)
}

export const PDF_QUALITY_PRESETS: PdfQualityPreset[] = [
  { label: "Low", scale: 1, quality: 0.70, estimateKb: "~80 KB/page" },
  { label: "Medium", scale: 2, quality: 0.85, estimateKb: "~250 KB/page" },
  { label: "High", scale: 3, quality: 0.95, estimateKb: "~600 KB/page" },
  { label: "Max", scale: 4, quality: 1.00, estimateKb: "~1.2 MB/page" },
];

/** Current active preset index (default = High) */
let activePresetIndex = 2;

export function getPdfQualityPreset(): PdfQualityPreset {
  return PDF_QUALITY_PRESETS[activePresetIndex];
}
export function setPdfQualityPreset(index: number) {
  activePresetIndex = Math.max(0, Math.min(index, PDF_QUALITY_PRESETS.length - 1));
}

class pdftoimgHandler implements FormatHandler {

  public name: string = "pdftoimg";

  public supportedFormats: FileFormat[] = [
    CommonFormats.PDF.builder("pdf").allowFrom(),
    CommonFormats.PNG.supported("png", false, true),
    CommonFormats.JPEG.supported("jpeg", false, true),
  ];

  public ready: boolean = true;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {

    if (
      outputFormat.format !== "png"
      && outputFormat.format !== "jpg"
    ) throw "Invalid output format.";

    const preset = getPdfQualityPreset();
    const outputFiles: FileData[] = [];

    for (const inputFile of inputFiles) {

      const blob = new Blob([inputFile.bytes as BlobPart], { type: inputFormat.mime });
      const url = URL.createObjectURL(blob);

      const images = await pdfToImg(url, {
        imgType: outputFormat.format,
        pages: "all",
        scale: preset.scale,
        quality: preset.quality,
      });

      URL.revokeObjectURL(url);

      const baseName = inputFile.name.split(".")[0];

      for (let i = 0; i < images.length; i++) {
        const base64 = images[i].slice(images[i].indexOf(";base64,") + 8);
        const bytes = base64ToBytes(base64);
        const name = `${baseName}_${i}.${outputFormat.extension}`;
        outputFiles.push({ bytes, name });
      }

    }

    return outputFiles;

  }

}

export default pdftoimgHandler;

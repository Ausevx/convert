import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";

/**
 * Handler that merges multiple image files (JPEG, PNG, WebP) into a single PDF.
 * Uses Canvas API to render images and builds a minimal valid PDF binary.
 */
class imagesToPdfHandler implements FormatHandler {

    public name: string = "imagesToPdf";
    public supportedFormats: FileFormat[] = [
        CommonFormats.JPEG.builder("jpeg").allowFrom().markLossless(),
        CommonFormats.PNG.builder("png").allowFrom().markLossless(),
        CommonFormats.WEBP.builder("webp").allowFrom(),
        CommonFormats.PDF.builder("pdf").allowTo().markLossless(),
    ];

    public ready: boolean = false;

    async init() {
        this.ready = true;
    }

    async doConvert(
        inputFiles: FileData[],
        inputFormat: FileFormat,
        outputFormat: FileFormat
    ): Promise<FileData[]> {

        if (outputFormat.internal !== "pdf") {
            throw new Error("imagesToPdf handler only supports PDF output.");
        }

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;

        // Render each image and collect JPEG data
        const pages: { width: number; height: number; jpegBytes: Uint8Array }[] = [];

        for (const file of inputFiles) {
            const blob = new Blob([file.bytes as BlobPart], { type: inputFormat.mime });
            const url = URL.createObjectURL(blob);

            const img = new Image();
            await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
                img.src = url;
            });

            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;

            // White background for JPEG
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);

            URL.revokeObjectURL(url);

            // Export as JPEG bytes
            const jpegBlob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((b) => {
                    if (!b) return reject(new Error("Canvas to blob failed"));
                    resolve(b);
                }, "image/jpeg", 0.92);
            });

            const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
            pages.push({
                width: img.naturalWidth,
                height: img.naturalHeight,
                jpegBytes,
            });
        }

        // Build a minimal valid PDF
        const pdfBytes = buildPdf(pages);

        const outputName = inputFiles.length === 1
            ? inputFiles[0].name.split(".").slice(0, -1).join(".") + ".pdf"
            : "merged.pdf";

        return [{ name: outputName, bytes: pdfBytes }];
    }
}

/**
 * Builds a minimal valid PDF binary with one page per image.
 * Each page is sized to the image dimensions (in points, 1px = 0.75pt for 96dpi).
 */
function buildPdf(
    pages: { width: number; height: number; jpegBytes: Uint8Array }[]
): Uint8Array {

    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const offsets: number[] = [];
    let pos = 0;

    function write(str: string) {
        const bytes = enc.encode(str);
        parts.push(bytes);
        pos += bytes.length;
    }

    function writeRaw(bytes: Uint8Array) {
        parts.push(bytes);
        pos += bytes.length;
    }

    function recordOffset() {
        offsets.push(pos);
    }

    // PDF header
    write("%PDF-1.4\n%\xC0\xC1\xC2\xC3\n");

    // Object numbering:
    // 1 = Catalog
    // 2 = Pages
    // For each page i (0-based): 3 + i*3 = Page, 4 + i*3 = Image XObject, 5 + i*3 = Content stream
    const numPages = pages.length;
    const pageObjNums: number[] = [];

    // Object 1: Catalog
    recordOffset();
    const pagesObjNum = 2;
    write(`1 0 obj\n<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>\nendobj\n`);

    // Build page object numbers
    for (let i = 0; i < numPages; i++) {
        pageObjNums.push(3 + i * 3);
    }

    // Object 2: Pages
    recordOffset();
    const kidsStr = pageObjNums.map(n => `${n} 0 R`).join(" ");
    write(`2 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${numPages} >>\nendobj\n`);

    // Write each page's objects
    for (let i = 0; i < numPages; i++) {
        const page = pages[i];
        const pageObjNum = 3 + i * 3;
        const imgObjNum = 4 + i * 3;
        const contentObjNum = 5 + i * 3;

        // Scale: 1px = 0.75 points (at 96 DPI), but we just use px as points for simplicity
        const w = page.width;
        const h = page.height;

        // Content stream: draw the image scaled to full page
        const contentStr = `q\n${w} 0 0 ${h} 0 0 cm\n/Img${i} Do\nQ\n`;
        const contentBytes = enc.encode(contentStr);

        // Page object
        recordOffset();
        write(`${pageObjNum} 0 obj\n`);
        write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]\n`);
        write(`   /Contents ${contentObjNum} 0 R\n`);
        write(`   /Resources << /XObject << /Img${i} ${imgObjNum} 0 R >> >> >>\n`);
        write(`endobj\n`);

        // Image XObject
        recordOffset();
        write(`${imgObjNum} 0 obj\n`);
        write(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h}\n`);
        write(`   /ColorSpace /DeviceRGB /BitsPerComponent 8\n`);
        write(`   /Filter /DCTDecode /Length ${page.jpegBytes.length} >>\n`);
        write(`stream\n`);
        writeRaw(page.jpegBytes);
        write(`\nendstream\nendobj\n`);

        // Content stream object
        recordOffset();
        write(`${contentObjNum} 0 obj\n`);
        write(`<< /Length ${contentBytes.length} >>\n`);
        write(`stream\n`);
        writeRaw(contentBytes);
        write(`\nendstream\nendobj\n`);
    }

    // Cross-reference table
    const xrefOffset = pos;
    const totalObjs = 2 + numPages * 3; // catalog + pages + 3 per page
    write(`xref\n0 ${totalObjs + 1}\n`);
    write(`0000000000 65535 f \n`);
    for (let i = 0; i < totalObjs; i++) {
        const offset = offsets[i].toString().padStart(10, "0");
        write(`${offset} 00000 n \n`);
    }

    // Trailer
    write(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\n`);
    write(`startxref\n${xrefOffset}\n%%EOF\n`);

    // Concatenate all parts
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
}

export default imagesToPdfHandler;

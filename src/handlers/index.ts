import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";

// ═══════ Core (lightweight) handlers — eagerly imported ═══════
import canvasToBlobHandler from "./canvasToBlob.ts";
import htmlEmbedHandler from "./htmlEmbed.ts";
import pdftoimgHandler from "./pdftoimg.ts";
import { renameZipHandler, renameTxtHandler } from "./rename.ts";
import envelopeHandler from "./envelope.ts";
import svgForeignObjectHandler from "./svgForeignObject.ts";
import jszipHandler from "./jszip.ts";
import { fromJsonHandler, toJsonHandler } from "./json.ts";
import cgbiToPngHandler from "./cgbi-to-png.ts";
import textEncodingHandler from "./textEncoding.ts";
import batToExeHandler from "./batToExe.ts";
import imagesToPdfHandler from "./imagesToPdf.ts";

// ═══════ Lazy handler wrapper — loads heavy handlers on demand ═══════

/**
 * Wraps a handler that should be loaded lazily via dynamic import().
 * The handler module is only fetched when doConvert() is first called.
 * Format lists are populated from cache.json, so no init() is needed at startup.
 */
class LazyHandler implements FormatHandler {
    public name: string;
    public supportedFormats?: FileFormat[];
    public supportAnyInput?: boolean;
    public ready: boolean = false;

    #importFn: () => Promise<{ default: new () => FormatHandler }>;
    #instance?: FormatHandler;

    constructor(
        name: string,
        importFn: () => Promise<{ default: new () => FormatHandler }>,
        supportAnyInput?: boolean
    ) {
        this.name = name;
        this.#importFn = importFn;
        this.supportAnyInput = supportAnyInput;
    }

    async init(): Promise<void> {
        if (this.#instance) {
            if (!this.#instance.ready) await this.#instance.init();
            this.ready = this.#instance.ready;
            this.supportedFormats = this.#instance.supportedFormats;
            return;
        }
        const mod = await this.#importFn();
        this.#instance = new mod.default();
        await this.#instance.init();
        this.ready = this.#instance.ready;
        this.supportedFormats = this.#instance.supportedFormats;
    }

    async doConvert(
        inputFiles: FileData[],
        inputFormat: FileFormat,
        outputFormat: FileFormat,
        args?: string[]
    ): Promise<FileData[]> {
        if (!this.#instance || !this.ready) {
            await this.init();
        }
        return this.#instance!.doConvert(inputFiles, inputFormat, outputFormat, args);
    }
}

// ═══════ Build handler list ═══════

const handlers: FormatHandler[] = [];

// Core handlers (eagerly loaded — small bundles)
try { handlers.push(new canvasToBlobHandler()) } catch (_) { };
try { handlers.push(new htmlEmbedHandler()) } catch (_) { };
try { handlers.push(new pdftoimgHandler()) } catch (_) { };
try { handlers.push(renameZipHandler) } catch (_) { };
try { handlers.push(renameTxtHandler) } catch (_) { };
try { handlers.push(new envelopeHandler()) } catch (_) { };
try { handlers.push(new svgForeignObjectHandler()) } catch (_) { };
try { handlers.push(new jszipHandler()) } catch (_) { };
try { handlers.push(new fromJsonHandler()) } catch (_) { };
try { handlers.push(new toJsonHandler()) } catch (_) { };
try { handlers.push(new cgbiToPngHandler()) } catch (_) { };
try { handlers.push(new textEncodingHandler()) } catch (_) { };
try { handlers.push(new batToExeHandler()) } catch (_) { };
try { handlers.push(new imagesToPdfHandler()) } catch (_) { };

// Heavy handlers (lazily loaded via dynamic import — WASM/large deps)
handlers.push(new LazyHandler("svgTrace", () => import("./svgTrace.ts")));
handlers.push(new LazyHandler("meyda", () => import("./meyda.ts")));
handlers.push(new LazyHandler("FFmpeg", () => import("./FFmpeg.ts")));
handlers.push(new LazyHandler("ImageMagick", () => import("./ImageMagick.ts")));
handlers.push(new LazyHandler("pandoc", () => import("./pandoc.ts")));
handlers.push(new LazyHandler("qoi-fu", () => import("./qoi-fu.ts")));
handlers.push(new LazyHandler("sppd", () => import("./sppd.ts")));
handlers.push(new LazyHandler("three.js", () => import("./threejs.ts")));
handlers.push(new LazyHandler("SQLite", () => import("./sqlite.ts")));
handlers.push(new LazyHandler("vtf", () => import("./vtf.ts")));
handlers.push(new LazyHandler("mcmap", () => import("./mcmap.ts")));
handlers.push(new LazyHandler("qoa-fu", () => import("./qoa-fu.ts")));
handlers.push(new LazyHandler("pyTurtle", () => import("./pyTurtle.ts")));
handlers.push(new LazyHandler("nbt", () => import("./nbt.ts")));
handlers.push(new LazyHandler("petozip", () => import("./petozip.ts")));
handlers.push(new LazyHandler("flptojson", () => import("./flptojson.ts")));
handlers.push(new LazyHandler("flo", () => import("./flo.ts")));
handlers.push(new LazyHandler("libopenmpt", () => import("./libopenmpt.ts")));
handlers.push(new LazyHandler("lzh", () => import("./lzh.ts")));

export default handlers;

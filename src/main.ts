import type { FileFormat, FileData, FormatHandler, ConvertPathNode } from "./FormatHandler.js";
import normalizeMimeType from "./normalizeMimeType.js";
import handlers from "./handlers";
import { TraversionGraph } from "./TraversionGraph.js";
import { PDF_QUALITY_PRESETS, setPdfQualityPreset } from "./handlers/pdftoimg.js";
import JSZip from "jszip";

/** A single file in the batch with optional per-file output override */
interface BatchFile {
  file: File;
  outputFormatIndex: number | null; // null = use global selection
}

/** Files currently selected for conversion */
let batchFiles: BatchFile[] = [];
/**
 * Whether to use "simple" mode.
 * - In **simple** mode, the input/output lists are grouped by file format.
 * - In **advanced** mode, these lists are grouped by format handlers, which
 *   requires the user to manually select the tool that processes the output.
 */
let simpleMode: boolean = true;

/** Whether to merge images into a single PDF */
let mergeMode: boolean = false;

/** Whether to use individual per-file output format selection */
let individualMode: boolean = false;

/** Handlers that support conversion from any formats. */
const conversionsFromAnyInput: ConvertPathNode[] = handlers
  .filter(h => h.supportAnyInput && h.supportedFormats)
  .flatMap(h => h.supportedFormats!
    .filter(f => f.to)
    .map(f => ({ handler: h, format: f })))

const ui = {
  fileInput: document.querySelector("#file-input") as HTMLInputElement,
  fileSelectArea: document.querySelector("#file-area") as HTMLDivElement,
  convertButton: document.querySelector("#convert-button") as HTMLButtonElement,
  modeToggleButton: document.querySelector("#mode-button") as HTMLButtonElement,
  inputList: document.querySelector("#from-list") as HTMLDivElement,
  outputList: document.querySelector("#to-list") as HTMLDivElement,
  inputSearch: document.querySelector("#search-from") as HTMLInputElement,
  outputSearch: document.querySelector("#search-to") as HTMLInputElement,
  popupBox: document.querySelector("#popup") as HTMLDivElement,
  popupBackground: document.querySelector("#popup-bg") as HTMLDivElement,
  batchPanel: document.querySelector("#batch-panel") as HTMLDivElement,
  batchFileList: document.querySelector("#batch-file-list") as HTMLDivElement,
  batchTitle: document.querySelector("#batch-title") as HTMLHeadingElement,
  batchClear: document.querySelector("#batch-clear") as HTMLButtonElement,
  mergeToggle: document.querySelector("#merge-toggle") as HTMLInputElement,
  mergeLabel: document.querySelector("#merge-label") as HTMLLabelElement,
  outputModeToggle: document.querySelector("#output-mode-toggle") as HTMLDivElement,
  convertOptions: document.querySelector("#convert-options") as HTMLDivElement,
  qualityBar: document.querySelector("#quality-bar") as HTMLDivElement,
  pdfQualityButtons: document.querySelector("#pdf-quality-buttons") as HTMLDivElement,
  pdfQualityEstimate: document.querySelector("#pdf-quality-estimate") as HTMLSpanElement,
  zipSection: document.querySelector("#zip-section") as HTMLDivElement,
  zipToggle: document.querySelector("#zip-toggle") as HTMLInputElement,
};

/**
 * Filters a list of buttons to exclude those not matching a substring.
 * @param list Button list (div) to filter.
 * @param string Substring for which to search.
 */
const filterButtonList = (list: HTMLDivElement, string: string) => {
  for (const button of Array.from(list.children)) {
    if (!(button instanceof HTMLButtonElement)) continue;
    const formatIndex = button.getAttribute("format-index");
    let hasExtension = false;
    if (formatIndex) {
      const format = allOptions[parseInt(formatIndex)]?.format;
      hasExtension = format?.extension.toLowerCase().includes(string);
    }
    const hasText = button.textContent.toLowerCase().includes(string);
    if (!hasExtension && !hasText) {
      button.style.display = "none";
    } else {
      button.style.display = "";
    }
  }
}

/**
 * Handles search box input by filtering its parent container.
 * @param event Input event from an {@link HTMLInputElement}
 */
const searchHandler = (event: Event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  const targetParentList = target.parentElement?.querySelector(".format-list");
  if (!(targetParentList instanceof HTMLDivElement)) return;

  const string = target.value.toLowerCase();
  filterButtonList(targetParentList, string);
};

// Assign search handler to both search boxes
ui.inputSearch.oninput = searchHandler;
ui.outputSearch.oninput = searchHandler;

// Map clicks in the file selection area to the file input element
ui.fileSelectArea.onclick = () => {
  ui.fileInput.click();
};

/** Format human-readable file sizes */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Check if a MIME type is an image type we can merge */
function isImageType(mime: string): boolean {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'].includes(mime);
}

/** Get output format display label for a per-file override */
function getFormatLabel(formatIndex: number | null): string {
  if (formatIndex === null) return 'Global';
  const opt = allOptions[formatIndex];
  return opt ? opt.format.format.toUpperCase() : 'Global';
}

/** Close any open per-file format popover + backdrop */
function closeAllPopovers() {
  document.querySelectorAll('.perfile-popover').forEach(el => el.remove());
  document.querySelectorAll('.perfile-backdrop').forEach(el => el.remove());
}

/** Render the batch file list UI */
function renderBatchFileList() {
  closeAllPopovers();

  if (batchFiles.length === 0) {
    ui.batchPanel.style.display = 'none';
    ui.fileSelectArea.innerHTML = `
      <div class="file-area-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
      <h2>Drop your files here</h2>
      <p id="drop-hint-text">or <span class="underline-link">browse</span> to choose</p>`;
    return;
  }

  ui.batchPanel.style.display = '';
  ui.batchTitle.textContent = `Selected Files (${batchFiles.length})`;

  // Show merge toggle only when ≥2 image files present
  const imageCount = batchFiles.filter(bf => isImageType(bf.file.type)).length;
  ui.mergeLabel.style.display = imageCount >= 2 ? '' : 'none';
  if (imageCount < 2) {
    mergeMode = false;
    ui.mergeToggle.checked = false;
  }

  // Update file area
  ui.fileSelectArea.innerHTML = `
    <div class="file-area-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
    <h2>${batchFiles.length} file${batchFiles.length > 1 ? 's' : ''} selected</h2>
    <p id="drop-hint-text">click to add more</p>`;

  // Render file rows
  ui.batchFileList.innerHTML = '';
  batchFiles.forEach((bf, idx) => {
    const row = document.createElement('div');
    row.className = 'batch-file-row';
    row.style.animationDelay = `${idx * 30}ms`;

    row.innerHTML = `
      <span class="batch-file-index">${idx + 1}</span>
      <span class="batch-file-name" title="${bf.file.name}">${bf.file.name}</span>
      <span class="batch-file-type">${bf.file.type || 'unknown'}</span>
      <span class="batch-file-size">${formatFileSize(bf.file.size)}</span>
    `;

    // Per-file output format badge (only in individual mode)
    if (individualMode) {
      const formatBadge = document.createElement('button');
      formatBadge.className = 'perfile-format-badge' + (bf.outputFormatIndex !== null ? ' perfile-set' : '');
      formatBadge.textContent = bf.outputFormatIndex !== null
        ? '\u2192 ' + getFormatLabel(bf.outputFormatIndex)
        : '\u2192 Choose format';
      formatBadge.title = bf.outputFormatIndex !== null
        ? `Output: ${getFormatLabel(bf.outputFormatIndex)} (click to change)`
        : 'Click to choose output format for this file';
      formatBadge.onclick = (e) => {
        e.stopPropagation();
        openPerFileFormatPicker(idx);
      };
      row.appendChild(formatBadge);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'batch-file-remove';
    removeBtn.textContent = '\u2715';
    removeBtn.title = 'Remove file';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      batchFiles.splice(idx, 1);
      renderBatchFileList();
      updateConvertButtonState();
    };
    row.appendChild(removeBtn);

    ui.batchFileList.appendChild(row);
  });
}

/** Open a fixed modal format picker for a given batch file */
function openPerFileFormatPicker(fileIdx: number) {
  closeAllPopovers();

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'perfile-backdrop';
  backdrop.onclick = () => closeAllPopovers();
  document.body.appendChild(backdrop);

  // Modal
  const popover = document.createElement('div');
  popover.className = 'perfile-popover';

  // Header with title and close button
  const header = document.createElement('div');
  header.className = 'perfile-popover-header';

  const title = document.createElement('div');
  title.className = 'perfile-popover-title';
  title.textContent = `Output format for: ${batchFiles[fileIdx].file.name}`;
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'perfile-popover-close';
  closeBtn.textContent = '\u2715';
  closeBtn.onclick = () => closeAllPopovers();
  header.appendChild(closeBtn);

  popover.appendChild(header);

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search formats\u2026';
  searchInput.className = 'perfile-search';
  popover.appendChild(searchInput);

  // "Use global" reset option
  const resetBtn = document.createElement('button');
  resetBtn.className = 'perfile-option perfile-option-reset';
  resetBtn.textContent = '\u21a9 Remove override (use global)';
  resetBtn.onclick = (e) => {
    e.stopPropagation();
    batchFiles[fileIdx].outputFormatIndex = null;
    closeAllPopovers();
    renderBatchFileList();
    updateConvertButtonState();
  };
  popover.appendChild(resetBtn);

  // Format options list
  const optionList = document.createElement('div');
  optionList.className = 'perfile-options';

  const outputFormats: { index: number; label: string; ext: string; mime: string }[] = [];
  const seenMimes = new Set<string>();

  for (let i = 0; i < allOptions.length; i++) {
    const opt = allOptions[i];
    if (!opt.format.to || !opt.format.mime) continue;
    const key = simpleMode ? `${opt.format.mime}|${opt.format.format}` : `${opt.format.mime}|${opt.format.format}|${opt.handler.name}`;
    if (seenMimes.has(key)) continue;
    seenMimes.add(key);
    const ext = opt.format.format.toUpperCase();
    const label = simpleMode
      ? `${ext} \u2014 ${opt.format.name.split('(').join(')').split(')').filter((_, j) => j % 2 === 0).filter(c => c !== '').join(' ')} (${opt.format.mime})`
      : `${ext} \u2014 ${opt.format.name} (${opt.format.mime})`;
    outputFormats.push({ index: i, label, ext, mime: opt.format.mime });
  }

  for (const fmt of outputFormats) {
    const btn = document.createElement('button');
    btn.className = 'perfile-option';
    if (batchFiles[fileIdx].outputFormatIndex === fmt.index) {
      btn.classList.add('perfile-option-selected');
    }
    btn.textContent = fmt.label;
    btn.dataset.search = fmt.label.toLowerCase();
    btn.onclick = (e) => {
      e.stopPropagation();
      batchFiles[fileIdx].outputFormatIndex = fmt.index;
      closeAllPopovers();
      renderBatchFileList();
      updateConvertButtonState();
    };
    optionList.appendChild(btn);
  }
  popover.appendChild(optionList);

  // Search filtering
  searchInput.oninput = () => {
    const q = searchInput.value.toLowerCase();
    for (const child of Array.from(optionList.children)) {
      const el = child as HTMLElement;
      el.style.display = (el.dataset.search || '').includes(q) ? '' : 'none';
    }
  };

  // Append to body (fixed position, never clipped)
  document.body.appendChild(popover);

  // Focus search
  requestAnimationFrame(() => searchInput.focus());
}

/** Update convert button enabled/disabled state */
function updateConvertButtonState() {
  if (batchFiles.length === 0) {
    ui.convertButton.className = 'disabled';
    updateOptionsBarVisibility();
    return;
  }

  if (mergeMode && batchFiles.length >= 2) {
    const outputSelected = document.querySelector("#to-list .selected");
    ui.convertButton.className = outputSelected ? '' : 'disabled';
    updateOptionsBarVisibility();
    return;
  }

  // Input format must be selected
  const inputSelected = document.querySelector("#from-list .selected");
  if (!inputSelected) {
    ui.convertButton.className = 'disabled';
    updateOptionsBarVisibility();
    return;
  }

  if (individualMode) {
    // In individual mode: every file must have a per-file override set
    const allHavePerFile = batchFiles.every(bf => bf.outputFormatIndex !== null);
    ui.convertButton.className = allHavePerFile ? '' : 'disabled';
  } else {
    // In global mode: global output must be selected
    const globalOutputSelected = document.querySelector("#to-list .selected");
    ui.convertButton.className = globalOutputSelected ? '' : 'disabled';
  }
  updateOptionsBarVisibility();
}

/** Show/hide the conversion options bar based on current format selections */
function updateOptionsBarVisibility() {
  const inputBtn = document.querySelector("#from-list .selected");
  const outputBtn = document.querySelector("#to-list .selected");

  let showQuality = false;
  let showZip = false;

  if (inputBtn && outputBtn) {
    const inputIdx = Number(inputBtn.getAttribute("format-index"));
    const outputIdx = Number(outputBtn.getAttribute("format-index"));
    const inputFormat = allOptions[inputIdx]?.format;
    const outputFormat = allOptions[outputIdx]?.format;

    // Show quality bar when input is PDF and output is an image format
    if (inputFormat && outputFormat) {
      const inputIsPdf = inputFormat.mime === 'application/pdf' || inputFormat.format === 'pdf';
      const outputIsImage = ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif', 'tiff'].includes(outputFormat.format.toLowerCase());
      showQuality = inputIsPdf && outputIsImage;
    }

    // Show ZIP option when there are multiple files, or when PDF→image (multi-page output)
    if (batchFiles.length >= 2 || showQuality) {
      showZip = true;
    }
  }

  // Quality bar lives in `.format-divider`, not in `#convert-options`
  ui.qualityBar.style.display = showQuality ? 'flex' : 'none';

  // Update dynamic estimate when quality bar is shown
  if (showQuality) updateDynamicEstimate();

  // ZIP toggle lives in `#convert-options`
  ui.convertOptions.style.display = showZip ? 'flex' : 'none';
  ui.zipSection.style.display = showZip ? 'flex' : 'none';
}

/** Dynamic size estimation based on actual uploaded file */
function updateDynamicEstimate() {
  const preset = PDF_QUALITY_PRESETS[getCurrentQualityIndex()];

  if (batchFiles.length === 0) {
    ui.pdfQualityEstimate.textContent = preset.estimateKb;
    return;
  }

  // Sum file sizes for all uploaded PDFs
  const totalBytes = batchFiles.reduce((sum, bf) => sum + bf.file.size, 0);
  // Rough page count: PDF overhead ~30KB/page for text-heavy, ~200KB/page for images
  // Use a midpoint heuristic: every ~50KB of PDF data ≈ 1 page
  const estimatedPages = Math.max(1, Math.round(totalBytes / 50_000));

  // Base output size per page scales quadratically with scale factor
  // Baseline: at scale=1 (72 DPI), a typical A4 image ≈ 80KB JPEG
  const baseKbPerPage = 80;
  const scaledKb = baseKbPerPage * preset.scale * preset.scale * preset.quality;
  const totalKb = scaledKb * estimatedPages;

  let sizeStr: string;
  if (totalKb >= 1024) {
    sizeStr = `~${(totalKb / 1024).toFixed(1)} MB`;
  } else {
    sizeStr = `~${Math.round(totalKb)} KB`;
  }

  const pageLabel = estimatedPages === 1 ? 'page' : 'pages';
  ui.pdfQualityEstimate.textContent = `${sizeStr} total · ~${estimatedPages} ${pageLabel}`;
}

function getCurrentQualityIndex(): number {
  const activeBtn = ui.pdfQualityButtons.querySelector('.seg-btn.active');
  return activeBtn ? Number((activeBtn as HTMLElement).getAttribute('data-quality')) : 2;
}

/**
 * Validates and stores user selected files. Works for both manual
 * selection and file drag-and-drop.
 * @param event Either a file input element's "change" event,
 * or a "drop" event.
 */
const fileSelectHandler = (event: Event) => {

  let inputFiles;

  if (event instanceof DragEvent) {
    inputFiles = event.dataTransfer?.files;
    if (inputFiles) event.preventDefault();
  } else if (event instanceof ClipboardEvent) {
    inputFiles = event.clipboardData?.files;
  } else {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    inputFiles = target.files;
  }

  if (!inputFiles) return;
  const newFiles = Array.from(inputFiles);
  if (newFiles.length === 0) return;

  // Add new files to existing batch (don't replace)
  for (const f of newFiles) {
    batchFiles.push({ file: f, outputFormatIndex: null });
  }

  // Sort by name
  batchFiles.sort((a, b) => a.file.name === b.file.name ? 0 : (a.file.name < b.file.name ? -1 : 1));

  renderBatchFileList();

  // Auto-detect input format from the first file's MIME type
  const firstFile = batchFiles[0].file;
  let mimeType = normalizeMimeType(firstFile.type);

  // Find a button matching the input MIME type.
  const buttonMimeType = Array.from(ui.inputList.children).find(button => {
    if (!(button instanceof HTMLButtonElement)) return false;
    return button.getAttribute("mime-type") === mimeType;
  });
  // Click button with matching MIME type.
  if (mimeType && buttonMimeType instanceof HTMLButtonElement) {
    buttonMimeType.click();
    ui.inputSearch.value = mimeType;
    filterButtonList(ui.inputList, ui.inputSearch.value);
    return;
  }

  // Fall back to matching format by file extension if MIME type wasn't found.
  const fileExtension = firstFile.name.split(".").pop()?.toLowerCase();

  const buttonExtension = Array.from(ui.inputList.children).find(button => {
    if (!(button instanceof HTMLButtonElement)) return false;
    const formatIndex = button.getAttribute("format-index");
    if (!formatIndex) return;
    const format = allOptions[parseInt(formatIndex)];
    return format.format.extension.toLowerCase() === fileExtension;
  });
  if (buttonExtension instanceof HTMLButtonElement) {
    buttonExtension.click();
    ui.inputSearch.value = buttonExtension.getAttribute("mime-type") || "";
  } else {
    ui.inputSearch.value = fileExtension || "";
  }

  filterButtonList(ui.inputList, ui.inputSearch.value);
};

// Add the file selection handler to both the file input element and to
// the window as a drag-and-drop event, and to the clipboard paste event.
ui.fileInput.addEventListener("change", fileSelectHandler);
window.addEventListener("drop", (e) => {
  ui.fileSelectArea.classList.remove('drag-over');
  fileSelectHandler(e);
});
window.addEventListener("dragover", e => {
  e.preventDefault();
  ui.fileSelectArea.classList.add('drag-over');
});
window.addEventListener("dragleave", (e) => {
  // Only remove if leaving the window
  if (e.relatedTarget === null) {
    ui.fileSelectArea.classList.remove('drag-over');
  }
});
window.addEventListener("paste", fileSelectHandler);

// Batch clear button
ui.batchClear.addEventListener("click", () => {
  batchFiles = [];
  renderBatchFileList();
  updateConvertButtonState();
  ui.fileInput.value = ''; // Reset file input
});

// Merge toggle
ui.mergeToggle.addEventListener("change", () => {
  mergeMode = ui.mergeToggle.checked;
  updateConvertButtonState();
});

// Output mode toggle (Same for all / Individual)
ui.outputModeToggle.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('output-mode-btn')) return;
  const mode = target.dataset.mode;
  if (!mode) return;

  // Update active state on buttons
  for (const btn of Array.from(ui.outputModeToggle.children)) {
    btn.classList.remove('active');
  }
  target.classList.add('active');

  individualMode = mode === 'individual';

  // When switching back to global, clear per-file overrides
  if (!individualMode) {
    for (const bf of batchFiles) {
      bf.outputFormatIndex = null;
    }
  }

  renderBatchFileList();
  updateConvertButtonState();
});

/**
 * Display an on-screen popup.
 * @param html HTML content of the popup box.
 */
window.showPopup = function (html: string) {
  ui.popupBox.innerHTML = html;
  ui.popupBox.style.display = "block";
  ui.popupBackground.style.display = "block";
}
/**
 * Hide the on-screen popup.
 */
window.hidePopup = function () {
  ui.popupBox.style.display = "none";
  ui.popupBackground.style.display = "none";
}

const allOptions: Array<{ format: FileFormat, handler: FormatHandler }> = [];

window.supportedFormatCache = new Map();
window.traversionGraph = new TraversionGraph();

window.printSupportedFormatCache = () => {
  const entries = [];
  for (const entry of window.supportedFormatCache) {
    entries.push(entry);
  }
  return JSON.stringify(entries, null, 2);
}

/** Formats to prioritize at the top of format lists */
const popularFormats = ['pdf', 'png', 'jpeg', 'jpg', 'mp4', 'mp3', 'svg', 'gif', 'webp', 'docx', 'wav', 'html'];

/** Re-order buttons in a format list so popular formats appear first, with a divider */
function sortPopularFormatsToTop(list: HTMLDivElement) {
  const buttons = Array.from(list.querySelectorAll('button')) as HTMLButtonElement[];
  if (buttons.length === 0) return;

  const popular: HTMLButtonElement[] = [];
  const rest: HTMLButtonElement[] = [];

  for (const btn of buttons) {
    const formatIdx = btn.getAttribute('format-index');
    if (formatIdx !== null) {
      const opt = allOptions[parseInt(formatIdx)];
      const fmt = opt?.format?.format?.toLowerCase() || '';
      if (popularFormats.includes(fmt)) {
        popular.push(btn);
      } else {
        rest.push(btn);
      }
    } else {
      rest.push(btn);
    }
  }

  // Sort popular buttons by their priority in the popularFormats array
  popular.sort((a, b) => {
    const aFmt = allOptions[parseInt(a.getAttribute('format-index') || '0')]?.format?.format?.toLowerCase() || '';
    const bFmt = allOptions[parseInt(b.getAttribute('format-index') || '0')]?.format?.format?.toLowerCase() || '';
    return popularFormats.indexOf(aFmt) - popularFormats.indexOf(bFmt);
  });

  // Only add divider if we have both popular and other formats
  if (popular.length > 0 && rest.length > 0) {
    // Clear and re-append in new order
    list.innerHTML = '';
    for (const btn of popular) list.appendChild(btn);

    const divider = document.createElement('div');
    divider.className = 'popular-divider';
    divider.innerHTML = '<span>All formats</span>';
    list.appendChild(divider);

    for (const btn of rest) list.appendChild(btn);
  }
}


async function buildOptionList() {

  allOptions.length = 0;
  ui.inputList.innerHTML = "";
  ui.outputList.innerHTML = "";

  for (const handler of handlers) {
    if (!window.supportedFormatCache.has(handler.name)) {
      console.warn(`Cache miss for formats of handler "${handler.name}".`);
      try {
        await handler.init();
      } catch (_) { continue; }
      if (handler.supportedFormats) {
        window.supportedFormatCache.set(handler.name, handler.supportedFormats);
        console.info(`Updated supported format cache for "${handler.name}".`);
      }
    }
    const supportedFormats = window.supportedFormatCache.get(handler.name);
    if (!supportedFormats) {
      console.warn(`Handler "${handler.name}" doesn't support any formats.`);
      continue;
    }
    for (const format of supportedFormats) {

      if (!format.mime) continue;

      allOptions.push({ format, handler });

      // In simple mode, display each input/output format only once
      let addToInputs = true, addToOutputs = true;
      if (simpleMode) {
        addToInputs = !Array.from(ui.inputList.children).some(c => {
          const currFormat = allOptions[parseInt(c.getAttribute("format-index") || "")]?.format;
          return currFormat?.mime === format.mime && currFormat?.format === format.format;
        });
        addToOutputs = !Array.from(ui.outputList.children).some(c => {
          const currFormat = allOptions[parseInt(c.getAttribute("format-index") || "")]?.format;
          return currFormat?.mime === format.mime && currFormat?.format === format.format;
        });
        if ((!format.from || !addToInputs) && (!format.to || !addToOutputs)) continue;
      }

      const newOption = document.createElement("button");
      newOption.setAttribute("format-index", (allOptions.length - 1).toString());
      newOption.setAttribute("mime-type", format.mime);

      const formatDescriptor = format.format.toUpperCase();
      if (simpleMode) {
        // Hide any handler-specific information in simple mode
        const cleanName = format.name
          .split("(").join(")").split(")")
          .filter((_, i) => i % 2 === 0)
          .filter(c => c != "")
          .join(" ");
        newOption.appendChild(document.createTextNode(`${formatDescriptor} - ${cleanName} (${format.mime})`));
      } else {
        newOption.appendChild(document.createTextNode(`${formatDescriptor} - ${format.name} (${format.mime}) ${handler.name}`));
      }

      const clickHandler = (event: Event) => {
        if (!(event.target instanceof HTMLButtonElement)) return;
        const targetParent = event.target.parentElement;
        const previous = targetParent?.getElementsByClassName("selected")?.[0];
        if (previous) previous.className = "";
        event.target.className = "selected";
        updateConvertButtonState();
      };

      if (format.from && addToInputs) {
        const clone = newOption.cloneNode(true) as HTMLButtonElement;
        clone.onclick = clickHandler;
        ui.inputList.appendChild(clone);
      }
      if (format.to && addToOutputs) {
        const clone = newOption.cloneNode(true) as HTMLButtonElement;
        clone.onclick = clickHandler;
        ui.outputList.appendChild(clone);
      }

    }
  }

  // Sort popular formats to top of each list
  sortPopularFormatsToTop(ui.inputList);
  sortPopularFormatsToTop(ui.outputList);

  window.traversionGraph.init();
  filterButtonList(ui.inputList, ui.inputSearch.value);
  filterButtonList(ui.outputList, ui.outputSearch.value);

  window.hidePopup();

}

(async () => {
  try {
    const cacheJSON = await fetch("cache.json").then(r => r.json());
    window.supportedFormatCache = new Map(cacheJSON);
  } catch {
    console.warn(
      "Missing supported format precache.\n\n" +
      "Consider saving the output of printSupportedFormatCache() to cache.json."
    );
  } finally {
    await buildOptionList();
    console.log("Built initial format list.");
  }
})();

// ═══════ Output Quality Selector ═══════
for (const btn of Array.from(ui.pdfQualityButtons.querySelectorAll('.seg-btn'))) {
  (btn as HTMLButtonElement).onclick = () => {
    const idx = Number((btn as HTMLElement).getAttribute('data-quality'));
    setPdfQualityPreset(idx);
    // Update active state
    for (const b of Array.from(ui.pdfQualityButtons.querySelectorAll('.seg-btn'))) {
      b.classList.toggle('active', b === btn);
    }
    // Update estimate with dynamic calculation
    updateDynamicEstimate();
  };
}

ui.modeToggleButton.addEventListener("click", () => {
  simpleMode = !simpleMode;
  if (simpleMode) {
    ui.modeToggleButton.textContent = "Advanced mode";
    document.body.style.setProperty("--highlight-color", "#1C77FF");
  } else {
    ui.modeToggleButton.textContent = "Simple mode";
    document.body.style.setProperty("--highlight-color", "#FF6F1C");
  }
  buildOptionList();
});

async function attemptConvertPath(files: FileData[], path: ConvertPathNode[]) {

  // Update status text if inside progress popup; otherwise update popup directly
  const statusEl = document.getElementById('batch-status');
  const routeLabel = path.map(c => c.format.format).join(" → ");
  if (statusEl) {
    statusEl.textContent = `Finding route: ${routeLabel}`;
  } else {
    ui.popupBox.innerHTML = `<h2>Finding conversion route...</h2>
      <p>Trying <b>${routeLabel}</b>...</p>`;
  }

  for (let i = 0; i < path.length - 1; i++) {
    const handler = path[i + 1].handler;
    try {
      let supportedFormats = window.supportedFormatCache.get(handler.name);
      if (!handler.ready) {
        try {
          await handler.init();
        } catch (_) { return null; }
        if (handler.supportedFormats) {
          window.supportedFormatCache.set(handler.name, handler.supportedFormats);
          supportedFormats = handler.supportedFormats;
        }
      }
      if (!supportedFormats) throw `Handler "${handler.name}" doesn't support any formats.`;
      const inputFormat = supportedFormats.find(c => c.mime === path[i].format.mime && c.from)!;
      files = (await Promise.all([
        handler.doConvert(files, inputFormat, path[i + 1].format),
        // Ensure that we wait long enough for the UI to update
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      ]))[0];
      if (files.some(c => !c.bytes.length)) throw "Output is empty.";
    } catch (e) {
      console.log(path.map(c => c.format.format));
      console.error(handler.name, `${path[i].format.format} → ${path[i + 1].format.format}`, e);
      if (statusEl) {
        statusEl.textContent = 'Looking for valid path...';
      } else {
        ui.popupBox.innerHTML = `<h2>Finding conversion route...</h2>
          <p>Looking for a valid path...</p>`;
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return null;
    }
  }

  return { files, path };

}

async function tryConvertByTraversing(
  files: FileData[],
  from: ConvertPathNode,
  to: ConvertPathNode
) {
  for await (const path of window.traversionGraph.searchPath(from, to, simpleMode)) {
    // Use exact output format if the target handler supports it
    if (path.at(-1)?.handler === to.handler) {
      path[path.length - 1] = to;
    }
    const attempt = await attemptConvertPath(files, path);
    if (attempt) return attempt;
  }
  return null;
}

function downloadFile(bytes: Uint8Array, name: string, mime: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  // Chrome requires the link to be in the DOM for download attribute to work
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  // Clean up after a tick
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }, 100);
}

/** Build a proper output filename: original name + output extension */
function buildOutputFilename(originalName: string, outputExtension: string): string {
  const dotIdx = originalName.lastIndexOf('.');
  const baseName = dotIdx > 0 ? originalName.substring(0, dotIdx) : originalName;
  return `${baseName}.${outputExtension.toLowerCase()}`;
}

/** Flag to cancel an in-progress conversion */
let conversionCancelled = false;

/** Build the progress popup HTML with percentage, progress bar, status text, and cancel button */
function buildProgressPopup(title: string): {
  updateProgress: (completed: number, total: number, statusText: string) => void;
  finish: () => void;
} {
  conversionCancelled = false;

  window.showPopup(
    `<h2>${title}</h2>` +
    `<div class="popup-progress-section">` +
    `<div class="popup-progress-header">` +
    `<span id="batch-status" class="popup-status">Preparing...</span>` +
    `<span id="batch-percent" class="popup-progress-percent">0%</span>` +
    `</div>` +
    `<div class="popup-progress"><div class="popup-progress-bar" id="batch-progress" style="width: 0%"></div></div>` +
    `</div>` +
    `<button class="popup-cancel-btn" id="cancel-convert">Cancel</button>`
  );

  const cancelBtn = document.getElementById('cancel-convert');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      conversionCancelled = true;
      cancelBtn.textContent = 'Cancelling...';
      (cancelBtn as HTMLButtonElement).disabled = true;
    };
  }

  return {
    updateProgress(completed: number, total: number, statusText: string) {
      const pct = Math.round((completed / total) * 100);
      const bar = document.getElementById('batch-progress');
      const percentEl = document.getElementById('batch-percent');
      const statusEl = document.getElementById('batch-status');
      if (bar) bar.style.width = `${pct}%`;
      if (percentEl) percentEl.textContent = `${pct}%`;
      if (statusEl) statusEl.textContent = statusText;
    },
    finish() {
      const bar = document.getElementById('batch-progress');
      if (bar) bar.style.width = '100%';
      const percentEl = document.getElementById('batch-percent');
      if (percentEl) percentEl.textContent = '100%';
    }
  };
}

/**
 * Handle merge mode: combine all image files into a single PDF
 * using the imagesToPdf handler directly.
 */
async function handleMergeConvert() {
  const imageFiles = batchFiles.filter(bf => isImageType(bf.file.type));
  if (imageFiles.length < 2) {
    return alert("Need at least 2 image files to merge.");
  }

  const progress = buildProgressPopup(`Merging ${imageFiles.length} images into PDF...`);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  try {
    const mergeHandler = handlers.find(h => h.name === "imagesToPdf");
    if (!mergeHandler) throw "imagesToPdf handler not found.";

    if (!mergeHandler.ready) await mergeHandler.init();

    progress.updateProgress(1, 4, 'Reading image files...');

    const inputFileData: FileData[] = [];
    for (let i = 0; i < imageFiles.length; i++) {
      if (conversionCancelled) {
        window.showPopup(
          `<h2>Merge cancelled</h2>` +
          `<p>Stopped before completing.</p>` +
          `<button onclick="window.hidePopup()">OK</button>`
        );
        return;
      }
      const buf = await imageFiles[i].file.arrayBuffer();
      inputFileData.push({ name: imageFiles[i].file.name, bytes: new Uint8Array(buf) });
      progress.updateProgress(i + 1, imageFiles.length + 2, `Reading: ${imageFiles[i].file.name}`);
    }

    const firstMime = normalizeMimeType(imageFiles[0].file.type);
    const inputFormat = mergeHandler.supportedFormats!.find(f => f.mime === firstMime && f.from);
    const outputFormat = mergeHandler.supportedFormats!.find(f => f.internal === "pdf" && f.to);

    if (!inputFormat || !outputFormat) {
      throw "Could not find matching format for merge.";
    }

    progress.updateProgress(imageFiles.length, imageFiles.length + 2, 'Building PDF...');

    if (conversionCancelled) {
      window.showPopup(
        `<h2>Merge cancelled</h2>` +
        `<p>Stopped before completing.</p>` +
        `<button onclick="window.hidePopup()">OK</button>`
      );
      return;
    }

    const result = await mergeHandler.doConvert(inputFileData, inputFormat, outputFormat);

    progress.finish();
    await new Promise(resolve => setTimeout(resolve, 300));

    for (const file of result) {
      downloadFile(file.bytes, file.name, "application/pdf");
    }

    window.showPopup(
      `<h2>Merged ${imageFiles.length} images into PDF!</h2>` +
      `<p>Output: <b>${result[0]?.name || 'merged.pdf'}</b></p>\n` +
      `<button onclick="window.hidePopup()">OK</button>`
    );

  } catch (e) {
    window.hidePopup();
    alert("Merge failed: " + e);
    console.error(e);
  }
}

ui.convertButton.onclick = async function () {

  if (batchFiles.length === 0) {
    return alert("Select input file(s).");
  }

  // Handle merge mode
  if (mergeMode) {
    return handleMergeConvert();
  }

  const inputButton = document.querySelector("#from-list .selected");
  if (!inputButton) return alert("Specify input file format.");

  const inputOption = allOptions[Number(inputButton.getAttribute("format-index"))];

  // Resolve global output (may be null if per-file overrides are used)
  const globalOutputButton = document.querySelector("#to-list .selected");
  const globalOutputOption = globalOutputButton
    ? allOptions[Number(globalOutputButton.getAttribute("format-index"))]
    : null;

  try {

    const totalFiles = batchFiles.length;
    let completedFiles = 0;
    let failedFiles = 0;

    const progress = buildProgressPopup(
      `Converting ${totalFiles} file${totalFiles > 1 ? 's' : ''}...`
    );
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const allOutputFiles: { name: string; bytes: Uint8Array; mime: string }[] = [];

    for (const bf of batchFiles) {
      // Check for cancellation
      if (conversionCancelled) break;

      const inputFile = bf.file;

      // Resolve this file's output format: per-file override takes priority
      const fileOutputOption = bf.outputFormatIndex !== null
        ? allOptions[bf.outputFormatIndex]
        : globalOutputOption;

      if (!fileOutputOption) {
        console.warn(`No output format for ${inputFile.name}, skipping.`);
        failedFiles++;
        completedFiles++;
        progress.updateProgress(completedFiles, totalFiles, `Skipped: ${inputFile.name} (no format)`);
        continue;
      }

      const outputFormat = fileOutputOption.format;
      const arrow = bf.outputFormatIndex !== null ? ` \u2192 ${outputFormat.format.toUpperCase()}` : '';
      progress.updateProgress(completedFiles, totalFiles, `Processing: ${inputFile.name}${arrow}`);

      const inputBuffer = await inputFile.arrayBuffer();
      const inputBytes = new Uint8Array(inputBuffer);

      if (inputOption.format.mime === outputFormat.mime) {
        downloadFile(inputBytes, inputFile.name, inputOption.format.mime);
        completedFiles++;
        progress.updateProgress(completedFiles, totalFiles, `Done: ${inputFile.name}`);
        continue;
      }

      const inputFileData: FileData[] = [{ name: inputFile.name, bytes: inputBytes }];

      const output = await tryConvertByTraversing(inputFileData, inputOption, fileOutputOption);
      if (!output) {
        console.warn(`Failed to convert ${inputFile.name}, skipping.`);
        failedFiles++;
        completedFiles++;
        progress.updateProgress(completedFiles, totalFiles, `Failed: ${inputFile.name}`);
        continue;
      }

      // Build proper output filename from original name + output extension
      const outputExt = outputFormat.extension || outputFormat.format;
      for (let fi = 0; fi < output.files.length; fi++) {
        const outName = output.files.length === 1
          ? buildOutputFilename(inputFile.name, outputExt)
          : buildOutputFilename(inputFile.name, outputExt).replace(/\.([^.]+)$/, `_${fi + 1}.$1`);
        allOutputFiles.push({ name: outName, bytes: output.files[fi].bytes, mime: outputFormat.mime });
      }

      completedFiles++;
      progress.updateProgress(completedFiles, totalFiles, `Done: ${inputFile.name}`);
    }

    // Handle cancellation
    if (conversionCancelled) {
      // Still download whatever was completed
      for (const file of allOutputFiles) {
        downloadFile(file.bytes, file.name, file.mime);
      }
      window.showPopup(
        `<h2>Conversion cancelled</h2>` +
        `<p>Completed ${completedFiles} of ${totalFiles} files before cancelling.</p>` +
        (allOutputFiles.length > 0 ? `<p>${allOutputFiles.length} file(s) downloaded.</p>` : '') +
        `<button onclick="window.hidePopup()">OK</button>`
      );
      return;
    }

    progress.finish();
    await new Promise(resolve => setTimeout(resolve, 200));

    // Download all output files — optionally as ZIP
    const useZip = ui.zipToggle.checked && allOutputFiles.length >= 2;
    if (useZip) {
      progress.updateProgress(completedFiles, totalFiles, 'Zipping files...');
      const zip = new JSZip();
      for (const file of allOutputFiles) {
        zip.file(file.name, file.bytes);
      }
      const zipBlob = await zip.generateAsync({ type: 'uint8array' });
      const firstBaseName = batchFiles[0]?.file.name.replace(/\.[^.]+$/, '') || 'converted';
      downloadFile(zipBlob, `${firstBaseName}_converted.zip`, 'application/zip');
    } else {
      for (const file of allOutputFiles) {
        downloadFile(file.bytes, file.name, file.mime);
      }
    }

    const outLabel = globalOutputOption
      ? `${inputOption.format.format.toUpperCase()} \u2192 ${globalOutputOption.format.format.toUpperCase()}`
      : `${inputOption.format.format.toUpperCase()} \u2192 per-file formats`;
    const zipNote = useZip ? `<p>\ud83d\udce6 Bundled into a single ZIP archive</p>` : '';
    window.showPopup(
      `<h2>Converted ${allOutputFiles.length} file${allOutputFiles.length !== 1 ? 's' : ''}!</h2>` +
      `<p>${outLabel}</p>` +
      zipNote +
      (failedFiles > 0 ? `<p style="color: var(--accent-red);">${failedFiles} file(s) failed</p>` : '') +
      `<button onclick="window.hidePopup()">OK</button>`
    );

  } catch (e) {

    window.hidePopup();
    alert("Unexpected error while routing:\n" + e);
    console.error(e);

  }

};

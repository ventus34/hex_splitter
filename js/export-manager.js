import HexMath from './hex-math.js?v=1.0.3';
import FrameGenerator from './frame-generator.js?v=1.0.3';
import { i18n } from './i18n.js?v=1.0.3';

class ExportManager {
    constructor(gridManager, imageProcessor) {
        this.gridManager = gridManager;
        this.imageProcessor = imageProcessor;
    }

    /**
     * Pokazuje pasek postępu eksportu
     */
    showProgress(show, text = '', pct = 0) {
        const wrapper = document.getElementById('export-progress-wrapper');
        const fill = document.getElementById('export-progress-fill');
        const txtEl = document.getElementById('export-progress-text');
        
        if (show) {
            wrapper.classList.remove('hidden');
            fill.style.width = `${pct}%`;
            txtEl.textContent = `${text} (${Math.round(pct)}%)`;
        } else {
            wrapper.classList.add('hidden');
        }
    }

    /**
     * Eksportuje wszystkie aktywne heksy jako spakowany ZIP
     */
    async exportHexesZip() {
        const activeCells = this.gridManager.getActiveCells();
        if (activeCells.length === 0) {
            alert(i18n.t('alert_no_hexes'));
            return;
        }

        const hasImages = activeCells.some(c => c.imageId !== null);
        if (!hasImages) {
            alert(i18n.t('alert_no_images'));
            return;
        }

        const exportFormat = this.gridManager.config.exportFormat || 'png';
        const exportQuality = this.gridManager.config.exportQuality !== undefined ? this.gridManager.config.exportQuality : 0.9;

        this.showProgress(true, i18n.t('generating_hex_images'), 0);
        const zip = new JSZip();
        let processed = 0;

        for (const cell of activeCells) {
            if (!cell.imageId) {
                processed++;
                continue;
            }

            try {
                // Wygeneruj canvas dla konkretnego heksa
                const canvas = this.imageProcessor.createHexagonCanvas(cell, this.gridManager);
                if (canvas) {
                    let blob;
                    let filename;

                    if (exportFormat === 'jpg') {
                        // JPEG nie wspiera przezroczystości, więc wypełniamy tło kolorem białym
                        const jpgCanvas = document.createElement('canvas');
                        jpgCanvas.width = canvas.width;
                        jpgCanvas.height = canvas.height;
                        const jpgCtx = jpgCanvas.getContext('2d');
                        jpgCtx.fillStyle = '#ffffff';
                        jpgCtx.fillRect(0, 0, jpgCanvas.width, jpgCanvas.height);
                        jpgCtx.drawImage(canvas, 0, 0);

                        blob = await new Promise(resolve => jpgCanvas.toBlob(resolve, 'image/jpeg', exportQuality));
                        filename = `hex_${cell.label}.jpg`;
                    } else {
                        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                        filename = `hex_${cell.label}.png`;
                    }

                    zip.file(filename, blob);
                }
            } catch (err) {
                console.error(`Błąd generowania heksu ${cell.label}:`, err);
            }

            processed++;
            const percent = (processed / activeCells.length) * 100;
            this.showProgress(true, i18n.t('generating_hex_images'), percent);
            // Pozwól przeglądarce na odświeżenie wątku UI
            await new Promise(r => setTimeout(r, 10));
        }

        this.showProgress(true, i18n.t('compressing_zip'), 100);
        
        try {
            const content = await zip.generateAsync({ type: 'blob' });
            saveAs(content, `hexsplitter_heksy.zip`);
        } catch (err) {
            alert(i18n.t('alert_zip_error') + err.message);
        }

        this.showProgress(false);
    }

    /**
     * Eksportuje pojedynczą ramkę jako plik PNG
     */
    async exportFramePNG() {
        const frameEnable = document.getElementById('frame-enable').checked;
        if (!frameEnable) {
            alert(i18n.t('alert_frames_disabled'));
            return;
        }

        const activeCells = this.gridManager.getActiveCells();
        if (activeCells.length === 0) {
            alert(i18n.t('alert_no_frames'));
            return;
        }

        const frameType = document.getElementById('frame-type').value;
        const frameWidth = parseFloat(document.getElementById('frame-width').value) || 4;
        const clearance = parseFloat(document.getElementById('frame-clearance').value) || 0.2;
        const frameColor = document.getElementById('frame-color').value || '#1a1a1a';

        let cellDpi = this.gridManager.config.dpi;
        if (cellDpi === 'original') {
            cellDpi = 300; // fallback dla ramek (brak oryginalnej rozdzielczości obrazu)
        }

        this.showProgress(true, 'Generowanie ramek PNG...', 0);
        const zip = new JSZip();
        let processed = 0;

        try {
            for (const cell of activeCells) {
                const canvas = FrameGenerator.createFrameCanvas(
                    cell,
                    this.gridManager,
                    frameType,
                    frameWidth,
                    clearance,
                    frameColor,
                    cellDpi
                );
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                zip.file(`ramka_${cell.label}.png`, blob);
                
                processed++;
                const percent = (processed / activeCells.length) * 100;
                this.showProgress(true, i18n.t('generating_png_frames'), percent);
                await new Promise(r => setTimeout(r, 10));
            }

            this.showProgress(true, i18n.t('compressing_zip'), 100);
            const content = await zip.generateAsync({ type: 'blob' });
            saveAs(content, `hexsplitter_ramki_${frameType}_png.zip`);
        } catch (err) {
            console.error('Błąd generowania ramek PNG:', err);
            alert(i18n.t('alert_frame_png_error') + err.message);
        }

        this.showProgress(false);
    }

    /**
     * Eksportuje ramki jako pliki SVG spakowane w ZIP
     */
    async exportFrameSVG() {
        const frameEnable = document.getElementById('frame-enable').checked;
        if (!frameEnable) {
            alert(i18n.t('alert_frames_disabled'));
            return;
        }

        const activeCells = this.gridManager.getActiveCells();
        if (activeCells.length === 0) {
            alert(i18n.t('alert_no_frames'));
            return;
        }

        const frameType = document.getElementById('frame-type').value;
        const frameWidth = parseFloat(document.getElementById('frame-width').value) || 4;
        const clearance = parseFloat(document.getElementById('frame-clearance').value) || 0.2;
        const frameColor = document.getElementById('frame-color').value || '#1a1a1a';

        this.showProgress(true, 'Generowanie ramek SVG...', 0);
        const zip = new JSZip();
        let processed = 0;

        try {
            for (const cell of activeCells) {
                const svgString = FrameGenerator.createFrameSVG(
                    cell,
                    this.gridManager,
                    frameType,
                    frameWidth,
                    clearance,
                    frameColor
                );
                const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
                zip.file(`ramka_${cell.label}.svg`, blob);
                
                processed++;
                const percent = (processed / activeCells.length) * 100;
                this.showProgress(true, i18n.t('generating_svg_frames'), percent);
                await new Promise(r => setTimeout(r, 10));
            }

            this.showProgress(true, i18n.t('compressing_zip'), 100);
            const content = await zip.generateAsync({ type: 'blob' });
            saveAs(content, `hexsplitter_ramki_${frameType}_svg.zip`);
        } catch (err) {
            console.error('Błąd generowania ramek SVG:', err);
            alert(i18n.t('alert_frame_svg_error') + err.message);
        }

        this.showProgress(false);
    }

    /**
     * Generuje instrukcję montażu w formacie HTML (zdatną do wydruku do PDF)
     */
    async generateAssemblyInstructions() {
        const activeCells = this.gridManager.getActiveCells();
        
        // 1. Zaktualizuj statystyki
        const dateStr = new Date().toLocaleDateString(i18n.locale === 'pl' ? 'pl-PL' : 'en-US');
        const timeStr = new Date().toLocaleTimeString(i18n.locale === 'pl' ? 'pl-PL' : 'en-US', { hour: '2-digit', minute: '2-digit' });
        document.querySelector('.instruction-date').textContent = i18n.t('generated_date', { date: dateStr, time: timeStr });
        document.getElementById('inst-stat-total').textContent = activeCells.length;

        const bbox = this.gridManager.getBoundingBoxMm();
        document.getElementById('inst-stat-dimensions').textContent = `${Math.round(bbox.width)} x ${Math.round(bbox.height)} mm`;
        document.getElementById('inst-stat-hexsize').textContent = `${this.gridManager.config.hexSize} mm`;
        document.getElementById('inst-stat-gap').textContent = `${this.gridManager.config.gap} mm`;

        // 2. Rysuj schemat ściany na instrukcji
        this.renderInstructionLayoutCanvas(bbox);

        // 3. Wygeneruj wiersze tabeli z miniaturkami
        const tbody = document.getElementById('instructions-table-body');
        tbody.innerHTML = ''; // wyczyść stary wykaz

        if (activeCells.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = `<td colspan="5" style="text-align: center;">${i18n.t('no_active_hexes')}</td>`;
            tbody.appendChild(row);
            return;
        }

        // Pobierz ustawienia ramki
        const frameEnable = this.gridManager.config.frameEnable;
        const frameType = document.getElementById('frame-type').value;
        const frameWidth = parseFloat(document.getElementById('frame-width').value) || 2;
        const clearance = parseFloat(document.getElementById('frame-clearance').value) || 0.2;
        const frameColor = document.getElementById('frame-color').value || '#1a1a1a';

        // Dodaj wiersze dla każdego aktywnego heksu
        for (const cell of activeCells) {
            const tr = document.createElement('tr');
            
            // Etykieta / Kod
            const tdCode = document.createElement('td');
            tdCode.innerHTML = `<span class="inst-code-badge">${cell.label}</span>`;
            tr.appendChild(tdCode);

            // Pozycja (Kolumna / Wiersz)
            const tdPos = document.createElement('td');
            tdPos.innerHTML = i18n.t('col_row_info', { col: cell.col + 1, row: cell.row + 1 });
            tr.appendChild(tdPos);

            // Miniaturka grafiki (heksu)
            const tdPreview = document.createElement('td');
            const previewCellDiv = document.createElement('div');
            previewCellDiv.className = 'inst-hex-preview-cell';
            
            if (cell.imageId && this.imageProcessor.getImage(cell.imageId)) {
                // Wygeneruj małą grafikę heksu (np. na niskim DPI = 72)
                const originalDpi = this.gridManager.config.dpi;
                
                // Tymczasowo przestaw DPI na niskie dla mini-generowania
                this.gridManager.config.dpi = 72;
                const hexCanvas = this.imageProcessor.createHexagonCanvas(cell, this.gridManager);
                this.gridManager.config.dpi = originalDpi; // przywróć
                
                if (hexCanvas) {
                    const img = document.createElement('img');
                    img.src = hexCanvas.toDataURL('image/png');
                    previewCellDiv.appendChild(img);
                }
            } else {
                previewCellDiv.innerHTML = `<span style="font-size: 0.6rem; color: #aaa;">${i18n.t('no_graphic')}</span>`;
            }
            tdPreview.appendChild(previewCellDiv);
            tr.appendChild(tdPreview);

            // Miniaturka kształtu ramki
            const tdFramePreview = document.createElement('td');
            const framePreviewDiv = document.createElement('div');
            framePreviewDiv.className = 'inst-hex-preview-cell';

            if (frameEnable) {
                try {
                    // Generujemy podgląd ramki na niskim DPI
                    const frameCanvas = FrameGenerator.createFrameCanvas(
                         cell,
                         this.gridManager,
                         frameType,
                         frameWidth,
                         clearance,
                         frameColor,
                         72
                    );
                    if (frameCanvas) {
                        const img = document.createElement('img');
                        img.src = frameCanvas.toDataURL('image/png');
                        framePreviewDiv.appendChild(img);
                    }
                } catch (err) {
                    console.error(`Błąd generowania podglądu ramki dla ${cell.label}:`, err);
                    framePreviewDiv.innerHTML = `<span style="font-size: 0.6rem; color: #aaa;">${i18n.t('gen_error')}</span>`;
                }
            } else {
                framePreviewDiv.innerHTML = `<span style="font-size: 0.6rem; color: #aaa;">${i18n.t('frames_disabled')}</span>`;
            }
            tdFramePreview.appendChild(framePreviewDiv);
            tr.appendChild(tdFramePreview);

            // Opis i wymiary montażowe
            const hexDim = HexMath.getHexDimensions(this.gridManager.config.hexSize, this.gridManager.config.orientation);
            const imageObj = cell.imageId ? this.imageProcessor.getImage(cell.imageId) : null;
            const imageName = imageObj ? imageObj.name : i18n.t('not_assigned');

            const tdDesc = document.createElement('td');
            tdDesc.innerHTML = `
                ${i18n.t('print_size')} <strong>${Math.round(hexDim.width)} x ${Math.round(hexDim.height)} mm</strong><br>
                ${i18n.t('source_image')} <code>${imageName}</code><br>
                ${frameEnable ? `${i18n.t('outer_frame_width')} <strong>${frameWidth} mm</strong>` : ''}
                <span style="font-size: 0.8rem; color: #666; margin-top: 4px; display: block;">
                    ${i18n.t('inst_mount_desc')}
                </span>
            `;
            tr.appendChild(tdDesc);

            tbody.appendChild(tr);
        }
    }

    /**
     * Rysuje uproszczony schemat z numeracją heksów na potrzeby instrukcji
     */
    renderInstructionLayoutCanvas(bbox) {
        const canvas = document.getElementById('instruction-layout-canvas');
        const ctx = canvas.getContext('2d');
        
        // Zabezpieczenie przed dzieleniem przez zero i brak heksów
        if (bbox.width === 0 || bbox.height === 0) {
            canvas.width = 100;
            canvas.height = 100;
            ctx.clearRect(0, 0, 100, 100);
            return;
        }

        // Piksele na mm dla ostrego wydruku instrukcji
        const scale = 2; // 2px na 1mm siatki
        canvas.width = bbox.width * scale + 40; // margines 20px z każdej strony
        canvas.height = bbox.height * scale + 40;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Ustawienia transformacji rysowania
        ctx.save();
        ctx.translate(-bbox.minX * scale + 20, -bbox.minY * scale + 20);

        const hexSize = this.gridManager.config.hexSize;
        const orientation = this.gridManager.config.orientation;
        const stagger = this.gridManager.config.stagger || 'left';
        const gap = this.gridManager.config.gap;
        
        const activeCells = this.gridManager.getActiveCells();

        // Parametry ramek
        const frameEnable = this.gridManager.config.frameEnable;
        const frameWidth = this.gridManager.config.frameWidth;
        const clearance = this.gridManager.config.frameClearance;
        const frameColor = document.getElementById('frame-color').value || '#1a1a1a';

        // Rysuj wypełnienia heksów z grafiką jako jasnoszary lub miniatura
        activeCells.forEach(cell => {
            const pos = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
            
            const innerSizeMm = hexSize + clearance;
            const innerVertices = HexMath.getHexVertices(pos.x * scale, pos.y * scale, innerSizeMm * scale, orientation);

            ctx.save();

            // 1. Rysuj ramkę wokół heksa (jeśli włączona)
            if (frameEnable) {
                const offsetsMm = [];
                for (let i = 0; i < 6; i++) {
                    const isShared = HexMath.isEdgeShared(cell, i, this.gridManager);
                    offsetsMm.push(isShared ? gap / 2 : frameWidth);
                }
                const offsetsScale = offsetsMm.map(o => o * scale);
                const outerVertices = HexMath.getOffsetOuterVertices(pos.x * scale, pos.y * scale, innerSizeMm * scale, orientation, offsetsScale);

                ctx.fillStyle = frameColor;
                ctx.beginPath();
                outerVertices.forEach((v, idx) => {
                    if (idx === 0) ctx.moveTo(v.x, v.y);
                    else ctx.lineTo(v.x, v.y);
                });
                ctx.closePath();

                const revInner = [...innerVertices].reverse();
                revInner.forEach((v, idx) => {
                    if (idx === 0) ctx.moveTo(v.x, v.y);
                    else ctx.lineTo(v.x, v.y);
                });
                ctx.closePath();
                ctx.fill('evenodd');
            }

            // 2. Wypełnienie heksa (otwór wewnętrzny)
            ctx.fillStyle = '#f9fafb';
            ctx.beginPath();
            innerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.fill();

            // 3. Cienka ciemna ramka wewnętrzna dla estetyki otworu
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            innerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.stroke();

            // 4. Numeracja/Etykieta w środku
            ctx.fillStyle = '#000000';
            ctx.font = `bold ${Math.round(hexSize * 0.3 * scale)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(cell.label, pos.x * scale, pos.y * scale);

            ctx.restore();
        });

        ctx.restore();
    }
}

export default ExportManager;

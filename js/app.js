import GridManager from './grid-manager.js?v=1.0.3';
import ImageProcessor from './image-processor.js?v=1.0.3';
import WallPlanner from './wall-planner.js?v=1.0.3';
import PreviewRenderer from './preview-renderer.js?v=1.0.3';
import ExportManager from './export-manager.js?v=1.0.3';
import { i18n } from './i18n.js?v=1.0.3';

// Silnik magazynu IndexedDB do trwałego zapisywania oryginalnych plików graficznych
class DBStore {
    static DB_NAME = 'HexSplitterImagesDB';
    static DB_VERSION = 1;
    static STORE_NAME = 'images';

    static open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    static async save(id, name, blob, width, height) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.put({ id, name, blob, width, height });
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    static async delete(id) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    static async getAll() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    static async clear() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.clear();
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // Inicjalizacja modułów
    const gridManager = new GridManager();
    const imageProcessor = new ImageProcessor();
    const planner = new WallPlanner('planner-canvas', gridManager, imageProcessor);
    const preview = new PreviewRenderer('preview-canvas', gridManager, imageProcessor);
    const exporter = new ExportManager(gridManager, imageProcessor);

    // Dynamiczne wskaźniki wymiarów pojedynczego heksa
    const valHexFlatWidth = document.getElementById('val-hex-flat-width');
    const valHexTotalHeight = document.getElementById('val-hex-total-height');

    // Język i i18n
    const selectLang = document.getElementById('select-lang');
    if (selectLang) {
        selectLang.value = i18n.locale;
        selectLang.addEventListener('change', (e) => {
            i18n.setLocale(e.target.value);
        });
    }
    i18n.translatePage();

    // Elementy DOM konfiguracji siatki
    const inputCols = document.getElementById('grid-cols');
    const inputRows = document.getElementById('grid-rows');
    const inputHexSize = document.getElementById('hex-size');
    const selectOrientation = document.getElementById('hex-orientation');
    const selectStagger = document.getElementById('hex-stagger');
    const inputGap = document.getElementById('hex-gap');
    const selectDpi = document.getElementById('export-dpi');
    const selectFormat = document.getElementById('export-format');
    const inputQuality = document.getElementById('export-quality');
    const valQuality = document.getElementById('val-export-quality');
    const jpgQualityGroup = document.getElementById('jpg-quality-group');

    // Elementy DOM weryfikacji stołu
    const chkBedVerify = document.getElementById('bed-verify');
    const inputBedX = document.getElementById('bed-size-x');
    const inputBedY = document.getElementById('bed-size-y');
    const bedWarningMessage = document.getElementById('bed-warning-message');

    // Elementy DOM konfiguracji ramek i złączy
    const chkFrameEnable = document.getElementById('frame-enable');
    const selectFrameType = document.getElementById('frame-type');
    const inputFrameWidth = document.getElementById('frame-width');
    const inputFrameClearance = document.getElementById('frame-clearance');
    const inputFrameColor = document.getElementById('frame-color');
    const txtFrameColorHex = document.getElementById('frame-color-hex');
    const frameSettingsSub = document.querySelector('.frame-settings-sub');
    const chkSyncFrameWidth = document.getElementById('chk-sync-frame-width');

    // Elementy biblioteki obrazów
    const fileInput = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');
    const imageList = document.getElementById('image-list');
    const selectMainImage = document.getElementById('select-main-image');
    const singleImageWrapper = document.querySelector('.single-image-select-wrapper');
    const inputSingleImageZoom = document.getElementById('single-image-zoom');
    const valSingleImageZoom = document.getElementById('val-single-image-zoom');
    const singleImageZoomGroup = document.getElementById('single-image-zoom-group');

    // Zmienne stanu trybu dopasowania
    const radioImageModes = document.querySelectorAll('input[name="image-mode"]');

    // Opcje podglądu AMS
    const chkPreviewAms = document.getElementById('chk-preview-ams');
    const selectAmsColors = document.getElementById('preview-ams-colors');

    // Przełączniki trybów pracy
    const btnModeGrid = document.getElementById('btn-mode-grid');
    const btnModeImage = document.getElementById('btn-mode-image');

    // Elementy miarki
    const chkPreviewRuler = document.getElementById('chk-preview-ruler');

    // Zabezpieczenie
    if (!inputCols || !inputRows || !inputHexSize || !selectOrientation || !selectStagger || !inputGap || !selectDpi) {
        console.error("Nie znaleziono wymaganych elementów konfiguracji w DOM.");
        return;
    }

    // Inicjalizacja konfiguracji
    function readConfigFromUI() {
        return {
            columns: parseInt(inputCols.value) || 4,
            rows: parseInt(inputRows.value) || 3,
            hexSize: parseFloat(inputHexSize.value) || 100,
            orientation: selectOrientation.value || 'flat-top',
            stagger: selectStagger.value || 'left',
            gap: parseFloat(inputGap.value) || 2,
            dpi: selectDpi.value === 'original' ? 'original' : (parseInt(selectDpi.value) || 300),
            exportFormat: selectFormat.value || 'png',
            exportQuality: (parseFloat(inputQuality.value) || 90) / 100,
            bedX: parseFloat(inputBedX.value) || 256,
            bedY: parseFloat(inputBedY.value) || 256,
            bedVerify: chkBedVerify.checked,
            frameEnable: chkFrameEnable.checked,
            frameWidth: parseFloat(inputFrameWidth.value) || 2,
            frameClearance: parseFloat(inputFrameClearance.value) || 0.2,
            singleImageOffsetX: gridManager.config.singleImageOffsetX || 0,
            singleImageOffsetY: gridManager.config.singleImageOffsetY || 0,
            singleImageScale: parseFloat(inputSingleImageZoom?.value || 100) / 100 || 1.0
        };
    }

    function updateFrameWidthSync() {
        if (chkSyncFrameWidth) {
            if (chkSyncFrameWidth.checked) {
                inputFrameWidth.value = inputGap.value;
                inputFrameWidth.disabled = true;
            } else {
                inputFrameWidth.disabled = false;
            }
        }
    }

    function updateHexDimensionLabels() {
        const size = parseFloat(inputHexSize.value) || 100;
        const orientation = selectOrientation.value;

        if (orientation === 'flat-top') {
            valHexFlatWidth.textContent = Math.round(size * Math.sqrt(3));
            valHexTotalHeight.textContent = Math.round(size * 2);
        } else {
            valHexFlatWidth.textContent = Math.round(size * Math.sqrt(3));
            valHexTotalHeight.textContent = Math.round(size * 2);
        }
    }

    // Automatyczny zapis do LocalStorage
    function saveProjectState() {
        const layoutData = {
            grid: {
                columns: parseInt(inputCols.value) || 4,
                rows: parseInt(inputRows.value) || 3,
                hexSize: parseFloat(inputHexSize.value) || 100,
                orientation: selectOrientation.value,
                stagger: selectStagger.value,
                gap: parseFloat(inputGap.value) || 2,
                dpi: selectDpi.value,
                exportFormat: selectFormat.value,
                exportQuality: parseInt(inputQuality.value) || 90,
                singleImageOffsetX: gridManager.config.singleImageOffsetX || 0,
                singleImageOffsetY: gridManager.config.singleImageOffsetY || 0,
                singleImageScale: gridManager.config.singleImageScale || 1.0
            },
            bed: {
                verify: chkBedVerify.checked,
                sizeX: parseFloat(inputBedX.value) || 256,
                sizeY: parseFloat(inputBedY.value) || 256
            },
            frame: {
                enable: chkFrameEnable.checked,
                type: selectFrameType.value,
                width: parseFloat(inputFrameWidth.value) || 2,
                clearance: parseFloat(inputFrameClearance.value) || 0.2,
                color: inputFrameColor.value,
                syncWidth: chkSyncFrameWidth ? chkSyncFrameWidth.checked : true
            },
            previewOptions: {
                showGaps: chkPreviewGaps.checked,
                showLabels: chkPreviewLabels.checked,
                showFrames: chkPreviewFrames.checked,
                showRuler: chkPreviewRuler ? chkPreviewRuler.checked : true,
                background: selectPreviewBg.value
            },
            imageMode: getActiveImageMode(),
            activeImageId: imageProcessor.activeImageId,
            cells: gridManager.getAllCells().map(c => ({
                q: c.q,
                r: c.r,
                enabled: c.enabled,
                imageId: c.imageId,
                cropRegion: c.cropRegion
            }))
        };
        localStorage.setItem('hexsplitter_project_layout', JSON.stringify(layoutData));
    }

    function checkBedVolumeAlert() {
        const activeCells = gridManager.getActiveCells();
        const hasExceeding = activeCells.some(c => c.exceedsBedSize);
        
        if (hasExceeding && chkBedVerify.checked) {
            bedWarningMessage.classList.remove('hidden');
        } else {
            bedWarningMessage.classList.add('hidden');
        }
    }

    // Aktualizacja etykiet opcji stagger w zależności od orientacji
    function updateStaggerDropdownLabels() {
        const orientation = selectOrientation.value;
        const optLeft = document.getElementById('opt-stagger-left');
        const optRight = document.getElementById('opt-stagger-right');
        if (optLeft && optRight) {
            if (orientation === 'pointy-top') {
                optLeft.setAttribute('data-i18n', 'stagger_left_pointy');
                optRight.setAttribute('data-i18n', 'stagger_right_pointy');
            } else {
                optLeft.setAttribute('data-i18n', 'stagger_left_flat');
                optRight.setAttribute('data-i18n', 'stagger_right_flat');
            }
            i18n.translatePage();
        }
    }

    // Obsługa zmian konfiguracji siatki
    function handleGridConfigChange() {
        updateStaggerDropdownLabels();
        updateFrameWidthSync();
        gridManager.updateConfig(readConfigFromUI());
        updateHexDimensionLabels();
        checkBedVolumeAlert();
        
        const mode = getActiveImageMode();
        if (mode === 'single') {
            imageProcessor.recalculateSingleImageMapping(gridManager);
        }

        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    }

    [inputCols, inputRows, inputHexSize, selectOrientation, selectStagger, inputGap, selectDpi].forEach(input => {
        input.addEventListener('input', handleGridConfigChange);
    });

    if (selectFormat) {
        selectFormat.addEventListener('change', () => {
            if (selectFormat.value === 'jpg') {
                jpgQualityGroup.classList.remove('hidden');
            } else {
                jpgQualityGroup.classList.add('hidden');
            }
            handleGridConfigChange();
        });
    }

    if (inputQuality) {
        inputQuality.addEventListener('input', () => {
            if (valQuality) {
                valQuality.textContent = `${inputQuality.value}%`;
            }
            handleGridConfigChange();
        });
    }

    // Weryfikacja stołu roboczego
    function handleBedVerifyChange() {
        const verify = chkBedVerify.checked;
        const container = document.querySelector('.id-bed-settings-container');
        if (verify) {
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
        }
        
        gridManager.updateConfig(readConfigFromUI());
        checkBedVolumeAlert();
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    }

    chkBedVerify.addEventListener('change', handleBedVerifyChange);
    [inputBedX, inputBedY].forEach(input => {
        input.addEventListener('input', () => {
            gridManager.updateConfig(readConfigFromUI());
            checkBedVolumeAlert();
            planner.scheduleRender();
            preview.scheduleRender();
            saveProjectState();
        });
    });

    // Konfiguracja ramek i złączy
    function handleFrameConfigChange() {
        updateFrameWidthSync();
        if (chkFrameEnable.checked) {
            frameSettingsSub.classList.remove('hidden');
        } else {
            frameSettingsSub.classList.add('hidden');
        }
        txtFrameColorHex.textContent = inputFrameColor.value.toUpperCase();
        
        // Zaktualizuj i przelicz weryfikację stołu pod kątem ramek
        gridManager.updateConfig(readConfigFromUI());
        checkBedVolumeAlert();
        
        preview.options.showFrames = chkFrameEnable.checked;
        if (chkPreviewFrames) {
            chkPreviewFrames.checked = chkFrameEnable.checked;
        }
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    }

    chkFrameEnable.addEventListener('change', handleFrameConfigChange);
    [selectFrameType, inputFrameWidth, inputFrameClearance, inputFrameColor].forEach(input => {
        if (input) input.addEventListener('input', handleFrameConfigChange);
    });

    if (chkSyncFrameWidth) {
        chkSyncFrameWidth.addEventListener('change', () => {
            updateFrameWidthSync();
            handleGridConfigChange();
        });
    }

    // Tryb przypisania grafik (Single Image vs Multi Image)
    function getActiveImageMode() {
        let activeMode = 'single';
        radioImageModes.forEach(r => {
            if (r.checked) activeMode = r.value;
        });
        return activeMode;
    }

    function updateZoomSliderVisibility() {
        const mode = getActiveImageMode();
        if (mode === 'single' && imageProcessor.activeImageId) {
            singleImageZoomGroup?.classList.remove('hidden');
        } else {
            singleImageZoomGroup?.classList.add('hidden');
        }
    }

    radioImageModes.forEach(radio => {
        radio.addEventListener('change', () => {
            const mode = getActiveImageMode();
            if (mode === 'single') {
                singleImageWrapper.classList.remove('hidden');
                imageProcessor.recalculateSingleImageMapping(gridManager);
            } else {
                singleImageWrapper.classList.add('hidden');
                gridManager.clearImageAssignments();
            }
            updateZoomSliderVisibility();
            planner.scheduleRender();
            preview.scheduleRender();
            saveProjectState();
        });
    });

    // Wybór głównej grafiki dla całej ściany
    selectMainImage.addEventListener('change', () => {
        imageProcessor.activeImageId = selectMainImage.value || null;
        imageProcessor.recalculateSingleImageMapping(gridManager);
        updateZoomSliderVisibility();
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    });

    // Zmiana skali powiększenia obrazu
    if (inputSingleImageZoom) {
        inputSingleImageZoom.addEventListener('input', () => {
            if (valSingleImageZoom) {
                valSingleImageZoom.textContent = `${inputSingleImageZoom.value}%`;
            }
            handleGridConfigChange();
        });
    }

    // Podgląd AMS (Kwantyzacja kolorów)
    chkPreviewAms.addEventListener('change', () => {
        if (chkPreviewAms.checked) {
            selectAmsColors.classList.remove('hidden');
        } else {
            selectAmsColors.classList.add('hidden');
        }
        preview.options.amsPreview = chkPreviewAms.checked;
        preview.scheduleRender();
    });

    selectAmsColors.addEventListener('change', () => {
        preview.options.amsColors = parseInt(selectAmsColors.value) || 4;
        preview.scheduleRender();
    });

    // Obsługa drag & drop plików
    dropzone.addEventListener('click', () => fileInput.click());
    
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            await handleImageFiles(files);
        }
    });

    fileInput.addEventListener('change', async () => {
        if (fileInput.files.length > 0) {
            await handleImageFiles(fileInput.files);
        }
    });

    // Wczytanie plików
    async function handleImageFiles(files) {
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            try {
                const imgObj = await imageProcessor.addImage(file);
                // Zapisz fizyczny blob pliku do trwałego IndexedDB
                await DBStore.save(imgObj.id, imgObj.name, file, imgObj.width, imgObj.height);
                addDraggableImageToUI(imgObj);
            } catch (err) {
                console.error("Nie udało się załadować obrazu:", err);
            }
        }
        updateMainImageSelector();
        
        if (getActiveImageMode() === 'single' && imageProcessor.activeImageId) {
            imageProcessor.recalculateSingleImageMapping(gridManager);
        }
        
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    }

    // Dodanie elementu grafiki do listy
    function addDraggableImageToUI(imageObj) {
        const emptyText = imageList.querySelector('.empty-list-text');
        if (emptyText) emptyText.remove();

        const item = document.createElement('div');
        item.className = 'image-item';
        item.draggable = true;
        item.dataset.id = imageObj.id;

        const img = document.createElement('img');
        img.src = imageObj.src;
        item.appendChild(img);

        const details = document.createElement('div');
        details.className = 'image-details';
        
        const name = document.createElement('span');
        name.className = 'image-name';
        name.textContent = imageObj.name;
        details.appendChild(name);

        const res = document.createElement('span');
        res.className = 'image-resolution';
        res.textContent = `${imageObj.width}x${imageObj.height} px`;
        details.appendChild(res);

        item.appendChild(details);

        // Przycisk usuwania
        const btnRemove = document.createElement('button');
        btnRemove.className = 'btn-remove-image';
        btnRemove.innerHTML = `
            <svg viewBox="0 0 24 24" class="icon-inline">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
            </svg>
        `;
        btnRemove.addEventListener('click', async (e) => {
            e.stopPropagation();
            imageProcessor.removeImage(imageObj.id);
            // Usuń z IndexedDB
            await DBStore.delete(imageObj.id);
            item.remove();
            
            if (imageProcessor.getAllImages().length === 0) {
                imageList.innerHTML = `<p class="empty-list-text">${i18n.t('no_images_loaded')}</p>`;
            }
            
            updateMainImageSelector();
            
            if (getActiveImageMode() === 'single') {
                imageProcessor.recalculateSingleImageMapping(gridManager);
            } else {
                gridManager.getAllCells().forEach(cell => {
                    if (cell.imageId === imageObj.id) {
                        cell.imageId = null;
                        cell.cropRegion = null;
                    }
                });
            }
            
            planner.scheduleRender();
            preview.scheduleRender();
            saveProjectState();
        });
        item.appendChild(btnRemove);

        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', imageObj.id);
            item.classList.add('dragging');
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });

        imageList.appendChild(item);
    }

    function updateMainImageSelector() {
        const images = imageProcessor.getAllImages();
        selectMainImage.innerHTML = `<option value="">${i18n.t('select_image_placeholder')}</option>`;
        images.forEach(img => {
            const opt = document.createElement('option');
            opt.value = img.id;
            opt.textContent = img.name;
            selectMainImage.appendChild(opt);
        });

        if (imageProcessor.activeImageId && images.some(i => i.id === imageProcessor.activeImageId)) {
            selectMainImage.value = imageProcessor.activeImageId;
        } else if (images.length > 0) {
            imageProcessor.activeImageId = images[0].id;
            selectMainImage.value = images[0].id;
        } else {
            imageProcessor.activeImageId = null;
            selectMainImage.value = '';
        }
        updateZoomSliderVisibility();
    }

    // Zakładki
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const targetTabId = btn.dataset.tab;
            tabContents.forEach(content => {
                if (content.id === targetTabId) {
                    content.classList.remove('hidden');
                } else {
                    content.classList.add('hidden');
                }
            });

            if (targetTabId === 'tab-planner') {
                planner.resize();
                planner.centerGrid();
            } 
            else if (targetTabId === 'tab-preview') {
                preview.resize();
                preview.centerGrid();
            } 
            else if (targetTabId === 'tab-instructions') {
                exporter.generateAssemblyInstructions();
            }
        });
    });

    // Przyciski zoomu
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
        const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
        if (activeTab === 'tab-planner') {
            planner.zoom = Math.min(planner.zoom * 1.15, 4.0);
            planner.scheduleRender();
        } else if (activeTab === 'tab-preview') {
            preview.zoom = Math.min(preview.zoom * 1.15, 4.0);
            preview.scheduleRender();
        }
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
        const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
        if (activeTab === 'tab-planner') {
            planner.zoom = Math.max(planner.zoom / 1.15, 0.1);
            planner.scheduleRender();
        } else if (activeTab === 'tab-preview') {
            preview.zoom = Math.max(preview.zoom / 1.15, 0.1);
            preview.scheduleRender();
        }
    });

    document.getElementById('btn-zoom-fit').addEventListener('click', () => {
        const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
        if (activeTab === 'tab-planner') {
            planner.centerGrid();
        } else if (activeTab === 'tab-preview') {
            preview.centerGrid();
        }
    });

    document.getElementById('btn-select-all').addEventListener('click', () => {
        gridManager.setAllCellsStatus(true);
        gridManager.checkBedSizeFit();
        checkBedVolumeAlert();
        if (getActiveImageMode() === 'single') {
            imageProcessor.recalculateSingleImageMapping(gridManager);
        }
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    });

    document.getElementById('btn-deselect-all').addEventListener('click', () => {
        gridManager.setAllCellsStatus(false);
        checkBedVolumeAlert();
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    });

    // Opcje podglądu
    const chkPreviewGaps = document.getElementById('chk-preview-gaps');
    const chkPreviewLabels = document.getElementById('chk-preview-labels');
    const chkPreviewFrames = document.getElementById('chk-preview-frames');
    const selectPreviewBg = document.getElementById('preview-bg-select');

    function updatePreviewOptions() {
        preview.options.showGaps = chkPreviewGaps.checked;
        preview.options.showLabels = chkPreviewLabels.checked;
        preview.options.showFrames = chkPreviewFrames.checked;
        preview.options.showRuler = chkPreviewRuler ? chkPreviewRuler.checked : true;
        preview.options.background = selectPreviewBg.value;

        // Synchronizuj przełącznik "Pokazuj ramki" z lewym panelem "Włącz generowanie ramek"
        if (chkFrameEnable.checked !== chkPreviewFrames.checked) {
            chkFrameEnable.checked = chkPreviewFrames.checked;
            if (chkFrameEnable.checked) {
                frameSettingsSub.classList.remove('hidden');
            } else {
                frameSettingsSub.classList.add('hidden');
            }
            gridManager.updateConfig(readConfigFromUI());
            checkBedVolumeAlert();
            planner.scheduleRender();
        }

        preview.scheduleRender();
        saveProjectState();
    }

    [chkPreviewGaps, chkPreviewLabels, chkPreviewFrames, chkPreviewRuler, selectPreviewBg].forEach(el => {
        if (el) el.addEventListener('change', updatePreviewOptions);
    });

    // Obsługa trybów interakcji (Siatka vs Kadr / Przesuwanie zdjęć)
    if (btnModeGrid && btnModeImage) {
        btnModeGrid.addEventListener('click', () => {
            btnModeGrid.classList.add('active');
            btnModeImage.classList.remove('active');
            planner.interactionMode = 'grid';
            document.getElementById('canvas-status-text').textContent = i18n.t('status_grid_mode');
        });
        btnModeImage.addEventListener('click', () => {
            btnModeImage.classList.add('active');
            btnModeGrid.classList.remove('active');
            planner.interactionMode = 'image';
            document.getElementById('canvas-status-text').textContent = i18n.t('status_image_mode');
        });
    }

    // Nasłuchiwanie zmian siatki z canvasa
    document.getElementById('planner-canvas').addEventListener('gridchange', () => {
        gridManager.checkBedSizeFit();
        checkBedVolumeAlert();
        preview.scheduleRender();
        saveProjectState();
    });

    // Resetowanie projektu
    document.getElementById('btn-reset-project').addEventListener('click', async () => {
        if (confirm(i18n.t('confirm_reset'))) {
            gridManager.clearImageAssignments();
            gridManager.setAllCellsStatus(true);
            
            // Wyczyść IndexedDB i ImageProcessor
            await DBStore.clear();
            imageProcessor.clearAll();
            
            imageList.innerHTML = `<p class="empty-list-text">${i18n.t('no_images_loaded')}</p>`;
            
            updateMainImageSelector();
            
            // Wyzeruj przesunięcia i skalę obrazu
            gridManager.config.singleImageOffsetX = 0;
            gridManager.config.singleImageOffsetY = 0;
            gridManager.config.singleImageScale = 1.0;
            if (inputSingleImageZoom) {
                inputSingleImageZoom.value = 100;
            }
            if (valSingleImageZoom) {
                valSingleImageZoom.textContent = '100%';
            }

            // Zresetuj tryb interakcji
            if (btnModeGrid && btnModeImage) {
                btnModeGrid.classList.add('active');
                btnModeImage.classList.remove('active');
                planner.interactionMode = 'grid';
                document.getElementById('canvas-status-text').textContent = i18n.t('status_grid_mode');
            }

            // Przywróć domyślne parametry w UI
            inputCols.value = 4;
            inputRows.value = 3;
            inputHexSize.value = 100;
            selectOrientation.value = 'flat-top';
            selectStagger.value = 'left';
            inputGap.value = 2;
            selectDpi.value = 300;
            if (selectFormat) selectFormat.value = 'png';
            if (inputQuality) inputQuality.value = 90;
            if (valQuality) valQuality.textContent = '90%';
            if (jpgQualityGroup) jpgQualityGroup.classList.add('hidden');
            chkBedVerify.checked = true;
            inputBedX.value = 256;
            inputBedY.value = 256;
            chkFrameEnable.checked = true;
            selectFrameType.value = 'outline';
            inputFrameWidth.value = 2;
            inputFrameClearance.value = 0.2;
            inputFrameColor.value = '#1a1a1a';
            if (chkSyncFrameWidth) chkSyncFrameWidth.checked = true;
            updateFrameWidthSync();
            if (chkPreviewRuler) chkPreviewRuler.checked = true;

            
            radioImageModes[0].checked = true;
            singleImageWrapper.classList.remove('hidden');

            gridManager.updateConfig(readConfigFromUI());
            updateHexDimensionLabels();
            handleBedVerifyChange();
            handleFrameConfigChange();
            
            localStorage.removeItem('hexsplitter_project_layout');

            planner.centerGrid();
            preview.scheduleRender();
        }
    });

    // Eksport ZIP z heksami
    document.getElementById('btn-export-hexes').addEventListener('click', async () => {
        await exporter.exportHexesZip();
    });

    // Eksport ramki jako PNG
    document.getElementById('btn-export-frame-png').addEventListener('click', async () => {
        await exporter.exportFramePNG();
    });

    // Eksport ramki jako SVG
    document.getElementById('btn-export-frame-svg').addEventListener('click', async () => {
        await exporter.exportFrameSVG();
    });

    // Drukowanie
    document.getElementById('btn-print-instructions').addEventListener('click', () => {
        window.print();
    });

    // Dopasowanie do okna
    window.addEventListener('resize', () => {
        const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
        if (activeTab === 'tab-planner') {
            planner.resize();
        } else if (activeTab === 'tab-preview') {
            preview.resize();
        }
    });

    // --- PRZYWRACANIE STANU PROJEKTU PRZY URUCHOMIENIU ---
    async function loadSavedProjectState() {
        try {
            // 1. Wczytaj obrazy z IndexedDB
            const savedImages = await DBStore.getAll();
            if (savedImages && savedImages.length > 0) {
                const emptyText = imageList.querySelector('.empty-list-text');
                if (emptyText) emptyText.remove();

                for (const saved of savedImages) {
                    const img = new Image();
                    const url = URL.createObjectURL(saved.blob);
                    
                    await new Promise((resolve) => {
                        img.onload = resolve;
                        img.src = url;
                    });

                    const imageObj = {
                        id: saved.id,
                        name: saved.name,
                        imgElement: img,
                        width: saved.width,
                        height: saved.height,
                        src: url
                    };

                    imageProcessor.images.set(saved.id, imageObj);
                    addDraggableImageToUI(imageObj);
                }
                updateMainImageSelector();
            }

            // 2. Wczytaj layout z localStorage
            const layoutStr = localStorage.getItem('hexsplitter_project_layout');
            if (layoutStr) {
                const layout = JSON.parse(layoutStr);

                // Przywróć wartości UI
                if (layout.grid) {
                    if (layout.grid.columns !== undefined) inputCols.value = layout.grid.columns;
                    if (layout.grid.rows !== undefined) inputRows.value = layout.grid.rows;
                    if (layout.grid.hexSize !== undefined) inputHexSize.value = layout.grid.hexSize;
                    if (layout.grid.orientation !== undefined) selectOrientation.value = layout.grid.orientation;
                    if (layout.grid.stagger !== undefined) selectStagger.value = layout.grid.stagger;
                    if (layout.grid.gap !== undefined) inputGap.value = layout.grid.gap;
                    if (layout.grid.dpi !== undefined) selectDpi.value = layout.grid.dpi;
                    if (layout.grid.exportFormat !== undefined && selectFormat) {
                        selectFormat.value = layout.grid.exportFormat;
                        if (layout.grid.exportFormat === 'jpg') {
                            if (jpgQualityGroup) jpgQualityGroup.classList.remove('hidden');
                        } else {
                            if (jpgQualityGroup) jpgQualityGroup.classList.add('hidden');
                        }
                    }
                    if (layout.grid.exportQuality !== undefined && inputQuality) {
                        inputQuality.value = layout.grid.exportQuality;
                        if (valQuality) valQuality.textContent = `${layout.grid.exportQuality}%`;
                    }
                    
                    gridManager.config.singleImageOffsetX = layout.grid.singleImageOffsetX || 0;
                    gridManager.config.singleImageOffsetY = layout.grid.singleImageOffsetY || 0;
                    gridManager.config.singleImageScale = layout.grid.singleImageScale || 1.0;
                    if (inputSingleImageZoom) {
                        inputSingleImageZoom.value = Math.round((layout.grid.singleImageScale || 1.0) * 100);
                    }
                    if (valSingleImageZoom) {
                        valSingleImageZoom.textContent = `${Math.round((layout.grid.singleImageScale || 1.0) * 100)}%`;
                    }
                }

                if (layout.bed) {
                    if (layout.bed.verify !== undefined) chkBedVerify.checked = layout.bed.verify;
                    if (layout.bed.sizeX !== undefined) inputBedX.value = layout.bed.sizeX;
                    if (layout.bed.sizeY !== undefined) inputBedY.value = layout.bed.sizeY;
                }

                if (layout.frame) {
                    if (layout.frame.enable !== undefined) chkFrameEnable.checked = layout.frame.enable;
                    if (layout.frame.type !== undefined) selectFrameType.value = layout.frame.type;
                    if (layout.frame.width !== undefined) inputFrameWidth.value = layout.frame.width;
                    if (layout.frame.clearance !== undefined) inputFrameClearance.value = layout.frame.clearance;
                    if (layout.frame.color !== undefined) inputFrameColor.value = layout.frame.color;
                    if (layout.frame.syncWidth !== undefined && chkSyncFrameWidth) {
                        chkSyncFrameWidth.checked = layout.frame.syncWidth;
                    }
                }

                if (layout.previewOptions) {
                    if (layout.previewOptions.showGaps !== undefined) chkPreviewGaps.checked = layout.previewOptions.showGaps;
                    if (layout.previewOptions.showLabels !== undefined) chkPreviewLabels.checked = layout.previewOptions.showLabels;
                    if (layout.previewOptions.showFrames !== undefined) chkPreviewFrames.checked = layout.previewOptions.showFrames;
                    if (layout.previewOptions.showRuler !== undefined && chkPreviewRuler) chkPreviewRuler.checked = layout.previewOptions.showRuler;
                    if (layout.previewOptions.background !== undefined) selectPreviewBg.value = layout.previewOptions.background;
                    
                    preview.options.showGaps = chkPreviewGaps.checked;
                    preview.options.showLabels = chkPreviewLabels.checked;
                    preview.options.showFrames = chkPreviewFrames.checked;
                    preview.options.showRuler = chkPreviewRuler ? chkPreviewRuler.checked : true;
                    preview.options.background = selectPreviewBg.value;
                }

                // Tryb obrazu
                radioImageModes.forEach(r => {
                    r.checked = (r.value === layout.imageMode);
                });

                imageProcessor.activeImageId = layout.activeImageId;
                updateMainImageSelector();

                // Zaaplikuj config siatki
                gridManager.updateConfig(readConfigFromUI());

                // Nadpisz stany komórek
                if (layout.cells) {
                    layout.cells.forEach(savedCell => {
                        const cell = gridManager.getCell(savedCell.q, savedCell.r);
                        if (cell) {
                            cell.enabled = savedCell.enabled;
                            cell.imageId = savedCell.imageId;
                            cell.cropRegion = savedCell.cropRegion;
                        }
                    });
                }

                // Aktualizuj widoczność
                handleBedVerifyChange();
                handleFrameConfigChange();
                
                if (layout.imageMode === 'single') {
                    singleImageWrapper.classList.remove('hidden');
                } else {
                    singleImageWrapper.classList.add('hidden');
                }
            } else {
                handleBedVerifyChange();
                handleFrameConfigChange();
            }

            updateStaggerDropdownLabels();
            updateZoomSliderVisibility();
            updateHexDimensionLabels();
            gridManager.checkBedSizeFit();
            checkBedVolumeAlert();

            // Dopasuj płótno planera i narysuj
            planner.resize();
            planner.centerGrid();
            
            preview.resize();
            preview.centerGrid();
        } catch (err) {
            console.error("Błąd przywracania stanu projektu:", err);
        }
    }

    // Nasłuchiwanie zmian języka
    document.addEventListener('languagechange', () => {
        if (imageProcessor.getAllImages().length === 0) {
            imageList.innerHTML = `<p class="empty-list-text">${i18n.t('no_images_loaded')}</p>`;
        }
        updateMainImageSelector();
        if (planner.interactionMode === 'grid') {
            document.getElementById('canvas-status-text').textContent = i18n.t('status_grid_mode');
        } else {
            document.getElementById('canvas-status-text').textContent = i18n.t('status_image_mode');
        }
        updateHexDimensionLabels();
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        if (activeTab === 'tab-instructions') {
            exporter.generateAssemblyInstructions();
        }
    });

    // Rozpocznij przywracanie stanu po wczytaniu DOM
    await loadSavedProjectState();
});
